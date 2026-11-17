// Пять экранов утверждённого интерфейса на логическом холсте 1600 × 520.
// Все обязательные показатели остаются на своих экранах; недоступное — «—» и статус, не 0.

import { cornerHeights, heightDeltas, maxSlipNow } from '../../../src/domain/derived';
import { altitudeChangeFromStart, sessionElapsedMs, type Extremum } from '../../../src/domain/session';
import { usableNumber, usableValue } from '../../../src/domain/signal';
import { SUSPENSION_LEVELS, WHEELS, type Signal, type SignalMap, type Wheel } from '../../../src/domain/types';
import { gearText } from '../../../src/components/displayHelpers';
import { cameraLayout, type CameraId, type CameraView } from '../../../src/screens/cameraPresentation';
import type { ImageRegistry, CameraKey } from '../assets/registry';
import { DIAL_K } from '../assets/spec';
import { formatDuration, formatNumber, NONE, presentSource, shownNumber, shownSignal, type Shown } from '../format';
import { asDomain, type NativeState } from '../model/model';
import type { Layer, Surface } from '../platform/kitTypes';
import { T } from '../strings';
import { BEZEL, drawDialLive, drawDialStatic, FACE, vehicleRotation, type DialKind, type DialTexture } from './dial';
import { drawDrivetrain, IMG_H, IMG_W, type Phases } from './drivetrain';
import { CAMERA_MAIN, CAMERA_THUMB, DIAL_R, GAP, M, TERRAIN, TOPDOWN_H_SUSPENSION, TOPDOWN_H_SYSTEMS, W, XRAY_H_TERRAIN, XRAY_H_TRACTION, Y0, Y1 } from './layout';
import { C, withA } from './palette';
import { bar, caps, chip, hline, panel, readout, statusTag, text, width } from './ui';

export interface PageEnv {
  readonly cv: Surface;
  readonly state: NativeState;
  readonly phases: Phases;
  readonly images: ImageRegistry;
  readonly dials: { readonly pitch: DialTexture | null; readonly roll: DialTexture | null };
  /** G.layer: статичная часть рисуется один раз и кэшируется (на GPU — текстурой). */
  readonly layer: (key: string, w: number, h: number, draw: (c: Surface) => void) => Layer;
  readonly nowMs: number;
  readonly primaryCamera: CameraId;
  /** Кнопка на странице (только когда kit сам ведёт экран); иначе null. */
  readonly button: ((x: number, y: number, w: number, h: number, label: string, run: () => unknown, key: string, primary?: boolean) => number) | null;
  readonly selectCamera: (id: CameraId) => void;
}

const t = T;
const deg = t.units.deg;
const HEIGHT_RANGE_MM = 120;

const extremum = (e: Extremum | null, d: number, signed = false): Shown => (e === null ? NONE : { text: formatNumber(e.value, d, signed), quality: 'valid', ok: true });
/** Подпись источника только при наличии значения (presentSource); иначе null. */
const sourceLabel = (s: Signal<unknown>): string | null => {
  const src = presentSource(s);
  return src === null ? null : t.source[src];
};

/* ============================== Рельеф ============================== */

function dialPanel(env: PageEnv, kind: DialKind, x: number, y: number, w: number, h: number): void {
  const { cv, state } = env;
  const sig = kind === 'pitch' ? state.snapshot.signals['attitude.pitchDeg'] : state.snapshot.signals['attitude.rollDeg'];
  const value = usableNumber(sig);
  panel(cv, x, y, w, h);
  const cx = x + 14 + DIAL_R;
  const cy = y + h / 2;
  const faceR = FACE * DIAL_K;
  const tex = env.dials[kind];
  if (tex) {
    tex.update(vehicleRotation(kind, value), value === null ? 0.25 : 1, env.nowMs);
    cv.image(tex.id, cx - faceR, cy - faceR, faceR * 2, faceR * 2);
  } else {
    cv.circle(cx, cy, faceR, '#0a0f15');
  }
  const size = Math.ceil(BEZEL * DIAL_K * 2 + 4);
  cv.blit(env.layer(`xop-dial-${kind}`, size, size, (c) => drawDialStatic(c, kind, size)), cx - size / 2, cy - size / 2);
  drawDialLive(cv, kind, cx, cy, value);
  readout(cv, x + 220, y + 44, {
    label: kind === 'pitch' ? t.attitude.pitch : t.attitude.roll,
    shown: shownNumber(sig, 1, true),
    unit: deg,
    size: 'lg',
    hint: kind === 'pitch' ? t.attitude.pitchHint : t.attitude.rollHint,
  });
}

