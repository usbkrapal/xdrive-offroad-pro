// Диагностическое чтение (UDS 0x22 через InternalTasu): схемы записей, узкий транспорт, планировщик с идентификацией,
// интеграция в модель. Транспорт — фальшивый signals (proxy/call/on/onAvailable), кадры — в формате TASU.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildManifest } from '../src/manifest';
import { NativeModel } from '../src/model/model';
import { diagnosticsLines, udsLines } from '../src/render/diagnostics';
import { ECUS, recordsFor, type EcuSpec } from '../src/vehicle/uds/ecus';
import { UdsReader, type UdsOutput } from '../src/vehicle/uds/reader';
import {
  decodeExact,
  ACSM_IMU_RAW,
  BDC_FES,
  BDC_LWR_PITCH,
  DSC_PRESSURE,
  DSC_WHEEL_SPEED,
  EGS_OIL,
  EGS_OIL_DA12,
  GHAS_DELTA_N,
  GHAS_FLAGS,
  GHAS_LOCK_TORQUE,
  GHAS_POSITION,
  GHAS_STATE,
  GHAS_TARGET,
  IB_FDR,
  IB_HDC,
  IB_PRESSURE,
  EPS_PINION,
  identityHex,
  LMV_MOMENT,
  VDP_HEIGHTS,
  VDP_LEVEL,
} from '../src/vehicle/uds/records';
import { allowedRead, parseEvent, READ_ALLOWLIST, ReadOnlyTasu, TASU_IFACE, type ReadResult, type TasuSignals } from '../src/vehicle/uds/tasu';
import { FakeTransport, flush } from './helpers';

const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const f32 = (v: number) => Array.from(Buffer.from(new Float32Array([v]).buffer).reverse());
const ok = (p: readonly number[]) => {
  const d = decodeExact(DSC_WHEEL_SPEED, p);
  assert.ok(d.ok, !d.ok ? d.error : '');
  return d.rec;
};

describe('UDS: схемы записей (точная длина, смещения из ширины типов)', () => {
  it('EGS 6000: байт − 40 °C; 255 → вне диапазона; другая длина — ошибка', () => {
    const r = decodeExact(EGS_OIL, [0x5a]);
    assert.ok(r.ok && r.rec.values.oilC === 50);
    const bad = decodeExact(EGS_OIL, [0xff]);
    assert.ok(bad.ok && bad.rec.values.oilC === null);
    assert.deepEqual(decodeExact(EGS_OIL, [0x5a, 0x00]), { ok: false, error: 'длина 2, ожидалась 1' });
  });

  it('DSC DBE4: 19 байт = 5 × int16 BE ÷100 + 5 направлений + 4 качества; качество < 10 % — нет значения; 8 и 14 байт не принимаются', () => {
    const speeds = [1234, -250, 1200, 1210, 1220].flatMap((v) => be16(v & 0xffff));
    const rec = ok([...speeds, 1, 2, 1, 1, 1, 90, 5, 40, 100]);
    assert.equal(rec.values['speed.FL'], 12.34);
    assert.equal(rec.values['speed.FR'], null, 'качество 5 % — сигнала нет');
    assert.match(rec.reasons['speed.FR'], /качество сигнала 5 %/);
    assert.equal(rec.values['speed.RL'], 12);
    assert.match(rec.reasons['speed.RL'], /слабый сигнал \(40 %\)/);
    assert.equal(rec.values['speed.RR'], 12.1);
    assert.equal(rec.values.vehicleKmh, 12.2);
    assert.equal(rec.values['direction.FR'], 2);
    // качество — проценты: байт вне 0…100 (например 255) не «хорошее качество», а недопустимое значение
    const odd = ok([...speeds, 1, 1, 1, 1, 1, 255, 101, 100, 0]);
    assert.equal(odd.values['speed.FL'], null);
    assert.match(odd.reasons['speed.FL'], /255 — вне диапазона 0…100 %/);
    assert.equal(odd.values['speed.FR'], null, '101 — тоже вне диапазона');
    assert.equal(odd.values['speed.RL'], 12, '100 — граница допустима');
    assert.equal(odd.reasons['speed.RL'], undefined);
    assert.equal(decodeExact(DSC_WHEEL_SPEED, speeds.slice(0, 8)).ok, false, 'четыре скорости без остального — не та схема');
    assert.equal(decodeExact(DSC_WHEEL_SPEED, [...speeds, 1, 1, 1, 1]).ok, false);
  });

  it('DSC DBE5: контуры 1/2 ÷10 бар; «колёсные» поля — только сырьё', () => {
    const r = decodeExact(DSC_PRESSURE, [...be16(123), ...be16(-5 & 0xffff), ...be16(10), ...be16(0), ...be16(20), ...be16(0)]);
    assert.ok(r.ok);
    assert.equal(r.rec.values.circuit1Bar, 12.3);
    assert.equal(r.rec.values.circuit2Bar, -0.5);
    assert.equal(r.rec.values.nominalHL, 2);
  });

  it('LMV DB32: 8 байт; квалификатор без описанного смысла — момент НЕ выдаётся (кандидат — только для диагностики)', () => {
    const r = decodeExact(LMV_MOMENT, [...be16(400), ...be16(2), ...be16(-8 & 0xffff), ...be16(2)]);
    assert.ok(r.ok);
    assert.equal(r.rec.values.frontTorqueCandidateNm, 100);
    assert.equal(r.rec.values.targetNm, -2);
    assert.equal(r.rec.values.frontTorqueNm, null);
    assert.match(r.rec.reasons.frontTorqueNm, /квалификатор 0x2/);
  });

  it('VDP DC05: motorola float × 1000 → мм; D8EC — только значения таблицы', () => {
    const r = decodeExact(VDP_HEIGHTS, [...f32(0.0125), ...f32(-0.003), ...f32(Number.NaN), ...f32(0)]);
    assert.ok(r.ok);
    assert.ok(Math.abs((r.rec.values['heightMm.FL'] as number) - 12.5) < 1e-4);
    assert.ok(Math.abs((r.rec.values['heightMm.FR'] as number) + 3) < 1e-4);
    assert.equal(r.rec.values['heightMm.RL'], null);
    const lv = decodeExact(VDP_LEVEL, be16(8));
    assert.ok(lv.ok && lv.rec.values.level === 8);
    const odd = decodeExact(VDP_LEVEL, be16(4));
    assert.ok(odd.ok && odd.rec.values.level === null);
  });

  it('EPS DB57: 7 байт (long, int, char); угол шестерни — только при состоянии 3', () => {
    const angle = 12345;
    const p = [(angle >>> 24) & 255, (angle >>> 16) & 255, (angle >>> 8) & 255, angle & 255, ...be16(40)];
    const good = decodeExact(EPS_PINION, [...p, 3]);
    assert.ok(good.ok && good.rec.values.pinionDeg === 123.45);
    const bad = decodeExact(EPS_PINION, [...p, 255]);
    assert.ok(bad.ok && bad.rec.values.pinionDeg === null && bad.rec.values.pinionCandidateDeg === 123.45);
  });

  it('идентификация: SGBD-индекс шестнадцатеричной строкой', () => {
    assert.equal(identityHex([0x0f, 0x25, 0xd0]), '0F25D0');
  });
});

