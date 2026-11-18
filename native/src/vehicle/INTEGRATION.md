# Телеметрия режима чтения — что нужно для интеграции

Дата: 18 ноября 2026. Этап: только чтение (r/s). Никаких UDS/TASU, методов, записи, `_broadcasts`.
Источник путей/масштабов — MIT upstream `cauliflowermossgrape/idrive7-apps` на `082d42d`
(`apps/live_data/signals.js`, `apps/live_adjustments/xdrive_live.js`, `apps/car_vitals/main.js` + `app.json`,
`apps/redline/tyres.js`, `kit/runtime/signals.js`). Ничего не выдумано; на G07 новые поля не проверены.

## Что изменено (только в зоне телеметрии)

| Файл | Суть |
|---|---|
| `native/src/vehicle/allowlist.ts` | 13 интерфейсов / 19 полей (было 5 / 8; прежние 8 привязок без изменений). `FieldSpec.pollMs`, `diag`, `diagChanges`; выходы `number` (с `priority`), `gearbox`/`selection`, `torqueSplit`, `gearboxOil`, `tyrePressure`/`tyreTemperature`, `units`. `outputIds()`, `SIGNAL_IFACE`. `VEHICLE_EXPANSION_NOTES` переписан и не пересекается с `VEHICLE_SIGNAL_IDS`. |
| `native/src/vehicle/adapter.ts` | Общее хранилище отсчётов (id → источник → отсчёт), обесценивание по номеру отсчёта при потере провайдера, удержание передачи, `diagnostics()`. Тип `TelemetryWatchFn` / `WatchOpts`. |
| `native/src/vehicle/decode.ts` | `decodeSteering`, `decodeYawRate`, `decodePedal`. |
| `native/src/vehicle/tpms.ts` | TPMS + единицы автомобиля (новый). |
| `native/src/vehicle/bds.ts` | BasicDataSet: распределение момента и масло КПП (новый). |
| `native/src/vehicle/diag.ts` | Ограниченный журнал сырых значений (новый). |
| `vendor/idrive7-apps/kit/runtime/signals.js` | Жизненный цикл `watch()`: эпоха провайдера, одно чтение на поле, `res.reads` (см. «Рантайм `watch()`»). |
| `native/test/vehicleTelemetry.test.ts`, `vehicleSignalsRuntime.test.ts` | Новые тесты; `vehicleAdapter.test.ts`, `vehicleDecode.test.ts` дополнены. |

## Обязательно сделать root (файлы вне моей зоны)

1. **`native/src/app.ts` — передать пятый аргумент.** Сейчас обёртка его теряет:
   ```ts
   watch: (iface, inst, handlers, l) => ctx.signals.watch(iface, inst, handlers, l)
   ```
   нужно:
   ```ts
   watch: (iface, inst, handlers, l, opts) => ctx.signals.watch(iface, inst, handlers, l, opts)
   ```
   Без этого нет опроса геттерами (стоящая скорость 0 устаревает через 5 с — то, что видно на фото) и нет
   колбэка потери провайдера. Адаптер при этом всё равно работает: потерю видит по `res.losses` / `res.available` в кадре.
2. **`native/src/platform/kitTypes.ts`** — расширить совместимо:
   ```ts
   export interface WatchOpts { pollMs?: number; fieldPollMs?: Record<string, number>; onAvailability?: (available: boolean) => void }
   export interface GetterStats { ok: number; failed: number; consecutiveFailures: number; dropped: number; skipped: number;
     lastOkAt: number | null; lastFailAt: number | null; lastError: string | null; pendingSince: number | null }
   export interface WatchResult { available: boolean; error: string | null; losses?: number;
     reads?: Readonly<Record<string, Partial<GetterStats>>>; shutdown(): Promise<unknown> }
   export type WatchFn = (iface: string, instance: string, handlers: Record<string, FieldHandler>, log?: Log, opts?: WatchOpts) => Promise<WatchResult>;
   ```
   После этого `WatchOpts`/`GetterStats`/`TelemetryWatchResult`/`TelemetryWatchFn` в `adapter.ts` можно заменить
   импортом из `kitTypes` (сейчас они локальные и структурно принимают нынешний четырёхаргументный `WatchFn` и
   `WatchResult` без `losses`/`reads`; `native:typecheck` по моим файлам чист).
