// Файл кадров видео mgu-render (mgu-render 0.6.21 PROTOCOL.md, «Video»; idrive7-apps kit/renderd/PROTOCOL.md): 64-байтный
// заголовок MGVF и nslot кадров I420 (Y, затем U, затем V, строки без выравнивания). Пишет его мост камер
// (native/bridge, root), читает рендерер; приложение читает только заголовок — чтобы рисовать видео, лишь пока
// кадры действительно идут (замершая картинка не выдаётся за живую).
//
//   слово 0 magic 0x4656474d ("MGVF"), 1 версия 1, 2–3 w, h (чётные, 16…2048), 4 seq (кадров записано),
//   5 slot (слот новейшего кадра), 6 nslot (1…4), 7 matrix (0 BT.601, 1 BT.709), 8 range (0 limited, 1 full), 9–15 нули.
// Писатель заполняет слот (slot + 1) % nslot, затем пишет slot, затем seq + 1.

export const MGVF_MAGIC = 0x4656474d;
export const MGVF_HEADER = 64;
export const MGVF_DIR = '/dev/shm';
/** Имя файла кадров вида камеры этого приложения (мост пишет, рендерер и приложение читают). */
export const videoPath = (view: string): string => `${MGVF_DIR}/mgu-video-xop-${view}`;

export interface MgvfHeader {
  readonly w: number;
  readonly h: number;
  readonly seq: number;
  readonly slot: number;
  readonly nslot: number;
  readonly matrix: number;
  readonly range: number;
}

export const frameBytes = (w: number, h: number): number => (w * h * 3) / 2;
export const fileBytes = (w: number, h: number, nslot: number): number => MGVF_HEADER + nslot * frameBytes(w, h);

/** Разбор заголовка; строка — почему недопустим. */
export function parseMgvf(b: Uint8Array, fileSize?: number): MgvfHeader | string {
  if (b.length < MGVF_HEADER) return `заголовок ${b.length} байт`;
  const buf = Buffer.from(b.buffer, b.byteOffset, b.length);
  const w32 = (i: number) => buf.readUInt32LE(i * 4);
  if (w32(0) !== MGVF_MAGIC) return 'не MGVF';
  if (w32(1) !== 1) return `версия ${w32(1)}`;
  const w = w32(2);
  const h = w32(3);
  if (w < 16 || h < 16 || w > 2048 || h > 2048 || w % 2 || h % 2) return `размер ${w}x${h}`;
  const nslot = w32(6);
  if (nslot < 1 || nslot > 4) return `nslot ${nslot}`;
  const slot = w32(5);
  if (slot >= nslot) return `slot ${slot}`;
  const matrix = w32(7);
  const range = w32(8);
  if (matrix > 1 || range > 1) return `matrix/range ${matrix}/${range}`;
  if (fileSize !== undefined && fileSize < fileBytes(w, h, nslot)) return `файл ${fileSize} байт короче заголовка`;
  return { w, h, seq: w32(4), slot, nslot, matrix, range };
}

/** Заголовок для записи. */
export function encodeMgvf(h: MgvfHeader): Buffer {
  const b = Buffer.alloc(MGVF_HEADER);
  [MGVF_MAGIC, 1, h.w, h.h, h.seq >>> 0, h.slot, h.nslot, h.matrix, h.range].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}

/** Ввод-вывод писателя (файл в /dev/shm у моста, буфер в тестах). */
export interface MgvfSink {
  write(data: Uint8Array, position: number): void;
}

/** Писатель файла кадров: слоты по кругу, порядок записи как в протоколе (кадр → slot → seq). */
export class MgvfWriter {
  private seq = 0;
  private slot = 0;
  constructor(
    private readonly sink: MgvfSink,
    readonly w: number,
    readonly h: number,
    readonly nslot = 3,
    readonly matrix = 0,
    readonly range = 1,
  ) {
    if (w < 16 || h < 16 || w > 2048 || h > 2048 || w % 2 || h % 2 || nslot < 1 || nslot > 4) throw new Error(`bad video size ${w}x${h}/${nslot}`);
    sink.write(this.header(), 0);
  }
  get frames(): number {
    return this.seq;
  }
  private header(): Buffer {
    return encodeMgvf({ w: this.w, h: this.h, seq: this.seq, slot: this.slot, nslot: this.nslot, matrix: this.matrix, range: this.range });
  }
  /** Кадр I420 ровно w×h×3/2 байт. */
  write(i420: Uint8Array): void {
    const n = frameBytes(this.w, this.h);
    if (i420.length !== n) throw new Error(`frame ${i420.length} bytes, expected ${n}`);
    const next = (this.slot + 1) % this.nslot;
    this.sink.write(i420, MGVF_HEADER + next * n);
    this.slot = next;
    const s = Buffer.alloc(4);
    s.writeUInt32LE(this.slot, 0);
    this.sink.write(s, 5 * 4);
    this.seq = (this.seq + 1) >>> 0;
    s.writeUInt32LE(this.seq, 0);
    this.sink.write(s, 4 * 4);
  }
}

/**
 * Свежесть по заголовку: кадр считается живым, пока seq растёт; без нового кадра дольше staleMs — «встал»
 * (рендерер показал бы последний кадр бесконечно — приложение тогда видео не рисует).
 */
export class Freshness {
  private lastSeq: number | null = null;
  private changedAt: number | null = null;
  constructor(private readonly staleMs = 1000) {}
  /** Новое чтение заголовка в момент now. */
  observe(h: MgvfHeader | null, now: number): void {
    if (!h) {
      this.lastSeq = null;
      return;
    }
    if (this.lastSeq === null || h.seq !== this.lastSeq) {
      // первое чтение — не доказательство свежести: только изменение seq после него
      if (this.lastSeq !== null) this.changedAt = now;
      else this.changedAt = null;
      this.lastSeq = h.seq;
    }
  }
  fresh(now: number): boolean {
    return this.lastSeq !== null && this.lastSeq > 0 && this.changedAt !== null && now - this.changedAt <= this.staleMs;
  }
  ageMs(now: number): number | null {
    return this.changedAt !== null ? now - this.changedAt : null;
  }
}
