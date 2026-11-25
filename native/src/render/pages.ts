// Пять экранов утверждённого интерфейса на логическом холсте 1600 × 520.
// Все обязательные показатели остаются на своих экранах; недоступное — «—» и статус, не 0.

import { cornerHeights, heightDeltas, maxSlipNow } from '../../../src/domain/derived';
import { altitudeChangeFromStart, type Extremum } from '../../../src/domain/session';
import { usableNumber, usableValue } from '../../../src/domain/signal';
import { SUSPENSION_LEVELS, WHEELS, type Signal, type SignalMap, type Wheel } from '../../../src/domain/types';
import { gearText } from '../../../src/components/displayHelpers';
import { cameraAvailability, type CameraId } from '../../../src/screens/cameraPresentation';
import type { ImageRegistry, CameraKey } from '../assets/registry';
import { DIAL_K } from '../assets/spec';
import { formatNumber, NONE, presentSource, shownNumber, shownSignal, type Shown } from '../format';
import { asDomain, type NativeState } from '../model/model';
import type { ExtraSignal } from '../vehicle/adapter';
import { sensorHeightDeltas, usableExtra, wheelDeltaMagnitude } from '../vehicle/derived';
import { EHC_LEVELS, FES_MODES, GHAS_STATES } from '../vehicle/uds/records';
import type { Layer, Surface } from '../platform/kitTypes';
import { T } from '../strings';
import { BEZEL, drawDialLive, drawDialStatic, FACE, vehicleRotation, type DialKind, type DialTexture } from './dial';
import { drawDrivetrain, IMG_H, IMG_W, type Phases } from './drivetrain';
import { DIAL_R, GAP, M, TERRAIN, TOPDOWN_H_SUSPENSION, TOPDOWN_H_SYSTEMS, W, XRAY_H_TERRAIN, XRAY_H_TRACTION, Y0, Y1 } from './layout';
import { C, withA } from './palette';
import { DIAG } from './diagnostics';
import { bar, caps, chip, hline, panel, readout, statusTag, text, width, wrapText } from './ui';

/**
 * Низ содержимого страницы: Y1 плюс место под страницей, которое даёт kit в полноэкранной раскладке (cv.extra). Чтение
 * cv.extra отмечает кадр как «доходящий донизу»: display.js тогда ставит ВСЕ вкладки одинаково (oyTop) — без сдвига
 * PLACE при переходе между «Камерами» и остальными (в 0.1.7 extra читали только «Камеры»).
 */
export const pageBottom = (cv: Surface): number => Y1 + (cv.extra ?? 0);

export interface PageEnv {
  readonly cv: Surface;
  readonly state: NativeState;
  readonly phases: Phases;
  readonly images: ImageRegistry;
  readonly dials: { readonly pitch: DialTexture | null; readonly roll: DialTexture | null };
  /** G.layer: статичная часть рисуется один раз и кэшируется (на GPU — текстурой). */
  readonly layer: (key: string, w: number, h: number, draw: (c: Surface) => void) => Layer;
  readonly nowMs: number;
  readonly selectedCamera?: CameraId;
  readonly cameraExpanded?: boolean;
  readonly selectCamera?: (id: CameraId) => unknown;
  readonly toggleCamera?: () => unknown;
  /** Кнопка на странице (только когда kit сам ведёт экран); иначе null. */
  readonly button: ((x: number, y: number, w: number, h: number, label: string, run: () => unknown, key: string, primary?: boolean) => number) | null;
  /** Новая сессия (кнопка «Сброс» в панели сессии «Рельефа»). */
  readonly newSession: () => void;
  /** Лист диагностики чтения — только доступ разработчика (XOP_DEV=diag); иначе null и кнопки нет. */
  readonly openDiagnostics: (() => unknown) | null;
  /**
   * Живой вид камеры в прямоугольнике (видео рендерера, op 19): true — нарисован (кадры идут прямо сейчас);
   * false — источника нет / кадры не свежие / рендерер без видео, тогда страница рисует «Недоступно».
   */
  readonly liveCamera: ((id: CameraId, x: number, y: number, w: number, h: number) => boolean) | null;
}

const t = T;
const deg = t.units.deg;
const HEIGHT_RANGE_MM = 120;

/** Величина вне домена (state.snapshot.extra) → показ: только свежая допустимая — числом. */
const shownExtra = (e: ExtraSignal, d: number, signed = false): Shown =>
  e.quality === 'valid' && e.value !== null && Number.isFinite(e.value) ? { text: formatNumber(e.value, d, signed), quality: 'valid', ok: true } : { text: '—', quality: e.quality === 'valid' ? 'invalid' : e.quality, ok: false };
/** Код состояния (UDS) → подпись по таблице; код вне таблицы — «—» как недопустимое. */
const shownCode = (e: ExtraSignal, table: Readonly<Record<number, string>>): Shown =>
  e.quality === 'valid' && e.value !== null && table[e.value] !== undefined ? { text: table[e.value], quality: 'valid', ok: true } : { text: '—', quality: e.quality === 'valid' ? 'invalid' : e.quality, ok: false };