/* ---------------- фальшивый InternalTasu ---------------- */

interface Call {
  method: string;
  params: Record<string, unknown>;
}
type Responder = (ecu: number, did: number) => (readonly number[] | 'none' | { nrc: number } | 'pending')[];

const frame = (ecu: number, uds: readonly number[]) => ({ errorCode: 'NO_ERROR', udsResponse: [0, 0, 0, 0, 0, 0, ecu, 0xf2, 0, ...uds] });

function fakeTasu(respond: Responder, opts: { verdicts?: string[]; available?: boolean } = {}) {
  const calls: Call[] = [];
  let emit: ((v: unknown) => void) | null = null;
  let avail: ((a: boolean) => void) | null = null;
  const verdicts = opts.verdicts ? opts.verdicts.slice() : [];
  const signals: TasuSignals = {
    proxy: (iface) => (iface === TASU_IFACE ? Promise.resolve({}) : Promise.reject(new Error('iface'))),
    on: (_p, _n, fn) => ((emit = fn), Promise.resolve()),
    onAvailable: (_p, fn) => ((avail = fn), fn(opts.available !== false), Promise.resolve()),
    call: (_p, method, params) => {
      calls.push({ method, params });
      const verdict = verdicts.length ? verdicts.shift()! : 'NO_ERROR';
      if (verdict === 'NO_ERROR') {
        const ecu = params.targetAddress as number;
        const d = Array.from(params.udsData as Buffer);
        const did = (d[0] << 8) | d[1];
        setTimeout(() => {
          for (const r of respond(ecu, did)) {
            if (r === 'none') continue;
            if (r === 'pending') emit!(frame(ecu, [0x7f, 0x22, 0x78]));
            else if (!Array.isArray(r)) emit!(frame(ecu, [0x7f, 0x22, (r as { nrc: number }).nrc]));
            else emit!(frame(ecu, [0x62, d[0], d[1], ...(r as number[])]));
          }
        }, 2);
      }
      return Promise.resolve({ TasuErrorEnum: verdict });
    },
  };
  return { signals, calls, emit: (v: unknown) => emit!(v), setAvailable: (a: boolean) => avail!(a) };
}

const FAST = { callTimeoutMs: 200, replyTimeoutMs: 40, hardTimeoutMs: 150, busyRetryMs: 5 };

describe('UDS: узкий транспорт чтения', () => {
  it('запрос: только 0x22 от 0xF2 к блоку, DID в udsData; ответ блока разобран', async () => {
    const f = fakeTasu(() => [[0x5a]]);
    const t = await new ReadOnlyTasu(f.signals, FAST).init();
    assert.deepEqual(await t.read(0x18, 0x6000), { kind: 'ok', payload: [0x5a] });
    const p = f.calls[0].params;
    assert.equal(f.calls[0].method, 'sendTasuRequest');
    assert.deepEqual([p.sourceAddress, p.targetAddress, p.serviceID, p.subroutineID, p.udsDataLength, Array.from(p.udsData as Buffer)], [0xf2, 0x18, 0x22, 0, 2, [0x60, 0x00]]);
  });

  it('запрещённое чтение отвергается до транспорта; разрешённые пары — ровно записи блоков + F150', async () => {
    const f = fakeTasu(() => [[1]]);
    const t = await new ReadOnlyTasu(f.signals, FAST).init();
    await assert.rejects(() => t.read(0x18, 0x4110), /not allowed/);
    await assert.rejects(() => t.read(0xdf, 0xf150), /not allowed/, 'функциональный адрес');
    assert.equal(f.calls.length, 0);
    for (const e of ECUS) {
      const dids = new Set([0xf150, ...e.records.map((r) => r.schema.did)]);
      for (const k of Object.keys(e.variants ?? {})) for (const r of e.variants![k]) dids.add(r.schema.did);
      assert.deepEqual([...READ_ALLOWLIST[e.addr]].sort(), [...dids].sort(), e.key);
    }
    assert.deepEqual(Object.keys(READ_ALLOWLIST).map(Number).sort(), ECUS.map((e) => e.addr).sort());
    assert.equal(allowedRead(0x29, 0xdbe4), true);
  });

  it('строго по одному: второй запрос уходит только после ответа на первый', async () => {
    const f = fakeTasu(() => [[1]]);
    const t = await new ReadOnlyTasu(f.signals, FAST).init();
    const a = t.read(0x18, 0xf150);
    const b = t.read(0x29, 0xf150);
    await flush();
    assert.equal(f.calls.length, 1);
    await a;
    await b;
    assert.equal(f.calls.length, 2);
  });

  it('NRC, «ответ задерживается» → ответ, нет ответа (в пределах), чужие кадры игнорируются', async () => {
    const f = fakeTasu((ecu, did) => (did === 0xdb32 ? [{ nrc: 0x31 }] : did === 0x6000 ? ['pending', [0x50]] : ecu === 0x29 ? ['none'] : [[1]]));
    const t = await new ReadOnlyTasu(f.signals, FAST).init();
    assert.deepEqual(await t.read(0x19, 0xdb32), { kind: 'nrc', nrc: 0x31 });
    assert.deepEqual(await t.read(0x18, 0x6000), { kind: 'ok', payload: [0x50] });
    const started = Date.now();
    assert.deepEqual(await t.read(0x29, 0xdbe4), { kind: 'timeout' });
    assert.ok(Date.now() - started < 400, 'ограничено');
    // кадр другого блока и ответ на другой DID не завершают запрос
    const p = t.read(0x18, 0xf150);
    await flush();
    f.emit(frame(0x29, [0x62, 0xf1, 0x50, 9]));
    f.emit(frame(0x18, [0x62, 0x60, 0x00, 9]));
    assert.deepEqual(await p, { kind: 'ok', payload: [1] });
    assert.equal(t.stats.nrc, 1);
    assert.equal(t.stats.timeouts, 1);
  });

  it('«транспорт занят» — один повтор; отказ транспорта — без ответа; close() завершает ожидание', async () => {
    const f = fakeTasu(() => [[7]], { verdicts: ['APP_REQUEST_TEMPORARILY_NOT_ACCEPTED', 'NO_ERROR', 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED', 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED', 'NOT_ALLOWED'] });
    const t = await new ReadOnlyTasu(f.signals, FAST).init();
    assert.deepEqual(await t.read(0x18, 0xf150), { kind: 'ok', payload: [7] });
    assert.equal((await t.read(0x18, 0xf150)).kind, 'refused', 'второй «занят» подряд — отказ, без третьей попытки');
    assert.equal((await t.read(0x18, 0xf150)).kind, 'refused');
    assert.equal(f.calls.length, 5);
    const g = fakeTasu(() => ['none']);
    const u = await new ReadOnlyTasu(g.signals, { ...FAST, replyTimeoutMs: 10000, hardTimeoutMs: 10000 }).init();
    const p = u.read(0x18, 0xf150);
    await new Promise((r) => setTimeout(r, 10));
    u.close();
    assert.deepEqual(await p, { kind: 'closed' });
    assert.deepEqual(await u.read(0x18, 0xf150), { kind: 'closed' });
  });

  it('событие: отказ транспорта, ошибка, короткий кадр', () => {
    assert.deepEqual(parseEvent({ errorCode: 'TIMEOUT' }), { kind: 'error', text: 'TIMEOUT' });
    assert.deepEqual(parseEvent({ udsResponse: [0, 0, 0x7f, 0, 0x22] }), { kind: 'reject', code: 0x22 });
    assert.deepEqual(parseEvent({ udsResponse: [1, 2, 3] }), { kind: 'short' });
  });
});

