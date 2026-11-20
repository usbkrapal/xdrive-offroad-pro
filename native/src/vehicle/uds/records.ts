// Схемы читаемых записей UDS (служба 0x22) и их разбор. Источники схем (поля, типы, порядок байт, масштаб, таблицы
// значений), MIT:
//   - EGS 6000: idrive7-apps apps/zf8hp/catalog.js (GSZFBCE rev. 15.000) @082d42d, car_vitals config.dme.egs;
//   - LMV DB32, DSC DBE4/DBE5, VDP DC05/DC06/DC31/D8EC, EPS DB57: strulock/m550-analyzer docs/channels
//     (LMV_G11, DSC_G30N, VDP_G11, EPS_G11) @2a2002b1, их таблицы значений (*-values.md) и docs/decoding.md.
// Смещения — из ширины типов EDIABAS по порядку полей (unsigned/signed char 1, int 2, long 4, motorola float 4 байта
// big-endian; L/H high — big-endian), а не из номера поля. Длина ответа должна совпасть ТОЧНО; совпадение длины
// не доказывает вариант блока — применимость решает идентификация (ecus.ts).

export type FieldValue = number | null;
const NONE: Readonly<Record<string, string>> = {};

/** Разобранная запись: именованные значения (null — недопустимо/нет) и причины по ним. */
export interface DecodedRecord {
  readonly values: Readonly<Record<string, FieldValue>>;
  readonly reasons: Readonly<Record<string, string>>;
  /**
   * Поля, у которых null значит «смысл/достоверность не установлены» (нет данных), а не «недопустимое значение»
   * (ошибка). Например, состояние при неописанных квалификаторах, момент LMV при неописанном квалификаторе.
   */
  readonly unknown?: Readonly<Record<string, true>>;
}

export interface RecordSchema {
  readonly did: number;
  readonly name: string;
  /** Точная длина полезной нагрузки (после 62 DIDhi DIDlo); −1 — любая (только сырьё, без разбора). */
  readonly length: number;
  decode(p: readonly number[]): DecodedRecord;
}

