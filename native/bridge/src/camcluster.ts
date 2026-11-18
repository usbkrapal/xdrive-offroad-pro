// Источники кадров моста и их проверка. Ни один не входит в пакет моста: оба ставятся своими инструментами Store и
// запускаются как отдельные процессы с ФИКСИРОВАННЫМИ аргументами (массив, без оболочки; от приложения в них не
// попадает ничего).
//
// 1. xop-camrx — наш отдельный GPL-3.0-or-later приёмник (native/camrx, свой инструмент Store): принимает поток камер
//    как ещё один приёмник AVB, читает метку камеры каждого кадра (SEI) и сам пишет файлы кадров mgu-render для
//    передней/левой/правой. При запуске печатает строку {"ev":"caps",…}: какие виды отдаёт и какие perspective
//    currentState разбирает.
// 2. mgu-camcluster — установлен инструментом iteriodev-turnview (IterioDev, GPL-3.0-or-later, без опубликованных
//    исходников; не копируется и не меняется). По строкам usage и разбору бинарника (QA_CAR_FIX_0.1.2.md):
//    --camera front|rear принимается (left/right в таблице разбора имён есть, но проверка аргумента их отклоняет),
//    кадры берутся только с меткой application 51 и perspective 1–8 и только 1280×480 — то есть в видах 1/5 (передняя),
//    не в «все камеры» (7 → метки 9/10). Мост берёт у него только переднюю.
//    --root DIR — префикс для определения поколения головного устройства (/usr/lib/oap-mainapp, /proc/<pid>/comm), а
//    НЕ каталог состояния: /dev/shm/camcluster/showing пишется по абсолютному пути любым экземпляром (запись .new +
//    rename, unlink при «ничего не показываю»). Изолировать это нельзя; Turn View читает этот файл. Поэтому мост
//    запускает mgu-camcluster только если файла нет (Turn View сейчас ничего не показывает) и сообщает об остаточном
//    пересечении; --root не передаётся (иначе он не опознал бы головное устройство).

import { BRIDGE_ID, CTL_DIR, type BridgeView, type Producer } from '../../src/camera/ctl';

export const CAMCLUSTER_ROOT = '/var/opt/iteriodev-turnview';
export const CAMCLUSTER = `${CAMCLUSTER_ROOT}/current/mgu-camcluster`;
/** Общий файл состояния всех экземпляров mgu-camcluster (абсолютный путь в бинарнике). */
export const CAMCLUSTER_SHOWING = '/dev/shm/camcluster/showing';
export const CAMRX_ROOT = '/var/opt/xop-camrx';
export const CAMRX = `${CAMRX_ROOT}/current/xop-camrx`;
/** Частный сокет протокола cluster-render моста (0600, root) — только для mgu-camcluster. */
export const CLUSTER_SOCKET = `${CTL_DIR}/cluster.sock`;
export const TARGET = 'xop';
/** Размер вывода mgu-camcluster (--rect) и частной цели моста: как его вход (только 1280×480), без масштабирования. */
export const FRAME_W = 1280;
export const FRAME_H = 480;
export const FPS = 15;
/** Роль потока AVB камер (строка в mgu-camcluster; так же у приёмника Drive Recorder). */
export const AVB_STREAM = 'media_transport.avb_streaming.1';

export interface ProducerSpec {
  readonly id: Producer;
  readonly root: string;
  readonly path: string;
  readonly views: readonly BridgeView[];
  /** perspective из currentState, кадры которых источник разбирает (по умолчанию; xop-camrx уточняет строкой caps). */
  readonly accept: readonly number[];
  /** Вид, который приложению просить, когда камеры свободны (0 — не просить). */
  readonly request: number;
  readonly args: readonly string[];
  /** Кадры идут через частный сокет cluster-render (мост сам пишет файл кадров); иначе источник пишет файлы сам. */
  readonly viaCluster: boolean;
}