/* ---------------- планировщик ---------------- */

const IDS: Record<number, number[]> = { 0x18: [0x0f, 0x25, 0xd0], 0x29: [0x0f, 0x28, 0x50], 0x76: [0x0f, 0x99, 0x01], 0x19: [0x0f, 0x77, 0x77] };

function carResponder(over: Partial<Record<string, readonly number[] | { nrc: number } | 'none'>> = {}): Responder {
  const wheels = [...be16(1500), ...be16(1510), ...be16(1490), ...be16(1505), ...be16(1500), 1, 1, 1, 1, 1, 100, 100, 100, 100];
  const base: Record<string, readonly number[]> = {
    '18:6000': [0x82],
    '29:dbe4': wheels,
    '29:dbe5': [...be16(150), ...be16(140), 0, 0, 0, 0, 0, 0, 0, 0],
    '76:dc05': [...f32(0.01), ...f32(0.01), ...f32(0.01), ...f32(0.01)],
    '76:dc06': [0, 0, 0, 0, 0, 0, 0, 0],
    '76:dc31': [1, 1, 1, 1],
    '76:d8ec': be16(8),
    '19:db32': [...be16(400), 0, 2, 0, 0, 0, 2],
  };
  return (ecu, did) => {
    const k = `${ecu.toString(16)}:${did.toString(16)}`;
    if (k in over) return [over[k] as never];
    if (did === 0xf150) return IDS[ecu] ? [IDS[ecu]] : ['none'];
    return base[k] ? [base[k]] : [{ nrc: 0x31 }];
  };
}

/** Пять блоков исходных тестов (EGS, LMV, DSC, EPS, VDP); полный рабочий набор — ECUS. */
const FIVE = ECUS.filter((e) => ['EGS', 'LMV', 'DSC', 'EPS', 'VDP'].indexOf(e.key) >= 0);

async function readerRig(respond: Responder, specs: readonly EcuSpec[] = FIVE) {
  const f = fakeTasu(respond);
  const t = await new ReadOnlyTasu(f.signals, FAST).init();
  let now = 0;
  const out: UdsOutput[] = [];
  const r = new UdsReader(t, () => now, (o) => out.push(o), undefined, { specs });
  (r as unknown as { running: boolean }).running = true;
  const steps = async (n: number) => {
    for (let i = 0; i < n; i++) await r.step();
  };
  return { f, t, r, out, steps, at: (v: number) => (now = v) };
}

