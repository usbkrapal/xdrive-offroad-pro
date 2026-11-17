/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { missing, snapAt, stale, valid } from '../domain/testUtils';
import { WHEELS, type Signal, type Wheel } from '../domain/types';
import { ru } from '../i18n/ru';
import { DrivetrainStage } from './DrivetrainStage';

const T = 10_000;
const esc = (s: string) => s.replace(/</g, '&lt;');

describe('DrivetrainStage: подписи нагрузки', () => {
  it('оценка по доле оси подписана как оценка, без выдуманных Нм', () => {
    const s = snapAt(T, {
      'xdrive.rearTorqueNm': missing('xdrive.rearTorqueNm', T),
      'xdrive.rearPercent': valid('xdrive.rearPercent', 60, T),
      'engine.torqueNm': valid('engine.torqueNm', 350, T),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    assert.ok(html.includes(ru.drivetrain.loadEstimate));
    assert.ok(html.includes(ru.drivetrain.legendFlowEstimate));
    assert.ok(html.includes('is-estimate'));
  });

  it('измеренные моменты осей — обычная легенда без пометки оценки', () => {
    const s = snapAt(T, {
      'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', 400, T),
      'xdrive.rearTorqueNm': valid('xdrive.rearTorqueNm', 600, T),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    assert.ok(!html.includes(ru.drivetrain.loadEstimate));
    assert.ok(html.includes(ru.drivetrain.legendFlow));
  });

  it('отрицательный момент — статичная нагрузка с подсказкой о торможении двигателем', () => {
    const s = snapAt(T, {
      'engine.rpm': valid('engine.rpm', 1500, T),
      'engine.torqueNm': valid('engine.torqueNm', -120, T),
      'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', -300, T),
      'xdrive.rearTorqueNm': valid('xdrive.rearTorqueNm', -400, T),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    assert.ok(html.includes(esc(ru.drivetrain.engineBraking)));
    assert.ok(html.includes('dts__load-static'));
    // Импульсы остаются только у вращающегося входного вала (нейтральные), не у осей.
    assert.equal(html.match(/class="dts__pulse"/g)?.length, 1);
    assert.ok(!html.includes('dts__core'));
    // Поршни и шестерни вращаются нейтрально: подсветка тяги не появляется ни на одном узле.
    assert.ok(!html.includes('is-load'));
    assert.match(html, /data-part="engine" data-state="running"/);
  });

  it('обороты без известного момента — нейтральное вращение без ядра нагрузки; тяга — ядро на всех валах', () => {
    const idle = snapAt(T, {
      'engine.rpm': valid('engine.rpm', 800, T),
      'engine.torqueNm': missing('engine.torqueNm', T),
      'xdrive.frontTorqueNm': missing('xdrive.frontTorqueNm', T),
      'xdrive.rearTorqueNm': missing('xdrive.rearTorqueNm', T),
    }).signals;
    const idleHtml = renderToStaticMarkup(<DrivetrainStage signals={idle} paused={false} />);
    assert.equal(idleHtml.match(/class="dts__pulse"/g)?.length, 1);
    assert.ok(!idleHtml.includes('dts__core'));
    assert.ok(!idleHtml.includes('is-load'));

    const drive = snapAt(T, {
      'engine.rpm': valid('engine.rpm', 2500, T),
      'engine.torqueNm': valid('engine.torqueNm', 350, T),
      'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', 400, T),
      'xdrive.rearTorqueNm': valid('xdrive.rearTorqueNm', 600, T),
    }).signals;
    const driveHtml = renderToStaticMarkup(<DrivetrainStage signals={drive} paused={false} />);
    // Вход + передний + карданный + четыре полуоси.
    assert.equal(driveHtml.match(/class="dts__core"/g)?.length, 7);
    assert.equal(driveHtml.match(/class="dts__pulse"/g)?.length, 7);
  });
});

const wheels = (make: (w: Wheel) => Signal<number>) => Object.fromEntries(WHEELS.map((w) => [`wheelSpeed.${w}`, make(w)]));
const treadOf = (html: string, w: Wheel) => html.match(new RegExp(`data-wheel="${w}" data-tread="([a-z]+)"`))?.[1];
/** Группа шины: классы, семантические атрибуты и разметка до кромки (маска + слои). */
const tyreOf = (html: string, w: Wheel) => {
  const m = html.match(
    new RegExp(
      `class="([^"]*)" data-wheel="${w}" data-tread="([a-z]+)" data-slip="([a-z]+)" data-brake="([a-z]+)" data-surface="([a-z-]+)" data-blink="([a-z]+)">(.*?)class="dts__tyre-edge"`,
    ),
  );
  assert.ok(m, w);
  return { cls: m[1], tread: m[2], slip: m[3], brake: m[4], surface: m[5], blink: m[6], body: m[7] };
};

describe('DrivetrainStage: протектор внутри шин', () => {
  it('валидные 0 км/ч — протектор стоит; нет данных — без прокрутки', () => {
    const stopped = snapAt(T, wheels((w) => valid(`wheelSpeed.${w}`, 0, T))).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={stopped} paused={false} />);
    for (const w of WHEELS) assert.equal(treadOf(html, w), 'stopped', w);

    const lost = snapAt(T, wheels((w) => (w === 'RL' ? missing(`wheelSpeed.${w}`, T) : stale(`wheelSpeed.${w}`, 12, T)))).signals;
    const lostHtml = renderToStaticMarkup(<DrivetrainStage signals={lost} paused={false} />);
    for (const w of WHEELS) assert.equal(treadOf(lostHtml, w), 'missing', w);
    // Без скорости ни у одной шины нет привязки к фазе колеса.
    assert.ok(!/--ph-t(FL|FR|RL|RR)/.test(lostHtml.split('dts__tread-roll').slice(1).join('')));
  });

  it('движущееся колесо катится; в паузе протектор заморожен', () => {
    const moving = snapAt(T, wheels((w) => valid(`wheelSpeed.${w}`, 1.6, T))).signals;
    const live = renderToStaticMarkup(<DrivetrainStage signals={moving} paused={false} />);
    for (const w of WHEELS) assert.equal(treadOf(live, w), 'rolling', w);
    assert.match(live, /data-animating="true"/);

    const paused = renderToStaticMarkup(<DrivetrainStage signals={moving} paused />);
    for (const w of WHEELS) assert.equal(treadOf(paused, w), 'frozen', w);
    assert.match(paused, /data-animating="false"/);
  });

  it('буксование подсвечивает саму шину, а не полосу рядом', () => {
    const s = snapAt(T, { 'wheelSlip.FR': valid('wheelSlip.FR', 45, T), 'wheelSlip.FL': valid('wheelSlip.FL', 2, T) }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    assert.match(html, /data-wheel="FR" data-tread="[a-z]+" data-slip="high"/);
    assert.match(html, /data-wheel="FL" data-tread="[a-z]+" data-slip="none"/);
  });

  it('торможение красит саму шину только при валидном true, каждое колесо отдельно', () => {
    const s = snapAt(T, {
      'brakeIntervention.FL': valid('brakeIntervention.FL', true, T),
      // Без пробуксовки: тормоз — ровный красный (мигание проверяется отдельно).
      'wheelSlip.FL': valid('wheelSlip.FL', 0, T),
      'brakeIntervention.FR': valid('brakeIntervention.FR', false, T),
      'brakeIntervention.RL': missing('brakeIntervention.RL', T),
      'brakeIntervention.RR': stale('brakeIntervention.RR', true, T),
      // Отрицательный момент — торможение двигателем, а не тормозом колеса.
      'engine.rpm': valid('engine.rpm', 1500, T),
      'engine.torqueNm': valid('engine.torqueNm', -120, T),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    assert.equal(tyreOf(html, 'FL').surface, 'brake');
    assert.equal(tyreOf(html, 'FL').brake, 'on');
    assert.equal(tyreOf(html, 'FR').brake, 'off');
    assert.equal(tyreOf(html, 'RL').brake, 'missing');
    assert.equal(tyreOf(html, 'RR').brake, 'missing');
    for (const w of ['FR', 'RL', 'RR'] as const) {
      assert.notEqual(tyreOf(html, w).surface, 'brake', w);
      assert.ok(!tyreOf(html, w).body.includes('dts__tyre-brake'), w);
    }
    // Красная заливка — внутри маски шины FL, протектор поверх неё сохраняется.
    const fl = tyreOf(html, 'FL').body;
    assert.ok(fl.indexOf('dts__tyre-brake') < fl.indexOf('dts__tread-lug'));
    assert.ok(fl.includes('dts__tyre-brake-glow'));
  });

  it('буксование + тормоз — красный без янтаря; без тормоза пробуксовка остаётся янтарной', () => {
    const s = snapAt(T, {
      'wheelSlip.RL': valid('wheelSlip.RL', 45, T),
      'brakeIntervention.RL': valid('brakeIntervention.RL', true, T),
      'wheelSlip.RR': valid('wheelSlip.RR', 45, T),
      'brakeIntervention.RR': valid('brakeIntervention.RR', false, T),
      'wheelSlip.FL': valid('wheelSlip.FL', 45, T),
      'brakeIntervention.FL': missing('brakeIntervention.FL', T),
      'wheelSpeed.RL': valid('wheelSpeed.RL', 12, T),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    const rl = tyreOf(html, 'RL');
    assert.equal(rl.surface, 'brake-slip');
    assert.ok(rl.cls.includes('is-brake'));
    assert.equal(rl.slip, 'high');
    assert.ok(!rl.body.includes('dts__tyre-slip'));
    assert.ok(!rl.cls.includes('is-slip'));
    // Протектор по-прежнему катится под красной резиной.
    assert.equal(rl.tread, 'rolling');
    for (const w of ['RR', 'FL'] as const) {
      assert.equal(tyreOf(html, w).surface, 'slip', w);
      assert.ok(tyreOf(html, w).body.includes('dts__tyre-slip'), w);
    }
  });
});

/** Явные тормоз и пробуксовка на всех колёсах — без влияния базового сценария. */
const wheelInputs = (brake: Record<Wheel, Signal<boolean>>, slip: Record<Wheel, Signal<number>>) =>
  Object.fromEntries(
    WHEELS.flatMap((w) => [[`brakeIntervention.${w}`, brake[w]] as const, [`wheelSlip.${w}`, slip[w]] as const]),
  );
/** Ничего не крутится: ни оборотов, ни моментов, ни скоростей колёс. */
const still = () => ({
  'engine.rpm': missing('engine.rpm', T),
  'engine.torqueNm': missing('engine.torqueNm', T),
  'xdrive.frontTorqueNm': missing('xdrive.frontTorqueNm', T),
  'xdrive.rearTorqueNm': missing('xdrive.rearTorqueNm', T),
  ...wheels((w) => missing(`wheelSpeed.${w}`, T)),
});

describe('DrivetrainStage: мигание шины при буксовании под тормозом DSC', () => {
  const combined = () =>
    snapAt(T, {
      ...still(),
      ...wheelInputs(
        {
          FL: valid('brakeIntervention.FL', true, T),
          FR: valid('brakeIntervention.FR', true, T),
          RL: valid('brakeIntervention.RL', false, T),
          RR: valid('brakeIntervention.RR', false, T),
        },
        {
          FL: valid('wheelSlip.FL', 24, T),
          FR: valid('wheelSlip.FR', 3, T),
          RL: valid('wheelSlip.RL', 0, T),
          RR: valid('wheelSlip.RR', 0, T),
        },
      ),
    }).signals;

  it('валидный тормоз + видимая пробуксовка — пульсирующий красный по общей фазе, только у этого колеса', () => {
    const html = renderToStaticMarkup(<DrivetrainStage signals={combined()} paused={false} />);
    const fl = tyreOf(html, 'FL');
    assert.equal(fl.surface, 'brake-slip');
    assert.equal(fl.blink, 'pulse');
    assert.ok(fl.cls.includes('is-brake') && fl.cls.includes('is-blink'));
    // Без янтаря: ни слоя пробуксовки, ни янтарных классов.
    assert.ok(!fl.body.includes('dts__tyre-slip'));
    assert.ok(!fl.cls.includes('is-slip'));
    // Слои по порядку: тёмно-красная резина → яркий пульсирующий слой → протектор поверх.
    const iBase = fl.body.indexOf('class="dts__tyre-brake"');
    const iBlink = fl.body.indexOf('dts__tyre-blink');
    const iLug = fl.body.indexOf('dts__tread-lug');
    assert.ok(iBase >= 0 && iBase < iBlink && iBlink < iLug);
    // Яркость берётся из общей rAF-фазы, а не из собственного таймера/CSS-анимации колеса.
    assert.match(fl.body, /dts__tyre-blink"[^>]*style="opacity:[^"]*var\(--ph-blink/);
    // Мигание запускает общий цикл фаз, даже когда больше ничего не движется.
    assert.match(html, /data-animating="true"/);

    // Тормоз без видимой пробуксовки (3 % < порога) — ровный красный.
    const fr = tyreOf(html, 'FR');
    assert.equal(fr.surface, 'brake');
    assert.equal(fr.blink, 'none');
    assert.ok(fr.body.includes('class="dts__tyre-brake"'));
    assert.ok(!fr.body.includes('dts__tyre-blink'));
    for (const w of ['RL', 'RR'] as const) assert.equal(tyreOf(html, w).blink, 'none', w);
  });

  it('пауза замораживает мигание: слой остаётся на текущей фазе, цикл фаз стоит', () => {
    const html = renderToStaticMarkup(<DrivetrainStage signals={combined()} paused />);
    const fl = tyreOf(html, 'FL');
    assert.equal(fl.blink, 'frozen');
    assert.ok(fl.body.includes('dts__tyre-blink'));
    assert.match(html, /data-animating="false"/);
  });

  it('тормоз без пригодной пробуксовки — ровный красный; устаревший/нет/false тормоз при пробуксовке — янтарь, не красный', () => {
    const s = snapAt(T, {
      ...still(),
      ...wheelInputs(
        {
          FL: valid('brakeIntervention.FL', true, T),
          FR: valid('brakeIntervention.FR', true, T),
          RL: stale('brakeIntervention.RL', true, T),
          RR: missing('brakeIntervention.RR', T),
        },
        {
          FL: missing('wheelSlip.FL', T),
          FR: stale('wheelSlip.FR', 40, T),
          RL: valid('wheelSlip.RL', 40, T),
          RR: valid('wheelSlip.RR', 40, T),
        },
      ),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    for (const w of ['FL', 'FR'] as const) {
      const ty = tyreOf(html, w);
      assert.equal(ty.surface, 'brake', w);
      assert.equal(ty.blink, 'none', w);
      assert.ok(!ty.body.includes('dts__tyre-blink'), w);
    }
    for (const w of ['RL', 'RR'] as const) {
      const ty = tyreOf(html, w);
      assert.equal(ty.brake, 'missing', w);
      assert.equal(ty.surface, 'slip', w);
      assert.ok(!ty.cls.includes('is-brake'), w);
      assert.ok(!ty.body.includes('dts__tyre-brake') && !ty.body.includes('dts__tyre-blink'), w);
    }
    // Ни одного мигающего колеса и ничего не движется — общий цикл фаз не запускается.
    assert.match(html, /data-animating="false"/);
  });

  it('пробуксовка и торможение двигателем без тормоза колеса — не красный и не мигает', () => {
    const s = snapAt(T, {
      ...wheelInputs(
        {
          FL: valid('brakeIntervention.FL', false, T),
          FR: valid('brakeIntervention.FR', false, T),
          RL: valid('brakeIntervention.RL', false, T),
          RR: valid('brakeIntervention.RR', false, T),
        },
        {
          FL: valid('wheelSlip.FL', 50, T),
          FR: valid('wheelSlip.FR', 50, T),
          RL: valid('wheelSlip.RL', 50, T),
          RR: valid('wheelSlip.RR', 50, T),
        },
      ),
      'engine.rpm': valid('engine.rpm', 1500, T),
      'engine.torqueNm': valid('engine.torqueNm', -150, T),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    for (const w of WHEELS) {
      const ty = tyreOf(html, w);
      assert.equal(ty.surface, 'slip', w);
      assert.equal(ty.blink, 'none', w);
      assert.ok(!ty.body.includes('dts__tyre-brake') && !ty.body.includes('dts__tyre-blink'), w);
    }
  });
});

describe('DrivetrainStage: подвеска и экземпляры', () => {
  it('пружина деформируется только при валидной высоте', () => {
    const s = snapAt(T, {
      'suspensionHeight.FL': valid('suspensionHeight.FL', 60, T),
      'suspensionHeight.RR': missing('suspensionHeight.RR', T),
    }).signals;
    const html = renderToStaticMarkup(<DrivetrainStage signals={s} paused={false} />);
    assert.match(html, /data-strut="FL" data-height="valid"/);
    assert.match(html, /data-strut="RR" data-height="missing"/);
    const rr = html.split('data-strut="RR"')[1].split('</g>')[0];
    assert.ok(!rr.includes('dts__coil-stretch'));
  });

  it('id масок и градиентов уникальны для каждого экземпляра', () => {
    const s = snapAt(T).signals;
    const html = renderToStaticMarkup(
      <>
        <DrivetrainStage signals={s} paused={false} />
        <DrivetrainStage signals={s} paused={false} compact />
      </>,
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, ids.length);
  });
});
