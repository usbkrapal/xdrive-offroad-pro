// Мост камер: по запросу приложения Terrain Monitor запускает установленный источник кадров xop-camrx (все виды), чтобы
// файлы кадров mgu-render /dev/shm/mgu-video-xop-<вид> наполнялись текущими кадрами. Путь mgu-camcluster (передняя через
// чужой инструмент Turn View) в рабочий набор НЕ входит: у него общее состояние /dev/shm/camcluster/showing, которым
// мост не владеет; код остаётся только для явного списка источников (тесты/разработка).
// Новый источник не запускается, пока прежний не завершился (иначе два процесса пишут одни файлы).
// Новое соединение приложения вытесняет прежнее (одно приложение; быстрое закрытие-открытие не должно отказываться).
// Без запроса ничего не запущено. Остановка — по «stop», по закрытию соединения приложения (ушло со страницы, закрылось)
// и при выходе моста. Вид у блока камер мост НЕ запрашивает: это делает приложение (camera/request.ts) по нуждам
// источника (accept/request в событиях моста), уступая штатным обзорам и чужим видам.
// Все внешние действия — через Deps (в тестах подменяются).

import { encodeLine, parseRequest, type BridgeState, type BridgeView, type CtlEvent, CTL_LINE_MAX } from '../../src/camera/ctl';
import { MgvfWriter, parseMgvf, videoPath, type MgvfSink } from '../../src/camera/mgvf';
import { CAMCLUSTER_SHOWING, CAMCLUSTER_SPEC, CAMRX_SPEC, checkProducer, FRAME_H, FRAME_W, parseCaps, TARGET, type FsLike, type ProducerSpec } from './camcluster';
import { ClusterSession, FrameReader, type Message } from './cluster';

export interface ChildLike {
  readonly pid: number;
  write(line: string): void;
  endInput(): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}
export interface SpawnHooks {
  onLine(stream: 'out' | 'err', line: string): void;
  onExit(code: number | null, signal: string | null): void;
}
export interface VideoFile extends MgvfSink {
  close(): void;
}
export interface Peer {
  send(data: Buffer | string): void;
  close(): void;
}
export interface Deps {
  readonly fs: FsLike;
  spawn(file: string, args: string[], hooks: SpawnHooks): ChildLike;
  openVideo(path: string, bytes: number): VideoFile;
  /** Первые 64 байта файла кадров и его размер (null — нет). */
  readHeader(path: string): { bytes: Uint8Array; size: number } | null;
  unlink(path: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  log(line: string): void;
}

/** Без кадра дольше — «stalled» (рендерер показал бы последний кадр бесконечно). */
export const STALL_MS = 2000;
/** После запуска столько ждём первый кадр. */
export const FIRST_FRAME_MS = 10000;
/** Остановка: «video off» и закрытый stdin, затем SIGTERM, затем SIGKILL. */
export const STOP_TERM_MS = 3000;
export const STOP_KILL_MS = 2000;
/** Повторов запуска после неожиданного выхода, пока приложение хочет виды. */
export const MAX_RESTARTS = 3;
export const RESTART_MS = 5000;
/** Источник не установлен / недоступен: повторная проверка, пока приложение хочет виды. */
export const UNAVAILABLE_RETRY_MS = 5000;
/** Новое соединение вытеснило прежнее: если «start» не пришёл за это время — остановить источник. */
export const HANDOVER_MS = 3000;
/** Строк вывода источника в журнал в минуту. */
export const CHILD_LINES_PER_MIN = 30;

interface Running {
  readonly spec: ProducerSpec;
  readonly child: ChildLike;
  views: BridgeView[];
  accept: number[];
  request: number;
  /** AVB callback registered before the app may ask ICAM2 to start its stream. */
  receiverReady: boolean;
  caps?: { accept: number[]; request: number };
  /** Файл состояния mgu-camcluster создан при нашем запуске (его не было до нас). */
  showingOurs: boolean;
  /** Где теряются кадры по последней статистике xop-camrx (stallLayer), '' — статистики ещё не было. */
  layer?: string;
  stats?: Record<string, unknown>;
}

function cameraStats(line: string): Record<string, unknown> | null {
  if (line.length > 2048 || line.indexOf('"ev":"stats"') < 0) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown> | null;
    return parsed && parsed.ev === 'stats' ? parsed : null;
  } catch {
    return null;
  }
}

