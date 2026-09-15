import { useEffect, useId, useRef } from 'react';
import type { AnomalyState } from '@/lib/telemetry-parser';

interface MotorVisualizerProps {
  /** Angular velocity from firmware (rad/s). Sign controls direction. */
  speedRadPerSec: number;
  /** Derived RPM for the caption. */
  rpm: number;
  /** When false, rotor holds still. */
  active: boolean;
  /** Firmware anomaly — BLOCKED freezes the rotor even if speed > 0. */
  anomaly?: AnomalyState;
}

/** Real ω → on-screen spin (proportional, capped). */
function toVisualRadPerSec(omega: number, anomaly: AnomalyState): number {
  if (anomaly === 'BLOCKED') {
    return 0;
  }
  const a = Math.abs(omega);
  if (a < 0.05) {
    return 0;
  }
  const VISUAL_SCALE = anomaly === 'SLOWED' ? 0.12 : 0.27;
  const VISUAL_MAX = anomaly === 'SLOWED' ? 28 : 84;
  return Math.sign(omega) * Math.min(a * VISUAL_SCALE, VISUAL_MAX);
}

/** Top-down motor rotor. Spin rate and direction track live telemetry. */
export function MotorVisualizer({
  speedRadPerSec,
  rpm,
  active,
  anomaly = 'NORMAL',
}: MotorVisualizerProps) {
  const uid = useId().replace(/:/g, '');
  const rotorRef = useRef<SVGGElement>(null);
  const angleRef = useRef(0);
  const speedRef = useRef(speedRadPerSec);
  const activeRef = useRef(active);
  const anomalyRef = useRef(anomaly);
  const rafRef = useRef<number>(0);

  speedRef.current = speedRadPerSec;
  activeRef.current = active;
  anomalyRef.current = anomaly;

  useEffect(() => {
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTs) / 1000, 0.05);
      lastTs = now;

      const omega = toVisualRadPerSec(
        activeRef.current ? speedRef.current : 0,
        anomalyRef.current
      );
      if (Math.abs(omega) >= 0.05) {
        angleRef.current = (angleRef.current + omega * dt * (180 / Math.PI)) % 360;
        if (angleRef.current < 0) {
          angleRef.current += 360;
        }
        rotorRef.current?.setAttribute('transform', `rotate(${angleRef.current} 100 100)`);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const blocked = active && anomaly === 'BLOCKED';
  const absRad = Math.abs(speedRadPerSec);
  const spinning = active && !blocked && absRad >= 0.05;
  const absRpm = Math.abs(rpm);

  return (
    <div className="mb-8 flex flex-col items-center">
      <div className="relative w-48 h-48">
        <svg viewBox="0 0 200 200" className="w-full h-full drop-shadow-sm" aria-hidden="true">
          <defs>
            <radialGradient id={`${uid}-housing`} cx="50%" cy="40%" r="65%">
              <stop offset="0%" stopColor="#1e3a5f" />
              <stop offset="55%" stopColor="#0f172a" />
              <stop offset="100%" stopColor="#020617" />
            </radialGradient>
            <linearGradient id={`${uid}-blade-a`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#67e8f9" />
              <stop offset="55%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#0891b2" />
            </linearGradient>
            <linearGradient id={`${uid}-blade-b`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#e9d5ff" />
              <stop offset="50%" stopColor="#a855f7" />
              <stop offset="100%" stopColor="#6b21a8" />
            </linearGradient>
            <linearGradient id={`${uid}-blade-marker`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#fde68a" />
              <stop offset="40%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#d97706" />
            </linearGradient>
            <radialGradient id={`${uid}-hub`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#e0f2fe" />
              <stop offset="45%" stopColor="#38bdf8" />
              <stop offset="100%" stopColor="#0369a1" />
            </radialGradient>
          </defs>

          <circle cx="100" cy="100" r="96" fill={`url(#${uid}-housing)`} />

          {Array.from({ length: 4 }).map((_, i) => {
            const a = (i * 90 * Math.PI) / 180;
            return (
              <line
                key={i}
                x1={100 + Math.cos(a) * 68}
                y1={100 + Math.sin(a) * 68}
                x2={100 + Math.cos(a) * 78}
                y2={100 + Math.sin(a) * 78}
                stroke="#67e8f9"
                strokeWidth="2.5"
                strokeLinecap="round"
                opacity="0.9"
              />
            );
          })}

          <g ref={rotorRef}>
            {/* Amber blade is the one to follow when judging direction */}
            <path
              d="M100 100
                 C92 78, 86 52, 90 28
                 C94 20, 106 20, 110 28
                 C114 52, 108 78, 100 100 Z"
              fill={`url(#${uid}-blade-marker)`}
              stroke="#92400e"
              strokeWidth="0.8"
              opacity="0.98"
            />
            <path
              d="M100 100
                 C92 78, 86 52, 90 28
                 C94 20, 106 20, 110 28
                 C114 52, 108 78, 100 100 Z"
              fill={`url(#${uid}-blade-a)`}
              stroke="#0e7490"
              strokeWidth="0.6"
              opacity="0.95"
              transform="rotate(120 100 100)"
            />
            <path
              d="M100 100
                 C92 78, 86 52, 90 28
                 C94 20, 106 20, 110 28
                 C114 52, 108 78, 100 100 Z"
              fill={`url(#${uid}-blade-b)`}
              stroke="#6b21a8"
              strokeWidth="0.6"
              opacity="0.95"
              transform="rotate(240 100 100)"
            />
            <path
              d="M97 95 C93 70, 92 45, 96 30"
              fill="none"
              stroke="#fff7ed"
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity="0.7"
            />
            <circle cx="100" cy="100" r="22" fill="#0f172a" stroke="#22d3ee" strokeWidth="2" />
            <circle cx="100" cy="100" r="14" fill={`url(#${uid}-hub)`} />
            <circle cx="100" cy="100" r="5" fill="#f8fafc" />
            <rect x="97" y="76" width="6" height="12" rx="2" fill="#f59e0b" />
          </g>
        </svg>
      </div>

      <div className="mt-3 text-center">
        <p
          className={`font-mono font-semibold tracking-tight transition-all duration-200 ${
            blocked
              ? 'text-destructive text-sm'
              : spinning
                ? 'text-cyan-700 text-base'
                : 'text-muted-foreground text-sm'
          }`}
        >
          {!active
            ? 'Awaiting telemetry'
            : blocked
              ? 'Motor blocked'
              : spinning
                ? `${absRpm.toFixed(0)} RPM  ·  ${absRad.toFixed(2)} rad/s`
                : 'Motor stopped'}
        </p>
      </div>
    </div>
  );
}
