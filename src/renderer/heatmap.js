const STOPS = [
  [0.0, '#1e3a8a'],
  [0.16, '#2563eb'],
  [0.34, '#06b6d4'],
  [0.52, '#10b981'],
  [0.7, '#eab308'],
  [0.85, '#f97316'],
  [1.0, '#ef4444'],
];

const COUNT_STOPS = [
  [0.0, '#1e293b'],
  [0.25, '#2563eb'],
  [0.5, '#10b981'],
  [0.75, '#eab308'],
  [1.0, '#ef4444'],
];

const INTERFERENCE_STOPS = [
  [0.0, '#065f46'],
  [0.3, '#84cc16'],
  [0.55, '#eab308'],
  [0.75, '#f97316'],
  [1.0, '#dc2626'],
];

function toRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function stopsFor(metric) {
  if (metric === 'count') return COUNT_STOPS;
  if (metric === 'interference') return INTERFERENCE_STOPS;
  return STOPS;
}

export function colorForValue(value, min, max, metric = 'coverage', alpha = 0.78) {
  if (!Number.isFinite(value)) return 'rgba(0,0,0,0)';
  const span = max - min || 1;
  const t = Math.max(0, Math.min(1, (value - min) / span));
  const stops = stopsFor(metric);
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const local = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const ca = toRgb(a[1]);
  const cb = toRgb(b[1]);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * local);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * local);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * local);
  return `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}

export function legendColors(metric) {
  return stopsFor(metric).map(([, color]) => color);
}

export function convexHull(points) {
  if (!points || points.length < 3) return null;
  const pts = points
    .map((p) => [p.x, p.y])
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function pointInPolygon(x, y, polygon) {
  if (!polygon || polygon.length < 3) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Expand the hull slightly so interpolated values reach the outside measurement ring.
function expandPolygon(polygon, amount) {
  if (!polygon || polygon.length < 3) return polygon;
  const cx = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
  const cy = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
  return polygon.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const length = Math.hypot(dx, dy) || 1;
    return [x + (dx / length) * amount, y + (dy / length) * amount];
  });
}

export function computeSurface(opts) {
  const {
    points = [],
    valueFn,
    mapW,
    mapH,
    cell = 5,
    power = 2.1,
    smoothing = 2,
    hullMask = true,
    extraMask = null,
  } = opts;

  const usable = [];
  for (const point of points) {
    const value = valueFn ? valueFn(point) : point.value;
    if (Number.isFinite(value)) usable.push({ x: point.x, y: point.y, value });
  }
  if (!usable.length || !mapW || !mapH) return null;

  const cols = Math.max(24, Math.min(620, Math.ceil(mapW / cell)));
  const rows = Math.max(24, Math.min(620, Math.ceil((cols * mapH) / mapW)));
  const cellX = mapW / cols;
  const cellY = mapH / rows;
  const values = new Float32Array(cols * rows).fill(NaN);
  const hull = hullMask && usable.length >= 3 ? expandPolygon(convexHull(usable), Math.max(mapW, mapH) * 0.012) : null;

  const epsilon = 0.35;
  for (let row = 0; row < rows; row++) {
    const y = (row + 0.5) * cellY;
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cellX;
      if (hull && !pointInPolygon(x, y, hull)) continue;
      if (extraMask && !extraMask(x, y)) continue;

      let weighted = 0;
      let weightSum = 0;
      for (const point of usable) {
        const dx = point.x - x;
        const dy = point.y - y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < epsilon) {
          weighted = point.value;
          weightSum = 1;
          break;
        }
        const weight = 1 / Math.pow(distance, power);
        weighted += point.value * weight;
        weightSum += weight;
      }
      if (weightSum > 0) values[row * cols + col] = weighted / weightSum;
    }
  }

  // NaN-aware box blur
  for (let pass = 0; pass < Math.max(0, Math.min(6, smoothing)); pass++) {
    const next = new Float32Array(values);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (!Number.isFinite(values[index])) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const r = row + dy;
          if (r < 0 || r >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const c = col + dx;
            if (c < 0 || c >= cols) continue;
            const value = values[r * cols + c];
            if (!Number.isFinite(value)) continue;
            sum += value;
            count += 1;
          }
        }
        if (count) next[index] = sum / count;
      }
    }
    values.set(next);
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min)) return null;

  return {
    cols,
    rows,
    cellX,
    cellY,
    mapW,
    mapH,
    values,
    min,
    max,
    hull,
    points: usable,
  };
}

export function surfaceToCanvas(surface, { min, max, metric, alpha = 0.82 }) {
  const canvas = document.createElement('canvas');
  canvas.width = surface.cols;
  canvas.height = surface.rows;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(surface.cols, surface.rows);
  const rgbCache = new Map();
  const span = max - min || 1;

  const stops = stopsFor(metric).map(([pos, hex]) => ({ pos, rgb: toRgb(hex) }));

  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) {
      const index = row * surface.cols + col;
      const value = surface.values[index];
      if (!Number.isFinite(value)) continue;

      const t = Math.max(0, Math.min(1, (value - min) / span));
      let a = stops[0];
      let b = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i].pos && t <= stops[i + 1].pos) {
          a = stops[i];
          b = stops[i + 1];
          break;
        }
      }
      const local = b.pos === a.pos ? 0 : (t - a.pos) / (b.pos - a.pos);
      const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * local);
      const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * local);
      const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * local);
      const offset = index * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = bl;
      image.data[offset + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function sampleSurface(surface, x, y) {
  if (!surface) return NaN;
  const col = Math.max(0, Math.min(surface.cols - 1, Math.floor(x / surface.cellX)));
  const row = Math.max(0, Math.min(surface.rows - 1, Math.floor(y / surface.cellY)));
  const value = surface.values[row * surface.cols + col];
  return Number.isFinite(value) ? value : NaN;
}

function edgePoints(surface, row, col, level) {
  const { values, cols } = surface;
  const v = [
    values[row * cols + col],
    values[row * cols + col + 1],
    values[(row + 1) * cols + col + 1],
    values[(row + 1) * cols + col],
  ];
  if (!v.every(Number.isFinite)) return null;
  const corners = [
    [col, row],
    [col + 1, row],
    [col + 1, row + 1],
    [col, row + 1],
  ];
  const intersections = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const a = v[i];
    const b = v[j];
    if (a === b) continue;
    if ((a < level && b >= level) || (a >= level && b < level)) {
      const t = (level - a) / (b - a);
      intersections.push([
        corners[i][0] + (corners[j][0] - corners[i][0]) * t,
        corners[i][1] + (corners[j][1] - corners[i][1]) * t,
      ]);
    }
  }
  if (intersections.length < 2) return null;
  return intersections;
}

export function drawIsolines(ctx, surface, { min, max, levels = 5, toScreen, color = 'rgba(255,255,255,0.42)' }) {
  if (!surface || levels < 1) return;
  const span = max - min || 1;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (let i = 1; i <= levels; i++) {
    const level = min + (span * i) / (levels + 1);
    ctx.beginPath();
    for (let row = 0; row < surface.rows - 1; row++) {
      for (let col = 0; col < surface.cols - 1; col++) {
        const points = edgePoints(surface, row, col, level);
        if (!points) continue;
        if (points.length === 2) {
          const p1 = toScreen((points[0][0] + 0.5) * surface.cellX, (points[0][1] + 0.5) * surface.cellY);
          const p2 = toScreen((points[1][0] + 0.5) * surface.cellX, (points[1][1] + 0.5) * surface.cellY);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        } else if (points.length === 4) {
          for (let k = 0; k < 4; k += 2) {
            const p1 = toScreen((points[k][0] + 0.5) * surface.cellX, (points[k][1] + 0.5) * surface.cellY);
            const p2 = toScreen((points[k + 1][0] + 0.5) * surface.cellX, (points[k + 1][1] + 0.5) * surface.cellY);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
          }
        }
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
