# Карта сигналов Terrain Monitor

Дата проверки: 16–17 ноября 2026. Репозиторий: [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps). Все значения веб-прототипа **mock**. В `native/src/vehicle` реализован экспериментальный адаптер чтения ограниченного набора полей; транспорт вызывается только при явном выборе режима «Автомобиль».

Зафиксированный commit: `082d42d52cfaa654c1a9740e6736cbd9433c486d` (main при проверке). Первый запуск на целевом G07 документирован фотографиями владельца: поступают обороты, момент двигателя, передача P, температуры ОЖ/масла и продольное/поперечное ускорение. Масштабы, знаки и точность независимой калибровкой не проверены. Остальные статусы отражают аудит исходников, не испытания на машине.

## Как читать статусы

- **confirmed**: в исследованных исходниках есть конкретный интерфейс/поле или DID и реализованная интерпретация. Это подтверждение реализации upstream, НЕ совместимости с конкретным G07.
- **likely**: есть конкретный кандидат или сырые поля, но масштаб, enum, семантика либо доступность не подтверждены; нельзя выводить их как точное физическое измерение.
- **unknown**: подходящий endpoint/интерпретация в просмотренной реализации не найден; не подменять догадкой.
- **mock** — независимый runtime source: все значения браузерного прототипа являются mock независимо от исследовательского статуса. Нельзя выводить confirmed как индикатор живого подключения.

Рекомендуется иметь отдельно `evidenceStatus`, `runtimeSource`, `quality`, `updatedAt`, `unit`, `value`; `quality` включает valid/stale/unavailable/invalid. Факт поступления отдельных полей на G07 подтверждён фотографиями; это не повышает автоматически статус остальных сигналов. Подробности: CAR_TEST_FINDINGS.md.

## Лицензия и допустимая основа

Корневой [LICENSE](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/LICENSE) — MIT, copyright 2026 cauliflowermossgrape и автор китайского перевода. При существенном копировании MIT-кода сохранять notices.