function steeringWheel(cv: Surface, cx: number, cy: number, value: number | null): void {
  const r = 30;
  const rot = ((value === null ? 0 : -value) * Math.PI) / 180;
  const ok = value !== null;
  const col = ok ? '#c9d3e1' : withA('#8a95a6', 0.4);
  cv.arc(cx, cy, r - 2.5, r + 2.5, 0, 360, col);
  cv.circle(cx, cy, 8, '#2a313c');
  cv.arc(cx, cy, 7, 9, 0, 360, col);
  const R = (x: number, y: number): [number, number] => [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
  for (const [a, b] of [[[-8, 1.5], [-29, 6]], [[8, 1.5], [29, 6]], [[0, 8], [0, 29]]] as const) {
    const p = R(a[0], a[1]);
    const q = R(b[0], b[1]);
    cv.line(p[0], p[1], q[0], q[1], 4, col);
  }
  if (ok) {
    const m = R(0, -r);
    cv.circle(m[0], m[1], 4, C.red);
  }
}

function levelNotches(cv: Surface, x: number, y: number, current: string | null): void {
  SUSPENSION_LEVELS.forEach((l, i) => cv.fillRect(x + i * 30, y, 26, 4, l === current ? C.ice : C.track));
}

export function terrainPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const L = TERRAIN;
  const dh = (Y1 - Y0 - GAP) / 2;
  dialPanel(env, 'pitch', L.dials.x, Y0, L.dials.w, dh);
  dialPanel(env, 'roll', L.dials.x, Y0 + dh + GAP, L.dials.w, dh);

  env.images.image('xray'); // загрузка растра до cv.image(IMAGE_ID.xray) в drawDrivetrain
  drawDrivetrain(cv, s, env.phases, { x: L.stage.x, y: L.stage.y, w: L.stage.w, h: XRAY_H_TERRAIN, full: true });

  // Правая колонка: высота, руль, уровень подвески.
  const sx = L.side.x;
  const ph = (L.stage.h - 2 * GAP) / 3;
  const altChange = altitudeChangeFromStart(state.session, asDomain(state.snapshot));
  panel(cv, sx, Y0, L.side.w, ph);
  readout(cv, sx + 16, Y0 + 12, {
    label: t.terrain.altitude,
    shown: shownNumber(s.altitudeM, 0),
    unit: t.units.m,
    size: 'lg',
    hint: altChange !== null ? `${formatNumber(altChange, 1, true)} ${t.units.m} ${t.terrain.altitudeChange}` : undefined,
    hintColor: C.ice,
  });
  const y2 = Y0 + ph + GAP;
  panel(cv, sx, y2, L.side.w, ph);
  steeringWheel(cv, sx + 52, y2 + ph / 2, usableNumber(s.steeringWheelAngleDeg));
  readout(cv, sx + 104, y2 + 12, { label: t.terrain.steering, shown: shownNumber(s.steeringWheelAngleDeg, 0, true), unit: deg, size: 'lg', hint: t.terrain.steeringHint });
  const y3 = y2 + ph + GAP;
  panel(cv, sx, y3, L.side.w, ph);
  readout(cv, sx + 16, y3 + 12, { label: t.terrain.suspensionLevel, shown: shownSignal(s['suspension.level'], (v) => t.suspensionLevel[v]), size: 'md' });
  levelNotches(cv, sx + 16, y3 + ph - 18, usableValue(s['suspension.level']));

  // Нижняя полоса: движение и сессия.
  const by = L.strip.y;
  const bh = L.strip.h;
  const bx = L.stage.x;
  const dw = 420;
  panel(cv, bx, by, dw, bh);
  readout(cv, bx + 16, by + 8, { label: t.terrain.speed, shown: shownNumber(s.vehicleSpeedKmh, 1), unit: t.units.km_h, size: 'md' });
  readout(cv, bx + 168, by + 8, { label: t.terrain.gear, shown: shownSignal(s.gear, gearText), size: 'md' });
  const hdcActive = usableValue(s['hdc.status']) === 'active';
  const setSpeed = shownNumber(s['hdc.setSpeedKmh'], 0);
  readout(cv, bx + 262, by + 8, {
    label: t.terrain.hdc,
    shown: shownSignal(s['hdc.status'], (v) => t.hdc[v]),
    size: 'sm',
    valueColor: hdcActive ? C.cold : undefined,
    hint: setSpeed.ok ? `${t.terrain.hdcSet} ${setSpeed.text} ${t.units.km_h}` : hdcActive || setSpeed.quality !== 'unavailable' ? `${t.terrain.hdcSet} — ${t.quality[setSpeed.quality]}` : undefined,
  });
  const sx2 = bx + dw + GAP;
  const sw = W - M - sx2;
  panel(cv, sx2, by, sw, bh);
  caps(cv, t.terrain.sessionTitle, sx2 + 16, by + 24, 12, C.dim);
  const ses = state.session;
  const alt = ses.minAltitude && ses.maxAltitude ? { text: `${formatNumber(ses.minAltitude.value, 0)} / ${formatNumber(ses.maxAltitude.value, 0)}`, quality: 'valid' as const, ok: true } : NONE;
  const slip = ses.maxSlipOverall;
  const items: [string, Shown, string | undefined][] = [
    [t.session.elapsed, { text: formatDuration(sessionElapsedMs(ses, state.snapshot.simTimeMs)), quality: 'valid', ok: true }, undefined],
    [t.session.maxAbsPitch, extremum(ses.maxAbsPitch, 1), deg],
    [t.session.maxAbsRoll, extremum(ses.maxAbsRoll, 1), deg],
    [t.session.altitudeRange, alt, t.units.m],
    [t.session.maxSlip, extremum(slip, 0), slip ? `${t.units.percent} ${t.wheels[slip.wheel].short}` : t.units.percent],
  ];
  // Ширины колонок по содержимому: «мин / макс» — самое длинное значение.
  const weights = [0.8, 0.95, 0.95, 1.55, 1.05];
  const unitW = (sw - 32) / weights.reduce((a, b) => a + b, 0);
  let cx = sx2 + 16;
  items.forEach(([label, shown, unit], i) => {
    readout(cv, cx, by + 32, { label, shown, unit, size: 'sm' });
    cx += weights[i] * unitW;
  });
}