3. **`native/scripts/vendor-upstream.ts` + `vendor/idrive7-apps/PROVENANCE.json`.** `kit/runtime/signals.js` теперь
   локально изменён: добавить в `MODIFIED` (`native/scripts/vendor-upstream.ts`) запись
   ```ts
   'kit/runtime/signals.js':
     'watch(): poll timer cleared on shutdown and no callbacks after it; at most one getValue() per field in flight ' +
     '(polls skipped while the binding\'s 3 s timeout has not settled it, never stacked); provider epoch: answers to reads ' +
     'started before a loss and notifications while the provider is away are dropped; per-field fieldPollMs, ' +
     'onAvailability, res.losses, res.reads (getter counts/times/short error text, no values)',
   ```
   и перегенерировать `PROVENANCE.json` через CLI вендоринга (`npm run native:vendor`; запись MODIFIED при
   повторном запуске не перезаписывается, её sha256 фиксируется как `modified`). После правки `signals.js` в будущем —
   снова `npm run native:vendor`. Иначе проверка вендорного дерева (`package-store`)
   падает на расхождении sha256. `kit/tools/build.py` копирует `kit/runtime` в `javascript/kit/` пакета — изменённый
   `signals.js` попадёт в пакет приложения; другим приложениям он не нужен. Без опций поведение совпадает с upstream
   (тест «без opts — поведение upstream»).
4. **`native/src/manifest.ts`** — менять не нужно: `"signals"` строится из `manifestSignals()`. Новые блоки
   `_optional`, флаги ровно как в upstream app.json (`SteeringAngle`, `AcceleratorPedal`, `BasicDataSet`,
   `Powertrain`, `VehicleModel`, `VehicleStabilizationManagement` — `s`; `TPMS`, `Vehicle.statusNewCurrentUnitsStatusExt`,
   `CDS2.statusYawVelocityVehicle` — `rs`). Проверено `manifest.test.ts` (allowlist ⇔ манифест ⇔ подписки).
5. **`native/src/model/model.ts`** — для экрана настроек отдать снимок по запросу (не на каждый тик 10 Гц):
   ```ts
   diagnostics(): VehicleDiagnostics | null  // VehicleSource: this.adapter.diagnostics(this.now() - this.t0)
   ```
   `VehicleStatus` не менялся (поля прежние).
6. **UI/страницы (`pages.ts` и т. п.)** — по желанию root:
   - `xdrive.frontPercent` приходит с `runtimeSource: 'estimated'` (100 − задняя), `xdrive.rearPercent` — `measured`.
     Показать различие. `xdrive.frontTorqueNm`/`rearTorqueNm` остаются «нет данных».
   - `acceleratorPedalPercent` — педаль; `engine.throttlePercent` остаётся «нет данных» (не подставлять педаль).
   - Давление шин — бар, температура — °C (перевод из единиц автомобиля уже сделан). 0 бар — настоящий ноль.
   - `temperature.gearboxC` до первого изменения сырого значения — `unavailable`; причина в `diagnostics().reasons`.
7. **Документация (root):** `SIGNALS.md`, `NATIVE_PORT.md` — новые поля, статус «upstream-реализация, на G07 не
   проверено», удержание передачи, опрос. `SIGNAL_CATALOG.staleAfterMs` адаптером не используется (у адаптера
   свои пороги в allowlist); менять каталог не требуется.

## Рантайм `watch()` (vendor `signals.js`)
- `shutdown()`: интервал снят, ни обработчики, ни `onAvailability`, ни поздние ответы `getValue` больше не вызываются.
- Одно чтение на поле: пока `getValue` не завершился (таймаут привязки 3 с должен его завершить), тики этого поля
  пропускаются (`res.reads[f].skipped`), висящий запрос виден как `pendingSince`. Повторных запросов поверх висящего
  нет (отмены в привязке нет — не выдумывается). Остальные поля читаются независимо.