describe('UDS: идентификация и планировщик', () => {
  it('сначала идентификация; опознанные EGS/DSC — значения в сигналы; VDP/LMV без доказанного варианта — только диагностика', async () => {
    const { f, r, out, steps } = await readerRig(carResponder());
    await steps(5);
    assert.deepEqual(f.calls.slice(0, 5).map((c) => Array.from(c.params.udsData as Buffer).join(',')), Array(5).fill('241,80'), 'первые запросы — F150 к каждому блоку');
    await steps(12);
    const val = (id: string) => out.filter((o) => o.target.id === id).slice(-1)[0];
    assert.equal(val('temperature.gearboxC').value, 90);
    assert.equal(val('wheelSpeed.FL').value, 15);
    assert.equal(val('brakePressure.circuit1').value, 15);
    for (const id of ['rideHeightSensor.FL', 'xdrive.frontTorqueNm', 'ehcLevel']) {
      const o = val(id);
      assert.ok(o && o.value === null && o.absent, `${id}: нет значения`);
      assert.match(String(o.reason), /вариант 0F/, `${id}: причина — неподтверждённый вариант`);
    }
    const d = r.diagnostics();
    const vdp = d.find((e) => e.key === 'VDP')!;
    assert.equal(vdp.state, 'unverified');
    assert.equal(vdp.identity, '0F9901');
    const dc05 = vdp.records.find((x) => x.did === 'DC05')!;
    assert.ok(dc05.lastRaw && dc05.values, 'сырые байты и разбор-кандидат сохранены');
    const eps = d.find((e) => e.key === 'EPS')!;
    assert.equal(eps.state, 'failed', 'не ответил на F150');
    assert.match(String(eps.reason), /нет ответа/);
    const lines = udsLines(0, { available: true, error: null, visible: true, stats: { requests: 1, ok: 1, nrc: 0, timeouts: 0, refused: 0, busyRetries: 0, lastError: null }, ecus: d, extraReasons: {} });
    assert.ok(lines.some((l) => l.label === '      кандидат (вариант не подтверждён)'));
    assert.ok(lines.some((l) => l.value.includes('F150 0F25D0')));
  });

  it('неопознанный вариант: его записи — не чаще раза в 30 с; неответивший блок — повтор идентификации с паузой', async () => {
    const { f, steps, at } = await readerRig(carResponder());
    at(0);
    await steps(30);
    const count = (ecu: number, did: number) => f.calls.filter((c) => c.params.targetAddress === ecu && Array.from(c.params.udsData as Buffer).join() === `${did >> 8},${did & 255}`).length;
    assert.equal(count(0x76, 0xdc05), 1, 'VDP DC05 один раз до 30 с');
    assert.equal(count(0x30, 0xf150), 1, 'EPS F150 повторится только через 5 с');
    at(5000);
    await steps(3);
    assert.equal(count(0x30, 0xf150), 2);
    at(31000);
    await steps(25);
    assert.equal(count(0x76, 0xdc05), 2);
  });

  it('NRC у опознанного блока — «нет данных» с причиной, запись реже; неверная длина — недопустимо', async () => {
    const { out, steps } = await readerRig(carResponder({ '18:6000': { nrc: 0x31 }, '29:dbe4': [1, 2, 3, 4, 5, 6, 7, 8] }));
    await steps(15);
    const g = out.filter((o) => o.target.id === 'temperature.gearboxC').slice(-1)[0];
    assert.equal(g.value, null);
    assert.match(String(g.reason), /NRC 31/);
    const w = out.filter((o) => o.target.id === 'wheelSpeed.FL').slice(-1)[0];
    assert.equal(w.absent, false);
    assert.match(String(w.reason), /длина 8, ожидалась 19/);
  });

  it('без экрана — ни одного запроса; stop() закрывает транспорт', async () => {
    const f = fakeTasu(carResponder());
    const t = await new ReadOnlyTasu(f.signals, FAST).init();
    const r = new UdsReader(t, () => 0, () => undefined, (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 5))));
    r.setVisible(false);
    r.start();
    await new Promise((ok) => setTimeout(ok, 60));
    assert.equal(f.calls.length, 0);
    r.setVisible(true);
    await new Promise((ok) => setTimeout(ok, 80));
    assert.ok(f.calls.length > 0);
    await r.stop();
    const n = f.calls.length;
    await new Promise((ok) => setTimeout(ok, 40));
    assert.equal(f.calls.length, n);
    assert.equal(t.available, false);
  });
});

describe('журнал приложения (обычный режим): только переходы, ограниченно', () => {
  it('UDS: вердикт идентификации и первый ответ — по разу; ошибка — при смене текста; восстановление — снова ok; сырьё ≤ 32 байт', async () => {
    let fail: { nrc: number } | null = null;
    const base = carResponder();
    const respond: Responder = (ecu, did) => (ecu === 0x29 && did === 0xdbe4 && fail ? [fail] : base(ecu, did));
    const f = fakeTasu(respond);
    const t = await new ReadOnlyTasu(f.signals, FAST).init();
    let now = 0;
    const lines: string[] = [];
    const log = { info: (m: unknown) => lines.push(`I ${String(m)}`), warn: (m: unknown) => lines.push(`W ${String(m)}`) };
    const r = new UdsReader(t, () => now, () => undefined, undefined, { log });
    (r as unknown as { running: boolean }).running = true;
    const run = async (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 500;
        await r.step();
      }
    };
    await run(40);
    const dbe4 = () => lines.filter((l) => l.includes('uds DSC DBE4'));
    assert.equal(lines.filter((l) => l.includes('F150 0F2850 -> accepted')).length, 1, 'вердикт DSC — один раз');
    assert.ok(lines.some((l) => /F150 0F9901 -> unverified/.test(l)), 'неопознанный вариант записан');
    assert.ok(lines.some((l) => l.startsWith('W uds EPS 0x30: identification failed')), 'неопознанный блок записан');
    assert.equal(dbe4().length, 1, 'десятки чтений — одна строка');
    assert.match(dbe4()[0], /^I uds DSC DBE4: ok raw 05 DC/);
    assert.ok(lines.some((l) => /uds VDP DC05: ok raw .* candidate heightMm\.FL=/.test(l)), 'у неопознанного блока — разбор-кандидат');
    fail = { nrc: 0x22 };
    await run(20);
    fail = null;
    await run(80); // после NRC запись читается реже (30 с)
    assert.deepEqual(dbe4().map((l) => l.slice(0, 26)), ['I uds DSC DBE4: ok raw 05 ', 'W uds DSC DBE4: NRC 22', 'I uds DSC DBE4: ok raw 05 ']);
    for (const l of lines) assert.ok(l.length <= 242, `строка ограничена: ${l.length}`);
    const before = lines.length;
    await run(40);
    assert.equal(lines.length, before, 'устойчивое состояние — ни строки');
  });

  it('SOME/IP: первый отсчёт поля — один раз; сводка — интервалы, источник и сырьё руля, ограниченно', async () => {
    const tr = new FakeTransport();
    const lines: string[] = [];
    let t = 0;
    const log = { info: (m: unknown) => lines.push(String(m)), warn: (m: unknown) => lines.push(String(m)), error: () => undefined };
    const model = new NativeModel({ now: () => t, watch: tr.watch, log }, 'vehicle');
    await flush();
    try {
      for (let i = 0; i < 20; i++) {
        t += 100;
        tr.feed('de.bmw.chassis.SteeringAngle', 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 1000 + i, vehicleIdentificationNumber: 'WBA00000000000000' });
      }
      tr.feed('de.bmw.chassis.SteeringAngle', 'actualSteeringAngleDriverNoCRC', { actualValueSteeringAngleDriver: 32696 });
      const first = lines.filter((l) => l.includes('SteeringAngle.ActualSteeringAngleDriver: first sample'));
      assert.equal(first.length, 1);
      assert.match(first[0], /\{"actualValueSteeringAngleDriver":1000\}/);
      (model as unknown as { source: { logSummary(): void } }).source.logSummary();
      const sum = lines.filter((l) => l.startsWith('signal intervals') || l.startsWith('steering source'));
      assert.equal(sum.length, 2);
      assert.match(sum[0], /ActualSteeringAngleDriver=100\/100ms/);
      assert.match(sum[1], /steering source ActualSteeringAngleDriver; latest raw .*1019.*actualSteeringAngleDriverNoCRC=\{"actualValueSteeringAngleDriver":32696\}/);
      assert.ok(!lines.some((l) => l.includes('WBA0')), 'идентификатор не попадает в журнал');
    } finally {
      model.dispose();
    }
  });
});