/* ============================== Сцепление ============================== */

function wheelHead(cv: Surface, w: Wheel, x: number, y: number): void {
  const sw = text(cv, t.wheels[w].short, x, y, 26, C.text, { font: 'bold' });
  text(cv, `${t.wheels[w].code} · ${t.wheels[w].long}`, x + sw + 10, y - 2, 14, C.dim);
}

function wheelCard(env: PageEnv, w: Wheel, x: number, y: number, cw: number, ch: number): void {
  const { cv } = env;
  const s = env.state.snapshot.signals;
  const brake = shownSignal(s[`brakeIntervention.${w}`], (v) => (v ? t.brake.active : t.brake.inactive));
  const braking = usableValue(s[`brakeIntervention.${w}`]) === true;
  panel(cv, x, y, cw, ch, braking ? { topLine: C.warn } : {});
  wheelHead(cv, w, x + 16, y + 34);
  readout(cv, x + 16, y + 58, { label: t.traction.wheelSpeed, shown: shownNumber(s[`wheelSpeed.${w}`], 1), unit: t.units.km_h, size: 'md' });
  const slip = usableNumber(s[`wheelSlip.${w}`]);
  readout(cv, x + cw / 2 + 4, y + 58, { label: t.traction.slip, shown: shownNumber(s[`wheelSlip.${w}`], 0), unit: t.units.percent, size: 'md' });
  bar(cv, x + cw / 2 + 4, y + 120, cw / 2 - 20, slip, 0, 100, (slip ?? 0) >= 30 ? C.warn : C.ice);
  hline(cv, x + 16, y + ch - 50, cw - 32);
  text(cv, t.traction.brakeIntervention, x + 16, y + ch - 30, 14, C.dim);
  const by = y + ch - 10;
  if (brake.ok) {
    if (braking) cv.circle(x + 21, by - 5, 5, C.warn);
    else cv.arc(x + 21, by - 5, 3.5, 5, 0, 360, C.dim);
    text(cv, brake.text, x + 32, by, 15, braking ? C.warn : C.text);
  } else {
    text(cv, '—', x + 16, by, 15, C.dim);
    statusTag(cv, brake.quality, x + 34, by - 2, 13);
  }
}