/** Диагноз по последнему интервалу (~5 с), а при первом отчёте — с запуска. */
function describeStall(o: Record<string, unknown>, previous?: Record<string, unknown>): string {
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  const n = (k: string) => Math.max(0, count(o[k]) - count(previous && previous[k]));
  const shown = n('front') + n('left') + n('right');
  const tag = typeof o.tag === 'string' && /^[0-9/]{1,20}$/.test(o.tag) ? o.tag : '';
  const size = typeof o.size === 'string' && /^[0-9x]{1,12}$/.test(o.size) ? o.size : '';
  const seen = tag && tag !== '0/0/0/0' ? `; метка ${tag}${size && size !== '0x0' ? `, кадр ${size}` : ''}` : '';
  const recovery = typeof o.clean_idr === 'number' && typeof o.idr === 'number' ? `; IDR ${count(o.clean_idr)}/${count(o.idr)}` : '';
  if (!count(o.active)) return 'приёмник AVB не запущен';
  if (!n('packets')) return 'AVB: пакетов нет (поток камер не идёт или приёмник не подключён)';
  if (!n('units')) return `AVB: пакеты есть, блоков H.264 нет (RTP не разобран${n('rtp_bad') ? `, ошибок RTP ${n('rtp_bad')}` : ''})`;
  if (!n('frames') && n('decode_errors')) return `блоки H.264 есть, декодер с ошибками${seen}`;
  if (!n('frames') && n('wait_idr')) return `блоки H.264 есть, ждём чистого IDR${recovery}${seen}`;
  if (!n('frames') && n('unlabelled')) return `блоки H.264 есть, нет метки камеры (SEI)${seen}`;
  if (!n('frames')) return `блоки H.264 есть, декодер кадров не выдаёт${seen}`;
  if (shown) return n('file_errors') ? `ошибка записи файла кадров${seen}` : '';

  // Причины ниже относятся к отброшенным кадрам декодера. Для фильтра допуска есть отдельные счётчики блоков H.264.
  const rejected: [string, string][] = [
    ['unmatched', 'декодер потерял привязку кадра'],
    ['corrupted', 'декодер пометил кадры повреждёнными'],
    ['too_old', 'кадры выходят с опозданием'],
    ['bad_size', 'неподдерживаемый размер кадра'],
    ['no_picture', 'декодер не выдал пиксели'],
    ['duplicate', 'повтор идентификатора кадра'],
    ['not_shown', 'кадры отсеяны до вывода'],
  ];
  const dominant = rejected.reduce<[string, string] | null>((best, entry) =>
    n(entry[0]) > (best ? n(best[0]) : 0) ? entry : best, null);
  if (dominant && dominant[0] !== 'not_shown') return `${dominant[1]}${seen}`;
  if (n('unlabelled')) return `кадры есть, нет метки камеры (SEI)${seen}`;
  if (n('wait_idr') || n('damaged')) return `кадры есть, ждём чистого IDR${recovery}${seen}`;
  if (n('gate_no_view')) return `метка не соответствует видам приложения${seen}`;
  return `${dominant ? dominant[1] : 'кадры есть, но вид не разобран (размер/метка)'}${seen}`;
}

export function stallLayer(line: string): string {
  const stats = cameraStats(line);
  return stats ? describeStall(stats) : '';
}

/**
 * Права ctl-сокета. Группа приложений OAP (deploy/updater: `tm_oap_app`) задаётся юнитом: XOP_CTL_GROUP=<имя> (ищется в
 * /etc/group) или XOP_BRIDGE_GID=<число> (главнее). Найдена — root:<gid> 0660. Не задана или не найдена — 0600 (только
 * root) и ошибка в журнале: доступ для всех (0666) не открывается никогда.
 */
