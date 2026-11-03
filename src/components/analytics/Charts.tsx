// Phase 11 — hand-rolled SVG charts (the codebase has no chart
// library). Charts render ONLY the points they are given: missing
// days are gaps in the line, never zero-filled points (§11).

interface Point {
  date: string;
  value: number;
}

const W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 52 };

function fmtTick(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v * 100) / 100);
}

export function LineChart({ points, color = "#1558C9", label }: { points: Point[]; color?: string; label: string }) {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const min = Math.min(...points.map((p) => p.value), 0);
  const span = max - min || 1;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - ((v - min) / span) * ih;
  // Split the polyline at date gaps > 1.5× the median step so missing
  // days show as breaks, not invented straight lines across them.
  const times = points.map((p) => new Date(`${p.date.length === 7 ? `${p.date}-01` : p.date}T00:00:00Z`).getTime());
  const steps = times.slice(1).map((t, i) => t - times[i]).filter((s) => s > 0).sort((a, b) => a - b);
  const medianStep = steps.length > 0 ? steps[Math.floor(steps.length / 2)] : 0;
  const segments: Point[][] = [];
  let current: Point[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    if (medianStep > 0 && times[i] - times[i - 1] > medianStep * 1.6) {
      segments.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  segments.push(current);
  const ticks = [min, min + span / 2, max];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ width: "100%", height: "auto", display: "block" }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#232a38" strokeDasharray="3 4" />
          <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#9aa3b2">{fmtTick(t)}</text>
        </g>
      ))}
      {segments.map((seg, si) => (
        <g key={si}>
          {seg.length > 1 && (
            <polyline
              fill="none"
              stroke={color}
              strokeWidth="2"
              points={seg.map((p) => `${x(points.indexOf(p))},${y(p.value)}`).join(" ")}
            />
          )}
          {seg.map((p) => (
            <circle key={p.date} cx={x(points.indexOf(p))} cy={y(p.value)} r="3" fill={color}>
              <title>{`${p.date}: ${p.value}`}</title>
            </circle>
          ))}
        </g>
      ))}
      <text x={PAD.left} y={H - 6} fontSize="11" fill="#9aa3b2">{points[0].date}</text>
      <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize="11" fill="#9aa3b2">{points[points.length - 1].date}</text>
    </svg>
  );
}

export function BarChart({ points, color = "#D4FF24", label }: { points: Point[]; color?: string; label: string }) {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const barW = Math.max(2, (iw / points.length) * 0.7);
  const step = iw / points.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ width: "100%", height: "auto", display: "block" }}>
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} stroke="#232a38" />
      <text x={PAD.left - 8} y={PAD.top + 4} textAnchor="end" fontSize="11" fill="#9aa3b2">{fmtTick(max)}</text>
      <text x={PAD.left - 8} y={PAD.top + ih + 4} textAnchor="end" fontSize="11" fill="#9aa3b2">0</text>
      {points.map((p, i) => {
        const h = (p.value / max) * ih;
        const x = PAD.left + i * step + (step - barW) / 2;
        return (
          <rect key={p.date} x={x} y={PAD.top + ih - h} width={barW} height={h} fill={color} rx="2">
            <title>{`${p.date}: ${p.value}`}</title>
          </rect>
        );
      })}
      <text x={PAD.left} y={H - 6} fontSize="11" fill="#9aa3b2">{points[0].date}</text>
      <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize="11" fill="#9aa3b2">{points[points.length - 1].date}</text>
    </svg>
  );
}
