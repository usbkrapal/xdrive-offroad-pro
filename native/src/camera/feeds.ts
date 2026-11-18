// Живые виды камер на странице «Камеры» (левая — передняя — правая). Кадры пишет мост xop-camera-bridge (отдельный
// root-инструмент Store) через свой источник (xop-camrx — все виды по меткам кадров; иначе mgu-camcluster — передняя).
// Приложение: просит мост о кадрах только пока страница «Камеры» на экране (уход / закрытие — «стоп» и разрыв), читает
// только заголовки файлов кадров и рисует вид, лишь пока его кадры действительно идут (замершая картинка не выдаётся
// за живую). Вид у блока камер запрашивает camera/request.ts по нуждам источника, которые сообщает мост (need()).

import type { CameraId } from '../../../src/screens/cameraPresentation';
import { CTL_SOCKET, encodeLine, parseEvent, type BridgeView, type CtlEvent } from './ctl';
import { Freshness, MGVF_HEADER, parseMgvf, videoPath, type MgvfHeader } from './mgvf';
import type { ProducerNeed } from './request';

/** id видео в рендерере (VIDEO / op 19), по виду страницы. */
export const VIDEO_ID: Readonly<Record<CameraId, number>> = { front: 1, left: 2, right: 3 };
const PAGE_VIEWS: readonly CameraId[] = ['front', 'left', 'right'];
const HEADER_EVERY_MS = 100;
const RECONNECT_MS = 5000;

export interface CtlSocket {
  write(s: string): void;
  end(): void;
}
export interface FeedDeps {
  connect(path: string, on: { connect(): void; data(s: string): void; close(err: string | null): void }): CtlSocket;
  /** Заголовок файла кадров: байты (≥ 64), владелец, обычный ли файл, размер; null — файла нет. */
  readHeader(path: string): { bytes: Uint8Array; uid: number; isFile: boolean; size: number } | null;
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  log?(line: string): void;
}

export interface ViewState {
  readonly live: boolean;
  readonly path: string | null;
  /** Почему не живое (журнал и лист диагностики; на экране — только «Недоступно»). */
  readonly reason: string;
}

interface ViewFile {
  readonly fresh: Freshness;
  header: MgvfHeader | null;
  error: string | null;
}

export class CameraFeeds {
  private wanted = false;
  private sock: CtlSocket | null = null;
  private connected = false;
  private retry: (() => void) | null = null;
  private inbuf = '';
  private bridge: CtlEvent | null = null;
  private bridgeError: string | null = null;
  private readonly files = new Map<CameraId, ViewFile>(PAGE_VIEWS.map((v): [CameraId, ViewFile] => [v, { fresh: new Freshness(1000), header: null, error: null }]));
  private headerAt = -Infinity;
  private readonly lastLog = new Map<string, string>();
  /** Поколение соединения: обработчики старого сокета (поздние close/data/connect) ничего не меняют. */
  private gen = 0;

  constructor(private readonly deps: FeedDeps) {}

  private log(key: string, s: string): void {
    if (!this.deps.log || this.lastLog.get(key) === s) return;
    this.lastLog.set(key, s);
    this.deps.log(`camera: ${s}`.slice(0, 240));
  }

  /** Страница «Камеры» на экране с данными автомобиля. */
  setWanted(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.open();
    else this.close();
  }

  private open(): void {
    if (this.sock || !this.wanted) return;
    this.inbuf = '';
    const g = ++this.gen;
    this.sock = this.deps.connect(CTL_SOCKET, {
      connect: () => {
        if (g !== this.gen) return;
        this.connected = true;
        this.bridgeError = null;
        if (this.sock) this.sock.write(encodeLine({ op: 'start' }));
      },
      data: (s) => g === this.gen && this.onData(s),
      close: (err) => {
        if (g !== this.gen) return;
        this.sock = null;
        this.connected = false;
        this.bridge = null;
        if (err) this.bridgeError = /ENOENT|ECONNREFUSED/.test(err) ? 'мост камер xop-camera-bridge не установлен или не запущен' : `мост камер: ${err.slice(0, 80)}`;
        if (this.bridgeError) this.log('bridge', this.bridgeError);
        if (this.wanted && !this.retry) this.retry = this.deps.setTimer(() => ((this.retry = null), this.open()), RECONNECT_MS);
      },
    });
  }