export function socketAccess(env: Readonly<Record<string, string | undefined>>, etcGroup: string | null): { gid: number | null; mode: number; note: string } {
  const num = env.XOP_BRIDGE_GID;
  if (num !== undefined && /^[0-9]{1,7}$/.test(num)) return { gid: Number(num), mode: 0o660, note: `gid ${num} (XOP_BRIDGE_GID), 0660` };
  const name = env.XOP_CTL_GROUP;
  if (!name || !/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) return { gid: null, mode: 0o600, note: 'ERROR: XOP_CTL_GROUP / XOP_BRIDGE_GID not set: socket root-only (0600), the app cannot connect' };
  for (const line of (etcGroup || '').split('\n')) {
    const f = line.split(':');
    if (f.length >= 3 && f[0] === name && /^[0-9]{1,7}$/.test(f[2])) return { gid: Number(f[2]), mode: 0o660, note: `group ${name} (gid ${f[2]}), 0660` };
  }
  return { gid: null, mode: 0o600, note: `ERROR: group ${name} not in /etc/group: socket root-only (0600), the app cannot connect` };
}

/** Рабочий набор источников: только свой xop-camrx. */
export const PRODUCTION_PRODUCERS: readonly ProducerSpec[] = [CAMRX_SPEC];
/** С запасным путём mgu-camcluster (только явно: разработка/тесты). */
export const WITH_CAMCLUSTER: readonly ProducerSpec[] = [CAMRX_SPEC, CAMCLUSTER_SPEC];

export class Bridge {
  private client: Peer | null = null;
  private inbuf = '';
  private wanted = false;
  private run: Running | null = null;
  private stopping: ChildLike[] = [];
  private state: BridgeState = 'idle';
  private reason = '';
  private frames = 0;
  private lastFrameAt: number | null = null;
  private startedAt = 0;
  private restarts = 0;
  private seqs = new Map<BridgeView, number>();
  private video: { file: VideoFile; writer: MgvfWriter; w: number; h: number } | null = null;
  private cluster: { peer: Peer; reader: FrameReader; session: ClusterSession } | null = null;
  private watchdog: (() => void) | null = null;
  private restartTimer: (() => void) | null = null;
  private lineBudget = { at: 0, n: 0 };
  private retryTimer: (() => void) | null = null;
  private handover: (() => void) | null = null;
  private lastLog = '';

  constructor(
    private readonly deps: Deps,
    private readonly producers: readonly ProducerSpec[] = PRODUCTION_PRODUCERS,
  ) {}

  private log(line: string): void {
    if (line === this.lastLog) return;
    this.lastLog = line;
    this.deps.log(line.slice(0, 240));
  }

  /* ---------------- приложение (ctl) ---------------- */

  connect(peer: Peer): boolean {
    if (this.client) {
      // одно приложение: новое соединение вытесняет прежнее; источник остаётся, если новое скоро попросит «start»
      const old = this.client;
      this.client = null;
      old.close();
      this.log('ctl: a new app connection replaces the previous one');
      if (this.wanted && !this.handover)
        this.handover = this.deps.setTimer(() => {
          this.handover = null;
          if (this.wanted) this.stop('новое соединение не попросило кадры');
        }, HANDOVER_MS);
    }
    this.client = peer;
    this.inbuf = '';
    this.emit();
    return true;
  }

  data(peer: Peer, chunk: string): void {
    if (peer !== this.client) return;
    this.inbuf += chunk;
    if (this.inbuf.length > CTL_LINE_MAX * 2) {
      this.log('ctl: too long a line from the app: closing');
      return this.disconnect(peer);
    }
    let i: number;
    while ((i = this.inbuf.indexOf('\n')) >= 0) {
      const line = this.inbuf.slice(0, i);
      this.inbuf = this.inbuf.slice(i + 1);
      const r = parseRequest(line);
      if (typeof r === 'string') {
        this.log(`ctl: refused request: ${r}`);
        peer.send(encodeLine(this.event(this.state, `запрос отклонён: ${r}`)));
        continue;
      }
      if (r.op === 'start') {
        if (this.handover) {
          this.handover();
          this.handover = null;
        }
        this.start();
      }
      else if (r.op === 'stop') this.stop('остановлено приложением');
      else this.emit();
    }
  }