describe('UDS: модель и интерфейс', () => {
  it('модель: EGS → температура масла АКПП, DSC → скорости колёс и давление контуров; VDP — нет данных; источник поля виден', async () => {
    // блоки, которых нет в этой подделке (GHAS, BDC, ACSM), отвечают отказом сразу: иначе каждый держит реальную шину 1,5 с
    const f = fakeTasu(carResponder({ '30:f150': { nrc: 0x11 }, 'f:f150': { nrc: 0x11 }, '40:f150': { nrc: 0x11 }, '1:f150': { nrc: 0x11 } }));
    let t = 1000;
    const model = new NativeModel({ now: () => t, watch: new FakeTransport().watch, tasu: f.signals }, 'vehicle');
    model.setVisible(true);
    try {
      const done = () => {
        const s = model.getState().snapshot;
        return s.signals['temperature.gearboxC'].value !== null && s.signals['wheelSpeed.FL'].value !== null && s.extra['brakePressure.circuit1'].value !== null && !!model.diagnostics()!.uds!.extraReasons['rideHeightSensor.FL'];
      };
      for (let i = 0; i < 300 && !done(); i++) {
        await new Promise((ok) => setTimeout(ok, 20));
        t += 20;
      }
      const s = model.getState().snapshot;
      assert.equal(s.signals['temperature.gearboxC'].value, 90);
      assert.equal(s.signals['wheelSpeed.FL'].value, 15);
      assert.equal(s.extra['brakePressure.circuit1'].value, 15);
      assert.equal(s.extra['rideHeightSensor.FL'].quality, 'unavailable');
      const d = model.diagnostics()!;
      assert.equal(d.sources['temperature.gearboxC'], 'UDS EGS 6000');
      assert.ok(d.uds && d.uds.ecus.some((e) => e.key === 'EGS' && e.state === 'accepted'));
      assert.match(String(d.uds!.extraReasons['rideHeightSensor.FL']), /вариант 0F9901/);
      const lines = diagnosticsLines(d);
      assert.ok(lines.some((l) => l.label === 'EGS 0x18'));
    } finally {
      model.dispose();
    }
  });

  it('модель без экрана — запросов нет; демо — транспорт не создаётся', async () => {
    const f = fakeTasu(carResponder());
    const model = new NativeModel({ now: () => 0, watch: new FakeTransport().watch, tasu: f.signals }, 'vehicle');
    model.setVisible(false);
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(f.calls.length, 0);
    model.dispose();
    const g = fakeTasu(carResponder());
    const demo = new NativeModel({ now: () => 0, watch: new FakeTransport().watch, tasu: g.signals }, 'demo');
    demo.setVisible(true);
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(g.calls.length, 0);
    demo.dispose();
  });

  it('app.json: InternalTasu — ровно один метод и одно событие, как у MIT car_vitals', () => {
    const m = buildManifest() as { signals: Record<string, Record<string, unknown>> };
    assert.deepEqual(m.signals[TASU_IFACE], {
      _optional: m.signals[TASU_IFACE]._optional,
      _instances: 'SystemFunctionsInternalTasuInst1',
      _methods: ['sendTasuRequest'],
      _broadcasts: ['sendTasuResponse'],
    });
  });
});

describe('педаль: от уведомления до снимка кадра — без таймера модели', () => {
  it('новое значение педали видно в getState() сразу после уведомления', async () => {
    const tr = new FakeTransport();
    let t = 0;
    const model = new NativeModel({ now: () => t, watch: tr.watch }, 'vehicle');
    await flush();
    try {
      model.getState();
      t += 5; // 5 мс, задолго до 100-мс тика
      tr.feed('de.bmw.powertrain.AcceleratorPedal', 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 1200 });
      assert.equal(model.getState().snapshot.signals.acceleratorPedalPercent.value, 30);
      tr.feed('de.bmw.powertrain.AcceleratorPedal', 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 2000 });
      assert.equal(model.getState().snapshot.signals.acceleratorPedalPercent.value, 50);
      t += 70;
      tr.feed('de.bmw.powertrain.AcceleratorPedal', 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 2400 });
      const pedal = model.diagnostics()!.interfaces.find((i) => i.iface === 'de.bmw.powertrain.AcceleratorPedal')!.fields[0];
      assert.deepEqual(pedal.intervalMs, { median: 70, max: 70, n: 2 }, 'интервалы уведомлений измерены');
    } finally {
      model.dispose();
    }
  });
});

export type { ReadResult };

/* ---------------- варианты G05-семейства, GHAS, BDC (integration-corrections.md §7) ---------------- */

const dec = (schema: Parameters<typeof decodeExact>[0], p: readonly number[]) => {
  const d = decodeExact(schema, p);
  assert.ok(d.ok, !d.ok ? d.error : '');
  return d.rec;
};