- Эпоха провайдера: каждая потеря (`available` true → false) увеличивает эпоху и `res.losses`. Ответ чтения, начатого
  в прошлой эпохе, или пришедший, пока провайдера нет, отбрасывается (`dropped`), даже после быстрого переподключения.
  Уведомление поля, пока провайдер известно недоступен, не доставляется. До первого сообщения о доступности
  (старая привязка без `subscribeToAvailability`) уведомления доставляются как в upstream.
- Неудачное чтение: `failed`, `consecutiveFailures`, `lastFailAt`, `lastError` (первая строка, ≤ 80 печатных ASCII);
  обработчик не вызывается. Успешное: `ok`, `lastOkAt`, `consecutiveFailures = 0` (`lastError` остаётся как история).
- Адаптер дополнительно не принимает колбэки, пока интерфейс после `onAvailability(false)` не вернулся или пока
  `res.available === false` у бывшего доступным провайдера (`droppedWhileUnavailable`).

## Поведение

### Опрос и свежесть
- Опрос только у полей с геттером (`rs` в upstream): скорость, обороты, момент, ускорения, рыскание — 200 мс (5 Гц, с 0.1.2; было 1 с);
  температуры двигателя — 5 с; TPMS и единицы — 10 с (как `pollMs: 10000` у car_vitals/live_data).
  `s`-поля (руль, педаль, BasicDataSet, передача, диагностические) не опрашиваются: геттера нет.
- Успешное чтение = новый отсчёт (стоящий автомобиль: скорость 0 остаётся `valid`). Неудачное чтение обработчик
  не вызывает и время не обновляет.
- Пороги «устарело»: быстрые 5 с, температуры 60 с, распределение 10 с (car_vitals `SPLIT_STALE`), TPMS 10 мин
  (Redline `STALE_MS`).
- Для старого рантайма без `fieldPollMs` передаётся и `pollMs` = минимальный период интерфейса (все геттеры CDS
  тогда читаются раз в 200 мс) — допустимо.

### Потеря провайдера
- Колбэк `onAvailability(false)`, рост `res.losses` или `res.available === false` в кадре → все отсчёты интерфейса
  с номером ≤ текущего обесцениваются: значение показывается только как `stale` и не становится `valid`, пока не
  придёт новый отсчёт — даже если провайдер вернулся до кадра.
- Передача (`statusGearboxDrive`, `DataPowerTrain2` — только уведомления при изменении) держится как `valid`, пока
  провайдер VehicleInformation непрерывно доступен (на стоянке P не устаревает). Потеря → не `valid` до нового
  события. Отсутствие/ошибка/неоднозначность — «нет данных», P не придумывается (логика `gear.ts` не менялась).
- Генерация подписки (`gen`) защищает и обработчики, и `onAvailability` после `stop()`.
- Потеря провайдера единиц (`Vehicle`) при работающем TPMS: известные единицы забываются; давления/температуры,
  раскодированные прежними единицами, — только `stale` (время исходное); отсчёты TPMS, пришедшие без единиц после
  потери (и ждавшие единиц в момент потери), с новыми единицами не связываются — `unavailable` с причиной, пока не
  придут свежие единицы И затем свежий отсчёт TPMS. Связывание отсчёта, пришедшего до ПЕРВЫХ единиц при запуске,
  сохранено.
- Потеря провайдера BasicDataSet сбрасывает «ждём изменения» масла КПП: после возврата снова нужны два разных
  сырых значения.