export function tractionPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const h = Y1 - Y0;
  // Распределение момента.
  const x1 = M;
  const w1 = 340;
  panel(cv, x1, Y0, w1, h, { title: t.traction.split });
  readout(cv, x1 + 16, Y0 + 48, { label: t.traction.front, shown: shownNumber(s['xdrive.frontPercent'], 0), unit: t.units.percent, size: 'xl' });
  readout(cv, x1 + w1 - 16, Y0 + 48, { label: t.traction.rear, shown: shownNumber(s['xdrive.rearPercent'], 0), unit: t.units.percent, size: 'xl', align: 'right' });
  const fv = usableNumber(s['xdrive.frontPercent']);
  const barY = Y0 + 150;
  cv.fillRect(x1 + 16, barY, w1 - 32, 8, C.track);
  if (fv !== null) {
    const fw = ((w1 - 32) * Math.max(0, Math.min(100, fv))) / 100;
    cv.fillRect(x1 + 16, barY, fw - 2, 8, C.ice);
    cv.fillRect(x1 + 16 + fw + 1, barY, w1 - 32 - fw - 1, 8, C.mBlue);
  }
  readout(cv, x1 + 16, Y0 + 186, { label: t.traction.frontTorque, shown: shownNumber(s['xdrive.frontTorqueNm'], 0), unit: t.units.nm, size: 'lg' });
  readout(cv, x1 + 16, Y0 + 268, { label: t.traction.rearTorque, shown: shownNumber(s['xdrive.rearTorqueNm'], 0), unit: t.units.nm, size: 'lg' });
  const srcY = Y0 + h - 18;
  const sl = text(cv, t.traction.splitSource, x1 + 16, srcY, 14, C.dim);
  const rearSrc = sourceLabel(s['xdrive.rearPercent']);
  chip(cv, rearSrc ?? t.native.noSource, x1 + 26 + sl, srcY, rearSrc === null ? C.dim : state.mode === 'demo' ? C.warn : C.cold);
  // передняя доля, выведенная из задней, помечается отдельно, строкой выше (в демо обе — «Демо»)
  if (rearSrc !== null && presentSource(s['xdrive.frontPercent']) === 'estimated' && presentSource(s['xdrive.rearPercent']) !== 'estimated') {
    chip(cv, t.native.frontDerived, x1 + 16, srcY - 28, C.dim);
  }

  // Колёса вокруг компактной схемы привода.
  const cw = 320;
  const ch = (h - GAP) / 2;
  const xl = x1 + w1 + GAP;
  const cx = xl + cw + GAP;
  const cWidth = 224;
  const xr = cx + cWidth + GAP;
  wheelCard(env, 'FL', xl, Y0, cw, ch);
  wheelCard(env, 'RL', xl, Y0 + ch + GAP, cw, ch);
  wheelCard(env, 'FR', xr, Y0, cw, ch);
  wheelCard(env, 'RR', xr, Y0 + ch + GAP, cw, ch);
  const sh = Math.min(XRAY_H_TRACTION, Math.floor((cWidth * IMG_H) / IMG_W));
  env.images.image('xray');
  drawDrivetrain(cv, s, env.phases, { x: cx, y: Y0 + (h - sh) / 2, w: cWidth, h: sh, full: false });

  // Дифференциал и ключевые показатели.
  const x3 = xr + cw + GAP;
  const w3 = W - M - x3;
  const dh = 118;
  panel(cv, x3, Y0, w3, dh, { title: t.traction.diff });
  readout(cv, x3 + 16, Y0 + 42, { label: t.traction.diffState, shown: shownSignal(s['rearDiff.lockState'], (v) => t.diffLock[v]), size: 'md' });
  readout(cv, x3 + w3 - 16, Y0 + 42, { label: t.traction.diffPercent, shown: shownNumber(s['rearDiff.lockPercent'], 0), unit: t.units.percent, size: 'md', align: 'right' });
  const ky = Y0 + dh + GAP;
  panel(cv, x3, ky, w3, h - dh - GAP, { title: t.traction.keyMetrics });
  const half = (w3 - 32) / 2;
  readout(cv, x3 + 16, ky + 42, { label: t.terrain.steering, shown: shownNumber(s.steeringWheelAngleDeg, 0, true), unit: deg, size: 'md' });
  readout(cv, x3 + 16 + half, ky + 42, { label: t.terrain.speed, shown: shownNumber(s.vehicleSpeedKmh, 1), unit: t.units.km_h, size: 'md' });
  const ses = state.session;
  const nowMax = maxSlipNow(asDomain(state.snapshot));
  readout(cv, x3 + 16, ky + 112, {
    label: t.session.maxSlip,
    shown: extremum(ses.maxSlipOverall, 0),
    unit: ses.maxSlipOverall ? `${t.units.percent} ${t.wheels[ses.maxSlipOverall.wheel].short}` : t.units.percent,
    size: 'md',
    hint: nowMax ? `${formatNumber(nowMax.value, 0)} ${t.units.percent} ${t.wheels[nowMax.wheel].short} · ${t.traction.now}` : undefined,
  });
  readout(cv, x3 + 16 + half, ky + 112, { label: t.session.maxTorque, shown: extremum(ses.maxEngineTorque, 0), unit: t.units.nm, size: 'md' });
  const my = ky + 202;
  text(cv, t.session.maxSlipWheel, x3 + 16, my, 14, C.dim);
  WHEELS.forEach((w, i) => {
    const d = extremum(ses.maxSlip[w], 0);
    const px = x3 + 16 + (i % 2) * half;
    const py = my + 26 + Math.floor(i / 2) * 24;
    const lw = text(cv, t.wheels[w].short, px, py, 16, C.ice);
    text(cv, d.ok ? `${d.text} ${t.units.percent}` : d.text, px + lw + 8, py, 16, C.text);
  });
}

/* ============================== Подвеска ============================== */

function heightBar(cv: Surface, x: number, y: number, h: number, v: number | null): void {
  cv.fillRect(x, y, 14, h, C.track);
  const mid = y + h / 2;
  cv.fillRect(x - 4, mid, 22, 2, C.dim);
  if (v === null) return;
  const f = Math.max(-1, Math.min(1, v / HEIGHT_RANGE_MM));
  const len = (h / 2) * Math.abs(f);
  cv.fillRect(x + 1, f >= 0 ? mid - len : mid + 2, 12, len, f >= 0 ? C.ice : C.warn);
}

