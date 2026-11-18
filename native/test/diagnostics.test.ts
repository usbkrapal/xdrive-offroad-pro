// «Диагностика чтения» (лист разработчика, XOP_DEV=diag): строки из настоящего снимка VehicleAdapter.diagnostics() (через
// NativeModel в режиме «Автомобиль», ctx.signals.watch — фальшивый SOME/IP), лист на настоящем Recorder kit.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NativeModel } from '../src/model/model';
import { DIAG, diagnosticsLines, diagnosticsSheet, getterLines, MAX_LINES, MAX_RAW } from '../src/render/diagnostics';
import type { GetterStats, VehicleDiagnostics } from '../src/vehicle/adapter';
import type { Surface } from '../src/platform/kitTypes';
import { VEHICLE_INTERFACES } from '../src/vehicle/allowlist';
import { FakeTransport, flush, stageVendorKit, THEME } from './helpers';

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';
const STEER = 'de.bmw.chassis.SteeringAngle';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const VIN_LIKE = 'WBACV810X0LM12345';

async function vehicleModel() {
  const tr = new FakeTransport();
  let t = 10_000;
  const model = new NativeModel({ now: () => t, watch: tr.watch }, 'vehicle');
  await flush();
  return { tr, model, advance: (ms: number) => (t += ms) };
}

