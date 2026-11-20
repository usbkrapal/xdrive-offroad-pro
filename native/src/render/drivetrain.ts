// Прозрачная схема xDrive (как DrivetrainStage браузера): статичный рендер xray-drivetrain.png +
// векторные слои показаний в координатах исходного PNG 1122 × 1402. Логика движения — общий
// src/components/motion.ts (те же скорости фаз, пороги буксования, мигание 1,25 Гц).
// Отличия от SVG (ограничения kit): нет clipPath/dasharray/градиентов по произвольной форме —
// шины рисуются скруглёнными прямоугольниками с полосами, пунктир и бегущие импульсы
// строятся отрезками вдоль ломаной пути; кривые Безье дискретизируются.

import { usableNumber, usableValue } from '../../../src/domain/signal';
import { WHEELS, type SignalMap, type Wheel } from '../../../src/domain/types';
import { gearText } from '../../../src/components/displayHelpers';
import {
  advancePhase,
  BLINK_HZ,
  blinkLevel,
  braking,
  clamp,
  computeMotion,
  flowing,
  halfShaftAxle,
  packetPeriod,
  shaftRate,
  SLIP_HIGH_PCT,
  tyreSurface,
  type AxleLoad,
  type MotionModel,
} from '../../../src/components/motion';
import { IMAGE_ID } from '../assets/spec';
import { formatNumber, shownNumber, shownSignal } from '../format';
import type { Pt, Surface } from '../platform/kitTypes';
import { T } from '../strings';
import { C, withA } from './palette';
import { caps, text, width } from './ui';

export const IMG_W = 1122;
export const IMG_H = 1402;

const A = { engine: [560, 175], gearbox: [560, 390], transfer: [560, 545], frontDiff: [470, 350], rearDiff: [560, 1010] } as const;
const TYRE: Record<Wheel, { x: number; y: number; w: number; h: number }> = {
  FL: { x: 272, y: 216, w: 78, h: 234 },
  FR: { x: 772, y: 216, w: 78, h: 234 },
  RL: { x: 146, y: 850, w: 112, h: 244 },
  RR: { x: 864, y: 850, w: 112, h: 244 },
};
const CALIPER: Record<Wheel, Pt> = { FL: [338, 322], FR: [784, 322], RL: [276, 1000], RR: [846, 1000] };
const STRUT: Record<Wheel, Pt> = { FL: [380, 205], FR: [741, 205], RL: [298, 892], RR: [825, 892] };
const LEFT = (w: Wheel) => w === 'FL' || w === 'RL';
const LUG_PITCH = 24;
const LUG_STEPS = 8;
const PISTONS = [
  [506, 0], [506, 270], [506, 90], [506, 180],
  [614, 180], [614, 90], [614, 270], [614, 0],
].map(([px, off], i) => ({ x: px, y: 122 + (i % 4) * 30, off }));
const PISTON_STROKES = 4;
const GEAR_TURNS = 2;
const COIL = { front: { len: 56, wid: 24 }, rear: { len: 60, wid: 26 } } as const;
const COIL_STRETCH = 0.38;
const TRAVEL_MM = 120;
const SPIN_PERIOD = 28;
const SPIN_STEPS = 6;
const DIFF_R = 66;