/** Только документированные три уровня EHC; шесть сценарных уровней остаются в демо. */
export function suspensionReading(state: NativeState): Shown {
  return state.snapshot.scenarioId !== null
    ? shownSignal(state.snapshot.signals['suspension.level'], (v) => t.suspensionLevel[v])
    : shownCode(state.snapshot.extra.ehcLevel, EHC_LEVELS);
}
function suspensionChoices(state: NativeState): { label: string; on: boolean }[] {
  if (state.snapshot.scenarioId !== null) {
    const current = usableValue(state.snapshot.signals['suspension.level']);
    return SUSPENSION_LEVELS.map((l) => ({ label: t.suspensionLevel[l], on: l === current }));
  }
  const current = usableExtra(state.snapshot.extra.ehcLevel);
  return [16, 8, 2].map((n) => ({ label: EHC_LEVELS[n], on: n === current }));
}

const extremum = (e: Extremum | null, d: number, signed = false): Shown => (e === null ? NONE : { text: formatNumber(e.value, d, signed), quality: 'valid', ok: true });

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
  const rx = x + 220;
  const rw = x + w - 14 - rx;
  readout(cv, rx, y + 24, {
    maxW: rw,
    label: kind === 'pitch' ? t.attitude.pitch : t.attitude.roll,
    shown: shownNumber(sig, 1, true),
    unit: deg,
    size: 'lg',
    hint: kind === 'pitch' && state.mode === 'vehicle' && state.snapshot.extra.pitchVsAxlesDeg.quality !== 'unavailable' ? undefined : kind === 'pitch' ? t.attitude.pitchHint : t.attitude.rollHint,
    statusBelow: true,
  });
  // Автомобиль: тангаж кузова ОТНОСИТЕЛЬНО ОСЕЙ (корректор фар, датчики высоты) — другая величина, отдельной строкой
  if (kind === 'pitch' && state.mode === 'vehicle') {
    const e = state.snapshot.extra.pitchVsAxlesDeg;
    if (e.quality !== 'unavailable')
      readout(cv, rx, y + h - 66, { label: t.native.extra.pitchVsAxles, shown: shownExtra(e, 1, true), unit: deg, size: 'sm', maxW: rw });
  }
}

function levelNotches(cv: Surface, x: number, y: number, state: NativeState): void {
  suspensionChoices(state).forEach((l, i) => cv.fillRect(x + i * 30, y, 26, 4, l.on ? C.ice : C.track));
}

export function terrainPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const L = TERRAIN;
  const B = pageBottom(cv);
  const dh = (B - Y0 - GAP) / 2;
  dialPanel(env, 'pitch', L.dials.x, Y0, L.dials.w, dh);
  dialPanel(env, 'roll', L.dials.x, Y0 + dh + GAP, L.dials.w, dh);

  env.images.image('xray'); // загрузка растра до cv.image(IMAGE_ID.xray) в drawDrivetrain
  drawDrivetrain(cv, s, env.phases, { x: L.stage.x, y: L.stage.y, w: L.stage.w, h: XRAY_H_TERRAIN, full: true });

  // Правая колонка: высота и уровень подвески (руля и нижней полосы нет — по просьбе владельца).
  const sx = L.side.x;
  const ph = (B - Y0 - GAP) / 2;
  const altChange = altitudeChangeFromStart(state.session, asDomain(state.snapshot));
  panel(cv, sx, Y0, L.side.w, ph);
  readout(cv, sx + 16, Y0 + 14, {
    maxW: L.side.w - 32,
    label: t.terrain.altitude,
    shown: shownNumber(s.altitudeM, 0),
    unit: t.units.m,
    size: 'lg',
    hint: altChange !== null ? `${formatNumber(altChange, 1, true)} ${t.units.m} ${t.terrain.altitudeChange}` : undefined,
    hintColor: C.ice,
  });
  const y2 = Y0 + ph + GAP;
  panel(cv, sx, y2, L.side.w, ph);
  readout(cv, sx + 16, y2 + 14, { label: t.terrain.suspensionLevel, shown: suspensionReading(state), size: 'md', maxW: L.side.w - 32 });
  levelNotches(cv, sx + 16, y2 + ph - 18, state);
}

/* ============================== Сцепление ============================== */

function wheelHead(cv: Surface, w: Wheel, x: number, y: number, maxW: number): void {
  const sw = text(cv, t.wheels[w].short, x, y, 24, C.text, { font: 'bold', maxW: maxW / 3 });
  text(cv, `${t.wheels[w].code} · ${t.wheels[w].long}`, x + sw + 10, y - 2, 13, C.dim, { maxW: maxW - sw - 10, attach: true });
}