describe('UDS: схемы вариантов (точные длины, недопустимое — до масштаба)', () => {
  it('DBE4: границы качества 9/10/50/51; > 100 — вне диапазона; знак сохраняется; Δ к опорной — только при качестве > 50 на всех', () => {
    const r = dec(DSC_WHEEL_SPEED, [...be16(1000), ...be16(1000), ...be16(1000), ...be16(1000), ...be16(1000), 1, 1, 1, 1, 1, 9, 10, 50, 51]);
    assert.equal(r.values['speed.FL'], null);
    assert.match(r.reasons['speed.FL'], /сигнала нет/);
    assert.equal(r.values['speed.FR'], 10);
    assert.match(r.reasons['speed.FR'], /слабый/);
    assert.equal(r.values['speed.RL'], 10);
    assert.equal(r.values['speed.RR'], 10);
    assert.equal(r.reasons['speed.RR'], undefined);
    assert.equal(r.values['deltaPct.RR'], null, 'одно колесо со слабым сигналом — оценки нет');
    const q101 = dec(DSC_WHEEL_SPEED, [...be16(1000), ...be16(1000), ...be16(1000), ...be16(1000), ...be16(1000), 1, 1, 1, 1, 1, 101, 60, 60, 60]);
    assert.match(q101.reasons['speed.FL'], /вне диапазона 0…100/);
    const rev = dec(DSC_WHEEL_SPEED, [0xff, 0x9c, ...be16(0), ...be16(0), ...be16(0), ...be16(0), 2, 0, 0, 0, 2, 80, 80, 80, 80]);
    assert.equal(rev.values['speed.FL'], -1, 'знаковое, не abs');
    assert.equal(rev.values['deltaPct.FL'], null, 'назад — оценки нет');
    const fwd = dec(DSC_WHEEL_SPEED, [...be16(2200), ...be16(2000), ...be16(2000), ...be16(2000), ...be16(2000), 1, 1, 1, 1, 1, 80, 80, 80, 80]);
    assert.equal(fwd.values['deltaPct.FL'], 10);
    assert.equal(fwd.values['deltaPct.FR'], 0);
    assert.deepEqual(decodeExact(DSC_WHEEL_SPEED, new Array(18).fill(0)), { ok: false, error: 'длина 18, ожидалась 19' });
    assert.deepEqual(decodeExact(DSC_WHEEL_SPEED, new Array(20).fill(0)), { ok: false, error: 'длина 20, ожидалась 19' });
  });

  it('GSZFB1 DA12: 2 байта, signed, −48; 00 FD = 205; FF FF / 00 FE — недопустимо; 1 байт — отказ; 00 00 — заполнитель', () => {
    assert.equal(dec(EGS_OIL_DA12, [0x00, 0x44]).values.oilC, 20);
    assert.equal(dec(EGS_OIL_DA12, [0x00, 0xfd]).values.oilC, 205);
    assert.equal(dec(EGS_OIL_DA12, [0x00, 0xfe]).values.oilC, null);
    assert.equal(dec(EGS_OIL_DA12, [0xff, 0xff]).values.oilC, null);
    assert.equal(dec(EGS_OIL_DA12, [0x44, 0x00]).values.oilC, null, 'перестановка байт не проходит');
    assert.equal(dec(EGS_OIL_DA12, [0x00, 0x00]).values.oilC, null);
    assert.ok(!decodeExact(EGS_OIL_DA12, [0x44]).ok);
  });

  it('IB_G05 DB29: ГТЦ и система ÷10 бар; перестановка байт — вне диапазона', () => {
    const r = dec(IB_PRESSURE, [...be16(125), ...be16(1500)]);
    assert.equal(r.values.tmcBar, 12.5);
    assert.equal(r.values.systemBar, 150);
    assert.equal(dec(IB_PRESSURE, [0x64, 0x00, 0, 0]).values.tmcBar, null);
  });

  it('состояния функций: квалификаторы без опубликованного смысла — известный код только кандидат; неизвестный код и 0xFF — нет', () => {
    for (const q of [[0, 0], [0x12, 0x34], [0xff, 0xff]]) {
      const w = dec(IB_FDR, [3, q[0], q[1]]);
      assert.equal(w.values.status, null, 'в показ не идёт ни при каких квалификаторах');
      assert.equal(w.values.statusCandidate, 3);
      assert.equal(w.values.qualifier, q[0]);
      assert.equal(w.values.qualifierExt, q[1]);
      assert.match(w.reasons.status, /только кандидат/);
    }
    const u = dec(IB_FDR, [2, 0, 0]);
    assert.equal(u.values.statusCandidate, null);
    assert.match(u.reasons.status, /неизвестный код 2/);
    assert.equal(dec(IB_FDR, [0xff, 0, 0]).values.statusCandidate, null);
    assert.equal(dec(IB_HDC, [1, 0, 0]).values.statusCandidate, 1, 'HDC: доступность (кандидат)');
  });

  it('GHAS: 4007 FF/19; 401B FF/FE; DC4C 100 Нм; 4012 FF/0/11; 4013 таблица; флаги', () => {
    assert.equal(dec(GHAS_POSITION, [0xff]).values.positionInc, null);
    assert.equal(dec(GHAS_POSITION, [0x19]).values.positionInc, 0);
    assert.equal(dec(GHAS_DELTA_N, [0xff]).values.deltaRpm, null);
    assert.equal(dec(GHAS_DELTA_N, [0xfe]).values.deltaRpm, -4);
    assert.equal(dec(GHAS_LOCK_TORQUE, be16(100)).values.torqueNm, 100);
    assert.equal(dec(GHAS_LOCK_TORQUE, be16(0x6400)).values.torqueNm, null, 'перестановка байт — вне 0…2500');
    assert.equal(dec(GHAS_TARGET, [0xff]).values.targetNm, null);
    assert.equal(dec(GHAS_TARGET, [0]).values.targetNm, null);
    assert.equal(dec(GHAS_TARGET, [11]).values.targetNm, 100);
    assert.equal(dec(GHAS_STATE, [2]).values.state, 2);
    assert.match(dec(GHAS_STATE, [7]).reasons.state, /неизвестное состояние 7/);
    const fl = dec(GHAS_FLAGS[0], [0x00, 0x10]);
    assert.equal(fl.values.flags, 0x10);
    assert.match(fl.reasons.flags, /не опубликовано/);
  });

  it('BDC D54D: 14 байт; тангаж к осям только при источнике 1…3 и квалификаторе 22; ACSM 4101 — только длина', () => {
    const lwr = (src: number, q: number, pitch: number) => [...be16(0), ...be16(0), src, q, ...be16(pitch & 0xffff), ...be16(0), ...be16(-50 & 0xffff), ...be16(-50 & 0xffff)];
    assert.equal(dec(BDC_LWR_PITCH, lwr(1, 22, -125)).values.pitchDeg, -1.25);
    assert.match(dec(BDC_LWR_PITCH, lwr(0, 22, 100)).reasons.pitchDeg, /источник/);
    assert.match(dec(BDC_LWR_PITCH, lwr(1, 21, 100)).reasons.pitchDeg, /квалификатор 21/);
    assert.equal(dec(BDC_LWR_PITCH, lwr(1, 22, 100)).values.vertLeftDeg, -0.5);
    assert.ok(!decodeExact(BDC_LWR_PITCH, new Array(13).fill(0)).ok);
    const raw = decodeExact(ACSM_IMU_RAW, new Array(30).fill(1));
    assert.ok(raw.ok && raw.rec.values.length === 30 && Object.keys(raw.rec.values).length === 1, 'никакого разбора, только длина');
  });

  it('BDC E468: таблица режимов; 0x3F недопустимо; неизвестный код', () => {
    assert.equal(dec(BDC_FES, [0x0d]).values.mode, 0x0d);
    assert.equal(dec(BDC_FES, [0x3f]).values.mode, null);
    assert.match(dec(BDC_FES, [0x30]).reasons.mode, /неизвестный код 48/);
  });
});