describe('диагностика чтения: строки из снимка адаптера', () => {
  it('демо: снимка нет, строка объясняет, где он есть', () => {
    const m = new NativeModel({ now: () => 0, watch: new FakeTransport().watch }, 'demo');
    assert.equal(m.diagnostics(), null);
    assert.deepEqual(diagnosticsLines(m.diagnostics()).map((l) => l.label), [DIAG.demo]);
    m.dispose();
  });

  it('автомобиль: каждый интерфейс с доступностью / отсчётами / возрастом / потерями, сырые — только числа, ничего лишнего', async () => {
    const { tr, model, advance } = await vehicleModel();
    try {
      // строка VIN-подобного вида в той же структуре не должна дойти до листа (в снимок пишутся только diag-члены-числа)
      tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3000, vehicleIdentificationNumber: VIN_LIKE });
      advance(2500);
      const lines = diagnosticsLines(model.diagnostics());
      assert.ok(lines.length <= MAX_LINES);
      const text = lines.map((l) => `${l.label} ${l.value}`).join('\n');
      assert.ok(!text.includes(VIN_LIKE), 'идентификатор не попал в диагностику');
      for (const spec of VEHICLE_INTERFACES) {
        const short = spec.iface.replace(/^de\.bmw\.(infotainment\.|infrastructure\.|powertrain\.|chassis\.)?/, '');
        assert.ok(lines.some((l) => l.label === short), `строка интерфейса ${short}`);
      }
      const cds = lines.find((l) => l.label === 'vehicle.CDS')!;
      assert.match(cds.value, /^доступен · отсчётов [1-9]\d* · 2,5 с назад · потерь 0/);
      const never = lines.filter((l) => l.value.includes(DIAG.never));
      assert.ok(never.length > 0, 'поля без отсчётов отмечены «отсчётов не было»');
      const rawAt = lines.findIndex((l) => l.label === DIAG.raw);
      assert.ok(rawAt > 0);
      const raw = lines.slice(rawAt + 1);
      assert.deepEqual(
        raw.slice(0, 2).map((l) => [l.label, l.value]),
        [['   statusEngineSpeed2', '2,5 с назад'], ['      actualValueRPMEngineCrankshaft', '3000']],
        'поле — заголовком с возрастом, член — своей строкой',
      );
      for (const l of raw.filter((x) => x.label.startsWith('      '))) assert.match(l.value, /^-?\d+(\.\d+)?(e[+-]?\d+)?$/, `только число: ${l.label} ${l.value}`);
    } finally {
      model.dispose();
    }
  });

  it('TPMS: каждое из четырёх колёс — своей строкой с числом (ничего не теряется при обрезке)', async () => {
    const { tr, model, advance } = await vehicleModel();
    try {
      const pressure = { actualValuePressureTyreFLH: 231, actualValuePressureTyreFRH: 232, actualValuePressureTyreRLH: 245, actualValuePressureTyreRRH: 246 };
      tr.feed(TPMS, 'statusTyrePressure', pressure);
      advance(1000);
      const lines = diagnosticsLines(model.diagnostics());
      const raw = lines.slice(lines.findIndex((l) => l.label === DIAG.raw) + 1);
      const at = raw.findIndex((l) => l.label === '   statusTyrePressure');
      assert.ok(at >= 0, 'заголовок поля');
      for (const [m, v] of Object.entries(pressure)) {
        assert.ok(raw.some((l) => l.label === `      ${m}` && l.value === String(v)), `${m} = ${v}: ${raw.map((l) => `${l.label.trim()}=${l.value}`).join('; ')}`);
      }
    } finally {
      model.dispose();
    }
  });

  it('чтение геттером: настоящие FieldDiagnostics.getter (res.reads пропатченного signals.js) — счётчики, «ждёт ответа», ошибка сейчас / прошлая', async () => {
    const { tr, model } = await vehicleModel();
    try {
      tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 900 });
      const res = tr.subs.find((x) => x.iface === CDS)!.res as unknown as { reads?: Record<string, Partial<GetterStats>> };
      const now = Date.now(); // время рантайма (wallclock), не часы адаптера
      res.reads = {
        // здоровое поле с прошлой ошибкой: после неё были успешные чтения
        statusEngineSpeed2: { ok: 40, failed: 2, consecutiveFailures: 0, dropped: 1, skipped: 0, lastOkAt: now, lastFailAt: now - 60000, lastError: 'timeout', pendingSince: null },
        // падает сейчас и ждёт ответа
        statusEngineTemperature: { ok: 0, failed: 3, consecutiveFailures: 3, dropped: 0, skipped: 5, lastOkAt: null, lastFailAt: now, lastError: 'no provider', pendingSince: now },
      };
      const d = model.diagnostics()!;
      const g = d.interfaces.find((i) => i.iface === CDS)!.fields.find((f) => f.field === 'statusEngineSpeed2')!.getter;
      assert.ok(g, 'адаптер отдаёт getter поля');
      const lines = diagnosticsLines(d);
      const after = (field: string) => lines.slice(lines.findIndex((l) => l.label === `   ${field}`) + 1, lines.findIndex((l) => l.label === `   ${field}`) + 3);
      const [okRead, okErr] = after('statusEngineSpeed2');
      assert.deepEqual([okRead.label.trim(), okRead.value, okRead.tone], [DIAG.read, 'успешно 40 · ошибок 2 · отброшено 1', 'dim']);
      assert.deepEqual([okErr.label.trim(), okErr.value, okErr.tone], [DIAG.errorPast, 'timeout', 'dim'], 'здоровое поле не показано как падающее');
      const [badRead, badErr] = after('statusEngineTemperature');
      assert.deepEqual([badRead.value, badRead.tone], ['успешно 0 · ошибок 3 · подряд 3 · пропущено 5 · ждёт ответа', 'warn']);
      assert.deepEqual([badErr.label.trim(), badErr.value, badErr.tone], [DIAG.errorNow, 'no provider', 'warn']);
      assert.ok(!lines.some((l) => /\d{6,}/.test(l.value) && /с назад/.test(l.value)), 'времена рантайма не смешаны с часами адаптера');
    } finally {
      model.dispose();
    }
  });

  it('getterLines: без ошибок и ожидания — одна строка счётчиков', () => {
    const g: GetterStats = { ok: 7, failed: 0, consecutiveFailures: 0, dropped: 0, skipped: 0, lastOkAt: 1, lastFailAt: null, lastError: null, pendingSince: null };
    assert.deepEqual(getterLines(g).map((l) => [l.value, l.tone]), [['успешно 7 · ошибок 0', 'dim']]);
  });

  it('сырых значений не больше MAX_RAW, строк не больше MAX_LINES', () => {
    const values: Record<string, number> = {};
    for (let k = 0; k < 30; k++) values[`m${k}`] = k;
    const d: VehicleDiagnostics = {
      at: 5000,
      interfaces: [],
      reasons: {},
      sources: {},
      tyreUnits: { pressure: 'none', temperature: 'none' },
      gearboxOilPromoted: false,
      gearboxOil: 'noSamples',
      latestSamples: [0, 1, 2, 3].map((n) => ({ at: 1000, iface: 'x', field: `f${n}`, values: { ...values, label: 'STRING_ENUM' } })),
      firstSamples: [],
      changes: [],
    };
    const lines = diagnosticsLines(d);
    const raw = lines.slice(lines.findIndex((l) => l.label === DIAG.raw) + 1).filter((l) => l.label.startsWith('      '));
    assert.equal(raw.length, MAX_RAW);
    assert.ok(!lines.some((l) => l.value === 'STRING_ENUM' || l.label.trim() === 'label'), 'строки (enum) не показываются');
    assert.ok(lines.length <= MAX_LINES);
  });

  it('сырые числа — ПОСЛЕДНИЙ отсчёт каждого поля с временем получения, не первый с запуска (было: 378 с при свежих сообщениях)', async () => {
    const { tr, model, advance } = await vehicleModel();
    try {
      // непрерывное поле (без кольца изменений): прежняя версия показывала только первый отсчёт и его возраст
      tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 100 });
      for (let i = 0; i < 378; i++) {
        advance(1000);
        tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 200 + i });
      }
      const d = model.diagnostics()!;
      const latest = d.latestSamples.find((e) => e.field === 'statusCarSpeed2')!;
      assert.equal(latest.values.speedVehicleCentreOfGravity, 577);
      assert.equal(latest.at, d.at, 'время — момент получения последнего отсчёта');
      assert.equal(d.firstSamples.find((e) => e.field === 'statusCarSpeed2')!.values.speedVehicleCentreOfGravity, 100, 'первый — только история');
      const lines = diagnosticsLines(d);
      const raw = lines.slice(lines.findIndex((l) => l.label === DIAG.raw) + 1);
      const at = raw.findIndex((l) => l.label === '   statusCarSpeed2');
      assert.deepEqual([raw[at].value, raw[at + 1].value], ['0,0 с назад', '577']);
      assert.ok(!raw.some((l) => l.value === '100'), 'первого отсчёта среди «последних» нет');
    } finally {
      model.dispose();
    }
  });

  it('руль: последние сырые обоих полей (главного и NoCRC) видны отдельно; источник показанного значения — главное поле', async () => {
    const { tr, model, advance } = await vehicleModel();
    try {
      tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 47321 });
      advance(500);
      tr.feed(STEER, 'actualSteeringAngleDriverNoCRC', { actualValueSteeringAngleDriver: 32696 });
      const d = model.diagnostics()!;
      assert.equal(d.sources.steeringWheelAngleDeg, 'ActualSteeringAngleDriver');
      const raw = (f: string) => d.latestSamples.find((e) => e.field === f)!;
      assert.deepEqual([raw('ActualSteeringAngleDriver').values.actualValueSteeringAngleDriver, raw('actualSteeringAngleDriverNoCRC').values.actualValueSteeringAngleDriver], [47321, 32696]);
      assert.equal(raw('ActualSteeringAngleDriver').at + 500, raw('actualSteeringAngleDriverNoCRC').at);
      const lines = diagnosticsLines(d);
      assert.ok(lines.some((l) => l.label === 'steeringWheelAngleDeg' && l.value === 'ActualSteeringAngleDriver'));
      assert.ok(lines.some((l) => l.label === DIAG.steeringNote));
    } finally {
      model.dispose();
    }
  });

  it('масло КПП: провайдер BasicDataSet недоступен ≠ «ждём изменения»; «ждём изменения» — только при отсчётах', async () => {
    const { tr, model, advance } = await vehicleModel();
    try {
      advance(1000);
      let d = model.diagnostics()!;
      assert.equal(d.gearboxOil, 'providerUnavailable');
      assert.match(String(d.reasons['temperature.gearboxC']), /провайдер интерфейса недоступен, отсчётов не было/);
      assert.match(String(d.reasons['xdrive.rearPercent']), /провайдер интерфейса недоступен/);
      let line = diagnosticsLines(d).find((l) => l.label === DIAG.gearboxOil)!;
      assert.equal(line.value, DIAG.gearboxOilState.providerUnavailable);
      assert.equal(line.tone, 'warn');
      assert.doesNotMatch(line.value, /ждём изменения/);
      tr.setAvailable(BDS, true);
      d = model.diagnostics()!;
      assert.equal(d.gearboxOil, 'noSamples');
      tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 120 });
      d = model.diagnostics()!;
      assert.equal(d.gearboxOil, 'waitingChange');
      assert.match(String(d.reasons['temperature.gearboxC']), /ждём изменения/);
      line = diagnosticsLines(d).find((l) => l.label === DIAG.gearboxOil)!;
      assert.equal(line.value, DIAG.gearboxOilState.waitingChange);
      tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 121 });
      assert.equal(model.diagnostics()!.gearboxOil, 'shown');
    } finally {
      model.dispose();
    }
  });

  it('ошибка подписки показывается строкой интерфейса', async () => {
    const tr = new FakeTransport();
    tr.errorFor.add(CDS);
    const model = new NativeModel({ now: () => 0, watch: tr.watch }, 'vehicle');
    await flush();
    try {
      const cds = diagnosticsLines(model.diagnostics()).find((l) => l.label === 'vehicle.CDS')!;
      assert.equal(cds.tone, 'warn');
      assert.match(cds.value, /^ошибка: /);
    } finally {
      model.dispose();
    }
  });
});

