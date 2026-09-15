import { memo, useCallback, useMemo, useRef } from 'react';
import { Download } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';

export interface SpeedHistoryPoint {
  /** Epoch ms */
  t: number;
  /** Target setpoint from Fan Control (rad/s) */
  commanded: number;
  /** Actual telemetry speed (rad/s) */
  actual: number;
}

interface SpeedCompareChartProps {
  data: SpeedHistoryPoint[];
  /** Latest Fan Control target (rad/s), shown in the header */
  commandedSpeed?: number;
  className?: string;
}

function formatTime(t: number) {
  const d = new Date(t);
  return `${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

/** Zoom Y-axis around live samples so small speed jitter is readable. */
function yDomainFromData(data: SpeedHistoryPoint[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of data) {
    min = Math.min(min, p.commanded, p.actual);
    max = Math.max(max, p.commanded, p.actual);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [-10, 10];
  }
  const span = max - min;
  // Minimum visible window so ±1–2 rad/s jitter isn't crushed near a 0…60 scale.
  const minSpan = Math.max(20, Math.abs(max) * 0.15, Math.abs(min) * 0.15);
  const pad = Math.max(span * 0.35, (minSpan - span) / 2, 4);
  return [min - pad, max + pad];
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Live line chart: Fan Control target vs actual BLE/sim telemetry (rad/s).
 * Uses linear paths (not monotone) — monotone cubic fits are costly on noisy high-rate data.
 */
export const SpeedCompareChart = memo(function SpeedCompareChart({
  data,
  commandedSpeed,
  className = '',
}: SpeedCompareChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const latestActual = data.length > 0 ? data[data.length - 1].actual : null;
  const yDomain = useMemo(
    () => (data.length > 0 ? yDomainFromData(data) : undefined),
    [data]
  );

  const exportChart = useCallback(async () => {
    if (data.length === 0) {
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    // CSV of all samples
    const csvLines = [
      'timestamp_iso,target_rad_s,actual_rad_s',
      ...data.map(
        (p) =>
          `${new Date(p.t).toISOString()},${p.commanded.toFixed(4)},${p.actual.toFixed(4)}`
      ),
    ];
    downloadBlob(
      new Blob([csvLines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }),
      `speed-compare-${stamp}.csv`
    );

    // PNG snapshot of the chart SVG
    const root = chartRef.current;
    const svg = root?.querySelector('svg');
    if (!svg) {
      return;
    }

    const serializer = new XMLSerializer();
    let svgText = serializer.serializeToString(svg);
    if (!svgText.includes('xmlns=')) {
      svgText = svgText.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const bbox = svg.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(bbox.width));
    const height = Math.max(1, Math.ceil(bbox.height));
    const scale = 2;

    const svgUrl = URL.createObjectURL(
      new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    );

    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to load chart SVG'));
        image.src = svgUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      ctx.scale(scale, scale);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      await new Promise<void>((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) {
            downloadBlob(blob, `speed-compare-${stamp}.png`);
          }
          resolve();
        }, 'image/png');
      });
    } catch {
      // CSV already saved; PNG is best-effort if SVG render fails.
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  }, [data]);

  return (
    <div
      className={`bg-white rounded-xl border border-border shadow-sm flex flex-col min-h-0 overflow-hidden ${className}`}
    >
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-primary">Speed Compare</h3>
          <p className="text-[10px] text-muted-foreground">
            Target {commandedSpeed != null ? commandedSpeed.toFixed(1) : '—'}
            {' · '}
            Act {latestActual != null ? latestActual.toFixed(1) : '—'} rad/s
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex items-center gap-3 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-0.5 bg-red-500 rounded" /> Target
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-0.5 bg-sky-500 rounded" /> Actual
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void exportChart()}
            disabled={data.length === 0}
            className="h-8 gap-1.5 text-xs"
            title="Export chart (PNG + CSV)"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </Button>
        </div>
      </div>
      <div ref={chartRef} className="min-h-0 flex-1 basis-0 p-2">
        {data.length === 0 ? (
          <div className="h-full min-h-[200px] flex items-center justify-center text-xs text-muted-foreground">
            Waiting for telemetry…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minHeight={200}>
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={formatTime}
                minTickGap={48}
                tick={{ fontSize: 10 }}
              />
              <YAxis
                domain={yDomain}
                tick={{ fontSize: 10 }}
                width={44}
                tickFormatter={(v: number) => v.toFixed(0)}
                label={{ value: 'rad/s', angle: -90, position: 'insideLeft', style: { fontSize: 10 } }}
              />
              <Tooltip
                labelFormatter={(label) => formatTime(Number(label))}
                formatter={(value: number, name: string) => [
                  `${Number(value).toFixed(2)} rad/s`,
                  name === 'commanded' ? 'Target' : 'Actual',
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(value) => (value === 'commanded' ? 'Target' : 'Actual')}
              />
              <Line
                type="stepAfter"
                dataKey="commanded"
                name="commanded"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="actual"
                name="actual"
                stroke="#0ea5e9"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
});