### Новые поля
| Сигнал | Источник | Декодирование |
|---|---|---|
| `steeringWheelAngleDeg` | `de.bmw.chassis.SteeringAngle` `ActualSteeringAngleDriver`, член `actualValueSteeringAngleDriver`. С 0.1.2 `actualSteeringAngleDriverNoCRC` — только сырой журнал (`outputs: []`): прежний код мог подменять им главное поле, а равнозначность кодировки на G07 не подтверждена (осторожное отключение подмены, не доказанная причина скачков) | int16 (uint16 в доп. коде принимается) × 0.04395°; 65535 (и −1) — нет; \|угол\| > 900 — нет. Источник один, на другое поле не переключается. |
| `yawRateDegS` | `CDS2.statusYawVelocityVehicle.yawVelocityVehicle` | uint16 × 0.005 − 163.84 °/с; 65535 — нет |
| `acceleratorPedalPercent` | `de.bmw.powertrain.AcceleratorPedal.AngleAcceleratorPedal.actualValueAngleAcceleratorPedal` | × 0.025 %, raw 0…4000, прочее — нет |
| `xdrive.rearPercent` / `xdrive.frontPercent` | `de.bmw.infrastructure.analytics.BasicDataSet.basicDataSet.valueDistributionLongitudinalTorqueRearAxisFrontAxis` | × 0.01 % задней; передняя = 100 − задняя (`estimated`). Квалификатор `qualifierValue…` ∈ {2, 10, `SIGNALWERT_IST_GUELTIG`, `SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF`} или отсутствует (upstream допускает; пометка в `reasons`). raw 0 / 65535 — не заполнено (`unavailable`, стирает прежнее), > 10000 — `invalid`. |
| `temperature.gearboxC` | тот же `basicDataSet.valueTemperatureTransmissionOil` (точное имя upstream) | raw − 48 °C, 255 — нет, вне −40…160 °C — нет (raw 0 никогда не значение). Показывается только после второго **разного** сырого значения (car_vitals `MOVE.gearbox`); до этого `unavailable` с причиной «стоит на raw N — ждём изменения». |
| `tyrePressure.{FL,FR,RL,RR}` | `de.bmw.infotainment.vehicle.TPMS.statusTyrePressure.actualValuePressureTyre{FLH,FRH,RLH,RRH}` | raw × 0.1 в единице автомобиля → бар (kPa/100, psi/14.5038); ≥ 65532 — нет; 0 — допустим; > 6 бар (граница upstream) — нет. |
| `tyreTemperature.{…}` | `TPMS.statusTyreTemperature.actualValueTemperatureTyre{…}` | raw − 40 в единице автомобиля, F → °C; 65535 — нет; вне −40…150 °C — нет. |
| (единицы) | `de.bmw.infotainment.vehicle.Vehicle.statusNewCurrentUnitsStatusExt` `unitOfMeasurementAirPressure` 1 BAR / 2 KPA / 3 PSI, `unitOfMeasurementTemperature` 1 C / 2 F (номер или то же имя) | Единицы обязательны (не угадываются по величине, psi ≠ °F). Сырые отсчёты до единиц хранятся и раскодируются после их прихода с исходным временем. Отсчёт связан с единицами на момент прихода. Недопустимые единицы обесценивают все прежние отсчёты навсегда (до новых). |

### Только диагностика (в сигналы не попадают)
`Powertrain.ActualValueRPMWheel` (`actualValueRPMWheelFLH`, `actualValueRPMwheelFRH` — так в upstream, `…RLH`, `…RRH`),
`VehicleModel.LaneSlope` (`actualValueLongitudinalGradientRoadway`, `actualValueTransverseGradientRoadway`),
`VehicleStabilizationManagement.StabilizationManagement` (`qualifierFunctionABS/ASC/FDR`, `statusBrakingDriver`).
Без масштаба и единиц; уклон дороги — не угол кузова; скорости тангажа/крена в углы не интегрируются.

### Остаются «нет данных»
Абсолютные тангаж/крен, высота, подвеска (уровень/высоты), HDC/DSC/DTC, скорость/проскальзывание колёс,
вмешательство тормозов, блокировка заднего дифференциала, дроссель, моменты осей — см. `VEHICLE_EXPANSION_NOTES`.

## Диагностический снимок (лист разработчика, `XOP_DEV=diag`)