  disconnect(peer: Peer): void {
    if (peer !== this.client) return;
    this.client = null;
    this.stop('приложение отсоединилось');
    peer.close();
  }

  private event(state: BridgeState, reason: string): CtlEvent {
    const r = this.run;
    return { ev: 'state', state, producer: r ? r.spec.id : null, views: r ? r.views : [], reason, frames: this.frames, accept: r ? r.accept : [], request: r ? r.request : 0 };
  }

  private emit(): void {
    if (this.client) this.client.send(encodeLine(this.event(this.state, this.reason)));
  }

  private set(state: BridgeState, reason: string): void {
    const changed = state !== this.state || reason !== this.reason;
    this.state = state;
    this.reason = reason;
    if (changed) {
      this.log(`state ${state}${this.run ? ` (${this.run.spec.id})` : ''}${reason ? `: ${reason}` : ''}`);
      this.emit();
    }
  }

  /* ---------------- источник кадров ---------------- */

  start(): void {
    this.wanted = true;
    if (this.run) return this.emit();
    this.restarts = 0;
    this.launch();
  }

  /** Первый годный источник: проверка установки и конфликтов; причины всех отвергнутых — в журнал. */
  private choose(): { spec: ProducerSpec; real: string } | string {
    const why: string[] = [];
    for (const spec of this.producers) {
      const dep = checkProducer(this.deps.fs, spec);
      if (!dep.ok) {
        why.push(`${spec.id}: ${dep.reason}`);
        continue;
      }
      if (spec.id === 'camcluster' && this.deps.fs.existsSync(CAMCLUSTER_SHOWING)) {
        why.push('camcluster: Turn View сейчас показывает камеру (/dev/shm/camcluster/showing) — второй экземпляр перезаписал бы его общее состояние');
        continue;
      }
      return { spec, real: dep.real };
    }
    return why.join('; ');
  }

  private launch(): void {
    if (!this.wanted || this.run) return;
    if (this.stopping.length) return this.set('starting', 'ждём завершения прежнего источника');
    const c = this.choose();
    if (typeof c === 'string') {
      this.set('unavailable', c);
      // установка может появиться позже: проверять снова, пока приложение хочет виды
      if (!this.retryTimer)
        this.retryTimer = this.deps.setTimer(() => {
          this.retryTimer = null;
          if (this.client && this.wanted && !this.run) this.launch();
        }, UNAVAILABLE_RETRY_MS);
      return;
    }
    const { spec, real } = c;
    this.frames = 0;
    this.lastFrameAt = null;
    this.seqs.clear();
    this.startedAt = this.deps.now();
    const showingBefore = spec.id === 'camcluster' && this.deps.fs.existsSync(CAMCLUSTER_SHOWING);
    let child: ChildLike;
    try {
      child = this.deps.spawn(real, spec.args.slice(), {
        onLine: (s, l) => this.childLine(child, s, l),
        onExit: (code, sig) => this.childExit(child, code, sig),
      });
    } catch (e) {
      return this.set('error', `запуск ${spec.id}: ${String(e).slice(0, 100)}`);
    }
    const receiverReady = spec.id !== 'camrx';
    this.run = { spec, child, views: spec.views.slice(), accept: receiverReady ? spec.accept.slice() : [], request: receiverReady ? spec.request : 0, receiverReady, showingOurs: !showingBefore };
    child.write('video on\n');
    this.set('starting', `${spec.id}, pid ${child.pid}`);
    if (!this.watchdog) this.armWatchdog();
  }