function wheelCard(env: PageEnv, w: Wheel, x: number, y: number, cw: number, ch: number): void {
  const { cv } = env;
  const s = env.state.snapshot.signals;
  const brake = shownSignal(s[`brakeIntervention.${w}`], (v) => (v ? t.brake.active : t.brake.inactive));
  const braking = usableValue(s[`brakeIntervention.${w}`]) === true;
  panel(cv, x, y, cw, ch, braking ? { topLine: C.warn } : {});
  const inner = cw - 32;
  wheelHead(cv, w, x + 16, y + 32, inner);
  const colW = (inner - 16) / 2;
  readout(cv, x + 16, y + 46, { label: t.traction.wheelSpeed, shown: shownNumber(s[`wheelSpeed.${w}`], 1), unit: t.units.km_h, size: 'md', statusBelow: true, maxW: colW });
  // Автомобиль: отклонение колеса от опорной скорости DSC (оценка; физического проскальзывания источник не даёт)
  const veh = env.state.mode === 'vehicle';
  const delta = env.state.snapshot.extra[`wheelDelta.${w}`];
  const slip = veh ? wheelDeltaMagnitude(env.state.snapshot, w) : usableNumber(s[`wheelSlip.${w}`]);
  const rx = x + 16 + colW + 16;
  readout(cv, rx, y + 46, {
    label: veh ? t.native.extra.wheelDelta : t.traction.slip,
    statusBelow: true,
    shown: veh ? shownExtra(delta, 0, true) : shownNumber(s[`wheelSlip.${w}`], 0),
    unit: t.units.percent,
    size: 'md',
    maxW: colW,
  });
  bar(cv, rx, y + 150, colW, slip, 0, 100, (slip ?? 0) >= 30 ? C.warn : C.ice);
  hline(cv, x + 16, y + ch - 58, inner);
  text(cv, t.traction.brakeIntervention, x + 16, y + ch - 36, 13, C.dim, { maxW: inner });
  const by = y + ch - 9;
  if (brake.ok) {
    if (braking) cv.circle(x + 21, by - 6, 5, C.warn);
    else cv.arc(x + 21, by - 6, 3.5, 5, 0, 360, C.dim);
    text(cv, brake.text, x + 32, by, 14, braking ? C.warn : C.text, { maxW: inner - 16 });
  } else {
    const dw = text(cv, '—', x + 16, by, 14, C.dim);
    statusTag(cv, brake.quality, x + 16 + dw + 10, by - 2, 13, inner - dw - 10);
  }
}

