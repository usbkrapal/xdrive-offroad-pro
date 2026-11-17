// Детерминированные генераторы демо-сценариев. Все величины — функции только
// от времени сценария t (секунды). Это условная модель, а не физика автомобиля.

import type {
  DiffLockState,
  Gear,
  HdcStatus,
  RawFrame,
  ScenarioId,
  SignalId,
  SuspensionLevel,
  Wheel,
} from '../../domain/types';

export type LossKind = 'unavailable' | 'stale' | 'invalid';

/** Имитация потери данных в окне [from, to) секунд (по модулю cycle, если задан). */
export interface LossRule {
  readonly ids: readonly SignalId[];
  readonly kind: LossKind;
  readonly from: number;
  readonly to: number;
  readonly cycle?: number;
}

export interface ScenarioDef {
  readonly id: ScenarioId;
  readonly generate: (t: number) => RawFrame;
  readonly loss?: readonly LossRule[];
}

const TAU = Math.PI * 2;
const wave = (t: number, period: number, phase = 0) => Math.sin((TAU * t) / period + phase);
/** Короткие неотрицательные всплески 0..1. */
const pulse = (t: number, period: number, phase = 0) => Math.max(0, wave(t, period, phase)) ** 3;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ramp = (t: number, tau: number) => 1 - Math.exp(-t / tau);
const round = (v: number, step: number) => Math.round(v / step) * step;

type PerWheel<T> = Record<Wheel, T>;

/** Ключевые величины сценария; остальные поля достраиваются composeFrame. */
interface Core {
  pitch: number;
  roll: number;
  altitude: number;
  speed: number;
  steering: number;
  level: SuspensionLevel;
  torque: number;
  pedal: number;
  throttle: number;
  rearPct: number;
  /** Synthetic slip 0–100 %, независим от скоростей колёс. */
  slip: PerWheel<number>;
  brake: PerWheel<boolean>;
  /** Отклонение каждого угла относительно базовой высоты уровня, мм. */
  articulation: PerWheel<number>;
  hdc: HdcStatus;
  hdcSetSpeed: number | undefined;
  dsc: boolean;
  dtc: boolean;
  diffPercent: number | undefined;
  /** Тепловая нагрузка сценария 0..1. */
  heat: number;
}

/** Базовая высота уровня относительно Normal, мм (mock). */
const LEVEL_BASE_MM: Record<SuspensionLevel, number> = {
  offroad: 40,
  high: 20,
  normal: 0,
  dynamic: -10,
  sport: -20,
  loading: -40,
  unknown: 0,
};

const GEAR_RPM_PER_KMH = [0, 92, 54, 37, 28];

function gearFor(speed: number): Gear {
  const gear = speed < 12 ? 1 : speed < 24 ? 2 : speed < 38 ? 3 : 4;
  return { selector: 'D', gear };
}

function diffState(pct: number): DiffLockState {
  if (pct < 3) return 'open';
  return pct > 85 ? 'locked' : 'partial';
}