function cornerCard(env: PageEnv, w: Wheel, x: number, y: number, cw: number, ch: number): void {
  const { cv } = env;
  const s = env.state.snapshot.signals;
  panel(cv, x, y, cw, ch);
  wheelHead(cv, w, x + 16, y + 34);
  readout(cv, x + 16, y + ch / 2 - 30, { label: t.suspension.cornerLabel, shown: shownNumber(s[`suspensionHeight.${w}`], 0, true), unit: t.units.mm, size: 'lg' });
  heightBar(cv, x + cw - 40, y + 50, ch - 80, usableNumber(s[`suspensionHeight.${w}`]));
}

/** Схема сверху (topdown-schematic-v2.png): 887 × 1774, центры шин и пружин как в TopDownCar. */
const TOP_W = 887;
const TOP_H = 1774;
const WHEEL_POS: Record<Wheel, { x: number; y: number }> = { FL: { x: 150, y: 440 }, FR: { x: 738, y: 440 }, RL: { x: 150, y: 1426 }, RR: { x: 738, y: 1426 } };
const SPRING_POS: Record<Wheel, { x: number; y: number }> = { FL: { x: 283, y: 412 }, FR: { x: 604, y: 412 }, RL: { x: 283, y: 1420 }, RR: { x: 604, y: 1420 } };
const TYRE_W = 84;
const TYRE_H = 276;

function topdown(env: PageEnv, key: 'topdownLarge' | 'topdownSmall', cx: number, y: number, h: number, opts: { labels: boolean; springs: SignalMap | null; tyreKnown?: Record<Wheel, boolean> }): void {
  const { cv } = env;
  const sc = h / TOP_H;
  const w = TOP_W * sc;
  const x = cx - w / 2;
  const img = env.images.image(key);
  if (img) cv.image(img.id, x, y, w, h);
  else cv.strokeRoundRect(x, y, w, h, 20, 1, C.tick);
  const P = (p: { x: number; y: number }): [number, number] => [x + p.x * sc, y + p.y * sc];
  if (opts.tyreKnown) {
    for (const wh of WHEELS) {
      const [px, py] = P(WHEEL_POS[wh]);
      const tw = (TYRE_W + 12) * sc;
      const th = (TYRE_H + 12) * sc;
      if (opts.tyreKnown[wh]) cv.strokeRoundRect(px - tw / 2, py - th / 2, tw, th, 22 * sc, 1.2, withA(C.ice, 0.6));
      else for (let k = 0; k < th; k += 8) cv.fillRect(px - tw / 2, py - th / 2 + k, 1.2, 4, withA('#8a95a6', 0.6));
    }
  }
  if (opts.springs) {
    for (const wh of WHEELS) {
      const v = usableNumber(opts.springs[`suspensionHeight.${wh}`]);
      const [px, py] = P(SPRING_POS[wh]);
      if (v === null) {
        cv.arc(px, py, 4, 5.5, 0, 360, withA('#8a95a6', 0.6));
        continue;
      }
      const len = (Math.max(-HEIGHT_RANGE_MM, Math.min(HEIGHT_RANGE_MM, v)) / HEIGHT_RANGE_MM) * 26;
      const col = v >= 0 ? C.ice : C.warn;
      cv.line(px, py, px, py - len, 4, col);
      cv.circle(px, py, 4.5, col);
    }
  }
  if (opts.labels) {
    for (const wh of WHEELS) {
      const left = wh === 'FL' || wh === 'RL';
      const p = WHEEL_POS[wh];
      const [lx, ly] = P({ x: left ? p.x - TYRE_W / 2 - 16 : p.x + TYRE_W / 2 + 16, y: p.y });
      text(cv, t.wheels[wh].short, lx, ly - 2, 15, C.text, { align: left ? 'right' : 'left' });
      text(cv, t.wheels[wh].code, lx, ly + 12, 11, C.dim, { align: left ? 'right' : 'left' });
    }
  }
}

function frontMark(cv: Surface, cx: number, y: number): void {
  cv.fill([[cx, y], [cx + 6, y + 8], [cx - 6, y + 8]], C.ice);
  caps(cv, t.terrain.front, cx, y + 22, 11, C.ice, 'center');
}

