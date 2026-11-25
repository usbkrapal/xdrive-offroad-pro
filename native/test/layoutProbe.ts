// Проверка вёрстки на настоящем рантайме kit (record.js Recorder + кириллический атлас, как в пакете --language ru):
// каждая страница при крайних значениях и каждом состоянии качества; прямоугольник каждого текста — объединение его
// глифов из записи (op 11), а не оценка ширины. Используется тестом layoutFit.test.ts и скриптом снимков preview-0.1.8.

import { startApp, type AppHandle } from '../src/app';
import { PRODUCTION, type DevAccess } from '../src/devAccess';
import { buildSignal } from '../../src/domain/signal';
import type { SignalId, SignalMap } from '../../src/domain/types';
import type { Kit } from '../src/platform/kit';
import type { AssetsModule } from '../src/assets/spec';
import type { Surface } from '../src/platform/kitTypes';
import type { NativeState } from '../src/model/model';
import type { ExtraSignal } from '../src/vehicle/adapter';
import { EHC_LEVELS, FES_MODES, GHAS_STATES } from '../src/vehicle/uds/records';
import { setLayoutProbe, type LayoutProbe, type ProbeText } from '../src/render/ui';
import { walkOps } from './fakeRenderer';
import { fakeCtx, FakeTransport, stageVendorKit, syntheticAssets } from './helpers';

export type Variant = 'valid' | 'unavailable' | 'stale' | 'invalid';
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface DrawnText extends ProbeText { box: Box | null }
export interface FrameProbe {
  page: number;
  words: Uint32Array;
  panels: LayoutProbe['panels'];
  texts: DrawnText[];
  extra: number;
  recorder: Surface & { words(): Uint32Array };
}

type RecorderCtor = new (w: number, h: number, o?: unknown) => Surface & { words(): Uint32Array; reset(): unknown; extra: number; own: boolean };

const f32 = (w: number) => new Float32Array(new Uint32Array([w]).buffer)[0];

/** Объединение глифов (op 11) в словах [n0, n1). */
export function glyphBox(words: Uint32Array, n0: number, n1: number): Box | null {
  const u = words.subarray(n0, n1);
  let b: Box | null = null;
  for (const o of walkOps(u)) {
    if (o.op !== 11) continue;
    const n = u[o.at + 3];
    for (let k = 0; k < n; k++) {
      const q = o.at + 4 + k * 8;
      const x = f32(u[q]), y = f32(u[q + 1]), w = f32(u[q + 2]), h = f32(u[q + 3]);
      if (!(w > 0 && h > 0)) continue;
      b = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x + w), y1: Math.max(b.y1, y + h) } : { x0: x, y0: y, x1: x + w, y1: y + h };
    }
  }
  return b;
}

const longest = (t: Readonly<Record<number, string>>) => Number(Object.keys(t).sort((a, b) => t[Number(b)].length - t[Number(a)].length)[0]);

/** Крайние значения: отрицательные, многозначные, длинные подписи кодов. */
const TRAP: Partial<Record<SignalId, unknown>> = {
  'attitude.pitchDeg': -38.7, 'attitude.rollDeg': -27.4, altitudeM: -12345, steeringWheelAngleDeg: -540, vehicleSpeedKmh: 188.8,
  gear: { selector: 'M', gear: 8 }, 'engine.torqueNm': -1234, 'engine.rpm': 12345, 'engine.throttlePercent': 100, acceleratorPedalPercent: 100,
  'xdrive.frontPercent': 100, 'xdrive.rearPercent': 100, 'xdrive.frontTorqueNm': -12345, 'xdrive.rearTorqueNm': -12345,
  'rearDiff.lockState': 'partial', 'rearDiff.lockPercent': 100, 'suspension.level': 'loading',
  'temperature.gearboxC': -40, 'temperature.coolantC': 128, 'temperature.engineOilC': 145, 'hdc.status': 'standby', 'hdc.setSpeedKmh': 35,
  'dsc.status': false, 'dtc.status': true, 'acceleration.longG': -1.25, 'acceleration.latG': -1.25, yawRateDegS: -123.4,
};
const WHEEL_TRAP: Record<string, unknown> = { wheelSpeed: 188.8, wheelSlip: 100, brakeIntervention: true, suspensionHeight: -120, tyrePressure: 3.95, tyreTemperature: -40 };