Но репозиторий НЕ целиком MIT. [README, раздел исключений](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/README.md#doom-and-renderer-licences):

- `kit/renderd` — GPL-3.0-or-later (включает части исходного MIT renderer с отдельным notice).
- `kit/emu/wasm` и `kit/emu/web/gfx` включают renderer и также GPL-3.0-or-later.
- `apps/doom`, `third_party/doomgeneric` — GPL-2.0, данные Freedoom отдельно BSD.
- Другие встроенные assets могут иметь собственные notices (OFL fonts, сторонние наборы диагностических данных); корневой MIT не заменяет их условия.

Для этого прототипа: новый React/SVG/CSS UI, без копирования кода/бинарников перечисленных GPL-частей, без копирования BMW SDK и proprietary service catalog. Для будущего порта допустимо исследовать MIT runtime, `apps/car_vitals`, `apps/live_data`, read-only файл `apps/live_adjustments/xdrive_live.js`; не тянуть все live_adjustments, где есть управляющие функции. Renderer как отдельная системная зависимость — отдельное решение на этапе порта, не часть браузерной сборки.

## Источники

Все ссылки закреплены на commit:

1. [Live Data signal definitions](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/apps/live_data/signals.js#L20-L144) — полные имена интерфейсов, поля, шкалы, явные raw-кандидаты.
2. [xDrive read-only implementation](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/apps/live_adjustments/xdrive_live.js#L1-L94) — split, wheel imbalance, steering, yaw.
3. [M Vitals subscriptions](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/apps/car_vitals/main.js#L277-L384) — TPMS units, температуры, gear, BDS.
4. [M Vitals scaling and LMV config](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/apps/car_vitals/app.json#L726-L796) — фактор, offset, sentinels, DB32.
5. [M Vitals split estimate](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/apps/car_vitals/main.js#L224-L246) — front torque и оценка процентов.
6. [EGS candidates](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/apps/car_vitals/app.json#L1102-L1124) — DID 6000 и неподтверждённый DA12.
7. [OBD definitions](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/apps/live_data/std.js#L39-L55) — throttle OBD PID 11.
8. [SOME/IP runtime](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/kit/runtime/signals.js#L1-L24) — конфиг берётся с автомобиля, native binding.
9. [Read-only diagnostic wrapper](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/kit/runtime/readonly-diag.js#L1-L60) — явное ограничение разрешённых diagnostic services.
10. [App structure and render API](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/README.md#6-writing-your-own-app) — CommonJS apps, RHMI, canvas/GPU, локализация.

## Полная карта запрошенных сигналов

Сокращения в таблице раскрыты ниже. Предлагаемая частота UI — проектное решение, не обещание частоты автомобиля.

| ID / показатель | Status | Подтверждённый путь или кандидат | Интерпретация / ограничение | UI Hz |
|---|---|---|---|---:|
| `wheelSpeed.FL/FR/RL/RR` | likely | PT.`ActualValueRPMWheel`: `actualValueRPMWheelFLH`, `actualValueRPMwheelFRH`, `actualValueRPMWheelRLH`, `actualValueRPMWheelRRH` | Обратить внимание на строчную **w** в FR. Raw, scaling неизвестен, source [1] строки 133–136. Нельзя заявить км/ч или RPM без проверки; mock может быть нормализован в км/ч. | 5–10 |
| `wheelSlip.FL/FR/RL/RR` | unknown для физического slip; likely для относительного индикатора | Расчёт из вышеуказанных wheel samples; отдельного подтверждённого slip endpoint нет | Upstream считает `(wheel/mean4 − 1) × 100`, только при vehicle speed >5 км/ч [2]. Это разница скоростей, поворот/разные шины тоже меняют её; синхронная пробуксовка всех колёс невидима. Честная подпись «разница вращения, оценка». | 5–10 |
| `xdrive.rearPercent/frontPercent` | confirmed (реализация), G07 unverified | BDS.`basicDataSet.valueDistributionLongitudinalTorqueRearAxisFrontAxis` + `qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis` | rear = raw×0.01%, front=100−rear. Upstream игнорирует 0/65535 и проверяет qualifier; на некоторых авто поле пустое. Это reported split, не два независимых датчика момента. | 5 |
| `xdrive.frontTorqueNm` | confirmed (кандидат реализован), G07 unverified | LMV ECU 25 / **0x19**, UDS ReadDataByIdentifier **0x22**, DID **DB32** [4] | 2-byte signed raw на offset 0 ×0.25 Nm. Конфиг называет LMV_MOMENT.ISTMOMENT; upstream ссылается на LMV_G11 description. Требует подтверждения варианта ECU и физического смысла на G07. Не смешивать с моментом непосредственно на шинах. | ≤2 |
| `xdrive.rearTorqueNm` | unknown | Прямого readout в изученных apps нет | Не engineTorque−frontTorque: они относятся к разным точкам трансмиссии. Можно показывать отдельную оценку только с передаточными отношениями/допущениями и меткой estimated; в v0 mock. | 5 |
| `rearDiff.lockStatus/lockPercent` | unknown | В исследованных apps подходящего endpoint не найдено | Комплектация M Sport Differential тоже не подтверждена; distinguish unsupported от unlocked. Нельзя выдавать DSC торможение за mechanical diff lock. | 2 |
| `brakes.intervention.FL/FR/RL/RR` | unknown | Per-wheel intervention endpoint не найден | DSC.`StabilizationManagement.statusBrakingDriver` — торможение водителем, НЕ индивидуальные тормозные вмешательства. | 5–10 |
| `steeringWheelAngleDeg` | confirmed | STEER.`ActualSteeringAngleDriver.actualValueSteeringAngleDriver`, fallback `actualSteeringAngleDriverNoCRC` [1,2] | signed int16×0.04395°, 65535 invalid. Это **рулевое колесо**, не положение управляемых колёс. Проверить знак/zero. | 5–10 |
| `attitude.pitchDeg/rollDeg` | unknown | Абсолютных body-angle endpoint не найдено | Не подставлять pitch/roll rates. VM.`LaneSlope.actualValueLongitudinalGradientRoadway` и `.actualValueTransverseGradientRoadway` существуют как raw candidates, но slope дороги и угол кузова различны, масштаб неизвестен. | 5–10 |
| `attitude.pitchRateDegS/rollRateDegS` (доп.) | confirmed | CDS.`datenFahrdynamiksensorErweitert.nickgeschwindigkeitSchwerpunkt` / `.wankgeschwindigkeitSchwerpunkt` [1] | raw×0.005−163.84 °/s, 65535 invalid. Интегрирование не даёт надёжного absolute attitude без bias/reference/filter. | 10 |
| `suspension.height.FL/FR/RL/RR` | unknown | Endpoint и калибровка не найдены | В mock лучше «относительная высота, мм от Normal», НЕ ground clearance. Реальный sensor travel может не равняться просвету. | 5 |
| `suspension.level` | unknown | Offroad/High/Normal/Dynamic/Sport/Loading — пока только доменная mock enum | Не утверждать соответствие реальным G07 режимам/кодам; это будущая таблица нормализации. | 1 |
| `suspension.articulation/frontDelta/rearDelta` | unknown (входы unknown) | Производное от corner heights | Определить передний L−R, задний L−R, cross-delta; не объявлять стандартный RTI без геометрии и методики. | 5 |
| `altitudeM` | unknown | Navigation/GNSS source вероятен, endpoint в исследованном repo не подтверждён | Указать систему высот: высота над средним уровнем моря отличается от эллипсоидальной. Барометрическая высота требует reference. Без данных — unavailable; mock имеет явный условный datum. | 1 |
| `engine.torqueNm` | confirmed | FES.`statusActualValueTorque2.actualValueTorqueCrankshaft` [1,3,4] | raw×0.5−1023.5 Nm, raw≥4095 invalid. Crankshaft torque, отрицательный возможен при engine braking; не обрезать для offroad бездумно до 0. | 5–10 |
| `engine.rpm` (доп.) | confirmed | CDS.`statusEngineSpeed2.actualValueRPMEngineCrankshaft` [1] | raw×0.25 об/мин, 65535 invalid; подтверждён decoder upstream, не проверен на этом G07. | 5–10 |
| `engine.throttlePercent` | confirmed как общий OBD candidate, G07 unverified | OBD current data 01 PID **11**, DME [7] | byte×100/255 %. Это положение дросселя, особенно для diesel не тождественно запросу тяги. OEM DID 4600/5858 перечислены в useful.js, но без проверки не выбирать их как универсальные. | ≤2 |
| `acceleratorPedalPercent` (доп.) | confirmed | PEDAL.`AngleAcceleratorPedal.actualValueAngleAcceleratorPedal` [1] | raw×0.025 %, отдельный показатель «Педаль газа». | 5–10 |
| `gear/stage` | confirmed | VI.`DataPowerTrain2.statusGearSelectionDrive` или VI.`statusGearboxDrive.statusActualGearDrive/statusActualStageDrive` [1,3] | Разные enum mapping! DataPowerTrain2: N1/R2/P3/NP4/G1=5; gearbox: gear G1=3, R1, N/P2; stage P1/R2/N3/D4. Нельзя декодировать одной таблицей. | 5 |
| `temperature.gearboxC` | confirmed (6000), likely (BDS/DA12 на G07) | BDS.`basicDataSet.valueTemperatureTransmissionOil`; EGS ECU **0x18**, DID **6000**; fallback candidate DA12 [6] | BDS raw−48, но бывает постоянно 0; **6000 byte−40**, upstream note «read on G22». **DA12 byte−48** явно помечен непроверенным forum candidate. Не объявлять DA12 confirmed. | 1–2 |
| `temperature.coolantC` | confirmed | CDS.`statusEngineTemperature.temperatureEngineDrive` [1,3] | raw−48 °C, 255 invalid. | 1–2 |
| `temperature.engineOilC` | confirmed | CDS.`statusEngineTemperature.temperatureEngineOilDrive` [1,3] | raw−48 °C, 255 invalid; отдельный реализованный fallback OBD PID 5C / DID F45C raw−40 в car_vitals app.json. | 1–2 |
| `tyres.pressure.FL/FR/RL/RR` | confirmed | TPMS.`statusTyrePressure.actualValuePressureTyre{FLH,FRH,RLH,RRH}` [3,4] | raw×0.1 в **unit автомобиля**; Vehicle.statusNewCurrentUnitsStatusExt.unitOfMeasurementAirPressure определяет bar/kPa/psi, потом convert. raw≥65532 invalid. Live Data older simplification bar небезопасно копировать как универсальную. | 0.1–1 |
| `tyres.temperature.FL/FR/RL/RR` | confirmed | TPMS.`statusTyreTemperature.actualValueTemperatureTyre{FLH,FRH,RLH,RRH}` [3,4] | raw−40 в temp unit автомобиля; convert °F→°C при необходимости. Raw65535/вне диапазона invalid. Read on G05 documented in config, не G07. | 0.1–1 |
| `hdc.status/setSpeed` | unknown | Endpoint в изученных app signal declarations/implementations не найден | Не выводить inactive вместо missing. Set speed в концепте только read-only отображение; нет кнопки изменения. | 2 |
| `dsc.status` | likely | DSC.`StabilizationManagement.qualifierFunctionFDR` [1] | Raw qualifier, validated semantic enum отсутствует. Qualifier не обязательно режим OFF/ON; не трактовать произвольно. | 2 |
| `dtc.status` | unknown | Подтверждённый Dynamic Traction Control mode endpoint не найден | DTC diagnostic trouble code — другое значение аббревиатуры; не использовать fault scanner signals. | 2 |
| `acceleration.longG/latG` (доп.) | confirmed | CDS2.`statusLongitudinalAccelerationMassCenter.longitudinalAccelerationCentreOfGravity` / lateral аналог [1] | `(raw×0.002−65)/9.80665` g; gravity/frame/grade effect требуют проверки. | 10 |
| `yawRateDegS` (доп.) | confirmed | CDS2.`statusYawVelocityVehicle.yawVelocityVehicle` [1,2] | raw×0.005−163.84 °/s, 65535 invalid. | 10 |
| `vehicleSpeedKmh` (доп.) | confirmed | V2.`statusCarSpeed2.speedVehicleCentreOfGravity` [1] | raw×0.015625 km/h, 65535 invalid. | 5–10 |

Полные пространства имён:

- CDS = `de.bmw.infotainment.vehicle.CDS`; CDS2 = `de.bmw.infotainment.vehicle.CDS2`.
- V2 = `de.bmw.infotainment.vehicle.Vehicle2`.
- FES = `de.bmw.infotainment.drivingexcitement.FES`.
- VI = `de.bmw.infrastructure.VehicleInformation` (не сокращённый неверный namespace в старой таблице README).
- TPMS = `de.bmw.infotainment.vehicle.TPMS`.
- PT = `de.bmw.powertrain.Powertrain`.
- PEDAL = `de.bmw.powertrain.AcceleratorPedal`.
- STEER = `de.bmw.chassis.SteeringAngle`.
- VM = `de.bmw.chassis.VehicleModel`.
- DSC = `de.bmw.chassis.VehicleStabilizationManagement`.
- BDS = `de.bmw.infrastructure.analytics.BasicDataSet`.

Числовые SOME/IP service/method/event IDs не выдумывать. Upstream генерирует per-app interface configs на основе service catalog конкретной head unit; собственно BMW SDK и полный master catalog намеренно не лежат в repo ([README](https://github.com/cauliflowermossgrape/idrive7-apps/blob/082d42d52cfaa654c1a9740e6736cbd9433c486d/README.md#repository-layout)).

## Session metrics

Все производные наследуют runtimeSource/quality входов и не обновляются по invalid, stale или missing sample. Reset создаёт новую session baseline, а не ставит все max/min в 0. Обязательны max absolute pitch/roll, altitude min/max, max wheel slip per corner и overall, max размах высот, peak transmission/oil/coolant temperature, max engine torque и elapsed time. Signed extrema, max steering, distance, gain/loss — будущие/опциональные расширения; набор/потери высоты требуют фильтрации noise. Mock-session маркировать mock. Смена demo scenario не должна переносить fixture max как якобы измеренный результат.

Для v0 mock slip — независимая условная неотрицательная величина 0–100%, не вычисляемая из wheel speeds. Дельты высоты: frontDelta=FL−FR; rearDelta=RL−RR; leftRight=(FL+RL−FR−RR)/2; frontRear=(FL+FR−RL−RR)/2; range=max−min. Невалидный/устаревший/отсутствующий необходимый вход делает соответствующий результат недоступным.

Абсолютные pitch/roll показания нельзя интерпретировать как универсальный предел опрокидывания: нагрузка, склон, динамика и сцепление меняют устойчивость; не добавлять «безопасный угол X°» без vehicle-specific engineering validation.

## Исправления прежних утверждений из чата

1. Утверждение «все перечисленные датчики уже доступны в SDK» чрезмерно. Часть — raw candidates, часть отсутствует, применимость к G07 не установлена.
2. `22 DB32`, LMV `0x19`, signed `raw/4` действительно присутствуют в исходниках; это не выдуманный адрес. Но наличие кода не подтверждает ответ конкретного G07.
3. Проценты xDrive из LMV — **оценка** `frontNm/(engineNm×gearRatio)`, не прямое измерение заднего момента. Upstream явно отмечает отсутствие converter multiplication/losses. Константы ZF ratios не считать универсальными.
4. «Wheel slip» upstream — относительная разница RPM к среднему четырёх колёс, scale intentionally unknown. Прямой traction slip sensor не найден.
5. Pitch/roll rates нельзя отображлять как degrees. Road slope raw candidates не доказывают кузовные absolute angles.
6. TPMS raw units зависят от units автомобиля; нельзя всегда применять bar/°C.
7. «DSC status» raw qualifier нельзя без enum mapping превращать в DSC ON/OFF/DTC.
8. Root MIT не распространяется автоматически на renderer/emulator/Doom. Нельзя копировать эти части в MIT prototype как будто исключений нет.

## Вывод по архитектуре и переносу

Самый практичный v0: React+TypeScript+Vite и новый SVG/CSS UI. Изолировать domain model, locale dictionaries, formatter, mock provider и session reducer от React. Никакого SOME/IP/OBD транспорта в web prototype; никаких write methods в provider contract.

Реальный idrive7-apps — **не webview/React host**: CommonJS `app.json` + `main.js`, BMW RHMI integration, `ctx.canvas`, `ctx.loop`, native SOME/IP module. UI рисуется command canvas→GPU daemon либо PNG fallback. Следовательно JSX/CSS придётся портировать в renderer primitives; domain normalization, metrics, localization dictionary и screen geometry можно переиспользовать через TS transpile в совместимый JS. Browser proof-of-concept не означает готовый `.mgu`.

Upstream рекомендует logical canvas 1600×520, header `G.TOP=44`, lower edge `G.BOTTOM=512`, с дополнительной высотой в full-screen configurations. Для v0 единый список viewport: 1440×900, 1920×720, 1600×520, 1280×480, 390×844; не объявлять физическое разрешение конкретного G07 без screen data. Главные показатели, которые должны помещаться на широком профиле, перечислены в PRODUCT_SPEC.md. Русские строки вынести в словарь с будущим EN; runtime upstream уже умеет fixed-language build `--language ru` и имеет Cyrillic atlas.

Для будущего read-only adapter: allowlisted subscriptions/read fields, никакого `signals.set` и write flags; только отдельно выбранные ReadDataByIdentifier/OBD reads после подтверждения unit catalog и ECU. `readonly-diag.js` полезен как архитектурный образец, но не нужно включать transport в текущий web prototype. Не импортировать управляющие приложения ради одной telemetry страницы.

Следующий доказательный этап — получить service catalog/пример telemetry payload с конкретной G07, записать ECU variant и units, подтвердить identity, scale, signs, validity flags и freshness для каждого поля. Затем повышать status для целевой машины; неизвестные показатели сохраняют unavailable и не заменяются нулями.

## Фронтальная и боковые камеры

| Показатель | evidenceStatus | runtimeSource v0 | Подтверждённый endpoint |
|---|---|---|---|
| Переднее изображение | unknown | mock | Не найден |
| Левое боковое изображение | unknown | mock | Не найден |
| Правое боковое изображение | unknown | mock | Не найден |
| Время захвата, доступность и параметры потока | unknown | отсутствует | Не найден |
| Композитный Surround View | unknown | отсутствует | Не найден |

Веб-прототип показывает локальные статичные изображения с подписью «Демонстрационное изображение». Выбор крупного ракурса меняет только локальное представление. Это отдельная модель демонстрации камер; выдуманные endpoints или timestamps в SignalMap не добавляются. Приложение не включает камеры автомобиля и не обращается к видеосервисам.

Старое ограничение README idrive7-apps о недоступности raw streams не описывает всю нынешнюю экосистему. Владелец подтвердил работающие камеры в Drive Recorder **из MGU Store**. Проверены [Drive Recorder](https://github.com/IterioDev/car-apps/blob/main/apps/oap-driverecorder-next/README.md) и [Turn View](https://github.com/IterioDev/car-apps/blob/main/apps/iteriodev_turnview/README.md): они используют собственные приёмники AVB-видео. В изученных клиентских интерфейсах нет поддерживаемой выдачи трёх live-потоков стороннему приложению; буфер кадров плеера относится к сохранённому ролику. Код этих приложений не копируется: [PolyForm Strict и дополнительные условия](https://github.com/IterioDev/car-apps/blob/main/LICENSE.md) не дают права на такое публичное производное приложение. Возможность камер в другой программе подтверждена, интеграция в нашу — ещё нет. Детали и дальнейшие требования: CAR_TEST_FINDINGS.md.

В макете нет фиктивных расстояний, безопасных траекторий, FPS, времени кадра или заявлений о синхронизации изображений с телеметрией. Будущий live-camera adapter требует отдельного подтверждения допустимого read-only пути, качества и задержки кадров.

## Первая нативная реализация 0.1.0 (исторический срез, 17 ноября 2026)

Цель пользователя: двигатель 4.4 л, MGU Store 0.9.40, mgu-render 0.6.21. Эти сведения не меняют исследовательский статус сигналов. Фотографии первого запуска подтверждают поступление части базовых полей; новые подписки требуют повторной проверки на машине.

Единый allowlist — `native/src/vehicle/allowlist.ts`; он задаёт и подписки адаптера, и раздел signals манифеста. Реализованы только следующие восемь показателей из ранее исследованных источников:

| Показатель | Поле | Пересчёт | Runtime / ограничение |
|---|---|---|---|
| Обороты | CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft | raw × 0.25; 65535 invalid | measured только после callback; 0 валиден |
| Скорость | Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity | raw × 0.015625; 65535 invalid | measured после callback |
| ОЖ | CDS.statusEngineTemperature.temperatureEngineDrive | raw − 48; 255 invalid | measured после callback |
| Масло ДВС | CDS.statusEngineTemperature.temperatureEngineOilDrive | raw − 48; 255 invalid | measured после callback |
| Момент двигателя | FES.statusActualValueTorque2.actualValueTorqueCrankshaft | raw × 0.5 − 1023.5; raw ≥ 4095 invalid | Отрицательный момент сохраняется |
| Продольное ускорение | CDS2.statusLongitudinalAccelerationMassCenter.longitudinalAccelerationCentreOfGravity | (raw × 0.002 − 65) / 9.80665; 65535 invalid | В g, не угол кузова |
| Поперечное ускорение | CDS2.statusLateralAccelerationMassCenter.lateralAccelerationCentreOfGravity | та же формула | В g, не угол кузова |
| Передача | VehicleInformation.statusGearboxDrive / DataPowerTrain2 | Две отдельные таблицы enum | N/P без селектора — unavailable; D/M не угадывается |

Интерфейсы optional, права только r/s, никаких новых числовых endpoint IDs, DID или диагностических запросов. Все прочие показатели из основной таблицы в режиме чтения — unavailable; в демо они остаются mock. Порог устаревания — проектное допущение: 5 с для динамических значений, 60 с для температур и передачи; при наблюдаемой потере доступности интерфейса значения сразу stale. Частоты уведомлений и необходимость корректировки этих порогов требуют аппаратной проверки. Камеры недоступны в режиме чтения.

## Исправленная нативная реализация 0.1.1

13 интерфейсов, 19 полей, 22 нормализованных показателя. Реализация новых декодеров подтверждена исходниками и локальными тестами; на G07 они ещё не испытаны. Исходные восемь показателей 0.1.0 сохранены.

| Добавлено | Поле и пересчёт | Ограничение |
|---|---|---|
| Угол руля | SteeringAngle.ActualSteeringAngleDriver / actualSteeringAngleDriverNoCRC, signed16 × 0.04395° | Только уведомления, не угол колёс; 65535 invalid |
| Скорость рыскания | CDS2.statusYawVelocityVehicle, raw × 0.005 − 163.84°/с | Getter читается раз в секунду |
| Педаль | AcceleratorPedal.AngleAcceleratorPedal, raw × 0.025% | Не положение дросселя; только уведомления |
| xDrive | BasicDataSet.basicDataSet.valueDistributionLongitudinalTorqueRearAxisFrontAxis × 0.01% | Задняя доля reported; передняя = 100 − задняя, estimated. Проверяется qualifier; 0/65535 не заполнены. Моменты осей в Н·м отсюда не вычисляются |
| Масло АКПП | BasicDataSet.basicDataSet.valueTemperatureTransmissionOil − 48°C | 255 invalid; требуется изменение сырого значения, чтобы отсеять постоянную заглушку прошивки |
| Давление четырёх шин | TPMS.statusTyrePressure, raw × 0.1 в единицах автомобиля | Только с полученными Vehicle.statusNewCurrentUnitsStatusExt: BAR/KPA/PSI. >=65532 invalid, 0 бар допустим |
| Температура четырёх шин | TPMS.statusTyreTemperature, raw − 40 в единицах автомобиля | C/F берутся из поля единиц, не угадываются по давлению. 65535 invalid |

Getter-поля перечитываются: быстрые раз в 1 с, температуры двигателя раз в 5 с, TPMS и единицы раз в 10 с. Только успешное чтение обновляет время отсчёта: это исправляет устаревание неподвижной скорости 0. Для шин TTL составляет 10 минут; это не обещание частоты самих датчиков. Передача удерживается при непрерывно доступном провайдере; после потери связи нужно новое значение. Подписные поля без getter (руль, педаль, BDS) могут устаревать без новых уведомлений — доступность сервиса сама по себе не доказывает свежесть этих значений.

Сырые ActualValueRPMWheel, LaneSlope и StabilizationManagement читаются только для ограниченной диагностики. Их единицы/enum не подтверждены, поэтому они не превращаются в км/ч колёс, slip, градусы кузова, DSC/DTC или индивидуальное торможение. Диагностический снимок содержит известные поля, доступность сервиса, ошибки чтения и время/число ответов; журнал изменений ограничен 50 записями.

Ранее начатый getter после обрыва/переподключения не может оживить старые данные. Одновременно выполняется не более одного чтения каждого поля; остановка источника прекращает опрос и обработку поздних ответов. Никаких DID/UDS-запросов и управляющих методов в 0.1.1 не добавлено.