const u8 = (p: readonly number[], at: number) => p[at];
const u16 = (p: readonly number[], at: number) => (p[at] << 8) | p[at + 1];
const s16 = (p: readonly number[], at: number) => {
  const v = u16(p, at);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const s32 = (p: readonly number[], at: number) => ((p[at] << 24) | (p[at + 1] << 16) | (p[at + 2] << 8) | p[at + 3]) | 0;
/** IEEE 754 single, big-endian («motorola float»). */
function f32be(p: readonly number[], at: number): number {
  const b = Buffer.from(p.slice(at, at + 4));
  return b.readFloatBE(0);
}

const WHEEL_CODES = [['VL', 'FL'], ['VR', 'FR'], ['HL', 'RL'], ['HR', 'RR']] as const;
export type WheelKey = (typeof WHEEL_CODES)[number][1];
export const WHEEL_KEYS: readonly WheelKey[] = WHEEL_CODES.map((w) => w[1]);

/** EGS 6000 _GETRIEBEOELTEMPERATUR: 1 байт без знака, −40 °C. Вне −40…160 °C — недопустимо (как car_vitals). */
export const EGS_OIL: RecordSchema = {
  did: 0x6000,
  name: 'EGS _GETRIEBEOELTEMPERATUR',
  length: 1,
  decode(p): DecodedRecord {
    const c = u8(p, 0) - 40;
    return c >= -40 && c <= 160 ? { values: { oilC: c }, reasons: NONE } : { values: { oilC: null }, reasons: { oilC: `raw ${u8(p, 0)} вне диапазона` } };
  },
};

/**
 * LMV DB32 LMV_MOMENT: ISTMOMENT signed int ÷4 Нм (момент к передней оси, факт), QUALIFIER_ISTMOMENT unsigned int,
 * SOLLMOMENT signed int ÷4 Нм (заданный), QUALIFIER_SOLLMOMENT unsigned int → 8 байт, big-endian.
 * Таблицы значений квалификатора в источниках нет: какой квалификатор означает «достоверно», не установлено.
 */
export const LMV_QUALIFIER_VALID: readonly number[] = [];
export const LMV_MOMENT: RecordSchema = {
  did: 0xdb32,
  name: 'LMV_MOMENT',
  length: 8,
  decode(p): DecodedRecord {
    const q = u16(p, 2);
    const qt = u16(p, 6);
    const ok = LMV_QUALIFIER_VALID.indexOf(q) >= 0;
    const values: Record<string, FieldValue> = {
      frontTorqueNm: ok ? s16(p, 0) / 4 : null,
      frontTorqueCandidateNm: s16(p, 0) / 4,
      qualifier: q,
      targetNm: s16(p, 4) / 4,
      targetQualifier: qt,
    };
    return ok
      ? { values, reasons: NONE }
      : { values, reasons: { frontTorqueNm: `квалификатор 0x${q.toString(16)}: значение квалификатора не описано в источниках` }, unknown: { frontTorqueNm: true } };
  },
};

/**
 * DSC DBE4 GESCHWINDIGKEIT_RAD (DSC_G30N): 5 × signed int ÷100 км/ч (VL, VR, HL, HR, автомобиль), 5 × unsigned char
 * направление (TAB_DREHRICHTUNG 0 стоит, 1 вперёд, 2 назад, 3 не определено; VL…HR, REF), 4 × unsigned char
 * качество сигнала % (VL…HR; < 10 % — сигнала нет, 10…50 — слабый, > 50 — в порядке; > 100 — вне диапазона
 * единицы, недопустимо) → 10 + 5 + 4 = 19 байт.
 */
export const DSC_WHEEL_SPEED: RecordSchema = {
  did: 0xdbe4,
  name: 'GESCHWINDIGKEIT_RAD',
  length: 19,
  decode(p): DecodedRecord {
    const values: Record<string, FieldValue> = {};
    const reasons: Record<string, string> = {};
    WHEEL_CODES.forEach(([, w], i) => {
      const q = u8(p, 15 + i);
      values[`quality.${w}`] = q;
      values[`direction.${w}`] = u8(p, 10 + i);
      // Качество — проценты (единица «%» в схеме): значение > 100 вне диапазона единицы и не считается хорошим.
      // Это проверка единицы/диапазона, а не догадка о смысле особого кода (смысл 101…255 не описан).
      if (q > 100) {
        values[`speed.${w}`] = null;
        reasons[`speed.${w}`] = `качество сигнала ${q} — вне диапазона 0…100 %`;
      } else if (q < 10) {
        values[`speed.${w}`] = null;
        reasons[`speed.${w}`] = `качество сигнала ${q} % (< 10 % — сигнала нет)`;
      } else {
        values[`speed.${w}`] = s16(p, i * 2) / 100;
        if (q <= 50) reasons[`speed.${w}`] = `слабый сигнал (${q} %)`;
      }
    });
    values.vehicleKmh = s16(p, 8) / 100;
    values.directionRef = u8(p, 14);
    // Отклонение колеса от опорной скорости DSC в том же ответе, % — ОЦЕНКА, не физическое проскальзывание шины
    // (опорная сама выводится из колёс: одновременная пробуксовка всех четырёх не видна). Только при качестве > 50 %
    // на всех четырёх колёсах и движении вперёд (направление опорной 1).
    const allGood = WHEEL_CODES.every((_w, i) => u8(p, 15 + i) > 50 && u8(p, 15 + i) <= 100);
    const ref = values.vehicleKmh;
    const unknown: Record<string, true> = {};
    WHEEL_CODES.forEach(([, w], i) => {
      if (!allGood || values.directionRef !== 1 || values[`speed.${w}`] === null) {
        values[`deltaPct.${w}`] = null;
        reasons[`deltaPct.${w}`] = !allGood ? 'качество сигнала колёс ≤ 50 %' : values.directionRef !== 1 ? 'не движение вперёд' : 'нет скорости колеса';
        // Стоянка / задний ход — нормальные условия, в которых эта оценка неприменима, не ошибка датчика.
        if (allGood && (values.directionRef === 0 || values.directionRef === 2)) unknown[`deltaPct.${w}`] = true;
        return;
      }
      values[`deltaPct.${w}`] = ((s16(p, i * 2) / 100 - ref) / Math.max(ref, 5)) * 100;
    });
    return { values, reasons, unknown };
  },
};

/**
 * DSC DBE5 DSC_DRUCKSENSOREN: 6 × signed int ÷10 бар: контур 1, контур 2, «VL», «VR», «HL», «HR» → 12 байт.
 * Колёсные поля в зависимости от исполнения — давление контура или не заняты: это НЕ давление/вмешательство по
 * колёсам. Наружу — только контуры 1 и 2 (давление тормозной системы), колёсные поля — сырьём в диагностику.
 */
export const DSC_PRESSURE: RecordSchema = {
  did: 0xdbe5,
  name: 'DSC_DRUCKSENSOREN',
  length: 12,
  decode(p): DecodedRecord {
    const v = (i: number) => s16(p, i * 2) / 10;
    return { values: { circuit1Bar: v(0), circuit2Bar: v(1), nominalVL: v(2), nominalVR: v(3), nominalHL: v(4), nominalHR: v(5) }, reasons: NONE };
  },
};

/**
 * VDP DC05 STATUS_HOEHENSTAENDE_LESEN: 4 × motorola float × 1000 → мм (VL, VR, HL, HR) → 16 байт. Это выход датчика
 * высоты в мм; относительно чего (нормальный уровень, нуль калибровки) — источник не говорит: НЕ «отклонение от
 * нормы». Пригодно только при исправном датчике (DC06 = 0) и успешной калибровке нуля (DC31 = 1).
 */
export const VDP_HEIGHTS: RecordSchema = {
  did: 0xdc05,
  name: 'STATUS_HOEHENSTAENDE_LESEN',
  length: 16,
  decode(p): DecodedRecord {
    const values: Record<string, FieldValue> = {};
    const reasons: Record<string, string> = {};
    WHEEL_CODES.forEach(([, w], i) => {
      const mm = f32be(p, i * 4) * 1000;
      values[`heightMm.${w}`] = Number.isFinite(mm) && Math.abs(mm) < 2000 ? mm : null;
      if (values[`heightMm.${w}`] === null) reasons[`heightMm.${w}`] = 'не число или вне ±2 м';
    });
    return { values, reasons };
  },
};

/** VDP DC06 STATUS_HOEHENSTAENDE_SENSOREN: 4 × signed int (TAB_HOHENSTAND_SENSOR: 0 исправен, 1/255 неисправен) → 8 байт. */
export const VDP_SENSOR_STATE: RecordSchema = {
  did: 0xdc06,
  name: 'STATUS_HOEHENSTAENDE_SENSOREN',
  length: 8,
  decode(p): DecodedRecord {
    const values: Record<string, FieldValue> = {};
    WHEEL_CODES.forEach(([, w], i) => (values[`sensor.${w}`] = s16(p, i * 2)));
    return { values, reasons: NONE };
  },
};

/** VDP DC31 STATUS_HOEHENSTAENDE_OFFSET_ZUSTAND: 4 × unsigned char (0 нуль не откалиброван, 1 успешно, 2 не установлен, 255 неизвестно). */
export const VDP_OFFSET_STATE: RecordSchema = {
  did: 0xdc31,
  name: 'STATUS_HOEHENSTAENDE_OFFSET_ZUSTAND',
  length: 4,
  decode(p): DecodedRecord {
    const values: Record<string, FieldValue> = {};
    WHEEL_CODES.forEach(([, w], i) => (values[`offset.${w}`] = u8(p, i)));
    return { values, reasons: NONE };
  },
};

/** VDP D8EC STATUS_EHC_VEHICLE_HEIGHT: unsigned int, TAB_EHC_VEHICLE_HEIGHT 2 низкий / 8 стандарт / 16 высокий → 2 байта. */
export const EHC_LEVELS: Readonly<Record<number, string>> = { 2: 'низкий', 8: 'стандарт', 16: 'высокий' };
export const VDP_LEVEL: RecordSchema = {
  did: 0xd8ec,
  name: 'STATUS_EHC_VEHICLE_HEIGHT',
  length: 2,
  decode(p): DecodedRecord {
    const n = u16(p, 0);
    return EHC_LEVELS[n] ? { values: { level: n }, reasons: NONE } : { values: { level: null }, reasons: { level: `значение ${n} не из таблицы` } };
  },
};

/**
 * EPS DB57 EPS_RITZELWINKELSENSOR: signed long ÷100 ° (угол ШЕСТЕРНИ рулевого механизма, не угол руля), signed int °/с,
 * signed char состояние (3 — смещение прямого хода записано, положение найдено и сохранено, Ist_Position_EPS
 * действительна; 255 — недопустимо) → 4 + 2 + 1 = 7 байт. Угол пригоден только при состоянии 3.
 */
export const EPS_PINION: RecordSchema = {
  did: 0xdb57,
  name: 'EPS_RITZELWINKELSENSOR',
  length: 7,
  decode(p): DecodedRecord {
    const state = u8(p, 6);
    const angle = s32(p, 0) / 100;
    return {
      values: { pinionDeg: state === 3 ? angle : null, pinionCandidateDeg: angle, pinionRateDegS: s16(p, 4), state },
      reasons: state === 3 ? NONE : { pinionDeg: `состояние датчика ${state} (нужно 3)` },
    };
  },
};

/* ---------- G05-семейство и прочие варианты (EdiabasX SGBD reference: IB_G05 rev 8.000, GSZFB1 rev 9.003, ghas10
 * rev 1.203, BDC_G05 rev 1.000 — только факты интерфейса: DID, порядок/тип полей, масштаб, таблицы значений;
 * сверено с бинарной выгрузкой m550-analyzer там, где она есть — integration-corrections.md). Порядок байт —
 * big-endian (все разборщики считают так всё, кроме «low»); у каждого многобайтового поля из источника только
 * EdiabasX есть диапазон, который байт-перестановка не проходит. ---------- */

/** GSZFB1 DA12 GETRIEBEOELTMEPERATUR: signed int (2 байта, high), −48 °C; −48…205 °C. Сырое 0 (−48 °C) — заполнитель. */
export const EGS_OIL_DA12: RecordSchema = {
  did: 0xda12,
  name: 'EGS GETRIEBEOELTMEPERATUR (GSZFB1)',
  length: 2,
  decode(p): DecodedRecord {
    const raw = s16(p, 0);
    const c = raw - 48;
    if (raw === 0) return { values: { oilC: null }, reasons: { oilC: 'сырое 0 (−48 °C) — вероятно заполнитель, ждём значения' } };
    return c > -48 && c <= 205 ? { values: { oilC: c }, reasons: NONE } : { values: { oilC: null }, reasons: { oilC: `сырое ${raw} вне −48…205 °C` } };
  },
};

/** IB_G05 DB29 DRUCKSENSOR_LESEN: давление в главном тормозном цилиндре, давление системы — 2 × signed int ÷10 бар. */
export const IB_PRESSURE: RecordSchema = {
  did: 0xdb29,
  name: 'DRUCKSENSOR_LESEN (IB_G05)',
  length: 4,
  decode(p): DecodedRecord {
    const values: Record<string, FieldValue> = {};
    const reasons: Record<string, string> = {};
    (['tmcBar', 'systemBar'] as const).forEach((k, i) => {
      const v = s16(p, i * 2) / 10;
      // −50…400 бар: перестановка байт (например 10 бар 00 64 → 64 00 = 2560 бар) не проходит
      values[k] = v >= -50 && v <= 400 ? v : null;
      if (values[k] === null) reasons[k] = `${v} бар вне −50…400`;
    });
    return { values, reasons };
  },
};

/**
 * Состояние функции DSC: 3 × unsigned char — состояние (TAB_*_FUNKTION), базовый и расширенный квалификатор (HEX, таблиц
 * НЕТ ни в IB_G05, ни в DSC_G30N). Достоверно ли состояние, решают квалификаторы, а их смысл не опубликован: известный код
 * состояния остаётся КАНДИДАТОМ (statusCandidate, в диагностику) и в показ не идёт; квалификаторы — сырыми.
 */
export const FUNCTION_STATUS_QUALIFIERS_KNOWN = false;
function functionStatus(did: number, name: string, codes: readonly number[]): RecordSchema {
  return {
    did,
    name,
    length: 3,
    decode(p): DecodedRecord {
      const c = u8(p, 0);
      const q = u8(p, 1);
      const qe = u8(p, 2);
      const values: Record<string, FieldValue> = { status: null, statusCandidate: null, code: c, qualifier: q, qualifierExt: qe };
      const reasons: Record<string, string> = {};
      if (c === 0xff) reasons.status = 'недопустимо (0xFF)';
      else if (codes.indexOf(c) < 0) reasons.status = `неизвестный код ${c}`;
      else {
        values.statusCandidate = c;
        if (FUNCTION_STATUS_QUALIFIERS_KNOWN) values.status = c;
        else {
          reasons.status = `квалификаторы 0x${q.toString(16)}/0x${qe.toString(16)} без опубликованного смысла: состояние ${c} — только кандидат`;
          // не ошибка блока: достоверность не установлена — «нет данных»
          return { values, reasons, unknown: { status: true } };
        }
      }
      return { values, reasons };
    },
  };
}
/** DC6E FDR: 0 недоступна, 1 доступна, 3 доступна с расширенным проскальзыванием. */
export const IB_FDR = functionStatus(0xdc6e, 'FDR_FUNKTION', [0, 1, 3]);
/** DC6D ASC: 0, 1, 2 запасной уровень, 3 расширенное проскальзывание, 4 запасной + расширенное. */
export const IB_ASC = functionStatus(0xdc6d, 'ASC_FUNKTION', [0, 1, 2, 3, 4]);
/** DC6C ABS: 0, 1, 2 запасной уровень. */
export const IB_ABS = functionStatus(0xdc6c, 'ABS_FUNKTION', [0, 1, 2]);
/** DC70 HDC: 0 недоступен, 1 доступен — ДОСТУПНОСТЬ функции, не «включён/работает». */
export const IB_HDC = functionStatus(0xdc70, 'HDC_FUNKTION', [0, 1]);

/** GHAS 4013 ZUSTAND_ECUM: 1 Init, 2 Run, 3 Shutdown, 4 Standby, 5 Selftest. Значения GHAS показываются только в Run. */
export const GHAS_STATES: Readonly<Record<number, string>> = { 1: 'инициализация', 2: 'работа', 3: 'выключение', 4: 'ожидание', 5: 'самопроверка' };
export const GHAS_STATE: RecordSchema = {
  did: 0x4013,
  name: 'ZUSTAND_ECUM',
  length: 1,
  decode(p): DecodedRecord {
    const s = u8(p, 0);
    return GHAS_STATES[s] ? { values: { state: s }, reasons: NONE } : { values: { state: null, code: s }, reasons: { state: `неизвестное состояние ${s}` } };
  },
};

/**
 * GHAS DC4C SPERRMOMENT: unsigned int Нм, «Status Sperrmoment». Тот же DID служит заданию момента (2E, не
 * используется): по чтению это статус/обратное чтение, НЕ доказанный фактический момент. 0…2500 Нм (диапазон
 * задания) — проверка единицы, не ёмкость блокировки для %.
 */
export const GHAS_LOCK_TORQUE: RecordSchema = {
  did: 0xdc4c,
  name: 'SPERRMOMENT',
  length: 2,
  decode(p): DecodedRecord {
    const v = u16(p, 0);
    return v <= 2500 ? { values: { torqueNm: v }, reasons: NONE } : { values: { torqueNm: null }, reasons: { torqueNm: `${v} Нм вне 0…2500` } };
  },
};

/** GHAS 4012 SPERRMOMENT_VORGABE_IPM: unsigned char ×10 −10 Нм, 0xFF недопустимо — ЗАДАННЫЙ момент блокировки. */
export const GHAS_TARGET: RecordSchema = {
  did: 0x4012,
  name: 'SPERRMOMENT_VORGABE_IPM',
  length: 1,
  decode(p): DecodedRecord {
    const r = u8(p, 0);
    if (r === 0xff) return { values: { targetNm: null }, reasons: { targetNm: 'недопустимо (0xFF)' } };
    if (r === 0) return { values: { targetNm: null }, reasons: { targetNm: 'сырое 0 (−10 Нм) — смысл не описан' } };
    return { values: { targetNm: r * 10 - 10 }, reasons: NONE };
  },
};

/** GHAS 4007 POSITION_SPERRE_ABSOLUT: unsigned char ×4 −100 инкрементов (фактическое положение), 0xFF недопустимо; в % не переводится. */
export const GHAS_POSITION: RecordSchema = {
  did: 0x4007,
  name: 'POSITION_SPERRE_ABSOLUT',
  length: 1,
  decode(p): DecodedRecord {
    const r = u8(p, 0);
    return r === 0xff ? { values: { positionInc: null }, reasons: { positionInc: 'недопустимо (0xFF)' } } : { values: { positionInc: r * 4 - 100 }, reasons: NONE };
  },
};

/** GHAS 401B DELTA_N_SPERRE: char (знаковый) ×2 об/мин — разность оборотов на блокировке; 0xFF недопустимо (до знака). */
export const GHAS_DELTA_N: RecordSchema = {
  did: 0x401b,
  name: 'DELTA_N_SPERRE',
  length: 1,
  decode(p): DecodedRecord {
    const r = u8(p, 0);
    if (r === 0xff) return { values: { deltaRpm: null }, reasons: { deltaRpm: 'недопустимо (0xFF)' } };
    return { values: { deltaRpm: (r >= 0x80 ? r - 0x100 : r) * 2 }, reasons: NONE };
  },
};

/** GHAS DC47 TEMP_OEL: int °C (масло главной передачи/блокировки), −50…250. */
export const GHAS_OIL: RecordSchema = {
  did: 0xdc47,
  name: 'TEMP_OEL',
  length: 2,
  decode(p): DecodedRecord {
    const v = s16(p, 0);
    return v >= -50 && v <= 250 ? { values: { oilC: v }, reasons: NONE } : { values: { oilC: null }, reasons: { oilC: `${v} °C вне −50…250` } };
  },
};

/** GSD_F90 (0F2550), rev 12.302. G07 answered 4012 with 00 03 and 4007 with 0C 79.
 * https://github.com/emdzej/ediabasx-docs-sgbd/blob/b644de8fbfbb4b207f57794e3c7894dc1dc58627/docs/sgbd/GSD_F90.md
 */
function gsdTorque(did: number, name: string, field: 'torqueNm' | 'targetNm'): RecordSchema {
  return {
    did, name, length: 2,
    decode(p) {
      const raw = u16(p, 0);
      const value = raw * 0.5 - 1.5;
      if (raw === 0xffff || (field === 'targetNm' && raw === 0xff) || value > 3000) {
        return { values: { [field]: null }, reasons: { [field]: 'недопустимый момент блокировки' } };
      }
      return { values: { [field]: value }, reasons: NONE };
    },
  };
}

export const GSD_LOCK_TORQUE = gsdTorque(0x4005, 'SPERRMOMENT_IST', 'torqueNm');
export const GSD_TARGET = gsdTorque(0x4012, 'SPERRMOMENT_VORGABE_AUS_TBC', 'targetNm');
export const GSD_POSITION: RecordSchema = {
  did: 0x4007, name: 'POSITION_SPERRE_ABSOLUT', length: 2,
  decode(p) {
    const raw = u16(p, 0);
    return raw === 0xffff ? { values: { positionInc: null }, reasons: { positionInc: 'недопустимо (0xFFFF)' } }
      : { values: { positionInc: raw - 3000 }, reasons: NONE };
  },
};
export const GSD_DELTA_N: RecordSchema = {
  did: 0x401b, name: 'DELTA_N_SPERRE', length: 1,
  decode(p) {
    const raw = u8(p, 0);
    return raw === 0xff ? { values: { deltaRpm: null }, reasons: { deltaRpm: 'недопустимо (0xFF)' } }
      : { values: { deltaRpm: raw * 2 - 256 }, reasons: NONE };
  },
};

/** GHAS 400F/4014/4015/4016: группы флагов (unsigned int HEX, таблиц битов нет) — только диагностика, не толкуются. */
function ghasFlags(did: number, name: string): RecordSchema {
  return {
    did,
    name,
    length: 2,
    decode(p): DecodedRecord {
      const v = u16(p, 0);
      return { values: { flags: v }, reasons: v ? { flags: 'внутренние флаги установлены (значение не опубликовано)' } : NONE };
    },
  };
}
export const GHAS_FLAGS: readonly RecordSchema[] = [ghasFlags(0x400f, 'FLAGS_400F'), ghasFlags(0x4014, 'FLAGS_4014'), ghasFlags(0x4015, 'FLAGS_4015'), ghasFlags(0x4016, 'FLAGS_4016')];

/** BDC_G05 E468 FES_MODUS: unsigned char, TAB_FES_MODUS (режим переключателя режимов движения); 0x3F недопустимо. Названия — как в таблице. */
export const FES_MODES: Readonly<Record<number, string>> = {
  0x00: 'инициализация',
  0x01: 'Sport Dynamic',
  0x02: 'Sport Expert',
  0x03: 'Sport Individual',
  0x04: 'Comfort',
  0x05: 'Comfort Plus',
  0x06: 'Comfort Individual',
  0x07: 'ECO PRO Efficient',
  0x08: 'ECO PRO Plus',
  0x09: 'ECO PRO Individual',
  0x0a: 'Adaptive',
  0x0b: 'Offroad Ice',
  0x0c: 'Offroad Smooth',
  0x0d: 'Offroad Grip',
  0x0e: 'Offroad Rough',
  0x0f: 'PHEV Sport Standard',
  0x10: 'PHEV Sport Individual',
  0x11: 'PHEV Hybrid Standard',
  0x12: 'PHEV Hybrid ECO',
  0x13: 'PHEV Hybrid Comfort',
  0x14: 'PHEV Electric Standard',
  0x15: 'PHEV Electric Individual',
  0x16: 'PHEV Battery Control',
};
export const BDC_FES: RecordSchema = {
  did: 0xe468,
  name: 'FES_MODUS',
  length: 1,
  decode(p): DecodedRecord {
    const m = u8(p, 0);
    if (m === 0x3f) return { values: { mode: null }, reasons: { mode: 'недопустимо (0x3F)' } };
    return FES_MODES[m] !== undefined ? { values: { mode: m }, reasons: NONE } : { values: { mode: null, code: m }, reasons: { mode: `неизвестный код ${m}` } };
  },
};

/**
 * BDC_G05 D54D HOEHENSTAENDE_LWR_MODUS (EdiabasX BDC_G05): s16 нагрузка спереди/сзади мм, u8 STAT_SOURCE_HSS
 * (TAB_HSS_TYPE: 0 нет, 1 по CAN, 2/3 у BDC, 0xFF недопустимо), u8 STAT_HSS_FRONT_REAR_QUALIFIER (22 — спереди и сзади
 * активны), s16 STAT_PITCH_ANGLE ÷100 ° («статический тангаж» корректора фар — кузов ОТНОСИТЕЛЬНО ОСЕЙ по датчикам высоты,
 * не к горизонту), s16 10MHDG см, s16 ×2 вертикаль фар ÷100 ° → 14 байт (ширины типов по порядку; на машине не сверено).
 * Угол выдаётся только при длине ровно 14, источнике 1…3 и квалификаторе 22.
 */
export const BDC_LWR_PITCH: RecordSchema = {
  did: 0xd54d,
  name: 'HOEHENSTAENDE_LWR_MODUS',
  length: 14,
  decode(p): DecodedRecord {
    const src = u8(p, 4);
    const q = u8(p, 5);
    const deg = s16(p, 6) / 100;
    const values: Record<string, FieldValue> = { source: src, qualifier: q, pitchCandidateDeg: deg, vertLeftDeg: s16(p, 10) / 100, vertRightDeg: s16(p, 12) / 100, pitchDeg: null };
    if (src < 1 || src > 3) return { values, reasons: { pitchDeg: `источник датчиков высоты ${src} (нужно 1…3)` } };
    if (q !== 22) return { values, reasons: { pitchDeg: `квалификатор ${q} (нужно 22 — спереди и сзади активны)` } };
    if (Math.abs(deg) > 30) return { values, reasons: { pitchDeg: `${deg}° вне ±30°` } };
    values.pitchDeg = deg;
    return { values, reasons: NONE };
  },
};

/**
 * ACSM 4101 неизвестного варианта: только длина и сырые байты. Разбор 30-байтового ответа ACSM5 ниже
 * применяется отдельно, после идентификации 0F2040, и остаётся в диагностике.
 */
export const ACSM_IMU_RAW: RecordSchema = {
  did: 0x4101,
  name: '_IMU_WERTE (только сырьё)',
  length: -1,
  decode(p): DecodedRecord {
    return { values: { length: p.length }, reasons: NONE };
  },
};

/** ACSM5 0F2040: RES_0X4101_D / IMU_QUAL, EdiabasX ACSM5 rev 4.000.
 * https://github.com/emdzej/ediabasx-docs-sgbd/blob/b644de8fbfbb4b207f57794e3c7894dc1dc58627/docs/sgbd/ACSM5.md
 * G07 фото 2026-11-18: ровно 30 байт, шесть u32 BE + u8, все квалификаторы 2.
 * Только диагностика: порядок/масштабы согласуются с этим ответом, ориентация осей на машине ещё не сверена.
 * Это ускорения и скорости вращения, НЕ абсолютные углы. Ни интеграции, ни подстановки в pitch/roll.
 */
export const ACSM5_IMU: RecordSchema = {
  did: 0x4101,
  name: '_IMU_WERTE (диагностика осей)',
  length: 30,
  decode(p): DecodedRecord {
    const fields = ['accX', 'accY', 'accZ', 'rateX', 'rateY', 'rateZ'];
    const scales = [0.02, 0.02, 0.02, 0.01, 0.05, 0.005];
    const offsets = [-41, -41, -20.92, -328, -102.5, -163.84];
    const values: Record<string, FieldValue> = { length: p.length };
    const reasons: Record<string, string> = {};
    fields.forEach((field, i) => {
      const at = i * 5;
      const raw = Buffer.from(p.slice(at, at + 4)).readUInt32BE(0);
      const q = p[at + 4];
      values[`${field}Qualifier`] = q;
      values[field] = q === 2 && raw !== 0xffffffff ? raw * scales[i] + offsets[i] : null;
      if (values[field] === null) reasons[field] = `IMU: квалификатор ${q}, raw ${raw}`;
    });
    return { values, reasons };
  },
};

/** Идентификация (22 F150): SGBD-индекс, шестнадцатеричной строкой (например 0F25D0). */
export const IDENT_DID = 0xf150;
export const identityHex = (p: readonly number[]): string => p.map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join('');

export const hexBytes = (p: readonly number[], max = 32): string =>
  p
    .slice(0, max)
    .map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase())
    .join(' ') + (p.length > max ? ' …' : '');

/** Разобрать ответ с проверкой точной длины. */
export function decodeExact(schema: RecordSchema, p: readonly number[]): { ok: true; rec: DecodedRecord } | { ok: false; error: string } {
  if (schema.length >= 0 && p.length !== schema.length) return { ok: false, error: `длина ${p.length}, ожидалась ${schema.length}` };
  return { ok: true, rec: schema.decode(p) };
}