type Packets = 1 | 2 | 3 | 4;
interface ShaftGeo {
  readonly pts: readonly Pt[];
  readonly len: number;
  readonly n: Packets;
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** Пути валов из DrivetrainStage.PATH (кривая переднего вала — дискретизированная Безье). */
export const PATH: { input: ShaftGeo; front: ShaftGeo; rear: ShaftGeo; half: Record<Wheel, ShaftGeo> } = {
  input: { pts: [[560, 250], [560, 515]], len: 265, n: 2 },
  front: { pts: cubic([548, 530], [520, 500], [488, 440], [478, 372], 12), len: 185, n: 2 },
  rear: { pts: [[562, 580], [565, 930], [560, 975]], len: 396, n: 4 },
  half: {
    FL: { pts: [[440, 350], [320, 342]], len: 120, n: 1 },
    FR: { pts: [[500, 350], [810, 342]], len: 310, n: 3 },
    RL: { pts: [[500, 1014], [262, 1010]], len: 238, n: 2 },
    RR: { pts: [[620, 1014], [860, 1010]], len: 240, n: 2 },
  },
};

/** Ломаная с нормированной длиной: точка и участок [a, b] (доли 0…1). */
class Path {
  readonly cum: number[];
  readonly total: number;
  constructor(readonly pts: readonly Pt[]) {
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.total = this.cum[this.cum.length - 1] || 1;
  }
  at(f: number): Pt {
    const d = clamp(f, 0, 1) * this.total;
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < d) i++;
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    const k = (d - this.cum[i - 1]) / seg;
    const a = this.pts[i - 1];
    const b = this.pts[i];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }
  slice(a: number, b: number): Pt[] {
    a = clamp(a, 0, 1);
    b = clamp(b, 0, 1);
    if (b <= a) return [];
    const out: Pt[] = [this.at(a)];
    for (let i = 1; i < this.pts.length - 1; i++) {
      const f = this.cum[i] / this.total;
      if (f > a && f < b) out.push(this.pts[i]);
    }
    out.push(this.at(b));
    return out;
  }
}
const PATHS = new Map<ShaftGeo, Path>();
const pathOf = (g: ShaftGeo) => {
  let p = PATHS.get(g);
  if (!p) PATHS.set(g, (p = new Path(g.pts)));
  return p;
};

/** Фазы анимации (0…1) по реальному времени; в паузе dt = 0 — всё стоит на месте. */
export class Phases {
  private readonly ph: Record<string, number> = {};
  get(k: string): number {
    return this.ph[k] ?? 0;
  }
  advance(rates: Record<string, number>, dtSec: number): void {
    if (!(dtSec > 0)) return;
    const dt = Math.min(0.1, dtSec);
    for (const k of Object.keys(rates)) {
      const r = rates[k];
      if (r !== 0) this.ph[k] = advancePhase(this.ph[k] ?? 0, r, dt);
    }
  }
  reset(): void {
    for (const k of Object.keys(this.ph)) delete this.ph[k];
  }
}

interface WheelData {
  speed: number | null;
  slip: number | null;
  brake: boolean | null;
  height: number | null;
}

/** Скорости всех фаз сцены (та же раскладка, что rates в DrivetrainStage). */
export function stageRates(s: SignalMap, motion: MotionModel = computeMotion(s)): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const w of WHEELS) {
    rates[`t${w}`] = motion.rates[`t${w}`];
    rates[`h${w}`] = shaftRate(motion.rates[halfShaftAxle(w)], PATH.half[w].len);
  }
  rates.input = shaftRate(motion.rates.input, PATH.input.len);
  rates.front = shaftRate(motion.rates.front, PATH.front.len);
  rates.rear = shaftRate(motion.rates.rear, PATH.rear.len);
  rates.eng = motion.rates.eng;
  rates.sf = motion.rates.sf;
  rates.sr = motion.rates.sr;
  const blinking = WHEELS.some((w) => tyreSurface(usableValue(s[`brakeIntervention.${w}`]), usableNumber(s[`wheelSlip.${w}`])) === 'brake-slip');
  rates.blink = blinking ? BLINK_HZ : 0;
  return rates;
}

export interface StageBox {
  /** Левый верх области сцены и её размер (логические px). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** full — выноски, подписи колёс, легенда; compact — только рендер и слои. */
  full: boolean;
}