export function tractionPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const B = pageBottom(cv);
  const h = B - Y0;
  // Распределение момента.
  const x1 = M;
  const w1 = 340;
  const half1 = (w1 - 48) / 2;
  panel(cv, x1, Y0, w1, h, { title: t.traction.split });
  readout(cv, x1 + 16, Y0 + 48, { label: t.traction.front, shown: shownNumber(s['xdrive.frontPercent'], 0), unit: t.units.percent, size: 'xl', statusBelow: true, maxW: half1 });
  readout(cv, x1 + w1 - 16, Y0 + 48, { label: t.traction.rear, shown: shownNumber(s['xdrive.rearPercent'], 0), unit: t.units.percent, size: 'xl', align: 'right', statusBelow: true, maxW: half1 });
  const fv = usableNumber(s['xdrive.frontPercent']);
  const barY = Y0 + 192;
  cv.fillRect(x1 + 16, barY, w1 - 32, 8, C.track);
  if (fv !== null) {
    const fw = ((w1 - 32) * Math.max(0, Math.min(100, fv))) / 100;
    cv.fillRect(x1 + 16, barY, fw - 2, 8, C.ice);
    cv.fillRect(x1 + 16 + fw + 1, barY, w1 - 32 - fw - 1, 8, C.mBlue);
  }
  readout(cv, x1 + 16, Y0 + 216, { label: t.traction.frontTorque, shown: shownNumber(s['xdrive.frontTorqueNm'], 0), unit: t.units.nm, size: 'lg', maxW: w1 - 32 });
  readout(cv, x1 + 16, Y0 + 316, { label: t.traction.rearTorque, shown: shownNumber(s['xdrive.rearTorqueNm'], 0), unit: t.units.nm, size: 'lg', maxW: w1 - 32 });
  // Передняя доля, выведенная из задней (100 − задняя), — это другая величина, чем измеренная: помечается.
  // Источники полей — в журнале и листе диагностики, не на экране.
  if (presentSource(s['xdrive.rearPercent']) === 'measured' && presentSource(s['xdrive.frontPercent']) === 'estimated') {
    chip(cv, t.native.frontDerived, x1 + 16, B - 16, C.dim, w1 - 32);
  }

  // Колёса вокруг компактной схемы привода.
  const cw = 332;
  const ch = (h - GAP) / 2;
  const xl = x1 + w1 + GAP;
  const cx = xl + cw + GAP;
  const cWidth = 160;
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
  const inner = w3 - 32;
  const half = (inner - 32) / 2; // две колонки, промежуток 32
  const vehicle = state.mode === 'vehicle';
  const dh = vehicle ? 192 : 150;
  panel(cv, x3, Y0, w3, dh, { title: vehicle ? t.native.extra.lockTitle : t.traction.diff });
  if (state.mode === 'vehicle') {
    // GHAS: момент блокировки по чтению (статус, не доказанный факт) и заданный, Н·м; степени в % источник не даёт
    const ex = state.snapshot.extra;
    readout(cv, x3 + 16, Y0 + 42, { label: 'Блокировка', shown: shownExtra(ex['rearLock.torqueNm'], 1), unit: t.units.nm, size: 'sm', maxW: half });
    readout(cv, x3 + w3 - 16, Y0 + 42, { label: 'Задано', shown: shownExtra(ex['rearLock.targetNm'], 1), unit: t.units.nm, size: 'sm', align: 'right', maxW: half });
    // четыре отдельных показателя — ячейки «подпись над значением» в две колонки с явным промежутком (в 0.1.7 они
    // стояли парами в одной строке и читались слитно)
    const cell = (cx: number, cy: number, label: string, shown: Shown, unit: string, right: boolean) => {
      const al = right ? 'right' : 'left';
      text(cv, label, cx, cy, 12, C.dim, { align: al, maxW: half });
      text(cv, shown.ok ? `${shown.text}${unit ? ` ${unit}` : ''}` : shown.text, cx, cy + 21, 14, shown.ok ? C.text : C.dim, { align: al, maxW: half, ellipsis: false });
      if (!shown.ok) {
        const dw = width(cv, shown.text, 14);
        statusTag(cv, shown.quality, right ? cx - dw - 10 - Math.min(half - dw - 10, 110) : cx + dw + 10, cy + 20, 12, half - dw - 10);
      }
    };
    cell(x3 + 16, Y0 + 110, t.native.extra.lockBlock, shownCode(ex['rearLock.state'], GHAS_STATES), '', false);
    cell(x3 + w3 - 16, Y0 + 110, t.native.extra.lockOil, shownExtra(ex['rearLock.oilC'], 0), t.units.celsius, true);
    cell(x3 + 16, Y0 + 156, t.native.extra.lockPosition, shownExtra(ex['rearLock.positionInc'], 0), t.native.extra.lockIncrement, false);
    cell(x3 + w3 - 16, Y0 + 156, t.native.extra.lockSpeedDelta, shownExtra(ex['rearLock.deltaRpm'], 0), t.units.rpm, true);
  } else {
    readout(cv, x3 + 16, Y0 + 42, { label: t.traction.diffState, shown: shownSignal(s['rearDiff.lockState'], (v) => t.diffLock[v]), size: 'md', maxW: half });
    readout(cv, x3 + w3 - 16, Y0 + 42, { label: t.traction.diffPercent, shown: shownNumber(s['rearDiff.lockPercent'], 0), unit: t.units.percent, size: 'md', align: 'right', maxW: half });
  }
  const ky = Y0 + dh + GAP;
  const kh = B - ky;
  panel(cv, x3, ky, w3, kh, { title: t.traction.keyMetrics });
  const c2 = x3 + 16 + half + 32;
  readout(cv, x3 + 16, ky + 40, { label: t.terrain.speed, shown: shownNumber(s.vehicleSpeedKmh, 1), unit: t.units.km_h, size: 'sm', maxW: half });
  readout(cv, c2, ky + 40, { label: t.session.maxTorque, shown: extremum(state.session.maxEngineTorque, 0), unit: t.units.nm, size: 'sm', maxW: half });
  const ses = state.session;
  const nowMax = state.mode === 'vehicle' ? null : maxSlipNow(asDomain(state.snapshot));
  readout(cv, x3 + 16, ky + 104, {
    label: state.mode === 'vehicle' ? t.native.extra.maxWheelDelta : t.session.maxSlip,
    shown: extremum(ses.maxSlipOverall, 0),
    unit: ses.maxSlipOverall ? `${t.units.percent} ${t.wheels[ses.maxSlipOverall.wheel].short}` : t.units.percent,
    size: 'sm',
    maxW: half,
  });
  // Давление тормозной системы по контурам (DSC), не вмешательство по колёсам
  const ex = state.snapshot.extra;
  // IB_G05: ГТЦ и система; DSC_G30N: контуры 1/2 — что ответил опознанный вариант
  const ib = ex['brakePressure.tmc'].quality !== 'unavailable' || ex['brakePressure.system'].quality !== 'unavailable';
  const p1 = shownExtra(ex[ib ? 'brakePressure.tmc' : 'brakePressure.circuit1'], 1);
  const p2 = shownExtra(ex[ib ? 'brakePressure.system' : 'brakePressure.circuit2'], 1);
  readout(cv, c2, ky + 104, { label: ib ? t.native.extra.brakeTmc : t.native.extra.brakeCircuit1, shown: p1, unit: t.units.bar, size: 'sm', maxW: half });
  readout(cv, c2, ky + 168, { label: ib ? t.native.extra.brakeSystem : t.native.extra.brakeCircuit2, shown: p2, unit: t.units.bar, size: 'sm', maxW: half });
  const my = ky + 176;
  const peakLabel = state.mode === 'vehicle' ? t.native.extra.maxWheelDeltaPerWheel : t.session.maxSlipWheel;
  wrapText(cv, peakLabel, 13, half, {}, 2).forEach((line, i) => text(cv, line, x3 + 16, my + i * 19, 13, C.dim, { maxW: half }));
  if (nowMax) text(cv, `${t.traction.now} ${formatNumber(nowMax.value, 0)} ${t.units.percent} ${t.wheels[nowMax.wheel].short}`, c2, ky + 236, 13, C.dim, { maxW: half });
  WHEELS.forEach((w, i) => {
    const d = extremum(ses.maxSlip[w], 0);
    const cellW = (half - 28) / 2; // две ячейки «колесо значение» в левой колонке, промежуток 28
    const px = x3 + 16 + (i % 2) * (cellW + 28);
    const py = my + 44 + Math.floor(i / 2) * 24;
    const lw = text(cv, t.wheels[w].short, px, py, 14, C.ice, { maxW: cellW / 2 });
    text(cv, d.ok ? `${d.text} ${t.units.percent}` : d.text, px + lw + 6, py, 14, C.text, { maxW: cellW - lw - 6, ellipsis: false, attach: true });
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
  const inner = cw - 32 - 44; // справа — полоса высоты
  wheelHead(cv, w, x + 16, y + 32, cw - 32);
  const relative = { label: t.suspension.cornerLabel, shown: shownNumber(s[`suspensionHeight.${w}`], 0, true) };
  const sensor = { label: t.native.extra.rideHeightSensor, shown: shownExtra(env.state.snapshot.extra[`rideHeightSensor.${w}`], 0, true) };
  // В машине реально читается DC05. Делаем его главным показанием, сохраняя его физический смысл.
  const [primary, secondary] = env.state.mode === 'vehicle' ? [sensor, relative] : [relative, sensor];
  readout(cv, x + 16, y + 50, { ...primary, unit: t.units.mm, size: 'lg', statusBelow: true, maxW: inner });
  const height = env.state.mode === 'vehicle' ? usableExtra(env.state.snapshot.extra[`rideHeightSensor.${w}`]) : usableNumber(s[`suspensionHeight.${w}`]);
  heightBar(cv, x + cw - 40, y + 50, ch - 80, height);
  // Выход датчика высоты VDP в мм — абсолютная величина датчика, не отклонение от нормального уровня
  readout(cv, x + 16, y + ch - 60, { ...secondary, unit: t.units.mm, size: 'sm', maxW: inner });
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
      text(cv, t.wheels[wh].short, lx, ly - 2, 14, C.text, { align: left ? 'right' : 'left', maxW: 48 });
      text(cv, t.wheels[wh].code, lx, ly + 18, 11, C.dim, { align: left ? 'right' : 'left', maxW: 48 });
    }
  }
}