describe('лист диагностики на настоящем Recorder kit', () => {
  it('рисуется, «Обновить» берёт новый снимок, прокрутка ограничена, «Назад» закрывает', async () => {
    const kit = stageVendorKit();
    const { tr, model, advance } = await vehicleModel();
    try {
      const { Recorder } = kit.req('./record.js') as { Recorder: new (w: number, h: number) => Surface & { words(): Uint32Array } };
      let reads = 0;
      const sh = diagnosticsSheet(() => (reads++, model.diagnostics()));
      assert.equal(reads, 1, 'снимок при открытии');
      const r = new Recorder(1600, 520);
      const targets = sh.draw(r, THEME) as { act(): unknown }[];
      assert.equal(targets.length, 2);
      assert.ok(r.words().length > 100);
      tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 1234 });
      advance(1000);
      assert.equal(targets[1].act(), null);
      assert.equal(reads, 2, '«Обновить» — новый снимок');
      assert.ok(sh.lines.some((l) => l.label === '      actualValueRPMEngineCrankshaft' && l.value === '1234'), 'новое сырое число после «Обновить»');
      sh.scroll(1e6);
      sh.draw(new Recorder(1600, 520), THEME);
      assert.ok(sh.offset > 0 && sh.offset <= sh.lines.length * 30, `прокрутка в пределах (${sh.offset})`);
      sh.scroll(-1e7);
      sh.draw(new Recorder(1600, 520), THEME);
      assert.equal(sh.offset, 0);
      assert.equal(targets[0].act(), 'close');
      assert.equal(sh.back(), 'close');
    } finally {
      model.dispose();
      kit.cleanup();
    }
  });
});