/** Нарисовать сцену. Возвращает масштаб (px на единицу PNG). */
export function drawDrivetrain(cv: Surface, s: SignalMap, ph: Phases, box: StageBox): number {
  const sc = box.h / IMG_H;
  const imgW = IMG_W * sc;
  const ox = box.x + (box.w - imgW) / 2;
  const oy = box.y;
  const X = (x: number) => ox + x * sc;
  const Y = (y: number) => oy + y * sc;
  const P = (p: Pt): Pt => [X(p[0]), Y(p[1])];
  const L = (px: number) => px * 0.9; // толщины CSS-«экранных» px → логические px сцены

  const motion = computeMotion(s);
  const wheel = {} as Record<Wheel, WheelData>;
  for (const w of WHEELS) {
    wheel[w] = {
      speed: usableNumber(s[`wheelSpeed.${w}`]),
      slip: usableNumber(s[`wheelSlip.${w}`]),
      brake: usableValue(s[`brakeIntervention.${w}`]),
      height: usableNumber(s[`suspensionHeight.${w}`]),
    };
  }
  const rpm = usableNumber(s['engine.rpm']);
  const torque = usableNumber(s['engine.torqueNm']);
  const speed = usableNumber(s.vehicleSpeedKmh);
  const front = usableNumber(s['xdrive.frontPercent']);
  const rear = usableNumber(s['xdrive.rearPercent']);
  const gearboxC = usableNumber(s['temperature.gearboxC']);
  const lockState = usableValue(s['rearDiff.lockState']);
  const lockPct = usableNumber(s['rearDiff.lockPercent']);
  const anyLive =
    motion.anyMotion ||
    [rpm, speed, torque, front, rear, gearboxC, lockPct, usableNumber(s['xdrive.frontTorqueNm'])].some((v) => v !== null) ||
    lockState !== null ||
    WHEELS.some((w) => wheel[w].speed !== null || wheel[w].slip !== null || wheel[w].brake !== null || wheel[w].height !== null);

  cv.image(IMAGE_ID.xray, ox, oy, imgW, IMG_H * sc);

  const running = motion.engine === 'running';
  const engineDrive = running && motion.engineDirection === 'drive';
  const driveLoad = engineDrive ? (motion.engineLoad ?? 0) : 0;

  // Двигатель: поршни V8 — ход по фазе оборотов; под тягой — циан.
  if (motion.engine !== 'missing') {
    const pe = ph.get('eng');
    for (const p of PISTONS) {
      const wave = Math.sin(((pe * PISTON_STROKES * 360 + p.off) * Math.PI) / 180);
      const scale = running ? 0.8 + 0.2 * wave : 1;
      const op = running ? 0.6 + 0.4 * wave : 0.4;
      const [cx, cy] = P([p.x, p.y]);
      const r = 12 * sc * scale;
      const fill = engineDrive ? withA(C.flowGlow, (0.22 + driveLoad * 0.3) * op) : withA('#d2deec', 0.16 * op);
      const edge = engineDrive ? withA('#9fe2ff', op) : withA('#e2ecf8', 0.75 * op);
      cv.circle(cx, cy, r, fill);
      cv.arc(cx, cy, r - L(0.8), r + L(0.8), 0, 360, edge);
      cv.circle(cx, cy, 5 * sc * scale, withA(engineDrive ? '#e6f7ff' : '#ecf3fa', 0.7 * op));
    }
  }

  const inputLoad: AxleLoad = { level: motion.engineLoad, source: null, direction: motion.engineDirection };
  drawShaft(cv, PATH.input, inputLoad, { axle: false, rotating: running, phase: ph.get('input'), spin: motion.engine === 'missing' ? null : ph.get('eng'), thin: false }, P, L);

  // АКПП и раздатка: шестерни вращаются с двигателем.
  const gearState = (load: boolean, spin: boolean, missing: boolean, hot = false) => ({ load, spin, missing, hot });
  const axleLevel = (a: AxleLoad) => (flowing(a) ? (a.level ?? 0) : 0);
  const eMissing = motion.engine === 'missing';
  const turn = (phase: number, known: boolean, dir = 1, off = 0) => (known ? phase * dir * GEAR_TURNS * 360 + off : off);
  drawGear(cv, P([A.gearbox[0], A.gearbox[1] - 24]), 25 * sc, 10, turn(ph.get('eng'), !eMissing), gearState(engineDrive, running, eMissing, gearboxC !== null && gearboxC >= 110), driveLoad, L);
  drawGear(cv, P([A.gearbox[0], A.gearbox[1] + 21]), 25 * sc, 10, turn(ph.get('eng'), !eMissing, -1, 18), gearState(engineDrive, running, eMissing, gearboxC !== null && gearboxC >= 110), driveLoad, L);
  const fDrive = flowing(motion.front);
  const rDrive = flowing(motion.rear);
  drawGear(cv, P(A.transfer as Pt), 22 * sc, 9, turn(ph.get('eng'), !eMissing), gearState(fDrive || rDrive, running, eMissing), Math.max(axleLevel(motion.front), axleLevel(motion.rear)), L);

  drawShaft(cv, PATH.front, motion.front, { axle: true, rotating: false, phase: ph.get('front'), spin: motion.spinKnown.front ? ph.get('sf') : null, thin: false }, P, L);
  drawShaft(cv, PATH.rear, motion.rear, { axle: true, rotating: false, phase: ph.get('rear'), spin: motion.spinKnown.rear ? ph.get('sr') : null, thin: false }, P, L);
  for (const w of WHEELS) {
    const axle = halfShaftAxle(w);
    drawShaft(cv, PATH.half[w], motion[axle], { axle: true, rotating: false, phase: ph.get(`h${w}`), spin: wheel[w].speed === null ? null : ph.get(`t${w}`), thin: true }, P, L);
  }

  drawGear(cv, P(A.frontDiff as Pt), 21 * sc, 8, turn(ph.get('sf'), motion.spinKnown.front), gearState(fDrive, motion.rates.sf > 0, !motion.spinKnown.front), axleLevel(motion.front), L);
  // Задний дифференциал: коронная шестерня; дуга — степень блокировки, неизвестно — пунктир (не «открыт»).
  const rd = P(A.rearDiff as Pt);
  drawGear(cv, rd, 32 * sc, 14, turn(ph.get('sr'), motion.spinKnown.rear), gearState(rDrive, motion.rates.sr > 0, !motion.spinKnown.rear), axleLevel(motion.rear), L);
  const dr = DIFF_R * sc;
  const lockFrac = lockState === null ? null : lockPct !== null ? clamp(lockPct, 0, 100) / 100 : lockState === 'locked' ? 1 : lockState === 'open' ? 0 : null;
  if (lockState === null) dashedRing(cv, rd[0], rd[1], dr, L(1.5), withA('#8a95a6', 0.55));
  else cv.arc(rd[0], rd[1], dr - L(1), dr + L(1), 0, 360, rDrive ? C.flowCore : withA('#b0d0ee', 0.4));
  if (lockFrac !== null && lockFrac > 0) {
    const locked = lockState === 'locked';
    cv.arc(rd[0], rd[1], dr - L(7), dr + L(7), 0, lockFrac * 360, withA(C.flowGlow, locked ? 0.45 : 0.3));
    cv.arc(rd[0], rd[1], dr - L(2.5), dr + L(2.5), 0, lockFrac * 360, locked ? '#e2f4ff' : C.cold);
  }

  const blink = blinkLevel(ph.get('blink'));
  for (const w of WHEELS) drawWheel(cv, w, wheel[w], motion.rates[`t${w}`] > 0, ph.get(`t${w}`), blink, sc, P, L);

  if (box.full) drawAnnotations(cv, s, box, sc, ox, oy);

  if (!anyLive) {
    text(cv, T.drivetrain.allLost, X(IMG_W / 2), Y(IMG_H / 2), 26, C.warn, { align: 'center' });
  }
  return sc;
}