function frontMark(cv: Surface, cx: number, y: number): void {
  cv.fill([[cx, y], [cx + 6, y + 8], [cx - 6, y + 8]], C.ice);
  caps(cv, t.terrain.front, cx, y + 22, 11, C.ice, 'center', 120);
}

export function suspensionPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const B = pageBottom(cv);
  const h = B - Y0;
  const lw = 280;
  panel(cv, M, Y0, lw, h, { title: t.terrain.suspensionLevel });
  readout(cv, M + 16, Y0 + 44, { label: t.suspension.level, shown: suspensionReading(state), size: 'md', statusBelow: true, maxW: lw - 32 });
  suspensionChoices(state).forEach((l, i) => {
    const ly = Y0 + 160 + i * 38;
    const on = l.on;
    if (on) cv.fillRect(M + 12, ly, lw - 24, 34, withA(C.ice, 0.08));
    cv.fillRect(M + 12, ly, 2, 34, on ? C.ice : C.track);
    cv.fillRect(M + 24, ly + 14, 7, 7, on ? C.ice : C.tick);
    text(cv, l.label, M + 40, ly + 24, 15, on ? C.text : C.dim, { maxW: lw - 56 });
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

  const x3 = xr + cw + GAP;
  const w3 = W - M - x3;
  const vehicle = state.mode === 'vehicle';
  panel(cv, x3, Y0, w3, h, { title: vehicle ? t.native.extra.sensorHeightDeltas : t.suspension.deltas });
  const d = vehicle ? sensorHeightDeltas(state.snapshot) : heightDeltas(cornerHeights(asDomain(state.snapshot)));
  const mm = (v: number | null): Shown => (v === null ? NONE : { text: formatNumber(v, 0, true), quality: 'valid', ok: true });
  const rows: [string, Shown][] = [
    [t.suspension.frontDelta, mm(d.frontDelta)],
    [t.suspension.rearDelta, mm(d.rearDelta)],
    [t.suspension.leftRight, mm(d.leftRight)],
    [t.suspension.frontRear, mm(d.frontRear)],
    [t.suspension.range, d.range === null ? NONE : { text: formatNumber(d.range, 0), quality: 'valid', ok: true }],
    [t.session.maxHeightRange, extremum(state.session.maxHeightRange, 0)],
  ];
  const step = Math.min(72, (B - Y0 - 44) / rows.length);
  rows.forEach(([label, shown], i) => {
    const ry = Y0 + 42 + i * step;
    readout(cv, x3 + 16, ry, { label, shown, unit: t.units.mm, size: 'sm', maxW: w3 - 32 });
    if (i < rows.length - 1) hline(cv, x3 + 16, ry + step - 4, w3 - 32);
  });
}

/* ============================== Системы ============================== */

function tempRow(cv: Surface, x: number, y: number, w: number, label: string, sig: Signal<number>, max: Extremum | null): void {
  const v = usableNumber(sig);
  const lw = Math.min(width(cv, label, 14), w * 0.45);
  text(cv, label, x, y + 22, 14, C.dim, { maxW: w * 0.45 });
  readout(cv, x + w, y - 18, { label: '', shown: shownNumber(sig, 0), unit: t.units.celsius, size: 'md', align: 'right', maxW: w - lw - 16 });
  const m = extremum(max, 0);
  text(cv, `${t.systems.sessionMax} ${m.text}${m.ok ? ` ${t.units.celsius}` : ''}`, x + w, y + 62, 13, C.dim, { align: 'right', maxW: w - lw - 16 });
  bar(cv, x, y + 68, w, v, 40, 140, v !== null && v >= 115 ? C.warn : C.ice);
}

export function systemsPage(env: PageEnv): void {
  const { cv, state } = env;
  const s = state.snapshot.signals;
  const ses = state.session;
  const B = pageBottom(cv);
  const h = B - Y0;
  // Силовой агрегат.
  const w1 = 500;
  panel(cv, M, Y0, w1, h, { title: t.systems.powertrain });
  readout(cv, M + 16, Y0 + 42, { label: t.systems.gear, shown: shownSignal(s.gear, gearText), size: 'xl', statusBelow: true, maxW: 180 });
  readout(cv, M + 220, Y0 + 42, {
    label: t.systems.engineTorque,
    shown: shownNumber(s['engine.torqueNm'], 0),
    unit: t.units.nm,
    size: 'lg',
    hint: `${t.systems.sessionMax} ${extremum(ses.maxEngineTorque, 0).text}`,
    maxW: w1 - 220 - 16,
  });
  readout(cv, M + 16, Y0 + 168, { label: t.systems.rpm, shown: shownNumber(s['engine.rpm'], 0), unit: t.units.rpm, size: 'md', maxW: w1 - 32 });
  const gy = (B - Y0 - 168 - 64) / 2; // две пары «значение + полоса» до низа панели
  const py = Y0 + 168 + 64 + Math.max(0, gy - 90) / 2;
  readout(cv, M + 16, py, { label: t.systems.pedal, shown: shownNumber(s.acceleratorPedalPercent, 0), unit: t.units.percent, size: 'md', maxW: w1 - 32 });
  bar(cv, M + 16, py + 70, w1 - 32, usableNumber(s.acceleratorPedalPercent), 0, 100);
  const ty0 = py + 90;
  readout(cv, M + 16, ty0, { label: t.systems.throttle, shown: shownNumber(s['engine.throttlePercent'], 0), unit: t.units.percent, size: 'md', maxW: w1 - 32 });
  bar(cv, M + 16, ty0 + 70, w1 - 32, usableNumber(s['engine.throttlePercent']), 0, 100, '#b9c4d4');

  // Ассистенты и температуры.
  const x2 = M + w1 + GAP;
  const w2 = 500;
  const ah = 178;
  const aw = (w2 - 64) / 2; // две колонки с промежутком 32
  const ax2 = x2 + 16 + aw + 32;
  panel(cv, x2, Y0, w2, ah, { title: t.systems.assists });
  const hdcActive = usableValue(s['hdc.status']) === 'active';
  const onOff = (v: boolean) => (v ? t.onOff.on : t.onOff.off);
  if (state.mode === 'vehicle') {
    // UDS DSC/IB и BDC: доступность HDC (не «работает»), состояние стабилизации, DTC из FDR+ASC, режим движения
    const ex = state.snapshot.extra;
    const xt = t.native.extra;
    const fdr = usableExtra(ex['dsc.fdr']);
    const asc = usableExtra(ex['dsc.asc']);
    const dtc: Shown =
      fdr === 3 && (asc === 3 || asc === 4)
        ? { text: xt.dtc.on, quality: 'valid', ok: true }
        : fdr === 1 && asc !== null && asc <= 2
          ? { text: xt.dtc.off, quality: 'valid', ok: true }
          : { text: '—', quality: fdr === null ? shownExtra(ex['dsc.fdr'], 0).quality : 'invalid', ok: false };
    readout(cv, x2 + 16, Y0 + 40, { label: xt.hdcAvailable, shown: shownCode(ex['hdc.available'], xt.hdc), size: 'sm', maxW: aw });
    readout(cv, ax2, Y0 + 40, { label: xt.driveMode, shown: shownCode(ex.driveMode, FES_MODES), size: 'sm', maxW: aw });
    readout(cv, x2 + 16, Y0 + 108, { label: xt.dscFdr, shown: shownCode(ex['dsc.fdr'], xt.fdr), size: 'sm', maxW: aw });
    readout(cv, ax2, Y0 + 108, { label: xt.dtcDerived, shown: dtc, size: 'sm', maxW: aw });
  } else {
    readout(cv, x2 + 16, Y0 + 40, { label: t.systems.hdc, shown: shownSignal(s['hdc.status'], (v) => t.hdc[v]), size: 'sm', valueColor: hdcActive ? C.cold : undefined, maxW: aw });
    readout(cv, ax2, Y0 + 40, { label: t.systems.hdcSet, shown: shownNumber(s['hdc.setSpeedKmh'], 0), unit: t.units.km_h, size: 'sm', maxW: aw });
    readout(cv, x2 + 16, Y0 + 108, { label: t.systems.dsc, shown: shownSignal(s['dsc.status'], onOff), size: 'sm', maxW: aw });
    readout(cv, ax2, Y0 + 108, { label: t.systems.dtc, shown: shownSignal(s['dtc.status'], onOff), size: 'sm', maxW: aw });
  }
  const ty = Y0 + ah + GAP;
  panel(cv, x2, ty, w2, B - ty, { title: t.systems.temps });
  const rowH = Math.max(80, (B - ty - 44) / 3);
  tempRow(cv, x2 + 16, ty + 40, w2 - 32, t.systems.gearbox, s['temperature.gearboxC'], ses.maxGearboxTemp);
  tempRow(cv, x2 + 16, ty + 40 + rowH, w2 - 32, t.systems.coolant, s['temperature.coolantC'], ses.maxCoolantTemp);
  tempRow(cv, x2 + 16, ty + 40 + 2 * rowH, w2 - 32, t.systems.oil, s['temperature.engineOilC'], ses.maxOilTemp);

  // Шины.
  const x3 = x2 + w2 + GAP;
  const w3 = W - M - x3;
  panel(cv, x3, Y0, w3, h, { title: t.systems.tyres });
  const known = {} as Record<Wheel, boolean>;
  for (const w of WHEELS) known[w] = usableNumber(s[`tyrePressure.${w}`]) !== null;
  const ccx = x3 + w3 / 2;
  const carY = Y0 + 44 + (h - 52 - TOPDOWN_H_SYSTEMS) / 2;
  frontMark(cv, ccx, carY - 26);
  topdown(env, 'topdownSmall', ccx, carY, TOPDOWN_H_SYSTEMS, { labels: false, springs: null, tyreKnown: known });
  // по сторонам от схемы: ширина схемы (887/1774 × высота) и отметки шин
  const carHalf = (TOP_W / TOP_H) * TOPDOWN_H_SYSTEMS / 2 + 14;
  const tw = w3 / 2 - carHalf - 16 - 8;
  const tyre = (w: Wheel, x: number, y: number, right: boolean) => {
    const al = right ? 'right' : 'left';
    const sw = text(cv, t.wheels[w].short, x, y, 16, C.text, { align: al, maxW: tw / 2 });
    if (!right) text(cv, t.wheels[w].code, x + sw + 8, y, 11, C.dim, { maxW: tw - sw - 8, attach: true });
    else text(cv, t.wheels[w].code, x - sw - 8, y, 11, C.dim, { align: 'right', maxW: tw - sw - 8, attach: true });
    readout(cv, x, y + 8, { label: t.systems.pressure, shown: shownNumber(s[`tyrePressure.${w}`], 1), unit: t.units.bar, size: 'sm', align: al, maxW: tw });
    readout(cv, x, y + 92, { label: t.systems.tyreTemp, shown: shownNumber(s[`tyreTemperature.${w}`], 0), unit: t.units.celsius, size: 'sm', align: al, maxW: tw });
  };
  const ry = Math.max(Y0 + 268, B - 172);
  tyre('FL', x3 + 16, Y0 + 66, false);
  tyre('FR', x3 + w3 - 16, Y0 + 66, true);
  tyre('RL', x3 + 16, ry, false);
  tyre('RR', x3 + w3 - 16, ry, true);

  // Только доступ разработчика: лист снимка чтения (в обычном запуске кнопки нет).
  if (env.button && env.openDiagnostics) env.button(M + 252, Y0 + 176, w1 - 268, 40, DIAG.open, env.openDiagnostics, 'dev-diagnostics');
}

/* ============================== Камеры ============================== */

const CAM_KEY: Record<CameraId, CameraKey> = { front: 'cameraFront', left: 'cameraLeft', right: 'cameraRight' };
/** Порядок как на машине: левая — передняя (крупно) — правая. */
const CAM_ROW: readonly CameraId[] = ['left', 'front', 'right'];

/** Заглушка вместо кадра: одна короткая подпись; никакой демо-картинки как «живой» камеры. */
function cameraPlaceholder(cv: Surface, x: number, y: number, w: number, h: number, label: string, color: string): void {
  cv.fillRect(x, y, w, h, '#07090d');
  cv.strokeRoundRect(x, y, w, h, 2, 1, withA('#8a95a6', 0.35));
  text(cv, label, x + w / 2, y + h / 2 + 6, 15, color, { align: 'center', maxW: w - 16 });
}

/**
 * Кадр одной камеры. Данные автомобиля: живого изображения в приложении нет — заглушка «Видео не подключено»
 * (без демо-снимков). Демо разработчика: локальный снимок с пометкой ДЕМО или смоделированная потеря.
 */
function cameraFrame(env: PageEnv, id: CameraId, x: number, y: number, w: number, h: number, large: boolean): void {
  const { cv, state } = env;
  if (state.mode !== 'demo') {
    // тёмная подложка под видео (op 19 рисует кадр с сохранением пропорций по центру прямоугольника)
    if (env.liveCamera) {
      cv.fillRect(x, y, w, h, '#000000');
      if (env.liveCamera(id, x, y, w, h)) return;
    }
    cameraPlaceholder(cv, x, y, w, h, t.native.cameras.noFeed, C.dim);
    return;
  }
  if (cameraAvailability(state.scenarioId, id) === 'simulatedLoss') {
    cameraPlaceholder(cv, x, y, w, h, t.cameras.unavailable, C.warn);
    return;
  }
  const img = large ? env.images.image(CAM_KEY[id]) : env.images.thumb(CAM_KEY[id]);
  if (!img) {
    cameraPlaceholder(cv, x, y, w, h, t.cameras.loadError, C.red);
    return;
  }
  const scale = Math.min(w / img.w, h / img.h);
  const iw = img.w * scale, ih = img.h * scale;
  cv.fillRect(x, y, w, h, '#000000');
  cv.image(img.id, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

export function camerasPage(env: PageEnv): void {
  const { cv, state } = env;
  const selected = env.selectedCamera ?? 'front';
  const expanded = !!env.cameraExpanded;
  const demo = state.mode === 'demo';
  const fullW = W - 2 * M;
  const top = expanded ? 38 : Y0;
  const h = pageBottom(cv) - top;
  const draw = (id: CameraId, x: number, y: number, w: number, ph: number, primary: boolean) => {
    const pad = 8, labelH = primary ? 34 : 30;
    cv.fillRect(x, y, w, ph, C.panel);
    const nw = text(cv, t.native.cameras.names[id], x + pad, y + 24, primary ? 17 : 15, C.text, { maxW: (w - 3 * pad) * 0.45 });
    const restW = w - 3 * pad - nw;
    if (demo) text(cv, t.native.cameras.demo, x + w - pad, y + 24, 13, C.warn, { align: 'right', maxW: restW });
    else if (primary) text(cv, expanded ? t.native.cameras.collapse : t.native.cameras.expand, x + w - pad, y + 24, 13, C.dim, { align: 'right', maxW: restW });
    cameraFrame(env, id, x + pad, y + labelH, w - pad * 2, ph - labelH - pad, primary);
    if (cv.own) {
      cv.target(x, y, w, ph, () => primary ? env.toggleCamera?.() : env.selectCamera?.(id), `camera:${id}`, 3);
    }
  };
  if (expanded) {
    draw(selected, M, top, fullW, h, true);
    return;
  }
  const mainW = Math.floor((fullW - GAP) * 0.64);
  draw(selected, M, top, mainW, h, true);
  const sideX = M + mainW + GAP;
  const sideW = fullW - mainW - GAP;
  const sideH = (h - GAP) / 2;
  CAM_ROW.filter((id) => id !== selected).forEach((id, i) => draw(id, sideX, top + i * (sideH + GAP), sideW, sideH, false));
}

export type PageFn = (env: PageEnv) => void;
export const PAGES: readonly PageFn[] = [terrainPage, tractionPage, suspensionPage, systemsPage, camerasPage];

/** Используется тестами: все страницы и их число совпадают с вкладками. */
export const PAGE_COUNT = PAGES.length;