describe('UDS: записи по варианту и ответ «нет ответа»', () => {
  const G07: Record<number, number[]> = { 0x18: [0x0f, 0x21, 0xd0], 0x29: [0x0f, 0x25, 0x00], 0x0f: [0x0f, 0x17, 0x20], 0x40: [0x0f, 0x26, 0x80] };
  function g07(ghasState = 2): Responder {
    const wheels = [...be16(1500), ...be16(1510), ...be16(1490), ...be16(1505), ...be16(1500), 1, 1, 1, 1, 1, 100, 100, 100, 100];
    const base: Record<string, readonly number[]> = {
      '18:da12': [0x00, 0x86],
      '29:dbe4': wheels,
      '29:db29': [...be16(10), ...be16(1500)],
      '29:dc6e': [3, 0, 0],
      '29:dc6d': [3, 0, 0],
      '29:dc6c': [1, 0, 0],
      '29:dc70': [1, 0, 0],
      'f:4013': [ghasState],
      'f:dc4c': be16(300),
      'f:4012': [21],
      'f:4007': [0x30],
      'f:401b': [2],
      'f:dc47': be16(40),
      'f:400f': [0, 0],
      'f:4014': [0, 0],
      'f:4015': [0, 0],
      'f:4016': [0, 0],
      '40:e468': [0x0c],
    };
    return (ecu, did) => {
      const k = `${ecu.toString(16)}:${did.toString(16)}`;
      if (did === 0xf150) return G07[ecu] ? [G07[ecu]] : ['none'];
      return base[k] ? [base[k]] : [{ nrc: 0x31 }];
    };
  }
  const reqs = (f: ReturnType<typeof fakeTasu>, ecu: number) =>
    f.calls.filter((c) => c.params.targetAddress === ecu).map((c) => {
      const d = Array.from(c.params.udsData as Buffer);
      return ((d[0] << 8) | d[1]).toString(16);
    });

  it('IB_G05 (0F2500): DBE4/DB29/DC6x, никогда DBE5; GSZFB1 (0F21D0): DA12, никогда 6000; значения в сигналы и величины', async () => {
    const { f, out, steps } = await readerRig(g07(), ECUS);
    await steps(80);
    const dsc = reqs(f, 0x29);
    assert.ok(dsc.indexOf('dbe4') >= 0 && dsc.indexOf('db29') >= 0 && dsc.indexOf('dc6e') >= 0 && dsc.indexOf('dc70') >= 0);
    assert.equal(dsc.indexOf('dbe5'), -1);
    const egs = reqs(f, 0x18);
    assert.ok(egs.indexOf('da12') >= 0);
    assert.equal(egs.indexOf('6000'), -1);
    const val = (id: string) => out.filter((o) => o.target.id === id).slice(-1)[0];
    assert.equal(val('temperature.gearboxC').value, 86);
    assert.equal(val('wheelSpeed.FL').value, 15);
    assert.equal(val('brakePressure.system').value, 150);
    assert.equal(val('dsc.fdr').value, null, 'кандидат: квалификаторы не опубликованы');
    assert.match(String(val('dsc.fdr').reason), /только кандидат/);
    assert.equal(val('hdc.available').value, null);
    assert.equal(val('driveMode').value, 0x0c);
    assert.equal(val('rearLock.torqueNm').value, 300);
    assert.equal(val('rearLock.targetNm').value, 200);
    assert.equal(val('rearLock.oilC').value, 40);
    assert.equal(recordsFor(ECUS.find((e) => e.key === 'DSC')!, '0F2850').some((r) => r.schema.did === 0xdbe5), true, 'G30N — прежний набор');
  });

  it('GHAS не в «работе» — значения скрыты с состоянием; блок без ответа на F150 — «нет ответа», не «не установлен»', async () => {
    const { r, out, steps } = await readerRig(g07(1), ECUS);
    await steps(80);
    const t = out.filter((o) => o.target.id === 'rearLock.torqueNm').slice(-1)[0];
    assert.equal(t.value, null);
    assert.match(String(t.reason), /не в работе \(инициализация\)/);
    const d = r.diagnostics();
    const vdp = d.find((e) => e.key === 'VDP')!;
    assert.equal(vdp.state, 'failed');
    assert.match(String(vdp.reason), /нет ответа/);
    assert.doesNotMatch(JSON.stringify(d), /не установлен/);
  });
});

/* ---------------- расписание: измеренная нагрузка шины (виртуальное время) ---------------- */