export const CAMRX_SPEC: ProducerSpec = {
  id: 'camrx',
  root: CAMRX_ROOT,
  path: CAMRX,
  views: ['front', 'left', 'right'],
  // до строки caps — только одиночные виды и пары, разбор которых известен по меткам (1–8): 1 передняя, 3/4 левая/правая,
  // 5 передняя+задняя (метки 5/6), 6 левая+правая (7/8). «Все камеры» (7 → 9/10) — только если xop-camrx сообщит.
  accept: [1, 3, 4, 5, 6],
  request: 7,
  args: ['--stream', AVB_STREAM, '--out-prefix', '/dev/shm/mgu-video-xop-', '--views', 'front,left,right', '--control', 'stdin'],
  viaCluster: false,
};

export const CAMCLUSTER_SPEC: ProducerSpec = {
  id: 'camcluster',
  root: CAMCLUSTER_ROOT,
  path: CAMCLUSTER,
  views: ['front'],
  accept: [1, 5, 6],
  request: 1,
  args: ['--camera', 'front', '--target', TARGET, '--rect', `${FRAME_W}x${FRAME_H}@0,0`, '--fps', String(FPS), '--socket', CLUSTER_SOCKET, '--control', 'stdin'],
  viaCluster: true,
};

/** Нужное от fs (подменяется в тестах). */
export interface FsLike {
  realpathSync(p: string): string;
  lstatSync(p: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number };
  existsSync(p: string): boolean;
}

/**
 * Установленный файл можно запускать от root: настоящий путь внутри root источника, обычный файл, владелец root, не
 * записываем группой/другими, исполняем; каждый каталог от root источника до него — root без записи другими.
 * Возвращает настоящий путь (его и запускаем) или причину.
 */
export function checkProducer(fs: FsLike, spec: ProducerSpec): { ok: true; real: string } | { ok: false; reason: string } {
  let real: string;
  try {
    real = fs.realpathSync(spec.path);
  } catch {
    return { ok: false, reason: `${spec.path}: не установлен` };
  }
  if (real.indexOf(`${spec.root}/`) !== 0) return { ok: false, reason: `${spec.path} указывает вне ${spec.root}` };
  const st = fs.lstatSync(real);
  if (!st.isFile()) return { ok: false, reason: `${real}: не обычный файл` };
  if (st.uid !== 0) return { ok: false, reason: `${real}: владелец не root` };
  if (st.mode & 0o022) return { ok: false, reason: `${real}: записываем группой или другими` };
  if (!(st.mode & 0o100)) return { ok: false, reason: `${real}: не исполняемый` };
  const parts = real.slice(spec.root.length + 1).split('/').slice(0, -1);
  let dir = spec.root;
  for (let i = 0; i <= parts.length; i++) {
    const d = fs.lstatSync(dir);
    if (!d.isDirectory() || d.uid !== 0 || d.mode & 0o022) return { ok: false, reason: `${dir}: не каталог root без записи другими` };
    if (i < parts.length) dir = `${dir}/${parts[i]}`;
  }
  return { ok: true, real };
}

/** Строка caps от xop-camrx: {"ev":"caps","views":[…],"accept":[…],"request":N} (только известные значения). */
export function parseCaps(line: string, allowed: readonly BridgeView[]): { views: BridgeView[]; accept: number[]; request: number } | null {
  if (line.length > 512) return null;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const j = o as Record<string, unknown>;
  if (!j || j.ev !== 'caps' || !Array.isArray(j.views) || !Array.isArray(j.accept)) return null;
  const views = allowed.filter((v) => (j.views as unknown[]).indexOf(v) >= 0);
  const accept = (j.accept as unknown[]).filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10).slice(0, 10);
  const request = typeof j.request === 'number' && Number.isInteger(j.request) && j.request >= 0 && j.request <= 7 ? j.request : 0;
  return { views, accept, request };
}

export const BRIDGE_UNIT = `${BRIDGE_ID}.service`;
