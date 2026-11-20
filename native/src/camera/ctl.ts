// Управляющий протокол приложение ↔ мост камер (native/bridge, отдельный root-инструмент Store).
// Unix-сокет с фиксированным путём, строки JSON, каждая ≤ CTL_LINE_MAX байт. От приложения — только три операции без
// параметров: никаких путей, аргументов, команд, видов или размеров; мост сам выбирает источник кадров и его
// фиксированные аргументы. Один клиент за раз; закрытие соединения = «стоп» (виды отпускаются при уходе со страницы).
//
//   приложение → мост: {"op":"start"} | {"op":"stop"} | {"op":"status"}
//   мост → приложение: {"ev":"state","state":…,"producer":…,"views":[…],"reason":…,"frames":N,"accept":[…],"request":N}
// Файлы кадров — только videoPath(вид) для видов из views.

export const BRIDGE_ID = 'xop-camera-bridge';
export const CTL_DIR = `/run/${BRIDGE_ID}`;
export const CTL_SOCKET = `${CTL_DIR}/ctl.sock`;
export const CTL_LINE_MAX = 1024;

/** Виды, которые вообще может отдавать мост (файлы /dev/shm/mgu-video-xop-<вид>). */
export const BRIDGE_VIEWS = ['front', 'left', 'right', 'rear'] as const;
export type BridgeView = (typeof BRIDGE_VIEWS)[number];

/** Источники кадров моста: свой приёмник xop-camrx (все виды по меткам кадров) или установленный mgu-camcluster (front). */
export const PRODUCERS = ['camrx', 'camcluster'] as const;
export type Producer = (typeof PRODUCERS)[number];

export type CtlRequest = { readonly op: 'start' } | { readonly op: 'stop' } | { readonly op: 'status' };

/**
 * Состояния моста: idle (ничего не запущено), starting, running (кадры идут), stalled (источник запущен, кадров нет
 * дольше предела), unavailable (источника нет / конфликт / отказ), error.
 */
export const BRIDGE_STATES = ['idle', 'starting', 'running', 'stalled', 'unavailable', 'error'] as const;
export type BridgeState = (typeof BRIDGE_STATES)[number];

export interface CtlEvent {
  readonly ev: 'state';
  readonly state: BridgeState;
  readonly producer: Producer | null;
  /** Виды, которые этот источник отдаёт файлами кадров. */
  readonly views: readonly BridgeView[];
  /** Короткая причина для журнала/диагностики (≤ 160 символов). */
  readonly reason: string;
  readonly frames: number;
  /**
   * Что нужно источнику от блока камер (запрос вида в приложении, camera/request.ts): perspective из currentState,
   * кадры которых он разбирает, и вид, который просить, когда камеры свободны (0 — не просить).
   */
  readonly accept: readonly number[];
  readonly request: number;
  readonly recovery?: {
    readonly idr: number;
    readonly cleanIdr: number;
    readonly intra: number;
    readonly standaloneIntra: number;
    readonly nonProgressive: number;
    readonly waitingIdr: boolean;
  };
}

/** Строка от приложения → запрос; строка — почему отклонена. */
export function parseRequest(line: string): CtlRequest | string {
  if (Buffer.byteLength(line, 'utf8') > CTL_LINE_MAX) return 'строка длиннее предела';
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return 'не JSON';
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'не объект';
  const j = o as Record<string, unknown>;
  if (Object.keys(j).join(',') !== 'op') return 'лишние поля';
  if (j.op === 'start' || j.op === 'stop' || j.op === 'status') return { op: j.op };
  return 'неизвестная операция';
}

const clean = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : 0);

/** Строка от моста → событие (только известные значения). */
export function parseEvent(line: string): CtlEvent | null {
  if (Buffer.byteLength(line, 'utf8') > CTL_LINE_MAX) return null;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const j = o as Record<string, unknown>;
  if (j.ev !== 'state' || (BRIDGE_STATES as readonly unknown[]).indexOf(j.state) < 0) return null;
  const producer = (PRODUCERS as readonly unknown[]).indexOf(j.producer) >= 0 ? (j.producer as Producer) : null;
  const views = Array.isArray(j.views) ? BRIDGE_VIEWS.filter((v) => (j.views as unknown[]).indexOf(v) >= 0) : [];
  const accept = Array.isArray(j.accept) ? j.accept.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255).slice(0, 12) : [];
  const raw = j.recovery && typeof j.recovery === 'object' ? j.recovery as Record<string, unknown> : null;
  const recovery = raw ? {
    idr: count(raw.idr, 0xffffffff), cleanIdr: count(raw.cleanIdr, 0xffffffff),
    intra: count(raw.intra, 0xffffffff), standaloneIntra: count(raw.standaloneIntra, 0xffffffff),
    nonProgressive: count(raw.nonProgressive, 0xffffffff), waitingIdr: raw.waitingIdr === true,
  } : undefined;
  return { ev: 'state', state: j.state as BridgeState, producer, views, reason: clean(j.reason, 160), frames: count(j.frames, 0xffffffff), accept, request: count(j.request, 255), ...(recovery ? { recovery } : {}) };
}

export const encodeLine = (o: CtlRequest | CtlEvent): string => `${JSON.stringify(o)}\n`;