export function suspensionPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const h = Y1 - Y0;
  const lw = 280;
  panel(cv, M, Y0, lw, h, { title: t.suspension.level });
  const current = usableValue(s['suspension.level']);
  readout(cv, M + 16, Y0 + 44, { label: t.suspension.level, shown: shownSignal(s['suspension.level'], (v) => t.suspensionLevel[v]), size: 'md' });
  text(cv, t.suspension.levelScale, M + 16, Y0 + 128, 14, C.dim);
  SUSPENSION_LEVELS.forEach((l, i) => {
    const ly = Y0 + 140 + i * 36;
    const on = l === current;
    if (on) cv.fillRect(M + 12, ly, lw - 32, 32, withA(C.ice, 0.08));
    cv.fillRect(M + 12, ly, 2, 32, on ? C.ice : C.track);
    cv.fillRect(M + 24, ly + 13, 7, 7, on ? C.ice : C.tick);
    text(cv, t.suspensionLevel[l], M + 40, ly + 22, 17, on ? C.text : C.dim);
  });

  const cw = 312;
  const ch = (h - GAP) / 2;
  const xl = M + lw + GAP;
  const cx0 = xl + cw + GAP;
  const cWidth = 360;
  const xr = cx0 + cWidth + GAP;
  cornerCard(env, 'FL', xl, Y0, cw, ch);
  cornerCard(env, 'RL', xl, Y0 + ch + GAP, cw, ch);
  cornerCard(env, 'FR', xr, Y0, cw, ch);
  cornerCard(env, 'RR', xr, Y0 + ch + GAP, cw, ch);
  const ccx = cx0 + cWidth / 2;
  frontMark(cv, ccx, Y0 + 2);
  topdown(env, 'topdownLarge', ccx, Y0 + 28, TOPDOWN_H_SUSPENSION, { labels: true, springs: s });
  text(cv, t.suspension.unitNote, ccx, Y1 - 4, 12, C.dim, { align: 'center' });

  const x3 = xr + cw + GAP;
  const w3 = W - M - x3;
  panel(cv, x3, Y0, w3, h, { title: t.suspension.deltas });
  const d = heightDeltas(cornerHeights(asDomain(state.snapshot)));
  const mm = (v: number | null): Shown => (v === null ? NONE : { text: formatNumber(v, 0, true), quality: 'valid', ok: true });
  const rows: [string, Shown][] = [
    [t.suspension.frontDelta, mm(d.frontDelta)],
    [t.suspension.rearDelta, mm(d.rearDelta)],
    [t.suspension.leftRight, mm(d.leftRight)],
    [t.suspension.frontRear, mm(d.frontRear)],
    [t.suspension.range, d.range === null ? NONE : { text: formatNumber(d.range, 0), quality: 'valid', ok: true }],
    [t.session.maxHeightRange, extremum(state.session.maxHeightRange, 0)],
  ];
  rows.forEach(([label, shown], i) => {
    const ry = Y0 + 40 + i * 62;
    readout(cv, x3 + 16, ry, { label, shown, unit: t.units.mm, size: 'sm' });
    if (i < rows.length - 1) hline(cv, x3 + 16, ry + 58, w3 - 32);
  });
}

/* ============================== Системы ============================== */

function tempRow(cv: Surface, x: number, y: number, w: number, label: string, sig: Signal<number>, max: Extremum | null): void {
  const v = usableNumber(sig);
  readout(cv, x, y, { label, shown: shownNumber(sig, 0), unit: t.units.celsius, size: 'md' });
  const m = extremum(max, 0);
  text(cv, `${t.systems.sessionMax} ${m.text}${m.ok ? ` ${t.units.celsius}` : ''}`, x + w, y + 46, 14, C.dim, { align: 'right' });
  bar(cv, x, y + 62, w, v, 40, 140, v !== null && v >= 115 ? C.warn : C.ice);
}