export function patchState(base: NativeState, variant: Variant, now: number): NativeState {
  const at = variant === 'stale' ? now - 600_000 : now;
  const signals = { ...base.snapshot.signals } as Record<string, unknown>;
  for (const k of Object.keys(signals) as SignalId[]) {
    const [p] = k.split('.');
    let raw: unknown = k.includes('.') && WHEEL_TRAP[p] !== undefined ? WHEEL_TRAP[p] : TRAP[k];
    if (raw === undefined) raw = typeof (base.snapshot.signals[k] as { value: unknown }).value === 'number' ? 1 : undefined;
    if (variant === 'unavailable') raw = undefined;
    if (variant === 'invalid') raw = Number.NaN;
    signals[k] = buildSignal(k, raw as never, at, now, 'measured');
  }
  const extra = { ...base.snapshot.extra } as Record<string, ExtraSignal>;
  const codes: Record<string, number> = { ehcLevel: longest(EHC_LEVELS), driveMode: longest(FES_MODES), 'rearLock.state': longest(GHAS_STATES), 'dsc.fdr': 3, 'dsc.asc': 3, 'hdc.available': 0 };
  for (const k of Object.keys(extra)) {
    const q: ExtraSignal['quality'] = variant === 'valid' ? 'valid' : variant;
    const v = codes[k] ?? (k.startsWith('rideHeightSensor') ? -123 : k.startsWith('wheelDelta') ? -100 : -12345.6);
    extra[k] = { value: q === 'unavailable' ? null : v, quality: q, updatedAt: q === 'unavailable' ? null : at };
  }
  const ext = (v: number) => (variant === 'valid' ? { value: v, atMs: now } : null);
  const session = {
    ...base.session,
    maxEngineTorque: ext(12345), maxGearboxTemp: ext(145), maxOilTemp: ext(145), maxCoolantTemp: ext(128), maxHeightRange: ext(240),
    maxSlipOverall: variant === 'valid' ? { value: 100, atMs: now, wheel: 'RR' as const } : null,
    maxSlip: { FL: ext(100), FR: ext(100), RL: ext(100), RR: ext(100) },
  };
  return { ...base, snapshot: { ...base.snapshot, signals: signals as unknown as SignalMap, extra: extra as never }, session: session as never };
}

export interface ProbeRig {
  app: AppHandle;
  kit: ReturnType<typeof stageVendorKit>;
  Recorder: RecorderCtor;
  record: { play(words: Uint32Array, cv: unknown): unknown; setImage: Kit['record']['setImage'] };
  Canvas: new (w: number, h: number) => { png(): Buffer };
  /** Кадр страницы page: вариант данных, масштаб текста, место под страницей kit (extra), own (полноэкранный kit). */
  frame(page: number, variant: Variant | null, textScale: number, extra: number, own?: boolean): Promise<FrameProbe>;
  png(fp: FrameProbe, h?: number): Buffer;
  close(): Promise<void>;
}

/** assets: модуль растров; по умолчанию — синтетические (тесты); снимки приёмки передают производственный assets.js сборки. */
export function probeRig(dev: DevAccess = PRODUCTION, assets: AssetsModule = syntheticAssets()): ProbeRig {
  const kit = stageVendorKit();
  const record = kit.req('./record.js') as ProbeRig['record'] & { Recorder: RecorderCtor };
  const G = kit.req('./gauges.js') as Kit['G'];
  const { Canvas } = kit.req('./canvas.js') as { Canvas: ProbeRig['Canvas'] };
  const ctx = fakeCtx(new FakeTransport(), {}, { own: true });
  let next: { textScale: number; extra: number; own: boolean } = { textScale: 1, extra: 0, own: true };
  let rec: (Surface & { words(): Uint32Array }) | null = null;
  ctx.canvas = (w, h) => {
    const r = new record.Recorder(w, h, { textScale: next.textScale });
    r.own = next.own;
    r.extra = next.extra;
    rec = r;
    return r;
  };
  const now = 1_000_000;
  const app = startApp(ctx, { mgu: { run: () => undefined }, G, record }, assets, () => now, dev);
  const baseGet = app.model.getState.bind(app.model);
  let variant: Variant | null = null;
  app.model.getState = () => (variant ? patchState(baseGet(), variant, now) : baseGet());
  return {
    app, kit, Recorder: record.Recorder, record, Canvas,
    async frame(page, v, textScale, extra, own = true) {
      variant = v;
      next = { textScale, extra, own };
      app.setPage(page);
      const probe: LayoutProbe = { panels: [], texts: [] };
      setLayoutProbe(probe);
      try {
        await app.render();
      } finally {
        setLayoutProbe(null);
      }
      const r = rec!;
      const words = new Uint32Array(r.words());
      return { page, words, panels: probe.panels, extra, recorder: r, texts: probe.texts.filter((t) => t.cv === r).map((t) => ({ ...t, box: glyphBox(words, t.n0, t.n1) })) };
    },
    png(fp, h = 520 + fp.extra) {
      const cv = new Canvas(1600, h);
      record.play(fp.words, cv);
      return cv.png();
    },
    async close() {
      try {
        await app.dispose();
      } finally {
        kit.cleanup();
      }
    },
  };
}