  private childLine(child: ChildLike, stream: 'out' | 'err', line: string): void {
    const r = this.run;
    if (r && r.child === child && stream === 'out' && r.spec.id === 'camrx' && line.trim() === '{"ev":"receiver_ready"}') {
      r.receiverReady = true;
      r.accept = r.caps ? r.caps.accept : r.spec.accept.slice();
      r.request = r.caps ? r.caps.request : r.spec.request;
      this.log('camrx: AVB receiver ready');
      this.emit();
      return;
    }
    if (r && r.child === child && stream === 'out' && r.spec.id === 'camrx' && line.indexOf('"caps"') >= 0) {
      const caps = parseCaps(line, r.spec.views);
      if (caps) {
        r.views = caps.views;
        r.caps = { accept: caps.accept, request: caps.request };
        if (r.receiverReady) {
          r.accept = caps.accept;
          r.request = caps.request;
        }
        this.log(`camrx caps: views ${caps.views.join(',')} accept ${caps.accept.join(',')} request ${caps.request}`);
        this.emit();
        return;
      }
    }
    const stats = r && r.child === child && stream === 'out' && r.spec.id === 'camrx' ? cameraStats(line) : null;
    if (r && stats) {
      r.layer = describeStall(stats, r.stats);
      r.stats = stats;
    }
    const now = this.deps.now();
    if (now - this.lineBudget.at > 60000) this.lineBudget = { at: now, n: 0 };
    if (++this.lineBudget.n > CHILD_LINES_PER_MIN) return;
    this.deps.log(`${r ? r.spec.id : 'producer'} ${stream}: ${line.replace(/[^\x20-\x7e]/g, '?').slice(0, stats ? 2048 : 200)}`);
  }

  private childExit(child: ChildLike, code: number | null, sig: string | null): void {
    const i = this.stopping.indexOf(child);
    if (i >= 0) {
      this.stopping.splice(i, 1);
      // прежний завершился: отложенный запуск
      if (!this.stopping.length && this.client && this.wanted && !this.run) this.launch();
      return;
    }
    const r = this.run;
    if (!r || r.child !== child) return;
    this.run = null;
    this.dropCluster();
    this.closeVideo(r.spec);
    const why = `${r.spec.id} завершился (${code !== null ? `код ${code}` : `сигнал ${sig}`})`;
    if (this.client && this.wanted && this.restarts < MAX_RESTARTS) {
      this.restarts++;
      this.set('error', `${why}; повтор ${this.restarts}/${MAX_RESTARTS} через ${RESTART_MS / 1000} с`);
      this.restartTimer = this.deps.setTimer(() => {
        this.restartTimer = null;
        if (this.client && this.wanted && !this.run) this.launch();
      }, RESTART_MS);
    } else this.set('error', why);
  }

  private stopProducer(): void {
    const r = this.run;
    this.run = null;
    if (this.restartTimer) {
      this.restartTimer();
      this.restartTimer = null;
    }
    if (this.retryTimer) {
      this.retryTimer();
      this.retryTimer = null;
    }
    this.dropCluster();
    if (!r) return;
    this.closeVideo(r.spec);
    const c = r.child;
    this.stopping.push(c);
    try {
      c.write('video off\n');
      c.endInput();
    } catch {
      /* уже закрыт */
    }
    this.deps.setTimer(() => {
      if (this.stopping.indexOf(c) < 0) return;
      c.kill('SIGTERM');
      this.deps.setTimer(() => {
        if (this.stopping.indexOf(c) >= 0) c.kill('SIGKILL');
      }, STOP_KILL_MS);
    }, STOP_TERM_MS);
  }

  stop(reason: string): void {
    this.wanted = false;
    if (this.handover) {
      this.handover();
      this.handover = null;
    }
    this.stopProducer();
    if (this.watchdog) {
      this.watchdog();
      this.watchdog = null;
    }
    this.set('idle', reason);
  }

  shutdown(): void {
    if (this.client) {
      const c = this.client;
      this.client = null;
      c.close();
    }
    this.stop('мост остановлен');
  }