  private close(): void {
    if (this.retry) {
      this.retry();
      this.retry = null;
    }
    const s = this.sock;
    this.gen++; // поздние события этого сокета больше ни на что не влияют
    this.sock = null;
    this.connected = false;
    this.bridge = null;
    this.inbuf = '';
    const now = this.deps.now();
    this.files.forEach((f) => {
      f.fresh.observe(null, now);
      f.header = null;
    });
    if (!s) return;
    try {
      s.write(encodeLine({ op: 'stop' }));
    } catch {
      /* закрыт */
    }
    s.end();
  }

  private onData(s: string): void {
    this.inbuf = (this.inbuf + s).slice(-4096);
    let i: number;
    while ((i = this.inbuf.indexOf('\n')) >= 0) {
      const ev = parseEvent(this.inbuf.slice(0, i));
      this.inbuf = this.inbuf.slice(i + 1);
      if (!ev) continue;
      this.bridge = ev;
      this.log('bridge', `bridge ${ev.state}${ev.producer ? ` ${ev.producer} [${ev.views.join(',')}]` : ''}${ev.reason ? `: ${ev.reason}` : ''}`);
    }
  }

  /** Нужды источника для запроса вида (null — источника нет). */
  need(): ProducerNeed | null {
    const b = this.bridge;
    if (!this.connected || !b || !b.producer) return null;
    return { accept: b.accept, request: b.request };
  }

  private served(id: CameraId): boolean {
    const b = this.bridge;
    return !!b && b.views.indexOf(id as BridgeView) >= 0;
  }

  /** Раз в кадр: прочитать заголовки файлов обслуживаемых видов (не чаще HEADER_EVERY_MS). */
  poll(): void {
    if (!this.wanted) return;
    const now = this.deps.now();
    if (now - this.headerAt < HEADER_EVERY_MS) return;
    this.headerAt = now;
    for (const id of PAGE_VIEWS) {
      const f = this.files.get(id)!;
      if (!this.served(id)) {
        f.fresh.observe(null, now);
        f.header = null;
        continue;
      }
      let h: MgvfHeader | null = null;
      let err: string | null = null;
      try {
        const r = this.deps.readHeader(videoPath(id));
        if (!r) err = 'файла кадров нет';
        else if (!r.isFile) err = 'файл кадров — не обычный файл';
        else if (r.uid !== 0) err = `владелец файла кадров uid ${r.uid}, не root (не мост/источник)`;
        else {
          const p = parseMgvf(r.bytes.subarray(0, MGVF_HEADER), r.size);
          if (typeof p === 'string') err = `заголовок: ${p}`;
          else h = p;
        }
      } catch (e) {
        err = `чтение: ${String(e).slice(0, 60)}`;
      }
      f.header = h;
      f.error = err;
      f.fresh.observe(h, now);
    }
  }

  view(id: CameraId): ViewState {
    const v = this.viewNow(id);
    this.log(`view:${id}`, `${id}: ${v.live ? 'live' : v.reason}`);
    return v;
  }

  private viewNow(id: CameraId): ViewState {
    if (!this.wanted) return { live: false, path: null, reason: 'страница не на экране' };
    if (!this.connected) return { live: false, path: null, reason: this.bridgeError ?? 'мост камер: подключение' };
    const b = this.bridge;
    if (!b) return { live: false, path: null, reason: 'мост: нет ответа' };
    if (!b.producer) return { live: false, path: null, reason: `мост: ${b.state}${b.reason ? ` — ${b.reason}` : ''}` };
    if (!this.served(id)) return { live: false, path: null, reason: `источник ${b.producer} не отдаёт вид ${id}` };
    const f = this.files.get(id)!;
    if (!f.header) return { live: false, path: null, reason: f.error ?? 'файл кадров не прочитан' };
    const now = this.deps.now();
    if (!f.fresh.fresh(now)) {
      const age = f.fresh.ageMs(now);
      return { live: false, path: null, reason: age === null ? `кадров ещё не было (мост: ${b.state}${b.reason ? ` — ${b.reason}` : ''})` : `кадры остановились ${Math.round(age / 100) / 10} с назад` };
    }
    return { live: true, path: videoPath(id), reason: '' };
  }

  diagnostics(): { wanted: boolean; connected: boolean; bridge: CtlEvent | null; bridgeError: string | null; views: Record<CameraId, ViewState> } {
    const views = {} as Record<CameraId, ViewState>;
    for (const id of PAGE_VIEWS) views[id] = this.viewNow(id);
    return { wanted: this.wanted, connected: this.connected, bridge: this.bridge, bridgeError: this.bridgeError, views };
  }

  dispose(): void {
    this.wanted = false;
    this.close();
  }
}