/** Наименьший зазор между РАЗНЫМИ показателями одной строки, логические px (≈ 28 px на экране): меньше — читается слитно. */
export const MIN_GAP = 24;

/** Нарушения вёрстки кадра (пустой список — всё помещается). */
export function layoutViolations(fp: FrameProbe, minPx: number): string[] {
  const out: string[] = [];
  const bottom = 520 + fp.extra;
  const tag = (t: DrawnText) => `«${t.s}»`;
  const inside = (b: Box, r: { x: number; y: number; w: number; h: number }, tol: number) => b.x0 >= r.x - tol && b.x1 <= r.x + r.w + tol && b.y0 >= r.y - tol && b.y1 <= r.y + r.h + tol;
  const drawn = fp.texts.filter((t) => t.box);
  for (const t of drawn) {
    const b = t.box!;
    if (t.maxW !== null && t.w > t.maxW + 0.5) out.push(`${tag(t)}: ширина ${t.w.toFixed(1)} > ячейки ${t.maxW.toFixed(1)}`);
    if (t.px < minPx - 0.01) out.push(`${tag(t)}: ${t.px.toFixed(1)} px < ${minPx}`);
    // видимая часть полноэкранной раскладки: x 12…1588, y ≥ 38 (display.js FULL.src), до низа страницы
    if (b.x0 < 12 - 0.5 || b.x1 > 1588 + 0.5 || b.y0 < 38 - 0.5 || b.y1 > bottom + 0.5) out.push(`${tag(t)}: вне видимой области (${b.x0.toFixed(0)},${b.y0.toFixed(0)})–(${b.x1.toFixed(0)},${b.y1.toFixed(0)})`);
    // панель, в которой точка привязки текста (начало, конец или середина — по выравниванию): текст целиком в ней
    const cx = t.align === 'left' ? b.x0 + 2 : t.align === 'right' ? b.x1 - 2 : (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const host = fp.panels.filter((p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h).sort((a, c) => a.w * a.h - c.w * c.h)[0];
    if (host && !inside(b, host, 1)) out.push(`${tag(t)}: выходит за панель (${host.x},${host.y} ${host.w}×${host.h}): (${b.x0.toFixed(0)},${b.y0.toFixed(0)})–(${b.x1.toFixed(0)},${b.y1.toFixed(0)})`);
  }
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i].box!, c = drawn[j].box!;
      const ox = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0);
      const oy = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
      if (ox > 1 && oy > 1) { out.push(`${tag(drawn[i])} и ${tag(drawn[j])} накладываются (${ox.toFixed(0)}×${oy.toFixed(0)} px)`); continue; }
      // на одной строке (перекрытие по высоте больше трети меньшего текста) — видимый зазор не меньше MIN_GAP;
      // единица, приклеенная к своему числу, — исключение (её зазор задаёт readout)
      const glued = (drawn[j].attached && j === i + 1) || (drawn[i].attached && i === j + 1);
      const minH = Math.min(a.y1 - a.y0, c.y1 - c.y0);
      if (!glued && oy > minH / 3 && -ox < MIN_GAP) out.push(`${tag(drawn[i])} и ${tag(drawn[j])}: зазор ${(-ox).toFixed(1)} px < ${MIN_GAP}`);
    }
  }
  return out;
}
