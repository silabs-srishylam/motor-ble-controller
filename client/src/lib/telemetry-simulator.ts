import type { AnomalyState, MotorTelemetry } from '@/lib/telemetry-parser';

export type SimMotorMode = 'stop' | 'low' | 'high' | 'custom';

/** Allowed custom / simulated angular velocity (rad/s). */
export const SPEED_RAD_S_MIN = -300;
export const SPEED_RAD_S_MAX = 300;

/** Target speeds matching Fan Control presets (M0 / M50 / M250). */
export const SIM_SPEED_RAD_S: Record<'stop' | 'low' | 'high', number> = {
  stop: 0,
  low: 50,
  high: 250,
};

/** Demo anomaly states so the panel also moves in simulation. */
export const SIM_ANOMALY: Record<SimMotorMode, AnomalyState> = {
  stop: 'NORMAL',
  low: 'NORMAL',
  high: 'SLOWED',
  custom: 'NORMAL',
};

export function clampSpeedRadS(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(SPEED_RAD_S_MAX, Math.max(SPEED_RAD_S_MIN, value));
}

/**
 * Build a telemetry frame as if firmware had notified over BLE.
 */
export function buildSimTelemetry(
  mode: SimMotorMode,
  options?: { anomaly?: AnomalyState; speedJitter?: number; customSpeed?: number }
): MotorTelemetry {
  const base =
    mode === 'custom'
      ? clampSpeedRadS(options?.customSpeed ?? 0)
      : SIM_SPEED_RAD_S[mode];
  const jitter = options?.speedJitter ?? 0;
  const speed =
    mode === 'stop' ? 0 : base + (Math.random() * 2 - 1) * jitter;

  return {
    status: mode === 'stop' || Math.abs(speed) < 0.5 ? 'Stop' : 'Running',
    speed,
    rpm: (Math.abs(speed) * 60) / (2 * Math.PI),
    anomaly: options?.anomaly ?? SIM_ANOMALY[mode],
    timestamp: Date.now(),
  };
}