interface ShaftOpts {
  axle: boolean;
  rotating: boolean;
  phase: number;
  spin: number | null;
  thin: boolean;
}

function drawShaft(cv: Surface, geo: ShaftGeo, load: AxleLoad, o: ShaftOpts, P: (p: Pt) => Pt, L: (px: number) => number): void {
  const path = pathOf(geo);
  const pts = geo.pts.map(P);
  const drive = flowing(load);
  const brakingLoad = braking(load);
  const on = o.axle ? drive : o.rotating;
  const w = drive ? (load.level ?? 0) : 0;
  const estimate = load.source === 'share';
  // Дорожка: нейтральная; у оси с неизвестной нагрузкой — пунктир.
  if (o.axle && load.level === null) dashed(cv, path, P, L(1.5), withA('#8a95a6', 0.55), 0.035);
  else cv.polyline(pts, L(1.5), withA('#bed7f0', 0.3));
  // Вращение вала (колёса оси / двигатель): поперечные блики бегут и без тяги.
  if (o.spin !== null) {
    const period = SPIN_PERIOD / geo.len;
    const shift = -o.spin * SPIN_PERIOD * SPIN_STEPS / geo.len;
    const start = (((-shift) % period) + period) % period;
    for (let a = start - period; a < 1; a += period) {
      const seg = path.slice(a, a + period * 0.3);
      if (seg.length > 1) cv.polyline(seg.map(P), L(o.thin ? 5 : 6) * 0.8, withA('#ecf3fa', 0.42));
    }
  }
  if (brakingLoad) cv.polyline(pts, L(3 + (load.level ?? 0) * 3), withA('#c8d0dc', 0.45));
  if (drive && (o.axle || o.rotating)) {
    cv.polyline(pts, L((o.thin ? 8 : 10) + w * (o.thin ? 6 : 8)), withA(C.flowGlow, 0.22 + w * 0.2));
    cv.polyline(pts, L((o.thin ? 2 : 2.5) + w * (o.thin ? 1.2 : 1.5)), withA(C.flowCore, estimate ? 0.6 : 1));
  }
  if (!on) return;
  // Импульсы: голова в фазе, хвост назад на долю периода; на длинных валах несколько пакетов.
  const period = packetPeriod(geo.n);
  const op = drive ? 0.8 + w * 0.2 : 0.7;
  const layers = drive
    ? [
        { frac: 0.62, c: withA(C.pulseTail, 0.32 * op), wd: (o.thin ? 9 : 11) + w * (o.thin ? 5 : 6) },
        { frac: 0.3, c: withA(C.pulseMid, 0.8 * op), wd: (o.thin ? 4 : 5) + w * (o.thin ? 2 : 2.5) },
        { frac: 0.1, c: withA(C.pulseCore, (estimate ? 0.7 : 1) * op), wd: (o.thin ? 2.5 : 3) + w },
      ]
    : [
        { frac: 0.62, c: withA('#c8d0dc', 0.16 * op), wd: 7 },
        { frac: 0.3, c: withA('#d2dae4', 0.45 * op), wd: 3.5 },
        { frac: 0.1, c: withA('#e6ebf2', 0.85 * op), wd: 2.2 },
      ];
  for (const l of layers) {
    const len = period * l.frac;
    for (let head = o.phase - Math.floor(o.phase / period) * period; head < 1 + len; head += period) {
      const seg = path.slice(head - len, head);
      if (seg.length > 1) cv.polyline(seg.map(P), L(l.wd), l.c);
    }
  }
}