С 0.1.2 добавлены `latestSamples` — последний отсчёт каждого поля с `at` = время получения (сырые числа листа берутся
отсюда, первые отсчёты — только история), `sources` — поле, давшее показанное значение, и `gearboxOil` —
`shown | waitingChange | noSamples | providerUnavailable | notSubscribed`. Сигналам без своей причины в `reasons`
записывается состояние интерфейса-источника.

### Поля снимка (0.1.1)

`adapter.diagnostics(nowMs): VehicleDiagnostics`:
- `interfaces[]`: `iface`, `diagnosticOnly`, `subscribed`, `available`, `error`, `losses`, `samples`, `lastSampleAt`,
  `fields[]: FieldDiagnostics` — `field`, `samples`, `lastSampleAt` (время адаптера), `droppedWhileUnavailable`,
  `getter: GetterStats | null` (только `rs`-поля и только с пропатченным рантаймом: `ok`, `failed`,
  `consecutiveFailures`, `dropped`, `skipped`, `lastOkAt`, `lastFailAt`, `lastError` ≤ 80 печатных ASCII,
  `pendingSince`; времена — `Date.now()` рантайма, мс). Адаптер копирует только эти ключи, значения полей не попадают;
- `reasons`: почему сигнал без значения/с пометкой (ждём единиц, ждём изменения масла КПП, квалификатор, провайдер пропадал);
- `tyreUnits`: `BAR|KPA|PSI|none|lost|invalid(x)` и `C|F|none|lost|invalid(x)` (`lost` — провайдер единиц пропадал, свежих единиц ещё нет);
- `gearboxOilPromoted`;
- `firstSamples[]`: первый отсчёт каждого поля; `changes[]`: кольцо ≤ 50 изменений (только поля с `diagChanges`:
  передача, BasicDataSet, TPMS, единицы, диагностические), не чаще 1 раза в секунду на поле.
- Пишутся только члены из `FieldSpec.diag`: конечные числа, булевы и имена enum `[A-Za-z0-9_]{1,48}`. Других
  членов структуры (и VIN/координат — на них нет подписки) в снимке нет.
Предлагаемый показ: строка на интерфейс («доступен · N отсчётов · Х с назад · потерь K»), под ней `rs`-поля с
`getter` («ok N / ошибок M (подряд K) · последняя: timeout · ждёт ответа с …»), затем `reasons`,
затем последние ~10 `changes`. Собирать при открытии/обновлении страницы настроек, не в цикле кадра.

## Проверка

```
node --import tsx --test native/test/vehicleAdapter.test.ts native/test/vehicleDecode.test.ts \
  native/test/vehicleTelemetry.test.ts native/test/vehicleSignalsRuntime.test.ts native/test/manifest.test.ts
# исходный upstream signals.js должен проваливать тесты жизненного цикла:
XOP_SIGNALS_SRC=../../work/research/idrive7-apps/kit/runtime/signals.js node --import tsx --test native/test/vehicleSignalsRuntime.test.ts
```

## Риски / на машине проверить
- Руль и педаль — только уведомления: если автомобиль шлёт их лишь при изменении, на стоянке они станут `stale` через 5 с
  (честно; удержание сделано только для передачи, как требовалось).
- Отсутствие квалификатора распределения upstream принимает; на G07 не подтверждено (видно в `reasons`).
- Масштаб TPMS (×0.1 в единице автомобиля) и температуры (−40) — из car_vitals/redline «seen on a car», не G07.
- Удержание передачи без ограничения по времени держится на доступности провайдера VehicleInformation.

## Диагностическое чтение UDS (0.1.2)

`native/src/vehicle/uds/`:
- `tasu.ts` — транспорт, только 0x22 и `READ_ALLOWLIST`;
- `records.ts` — схемы, точная длина;
- `ecus.ts` — блоки, принимаемые SGBD-индексы, выходы;
- `reader.ts` — идентификация первой, периоды, пауза без экрана, диагностика.

Модель создаёт его только в режиме автомобиля и только если `ctx.signals` дал `proxy/call/on/onAvailable`. Отсчёты идут в адаптер через `putUds`: доменные сигналы — приоритетом ниже SOME/IP, остальное — в `extras` (`NativeSnapshot.extra`).