function composeFrame(t: number, c: Core): RawFrame {
  const gear = gearFor(c.speed);
  const rpm = 720 + c.speed * GEAR_RPM_PER_KMH[gear.gear ?? 1] + Math.max(0, c.torque) * 0.55;
  const frontPct = 100 - c.rearPct;
  // Кинематика поворота: внешние колёса чуть быстрее. Slip сюда не входит.
  const k = (c.steering / 540) * 0.05;
  const base = LEVEL_BASE_MM[c.level];
  const tyreWarm = ramp(t, 400);

  const frame: RawFrame = {
    'attitude.pitchDeg': c.pitch,
    'attitude.rollDeg': c.roll,
    altitudeM: c.altitude,
    steeringWheelAngleDeg: c.steering,
    vehicleSpeedKmh: c.speed,
    gear,
    'engine.torqueNm': c.torque,
    'engine.rpm': round(rpm, 10),
    'engine.throttlePercent': clamp(c.throttle, 0, 100),
    acceleratorPedalPercent: clamp(c.pedal, 0, 100),
    'xdrive.frontPercent': frontPct,
    'xdrive.rearPercent': c.rearPct,
    // Условные моменты осей: каждая ось — отдельный mock-сигнал,
    // задняя НЕ вычисляется как engine − front.
    'xdrive.frontTorqueNm': c.torque * 2.4 * (frontPct / 100) + 20 * wave(t, 2.9),
    'xdrive.rearTorqueNm': c.torque * 2.6 * (c.rearPct / 100) + 25 * wave(t, 3.7, 1),
    'suspension.level': c.level,
    'temperature.gearboxC': 68 + 34 * c.heat * ramp(t, 240) + 1.2 * wave(t, 47),
    'temperature.coolantC': 89 + 9 * c.heat * ramp(t, 180) + 0.8 * wave(t, 31),
    'temperature.engineOilC': 97 + 21 * c.heat * ramp(t, 260) + 1.0 * wave(t, 53),
    'hdc.status': c.hdc,
    'dsc.status': c.dsc,
    'dtc.status': c.dtc,
    'acceleration.longG': 0.06 * wave(t, 4.1) + 0.03 * wave(t, 1.7, 2),
    'acceleration.latG': (c.speed * c.speed * c.steering) / 1.6e6 + 0.02 * wave(t, 2.3, 1),
    yawRateDegS: (c.speed * c.steering) / 260,
    'wheelSpeed.FL': Math.max(0, c.speed * (1 - k) + 0.25 * wave(t, 1.3)),
    'wheelSpeed.FR': Math.max(0, c.speed * (1 + k) + 0.25 * wave(t, 1.1, 1)),
    'wheelSpeed.RL': Math.max(0, c.speed * (1 - k * 0.8) + 0.25 * wave(t, 1.7, 2)),
    'wheelSpeed.RR': Math.max(0, c.speed * (1 + k * 0.8) + 0.25 * wave(t, 1.5, 3)),
    'tyrePressure.FL': round(2.3 + 0.06 * tyreWarm, 0.01),
    'tyrePressure.FR': round(2.3 + 0.05 * tyreWarm, 0.01),
    'tyrePressure.RL': round(2.5 + 0.07 * tyreWarm, 0.01),
    'tyrePressure.RR': round(2.48 + 0.06 * tyreWarm, 0.01),
    'tyreTemperature.FL': round(16 + 14 * tyreWarm, 1),
    'tyreTemperature.FR': round(16 + 13 * tyreWarm, 1),
    'tyreTemperature.RL': round(15 + 12 * tyreWarm, 1),
    'tyreTemperature.RR': round(15 + 12.5 * tyreWarm, 1),
  };
  for (const w of ['FL', 'FR', 'RL', 'RR'] as const) {
    frame[`wheelSlip.${w}`] = clamp(c.slip[w], 0, 100);
    frame[`brakeIntervention.${w}`] = c.brake[w];
    frame[`suspensionHeight.${w}`] = base + c.articulation[w];
  }
  if (c.hdcSetSpeed !== undefined) frame['hdc.setSpeedKmh'] = c.hdcSetSpeed;
  if (c.diffPercent !== undefined) {
    frame['rearDiff.lockPercent'] = clamp(c.diffPercent, 0, 100);
    frame['rearDiff.lockState'] = diffState(c.diffPercent);
  }
  return frame;
}

function trailCore(t: number, level: SuspensionLevel): Core {
  const pitch = 9 * wave(t, 13, 0.6) + 3.5 * wave(t, 5.3, 1.1);
  const roll = 7.5 * wave(t, 9.7, 4.0) + 2.5 * wave(t, 3.9, 0.4);
  const slip = {
    FL: 3 + 18 * pulse(t, 6.7, 0.2),
    FR: 2 + 26 * pulse(t, 8.3, 2.1),
    RL: 4 + 31 * pulse(t, 7.1, 4.0),
    RR: 3 + 22 * pulse(t, 9.4, 1.0),
  };
  const torque = 260 + 140 * wave(t, 7, 0.5) + 12 * pitch;
  return {
    pitch,
    roll,
    altitude: 1846 + 0.12 * t + 3 * wave(t, 40),
    speed: 9 + 3 * wave(t, 11, 0.3),
    steering: 95 * wave(t, 8.5, 1.2) + 20 * wave(t, 3.1),
    level,
    torque,
    pedal: 22 + 12 * wave(t, 7, 0.5) + 0.8 * pitch,
    throttle: 19 + 11 * wave(t, 7, 0.6) + 0.7 * pitch,
    rearPct: 58 + 8 * wave(t, 6.3),
    slip,
    brake: { FL: slip.FL > 15, FR: slip.FR > 15, RL: slip.RL > 15, RR: slip.RR > 15 },
    articulation: {
      FL: 24 * wave(t, 6.1, 0.3) - 1.6 * roll,
      FR: -22 * wave(t, 6.1, 0.3) + 1.6 * roll,
      RL: -20 * wave(t, 5.4, 1.9) - 1.4 * roll,
      RR: 21 * wave(t, 5.4, 1.9) + 1.4 * roll,
    },
    hdc: 'off',
    hdcSetSpeed: undefined,
    dsc: true,
    dtc: true,
    diffPercent: undefined,
    heat: 0.6,
  };
}