function dashed(cv: Surface, path: Path, P: (p: Pt) => Pt, width: number, c: string, step: number): void {
  for (let a = 0; a < 1; a += step * 2) {
    const seg = path.slice(a, a + step);
    if (seg.length > 1) cv.polyline(seg.map(P), width, c);
  }
}

function dashedRing(cv: Surface, cx: number, cy: number, r: number, w: number, c: string): void {
  for (let a = 0; a < 360; a += 20) cv.arc(cx, cy, r - w / 2, r + w / 2, a, a + 10, c);
}

function drawGear(
  cv: Surface,
  c: Pt,
  r: number,
  n: number,
  rotDeg: number,
  st: { load: boolean; spin: boolean; missing: boolean; hot: boolean },
  w: number,
  L: (px: number) => number,
): void {
  const step = (Math.PI * 2) / n;
  const rot = (rotDeg * Math.PI) / 180;
  const rIn = r * 0.8;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * step + rot;
    for (const [da, rr] of [
      [0, rIn],
      [step * 0.18, r],
      [step * 0.5, r],
      [step * 0.68, rIn],
    ] as const) {
      pts.push([c[0] + rr * Math.cos(a + da), c[1] + rr * Math.sin(a + da)]);
    }
  }
  const alpha = st.missing ? 0.35 : 1;
  if (!st.missing) cv.fill(pts, st.load ? withA(C.flowGlow, 0.2 + w * 0.25) : withA('#c8d8ea', 0.14));
  const edge = st.missing ? withA('#8a95a6', 0.8 * alpha) : st.hot ? C.warn : st.load ? '#9fe2ff' : withA('#e2ecf8', 0.78);
  cv.polyline(pts.concat([pts[0]]), L(1.5), edge);
  cv.circle(c[0], c[1], r * 0.32, withA('#0a0e14', 0.6 * alpha));
  cv.arc(c[0], c[1], r * 0.32 - L(0.6), r * 0.32 + L(0.6), 0, 360, withA('#e2ecf8', 0.7 * alpha));
  const mx = Math.sin(rot);
  const my = -Math.cos(rot);
  cv.line(c[0] + mx * r * 0.32, c[1] + my * r * 0.32, c[0] + mx * r * 0.72, c[1] + my * r * 0.72, L(1.6), withA('#f0f6fc', 0.9 * alpha));
}