  /** Источник, пишущий файлы сам (xop-camrx): свежесть — по росту seq в заголовках его файлов. */
  private pollFiles(r: Running): void {
    for (const v of r.views) {
      const h = this.deps.readHeader(videoPath(v));
      const p = h ? parseMgvf(h.bytes, h.size) : null;
      if (!p || typeof p === 'string') continue;
      const before = this.seqs.get(v);
      this.seqs.set(v, p.seq);
      if (before !== undefined && p.seq !== before) {
        this.frames += (p.seq - before) >>> 0;
        this.lastFrameAt = this.deps.now();
      }
    }
  }

  private armWatchdog(): void {
    this.watchdog = this.deps.setTimer(() => {
      this.watchdog = null;
      const r = this.run;
      if (!r) return;
      if (!r.spec.viaCluster) this.pollFiles(r);
      const now = this.deps.now();
      if (this.lastFrameAt === null) {
        if (now - this.startedAt > FIRST_FRAME_MS)
          this.set('stalled', `нет кадров: ${r.layer || 'статистики приёмника ещё нет (нужного вида у блока камер нет или поток не принимается)'}`.slice(0, 160));
      } else if (now - this.lastFrameAt > STALL_MS) this.set('stalled', `кадры остановились${r.layer ? `: ${r.layer}` : ''}`.slice(0, 160));
      else if (this.state !== 'running') this.set('running', `${r.views.join(',')}`);
      else this.emit();
      this.armWatchdog();
    }, 1000);
  }

  /* ---------------- частный сокет cluster-render (mgu-camcluster) ---------------- */

  clusterConnect(peer: Peer): boolean {
    if (!this.run || !this.run.spec.viaCluster || this.cluster) {
      peer.close();
      return false;
    }
    this.cluster = { peer, reader: new FrameReader(), session: new ClusterSession({ backend: 'id7', target: TARGET, targetW: FRAME_W, targetH: FRAME_H }) };
    return true;
  }

  clusterData(peer: Peer, chunk: Buffer): void {
    const c = this.cluster;
    if (!c || c.peer !== peer) return;
    const msgs = c.reader.push(chunk);
    if (typeof msgs === 'string') {
      this.log(`cluster: ${msgs}: closing`);
      return this.clusterClosed(peer);
    }
    for (const m of msgs) if (!this.clusterMessage(c, m)) return;
  }

  private clusterMessage(c: NonNullable<Bridge['cluster']>, m: Message): boolean {
    const out = c.session.handle(m);
    for (const b of out.send) c.peer.send(b);
    if (out.note) this.log(`cluster: ${out.note}`);
    if (out.close) {
      this.log(`cluster: ${out.close}: closing`);
      this.clusterClosed(c.peer);
      return false;
    }
    const r = this.run;
    if (out.frame && r) {
      const f = out.frame;
      const view = r.views[0];
      if (!this.video || this.video.w !== f.w || this.video.h !== f.h) {
        this.closeVideo(r.spec);
        const file = this.deps.openVideo(videoPath(view), 64 + 3 * f.i420.length);
        this.video = { file, writer: new MgvfWriter(file, f.w, f.h, 3, 0, 1), w: f.w, h: f.h };
      }
      this.video.writer.write(f.i420);
      this.frames++;
      this.lastFrameAt = this.deps.now();
      if (this.state !== 'running') this.set('running', `${view} ${f.w}x${f.h}`);
    }
    return true;
  }

  clusterClosed(peer: Peer): void {
    if (!this.cluster || this.cluster.peer !== peer) return;
    this.cluster = null;
    peer.close();
  }

  private dropCluster(): void {
    if (this.cluster) this.clusterClosed(this.cluster.peer);
  }

  /** Файл кадров, который пишет мост (mgu-camcluster), закрыть и убрать; файлы xop-camrx убирает он сам. */
  private closeVideo(spec: ProducerSpec): void {
    const v = this.video;
    this.video = null;
    if (!v || !spec.viaCluster) return;
    try {
      v.file.close();
    } catch {
      /* закрыт */
    }
    try {
      this.deps.unlink(videoPath(spec.views[0]));
    } catch {
      /* нет файла */
    }
  }
}