const PARTIAL_LEVELS: readonly SuspensionLevel[] = ['dynamic', 'sport', 'loading', 'unknown', 'normal'];

export const SCENARIOS: Readonly<Record<ScenarioId, ScenarioDef>> = {
  mountainTrail: {
    id: 'mountainTrail',
    generate: (t) => composeFrame(t, trailCore(t, t % 40 < 30 ? 'offroad' : 'high')),
  },

  climb: {
    id: 'climb',
    generate: (t) => {
      const slip = {
        FL: 4 + 12 * pulse(t, 5.1, 0.4),
        FR: 3 + 15 * pulse(t, 6.2, 2.0),
        RL: 8 + 38 * pulse(t, 4.3, 1.2),
        RR: 7 + 44 * pulse(t, 5.7, 3.1),
      };
      const torque = 520 + 120 * wave(t, 5, 0.2);
      const pitch = 21 + 4 * wave(t, 9, 0.4) + 1.5 * wave(t, 2.7);
      const roll = 2.5 * wave(t, 7, 1);
      return composeFrame(t, {
        pitch,
        roll,
        altitude: 1210 + 0.55 * t + 0.8 * wave(t, 19),
        speed: 4.5 + 1.5 * wave(t, 6),
        steering: 25 * wave(t, 10) - 10,
        level: t % 36 < 8 ? 'high' : 'offroad',
        torque,
        pedal: 48 + 14 * wave(t, 5, 0.2),
        throttle: 43 + 13 * wave(t, 5, 0.3),
        rearPct: 62 + 5 * wave(t, 4),
        slip,
        brake: { FL: false, FR: false, RL: slip.RL > 30, RR: slip.RR > 30 },
        articulation: {
          FL: -18 + 6 * wave(t, 3.3),
          FR: -16 + 6 * wave(t, 3.1, 1),
          RL: 14 + 7 * wave(t, 3.7, 2),
          RR: 15 + 7 * wave(t, 3.5, 3),
        },
        hdc: 'off',
        hdcSetSpeed: undefined,
        dsc: true,
        dtc: true,
        diffPercent: 32 + 30 * wave(t, 6.5, 0.8),
        heat: 1,
      });
    },
  },

  diagonal: {
    id: 'diagonal',
    generate: (t) => {
      const slip = {
        FL: 3 + 5 * pulse(t, 4.4),
        FR: 58 + 30 * pulse(t, 3.9, 0.7),
        RL: 62 + 28 * pulse(t, 4.7, 2.2),
        RR: 4 + 6 * pulse(t, 5.2, 1.4),
      };
      return composeFrame(t, {
        pitch: 1.5 + 5 * wave(t, 12, 2),
        roll: -14 + 3 * wave(t, 10, 0.7),
        altitude: 655 + 0.05 * t + 0.4 * wave(t, 17),
        speed: Math.max(0.3, 1.6 + 1.2 * wave(t, 5)),
        steering: -60 + 30 * wave(t, 9),
        level: 'offroad',
        torque: 380 + 160 * wave(t, 4.2),
        pedal: 31 + 12 * wave(t, 4.2, 0.1),
        throttle: 28 + 11 * wave(t, 4.2, 0.2),
        rearPct: 50 + 10 * wave(t, 3.3),
        slip,
        brake: { FL: false, FR: slip.FR > 40, RL: slip.RL > 40, RR: false },
        articulation: {
          FL: 45 + 8 * wave(t, 5.5),
          FR: -95 + 8 * wave(t, 5.5, 1.5),
          RL: -100 + 8 * wave(t, 6.1, 0.4),
          RR: 40 + 8 * wave(t, 6.1, 2.6),
        },
        hdc: 'off',
        hdcSetSpeed: undefined,
        dsc: true,
        dtc: false,
        diffPercent: 72 + 22 * wave(t, 7.3),
        heat: 0.8,
      });
    },
  },

  hdcDescent: {
    id: 'hdcDescent',
    generate: (t) => {
      const setSpeed = t % 30 < 15 ? 6 : 8;
      return composeFrame(t, {
        pitch: -17 + 3 * wave(t, 8, 0.5) + 1 * wave(t, 2.3),
        roll: 3 * wave(t, 6.5, 2),
        altitude: 1530 - 0.45 * t + 0.6 * wave(t, 23),
        speed: setSpeed + 0.5 * wave(t, 3),
        steering: 15 * wave(t, 7),
        level: t % 40 < 20 ? 'high' : 'normal',
        // Торможение двигателем: отрицательный момент — валидное значение.
        torque: -55 + 15 * wave(t, 4),
        pedal: 0,
        throttle: 0,
        rearPct: 40 + 4 * wave(t, 5),
        slip: {
          FL: 2 + 5 * pulse(t, 3.1),
          FR: 2 + 5 * pulse(t, 3.4, 1),
          RL: 1 + 3 * pulse(t, 3.7, 2),
          RR: 1 + 3 * pulse(t, 2.9, 3),
        },
        brake: {
          FL: wave(t, 2.4, 0) > 0.2,
          FR: wave(t, 2.4, 1.6) > 0.2,
          RL: wave(t, 2.8, 3.1) > 0.5,
          RR: wave(t, 2.8, 4.7) > 0.5,
        },
        articulation: {
          FL: -22 + 5 * wave(t, 3.1),
          FR: -21 + 5 * wave(t, 3.3, 1),
          RL: 12 + 5 * wave(t, 3.6, 2),
          RR: 13 + 5 * wave(t, 3.4, 3),
        },
        hdc: 'active',
        hdcSetSpeed: setSpeed,
        dsc: true,
        dtc: false,
        diffPercent: 0,
        heat: 0.4,
      });
    },
  },

  partialLoss: {
    id: 'partialLoss',
    generate: (t) => {
      const level = PARTIAL_LEVELS[Math.floor(t / 5) % PARTIAL_LEVELS.length];
      return composeFrame(t, { ...trailCore(t, level), hdc: 'standby', hdcSetSpeed: 7, diffPercent: 20 });
    },
    loss: [
      {
        kind: 'unavailable',
        from: 0,
        to: Infinity,
        ids: [
          'altitudeM',
          'hdc.status',
          'hdc.setSpeedKmh',
          'rearDiff.lockState',
          'rearDiff.lockPercent',
          'brakeIntervention.RL',
          'suspensionHeight.RR',
          'tyreTemperature.RL',
          'dtc.status',
        ],
      },
      { kind: 'stale', from: 1, to: Infinity, ids: ['temperature.gearboxC', 'xdrive.frontTorqueNm'] },
      { kind: 'stale', from: 0, to: Infinity, ids: ['tyrePressure.FR'] },
      { kind: 'stale', from: 6, to: 18, cycle: 24, ids: ['attitude.rollDeg'] },
      { kind: 'stale', from: 3, to: 15, cycle: 24, ids: ['wheelSpeed.FL'] },
      { kind: 'invalid', from: 12, to: 20, cycle: 24, ids: ['steeringWheelAngleDeg'] },
      { kind: 'invalid', from: 0, to: 7, cycle: 24, ids: ['engine.torqueNm'] },
      { kind: 'invalid', from: 14, to: 22, cycle: 24, ids: ['wheelSlip.RR'] },
    ],
  },
};

/** Активное правило потери для сигнала в момент t и время «замерзания» для stale. */
export function activeLoss(
  def: ScenarioDef,
  id: SignalId,
  t: number,
): { kind: LossKind; frozenAt: number } | null {
  for (const rule of def.loss ?? []) {
    if (!rule.ids.includes(id)) continue;
    const local = rule.cycle ? t % rule.cycle : t;
    if (local >= rule.from && local < rule.to) {
      return { kind: rule.kind, frozenAt: t - (local - rule.from) };
    }
  }
  return null;
}