export function systemsPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const ses = state.session;
  const h = Y1 - Y0;
  // Силовой агрегат.
  const w1 = 380;
  panel(cv, M, Y0, w1, h, { title: t.systems.powertrain });
  readout(cv, M + 16, Y0 + 44, { label: t.systems.gear, shown: shownSignal(s.gear, gearText), size: 'xl' });
  readout(cv, M + 180, Y0 + 44, {
    label: t.systems.engineTorque,
    shown: shownNumber(s['engine.torqueNm'], 0),
    unit: t.units.nm,
    size: 'lg',
    hint: `${t.systems.sessionMax} ${extremum(ses.maxEngineTorque, 0).text}`,
  });
  readout(cv, M + 16, Y0 + 158, { label: t.systems.rpm, shown: shownNumber(s['engine.rpm'], 0), unit: t.units.rpm, size: 'md' });
  readout(cv, M + 16, Y0 + 238, { label: t.systems.pedal, shown: shownNumber(s.acceleratorPedalPercent, 0), unit: t.units.percent, size: 'md' });
  bar(cv, M + 16, Y0 + 300, w1 - 32, usableNumber(s.acceleratorPedalPercent), 0, 100);
  readout(cv, M + 16, Y0 + 318, { label: t.systems.throttle, shown: shownNumber(s['engine.throttlePercent'], 0), unit: t.units.percent, size: 'md' });
  bar(cv, M + 16, Y0 + 380, w1 - 32, usableNumber(s['engine.throttlePercent']), 0, 100, '#b9c4d4');

  // Ассистенты и температуры.
  const x2 = M + w1 + GAP;
  const w2 = 380;
  const ah = 150;
  panel(cv, x2, Y0, w2, ah, { title: t.systems.assists });
  text(cv, t.systems.assistsNote, x2 + w2 - 16, Y0 + 30, 12, C.dim, { align: 'right' });
  const hdcActive = usableValue(s['hdc.status']) === 'active';
  const onOff = (v: boolean) => (v ? t.onOff.on : t.onOff.off);
  readout(cv, x2 + 16, Y0 + 40, { label: t.systems.hdc, shown: shownSignal(s['hdc.status'], (v) => t.hdc[v]), size: 'sm', valueColor: hdcActive ? C.cold : undefined });
  readout(cv, x2 + w2 / 2, Y0 + 40, { label: t.systems.hdcSet, shown: shownNumber(s['hdc.setSpeedKmh'], 0), unit: t.units.km_h, size: 'sm' });
  readout(cv, x2 + 16, Y0 + 92, { label: t.systems.dsc, shown: shownSignal(s['dsc.status'], onOff), size: 'sm' });
  readout(cv, x2 + w2 / 2, Y0 + 92, { label: t.systems.dtc, shown: shownSignal(s['dtc.status'], onOff), size: 'sm' });
  const ty = Y0 + ah + GAP;
  panel(cv, x2, ty, w2, h - ah - GAP, { title: t.systems.temps });
  tempRow(cv, x2 + 16, ty + 38, w2 - 32, t.systems.gearbox, s['temperature.gearboxC'], ses.maxGearboxTemp);
  tempRow(cv, x2 + 16, ty + 112, w2 - 32, t.systems.coolant, s['temperature.coolantC'], ses.maxCoolantTemp);
  tempRow(cv, x2 + 16, ty + 186, w2 - 32, t.systems.oil, s['temperature.engineOilC'], ses.maxOilTemp);

  // Шины.
  const x3 = x2 + w2 + GAP;
  const w3 = 404;
  panel(cv, x3, Y0, w3, h, { title: t.systems.tyres });
  const known = {} as Record<Wheel, boolean>;
  for (const w of WHEELS) known[w] = usableNumber(s[`tyrePressure.${w}`]) !== null;
  const ccx = x3 + w3 / 2;
  const carY = Y0 + 44 + (h - 52 - TOPDOWN_H_SYSTEMS) / 2;
  frontMark(cv, ccx, carY - 26);
  topdown(env, 'topdownSmall', ccx, carY, TOPDOWN_H_SYSTEMS, { labels: false, springs: null, tyreKnown: known });
  const tyre = (w: Wheel, x: number, y: number, right: boolean) => {
    const al = right ? 'right' : 'left';
    const hx = x;
    const sw = text(cv, t.wheels[w].short, hx, y, 18, C.text, { align: al });
    if (!right) text(cv, t.wheels[w].code, hx + sw + 6, y, 12, C.dim);
    else text(cv, t.wheels[w].code, hx - sw - 6, y, 12, C.dim, { align: 'right' });
    readout(cv, x, y + 8, { label: t.systems.pressure, shown: shownNumber(s[`tyrePressure.${w}`], 2), unit: t.units.bar, size: 'sm', align: al });
    readout(cv, x, y + 66, { label: t.systems.tyreTemp, shown: shownNumber(s[`tyreTemperature.${w}`], 0), unit: t.units.celsius, size: 'sm', align: al });
  };
  tyre('FL', x3 + 16, Y0 + 70, false);
  tyre('FR', x3 + w3 - 16, Y0 + 70, true);
  tyre('RL', x3 + 16, Y0 + 290, false);
  tyre('RR', x3 + w3 - 16, Y0 + 290, true);

  // Динамика.
  const x4 = x3 + w3 + GAP;
  const w4 = W - M - x4;
  panel(cv, x4, Y0, w4, h, { title: t.systems.dynamics });
  const gcx = x4 + w4 / 2;
  const gcy = Y0 + 128;
  const gr = 72;
  const LIMIT = 0.5;
  cv.arc(gcx, gcy, gr - 0.6, gr + 0.6, 0, 360, withA('#bed7f0', 0.35));
  for (let a = 0; a < 360; a += 12) cv.arc(gcx, gcy, gr / 2 - 0.6, gr / 2 + 0.6, a, a + 6, withA('#bed7f0', 0.3));
  cv.line(gcx - gr - 8, gcy, gcx + gr + 8, gcy, 1, C.hair);
  cv.line(gcx, gcy - gr - 8, gcx, gcy + gr + 8, 1, C.hair);
  text(cv, `${formatNumber(LIMIT, 1, true)} ${t.units.g}`, gcx, gcy - gr - 6, 12, C.dim, { align: 'center' });
  const lg = usableNumber(s['acceleration.longG']);
  const la = usableNumber(s['acceleration.latG']);
  if (lg !== null && la !== null) {
    const k = gr / LIMIT;
    cv.circle(gcx + Math.max(-LIMIT, Math.min(LIMIT, la)) * k, gcy - Math.max(-LIMIT, Math.min(LIMIT, lg)) * k, 7, C.ice);
  }
  readout(cv, x4 + 16, Y0 + 222, { label: t.systems.longG, shown: shownNumber(s['acceleration.longG'], 2, true), unit: t.units.g, size: 'md' });
  readout(cv, x4 + 16, Y0 + 288, { label: t.systems.latG, shown: shownNumber(s['acceleration.latG'], 2, true), unit: t.units.g, size: 'md' });
  readout(cv, x4 + 16, Y0 + 354, { label: t.systems.yaw, shown: shownNumber(s.yawRateDegS, 1, true), unit: t.units.deg_s, size: 'md' });
}