function drawWheel(
  cv: Surface,
  w: Wheel,
  d: WheelData,
  rolling: boolean,
  phase: number,
  blink: number,
  sc: number,
  P: (p: Pt) => Pt,
  L: (px: number) => number,
): void {
  const t = TYRE[w];
  const [x, y] = P([t.x, t.y]);
  const tw = t.w * sc;
  const th = t.h * sc;
  const rad = Math.min(t.w * 0.3, 26) * sc;
  const surface = tyreSurface(d.brake, d.slip);
  const brakeOn = d.brake === true;
  const pulsing = surface === 'brake-slip';
  const missing = d.speed === null;
  // Резина: тёмные плечи, светлее к середине беговой дорожки.
  cv.roundRect(x, y, tw, th, rad, withA('#0d1014', 0.88));
  cv.roundRect(x + tw * 0.22, y + 1, tw * 0.56, th - 2, rad * 0.6, withA('#262c34', 0.72));
  if (brakeOn) {
    cv.roundRect(x, y, tw, th, rad, withA('#8e1216', 0.9));
    cv.roundRect(x + tw * 0.25, y + 1, tw * 0.5, th - 2, rad * 0.6, withA('#ff3b3d', 0.75));
  }
  if (pulsing) cv.roundRect(x, y, tw, th, rad, withA('#ff3034', 0.9 * blink));
  // Протектор «ёлочкой»: катится по фазе колеса; без скорости — приглушён и стоит.
  const lug = missing ? withA('#8a95a6', 0.16) : surface === 'slip' ? withA('#ffd68c', 0.62) : withA('#cddae8', 0.4);
  const shift = rolling ? -((phase * LUG_PITCH * LUG_STEPS) % LUG_PITCH) : 0;
  const cx = t.x + t.w / 2;
  const g = t.w * 0.07;
  const dd = LUG_PITCH * 0.6;
  for (let yy = t.y - LUG_PITCH + shift; yy <= t.y + t.h; yy += LUG_PITCH) {
    clipLine(cv, P([t.x + t.w * 0.06, yy + dd]), P([cx - g, yy]), y + 1, y + th - 1, L(1.6), lug);
    clipLine(cv, P([cx + g, yy]), P([t.x + t.w * 0.94, yy + dd]), y + 1, y + th - 1, L(1.6), lug);
  }
  if (surface === 'slip') {
    const f = d.slip === null ? 0 : clamp(d.slip, 0, 100) / 100;
    const a = 0.35 + f * 0.6;
    cv.gradientRect(x + 1, y + 2, tw - 2, th - 4, [
      [0, withA(C.warn, 0.15 * a)],
      [0.5, withA(C.warn, 0.75 * a)],
      [1, withA(C.warn, 0.15 * a)],
    ]);
  }
  // Блик и кривизна шины.
  cv.fillRect(x + tw * 0.3, y + th * 0.08, tw * 0.12, th * 0.84, withA('#dfeaf6', 0.07));
  cv.gradientRect(x + 1, y, tw - 2, th * 0.2, [[0, withA('#000000', 0.6)], [1, withA('#000000', 0)]]);
  cv.gradientRect(x + 1, y + th * 0.8, tw - 2, th * 0.2, [[0, withA('#000000', 0)], [1, withA('#000000', 0.6)]]);
  // Кромка: янтарь — буксование, красный — торможение (мигает вместе со слоем).
  if (brakeOn) {
    cv.strokeRoundRect(x - L(4), y - L(4), tw + L(8), th + L(8), rad + L(4), L(5), withA(C.red, 0.4 * (pulsing ? 0.35 + 0.65 * blink : 1)));
    cv.strokeRoundRect(x, y, tw, th, rad, L(2.4), C.red);
  } else if (surface === 'slip') {
    cv.strokeRoundRect(x, y, tw, th, rad, L((d.slip ?? 0) >= SLIP_HIGH_PCT ? 2.4 : 1.6), C.warn);
  } else {
    cv.strokeRoundRect(x, y, tw, th, rad, L(1), missing ? withA('#8a95a6', 0.5) : withA('#d6e2f0', 0.28));
  }

  // Суппорт: дуга со стороны колеса; без данных — тонкая серая.
  const [kx, ky] = P(CALIPER[w]);
  const dir = LEFT(w) ? -1 : 1;
  const ccx = kx - dir * 6 * sc;
  const r = 40 * sc;
  const a0 = LEFT(w) ? 180 : 0;
  if (d.brake === true) {
    cv.arc(ccx, ky, r - L(7), r + L(7), a0, a0 + 180, withA(C.red, 0.35));
    cv.arc(ccx, ky, r - L(2.25), r + L(2.25), a0, a0 + 180, C.red);
  } else if (d.brake === null) {
    for (let a = a0; a < a0 + 180; a += 24) cv.arc(ccx, ky, r - L(0.75), r + L(0.75), a, a + 12, withA('#8a95a6', 0.55));
  }

  // Пружина стойки: длиннее — выше нормы (циан), короче — ниже (янтарь); без данных — силуэт.
  const coil = w === 'FL' || w === 'FR' ? COIL.front : COIL.rear;
  const [sx, sy] = STRUT[w];
  const top = sy - coil.len / 2;
  const hn = d.height === null ? null : clamp(d.height, -TRAVEL_MM, TRAVEL_MM) / TRAVEL_MM;
  const stretch = hn === null ? 1 : 1 + hn * COIL_STRETCH;
  const zig = (k: number): Pt[] => {
    const n = 10;
    const out: Pt[] = [[sx, top]];
    for (let i = 1; i < n; i++) out.push([sx + (i % 2 ? -1 : 1) * (coil.wid / 2), top + ((coil.len * i) / n) * k]);
    out.push([sx, top + coil.len * k]);
    return out.map(P);
  };
  const capX = coil.wid * 0.75;
  cv.polyline(zig(1), L(1), withA('#e2ecf8', hn === null ? 0.2 : 0.28));
  const [c1x, c1y] = P([sx - capX, top]);
  const [c2x] = P([sx + capX, top]);
  cv.line(c1x, c1y, c2x, c1y, L(2.2), withA('#ecf3fa', 0.85));
  if (hn !== null) {
    const col = hn >= 0 ? C.cold : C.warn;
    cv.polyline(zig(stretch), L(7), withA(col, 0.3));
    cv.polyline(zig(stretch), L(2.4), col);
    const [, by] = P([sx, top + coil.len * stretch]);
    cv.line(c1x, by, c2x, by, L(2.2), withA('#ecf3fa', 0.85));
  }
}