describe('UDS: расписание на последовательной шине (G07, виртуальное время)', () => {
  /** Ответы G07: опознаны DSC IB_G05, EGS GSZFB1, EPS, LMV, VDP, BDC; GHAS и ACSM молчат (не отвечают вообще). */
  function g07Bus(opts: { latencyMs: number; silentDid?: string }) {
    const ID: Record<number, number[]> = {
      0x29: [0x0f, 0x25, 0x00],
      0x18: [0x0f, 0x21, 0xd0],
      0x30: [0x0f, 0x25, 0x80],
      0x19: [0x0f, 0x21, 0x80],
      0x76: [0x0f, 0x1f, 0x50],
      0x40: [0x0f, 0x26, 0x80],
    };
    const wheels = [...be16(1500), ...be16(1510), ...be16(1490), ...be16(1505), ...be16(1500), 1, 1, 1, 1, 1, 100, 100, 100, 100];
    const data: Record<string, readonly number[]> = {
      '29:dbe4': wheels,
      '29:db29': [...be16(2), ...be16(0)],
      '29:dc6e': [1, 0, 0],
      '29:dc6d': [1, 0, 0],
      '29:dc6c': [1, 0, 0],
      '29:dc70': [1, 0, 0],
      '18:da12': [0x00, 0x57],
      '30:db57': [0, 0, 0, 0, 0, 0, 3],
      '19:db32': [...be16(400), 0, 2, 0, 0, 0, 2],
      '76:dc05': [...f32(0.01), ...f32(0.01), ...f32(0.01), ...f32(0.01)],
      '76:dc06': [0, 0, 0, 0, 0, 0, 0, 0],
      '76:dc31': [1, 1, 1, 1],
      '76:d8ec': be16(8),
      '40:e468': [0x04],
      '40:d54d': [...be16(0), ...be16(0), 1, 22, ...be16(-10 & 0xffff), ...be16(0), ...be16(0), ...be16(0)],
    };
    let now = 0;
    const port = {
      available: true,
      close: () => undefined,
      read: async (ecu: number, did: number): Promise<ReadResult> => {
        const k = `${ecu.toString(16)}:${did.toString(16)}`;
        if (did === 0xf150) {
          if (!ID[ecu]) return (now += 1500), { kind: 'timeout' };
          now += opts.latencyMs;
          return { kind: 'ok', payload: ID[ecu] };
        }
        if (k === opts.silentDid || !data[k]) return (now += 1500), { kind: 'timeout' };
        now += opts.latencyMs;
        return { kind: 'ok', payload: data[k] };
      },
    };
    const out: UdsOutput[] = [];
    const r = new UdsReader(port, () => now, (o) => out.push(o));
    (r as unknown as { running: boolean }).running = true;
    const run = async (untilMs: number) => {
      while (now < untilMs) {
        const did = await r.step();
        now += did ? 150 : 100; // GAP_MS / ожидание, как в run()
      }
    };
    return { r, out, run, now: () => now };
  }

  /** Самая большая доля срока свежести между соседними значениями цели после разогрева (≤ 1 — ни разу не устарело). */
  function worst(out: readonly UdsOutput[], id: string, fromMs: number): { ratio: number; n: number } {
    const xs = out.filter((o) => o.target.id === id && o.at >= fromMs && !o.absent);
    let ratio = 0;
    for (let i = 1; i < xs.length; i++) ratio = Math.max(ratio, (xs[i].at - xs[i - 1].at) / xs[i - 1].staleMs);
    return { ratio, n: xs.length };
  }

  /** Промежутки между значениями цели после разогрева: медиана, p95, наибольший, мс. */
  function intervals(out: readonly UdsOutput[], id: string, fromMs: number): { median: number; p95: number; max: number } {
    const xs = out.filter((o) => o.target.id === id && o.at >= fromMs && !o.absent).map((o) => o.at);
    const d = xs.slice(1).map((t, i) => t - xs[i]).sort((a, b) => a - b);
    const q = (p: number) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
    return { median: q(0.5), p95: q(0.95), max: d[d.length - 1] };
  }

  it('промежутки чтения колёс (ответ 80 мс, GHAS/ACSM молчат): медиана ≈ периоду, p95 и наибольший ограничены; в диагностике — измеренное', async () => {
    const { r, out, run } = g07Bus({ latencyMs: 80 });
    await run(300000);
    const w = intervals(out, 'wheelSpeed.FL', 30000);
    const dsc = r.diagnostics().find((e) => e.key === 'DSC')!.records.find((x) => x.did === 'DBE4')!;
    console.log(`wheelSpeed.FL interval ms: median ${w.median} p95 ${w.p95} max ${w.max}; period ${dsc.periodMs}; bus ${JSON.stringify(r.bus())}`);
    assert.ok(w.median <= dsc.periodMs * 1.3, `медиана ${w.median} ≤ 1,3 × период ${dsc.periodMs}`);
    assert.ok(w.p95 <= dsc.periodMs * 2, `p95 ${w.p95}`);
    // повтор молчащей идентификации — наравне с записями, не вперёд всех: наибольший промежуток ≤ 2 периода + один тайм-аут
    assert.ok(w.max <= 2 * dsc.periodMs + 2000, `наибольший ${w.max}`);
    assert.ok(dsc.intervalMs !== null && dsc.maxIntervalMs >= w.max - 1, 'измеренный промежуток в диагностике');
  });

  for (const latencyMs of [80, 200, 350]) {
    it(`задержка ответа ${latencyMs} мс: показываемые величины не устаревают между чтениями; молчащие GHAS/ACSM не отнимают шину`, async () => {
      const { r, out, run } = g07Bus({ latencyMs });
      await run(180000);
      for (const id of ['wheelSpeed.FL', 'rideHeightSensor.FL', 'brakePressure.system', 'temperature.gearboxC', 'driveMode', 'pitchVsAxlesDeg']) {
        const w = worst(out, id, 30000);
        assert.ok(w.n >= 5, `${id}: значения идут (${w.n})`);
        assert.ok(w.ratio <= 1, `${id}: промежуток между чтениями ${w.ratio.toFixed(2)} × срок свежести (бюджет ${JSON.stringify(r.bus())})`);
      }
      // кандидаты (квалификаторы не описаны) — «нет данных», не ошибка
      const fdr = out.filter((o) => o.target.id === 'dsc.fdr').slice(-1)[0];
      assert.ok(fdr && fdr.absent && fdr.value === null, 'DSC FDR: нет данных (кандидат), не недопустимое значение');
      const lmv = out.filter((o) => o.target.id === 'xdrive.frontTorqueNm').slice(-1)[0];
      assert.ok(lmv && lmv.absent, 'LMV: момент не установлен — нет данных');
      // записи «только диагностика» — редко
      const eps = r.diagnostics().find((e) => e.key === 'EPS')!.records[0];
      assert.ok(eps.periodMs >= 20000, `EPS DB57 только диагностика: ${eps.periodMs} мс`);
    });
  }

  it('очень медленная шина (ответ 3 с): срок свежести не растягивается сверх 10 с — значения честно устаревают', async () => {
    const { r, out, run } = g07Bus({ latencyMs: 3000 });
    await run(240000);
    const xs = out.filter((o) => o.target.id === 'wheelSpeed.FL' && !o.absent);
    assert.ok(xs.every((o) => o.staleMs <= 10000), 'срок свежести не больше MAX_STALE_MS');
    assert.ok(worst(out, 'wheelSpeed.FL', 30000).ratio > 1, 'между чтениями дольше срока — показ «устарело», не подделка свежести');
    assert.ok(r.bus().floorMs > 3000);
  });

  it('молчащая запись опознанного блока (DB29) не забивает шину: отсрочка, колёса остаются свежими', async () => {
    const { out, run } = g07Bus({ latencyMs: 150, silentDid: '29:db29' });
    await run(180000);
    const w = worst(out, 'wheelSpeed.FL', 30000);
    assert.ok(w.ratio <= 1, `колёса: ${w.ratio.toFixed(2)}`);
    // DB29 — без значений (устаревает честно), но не каждые 500 мс
    assert.equal(out.filter((o) => o.target.id === 'brakePressure.system' && o.value !== null).length, 0);
  });
});