/* ============================== Камеры ============================== */

const CAM_KEY: Record<CameraId, CameraKey> = { front: 'cameraFront', left: 'cameraLeft', right: 'cameraRight' };

/** Заглушка вместо кадра: никакой демо-картинки как «живой» камеры. */
function cameraPlaceholder(cv: Surface, x: number, y: number, w: number, h: number, label: string, color: string): void {
  cv.fillRect(x, y, w, h, '#07090d');
  cv.strokeRoundRect(x, y, w, h, 2, 1, withA('#8a95a6', 0.35));
  for (let k = 0; k < w + h; k += 22) {
    const x0 = x + Math.max(0, k - h);
    const y0 = y + Math.min(h, k);
    const x1 = x + Math.min(w, k);
    const y1 = y + Math.max(0, k - w);
    cv.line(x0, y0, x1, y1, 1, withA('#8a95a6', 0.08));
  }
  text(cv, label, x + w / 2, y + h / 2 + 6, 16, color, { align: 'center' });
}

function cameraFrame(env: PageEnv, view: CameraView, x: number, y: number, w: number, h: number, primary: boolean): void {
  const { cv, state } = env;
  if (state.mode !== 'demo') {
    cameraPlaceholder(cv, x, y, w, h, t.native.cameras.vehicleNoFeed, C.dim);
    return;
  }
  if (view.availability === 'simulatedLoss') {
    cameraPlaceholder(cv, x, y, w, h, t.cameras.simulatedLoss, C.warn);
    return;
  }
  const img = primary ? env.images.image(CAM_KEY[view.id]) : env.images.thumb(CAM_KEY[view.id]);
  if (!img) {
    cameraPlaceholder(cv, x, y, w, h, t.cameras.loadError, C.red);
    return;
  }
  cv.image(img.id, x, y, w, h);
}

function cameraHeader(cv: Surface, x: number, y: number, view: CameraView, demo: boolean): void {
  text(cv, t.cameras.names[view.id], x, y + 20, 17, C.text);
  if (demo) text(cv, view.availability === 'simulatedLoss' ? t.cameras.unavailable : t.cameras.demoLabel, x, y + 40, 13, C.warn);
  else text(cv, t.native.cameras.vehicleStatus, x, y + 40, 13, C.dim);
}

export function camerasPage(env: PageEnv): void {
  const { cv, state } = env;
  const demo = state.mode === 'demo';
  const layout = cameraLayout(env.primaryCamera, state.scenarioId);
  const h = Y1 - Y0;
  const pw = CAMERA_MAIN.w + 32;
  panel(cv, M, Y0, pw, h);
  cameraHeader(cv, M + 16, Y0 + 4, layout.primary, demo);
  const pl = width(cv, t.cameras.primary, 14) + 14;
  chip(cv, t.cameras.primary, M + pw - 16 - pl, Y0 + 30, C.ice);
  cameraFrame(env, layout.primary, M + 16, Y1 - 12 - CAMERA_MAIN.h, CAMERA_MAIN.w, CAMERA_MAIN.h, true);

  const x2 = M + pw + GAP;
  const w2 = W - M - x2;
  const sh = (h - GAP) / 2;
  layout.secondary.forEach((v, i) => {
    const y = Y0 + i * (sh + GAP);
    panel(cv, x2, y, w2, sh);
    const iy = y + (sh - CAMERA_THUMB.h) / 2;
    cameraFrame(env, v, x2 + 16, iy, CAMERA_THUMB.w, CAMERA_THUMB.h, false);
    const tx = x2 + 16 + CAMERA_THUMB.w + 20;
    cameraHeader(cv, tx, iy - 4, v, demo);
    // «Показать крупно» — только у демо-снимков: в режиме автомобиля изображения нет ни у одной камеры
    if (env.button && demo) env.button(tx, iy + 52, 210, 34, t.native.buttons.showLarge, () => env.selectCamera(v.id), `cam-${v.id}`);
    // Пояснение — в нижней части второй панели, по предложениям.
    if (i === layout.secondary.length - 1) {
      const note = demo ? t.native.cameras.demoNote : t.native.cameras.vehicleNote;
      const parts = note.split('. ');
      parts.forEach((p, k) => text(cv, k < parts.length - 1 ? `${p}.` : p, tx, iy + CAMERA_THUMB.h - (parts.length - 1 - k) * 17, 13, C.dim));
    }
  });
}

export type PageFn = (env: PageEnv) => void;
export const PAGES: readonly PageFn[] = [terrainPage, tractionPage, suspensionPage, systemsPage, camerasPage];

/** Используется тестами: все страницы и их число совпадают с вкладками. */
export const PAGE_COUNT = PAGES.length;