/** Отрезок, обрезанный по вертикальной полосе [y0, y1] (протектор внутри шины). */
function clipLine(cv: Surface, a: Pt, b: Pt, y0: number, y1: number, w: number, c: string): void {
  let [ax, ay] = a;
  let [bx, by] = b;
  if ((ay < y0 && by < y0) || (ay > y1 && by > y1)) return;
  const at = (yy: number) => ax + ((bx - ax) * (yy - ay)) / (by - ay || 1);
  if (ay < y0) [ax, ay] = [at(y0), y0];
  else if (ay > y1) [ax, ay] = [at(y1), y1];
  if (by < y0) [bx, by] = [at(y0), y0];
  else if (by > y1) [bx, by] = [at(y1), y1];
  cv.line(ax, ay, bx, by, w, c);
}

/** Выноски, подписи колёс и пояснение к пружинам (только полный режим «Рельефа»). */
function drawAnnotations(cv: Surface, s: SignalMap, box: StageBox, sc: number, ox: number, oy: number): void {
  const t = T;
  const X = (x: number) => ox + x * sc;
  const Y = (y: number) => oy + y * sc;
  const num = (sig: SignalMap['engine.rpm'], d: number, unit: string) => {
    const v = shownNumber(sig, d);
    return { ok: v.ok, text: v.ok ? `${v.text} ${unit}` : `— ${t.quality[v.quality]}`, q: v.quality };
  };
  const lines = (parts: { ok: boolean; text: string; q: keyof typeof t.quality }[], join = false) =>
    parts.some((p) => p.ok) ? { ok: true, lines: join ? [parts.map((p) => p.text).join(' · ')] : parts.map((p) => p.text) } : { ok: false, lines: [t.quality[parts[0].q]] };
  const gear = shownSignal(s.gear, gearText);
  const front = usableNumber(s['xdrive.frontPercent']);
  const rear = usableNumber(s['xdrive.rearPercent']);
  const pct = (v: number | null) => (v === null ? '—' : formatNumber(v, 0));
  const diffState = shownSignal(s['rearDiff.lockState'], (v) => t.diffLock[v]);
  const diffPct = num(s['rearDiff.lockPercent'], 0, t.units.percent);
  const diff = lines([{ ok: diffState.ok, text: diffState.ok ? diffState.text : `— ${t.quality[diffState.quality]}`, q: diffState.quality }, diffPct]);
  if (usableValue(s['rearDiff.lockState']) === null) diff.ok = false;
  const callouts = [
    { side: 'left', y: 100, anchor: [462, 125], label: t.drivetrain.engine, ...lines([num(s['engine.rpm'], 0, t.units.rpm), num(s['engine.torqueNm'], 0, t.units.nm)]) },
    { side: 'left', y: 610, anchor: [A.frontDiff[0] - 24, A.frontDiff[1] + 20], label: t.drivetrain.frontAxle, ...lines([num(s['xdrive.frontPercent'], 0, t.units.percent)]) },
    { side: 'left', y: 1190, anchor: [500, 1032], label: t.drivetrain.rearAxle, ...lines([num(s['xdrive.rearPercent'], 0, t.units.percent)]) },
    {
      side: 'right',
      y: 440,
      anchor: [612, 420],
      label: t.drivetrain.gearbox,
      ...lines([{ ok: gear.ok, text: gear.ok ? gear.text : `— ${t.quality[gear.quality]}`, q: gear.quality }, num(s['temperature.gearboxC'], 0, t.units.celsius)], true),
    },
    {
      side: 'right',
      y: 640,
      anchor: [618, 560],
      label: t.drivetrain.transfer,
      ...(front !== null || rear !== null ? { ok: true, lines: [`${pct(front)} / ${pct(rear)} ${t.units.percent}`] } : lines([num(s['xdrive.frontPercent'], 0, t.units.percent)])),
    },
    { side: 'right', y: 1170, anchor: [A.rearDiff[0] + DIFF_R, A.rearDiff[1] + 14], label: t.drivetrain.rearDiff, ...diff },
  ] as const;
  const leftX = box.x + 6;
  const rightX = box.x + box.w - 6;
  for (const c of callouts) {
    const left = c.side === 'left';
    const cy = Y(c.y);
    const edge = left ? X(-40) : X(IMG_W + 40);
    const elbow = left ? X(70) : X(IMG_W - 70);
    const textEnd = left ? leftX + 190 : rightX - 190;
    const lineCol = withA('#f4f7fb', c.ok ? 0.38 : 0.22);
    cv.polyline([[textEnd, cy], [edge, cy], [elbow, cy], [X(c.anchor[0]), Y(c.anchor[1])]], 1.2, lineCol);
    cv.circle(X(c.anchor[0]), Y(c.anchor[1]), 3, C.text);
    caps(cv, c.label, left ? leftX : rightX, cy - 8, 13, C.dim, left ? 'left' : 'right');
    c.lines.forEach((ln, i) => {
      text(cv, ln, left ? leftX : rightX, cy + 18 + i * 26, 17, c.ok ? C.text : C.warn, { align: left ? 'left' : 'right' });
    });
  }
  for (const w of WHEELS) {
    const tyre = TYRE[w];
    const x = LEFT(w) ? X(Math.min(tyre.x, 140) - 34) : X(Math.max(tyre.x + tyre.w, 982) + 34);
    const y = Y(tyre.y + tyre.h / 2) + 6;
    const ruW = width(cv, t.wheels[w].short, 16);
    const codeW = width(cv, t.wheels[w].code, 11);
    if (LEFT(w)) {
      text(cv, t.wheels[w].code, x, y, 11, C.dim, { align: 'right' });
      text(cv, t.wheels[w].short, x - codeW - 4, y, 16, C.text, { align: 'right' });
    } else {
      text(cv, t.wheels[w].short, x, y, 16, C.text);
      text(cv, t.wheels[w].code, x + ruW + 4, y, 11, C.dim);
    }
  }
  // Цветовой легенды (момент / буксование / торможение) нет: значения подписаны выносками. Остаётся пояснение
  // к длине пружин стоек — это не цвет, а геометрия.
  text(cv, t.drivetrain.legendTravel, box.x + 6, box.y + box.h + 22, 12, C.dim);
}
