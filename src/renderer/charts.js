const AP_COLORS = [
  '#3b82f6', '#22d3ee', '#34d399', '#fbbf24', '#f472b6',
  '#a78bfa', '#fb923c', '#2dd4bf', '#f87171', '#84cc16',
  '#60a5fa', '#e879f9', '#4ade80', '#facc15', '#38bdf8',
];

const QUALITY_COLORS = {
  excellent: '#22d3ee',
  good: '#34d399',
  fair: '#fbbf24',
  weak: '#fb923c',
  bad: '#f87171',
  unknown: '#64748b',
};

export function colorForBssid(bssid) {
  let hash = 0;
  const text = String(bssid || '');
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return AP_COLORS[hash % AP_COLORS.length];
}

export function qualityColor(quality) {
  return QUALITY_COLORS[quality] || QUALITY_COLORS.unknown;
}

function setup(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function noData(ctx, width, height, text) {
  ctx.save();
  ctx.fillStyle = cssVar('--faint', '#5d6b80');
  ctx.font = '12px Inter, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function drawSignalChart(canvas, opts) {
  const { ctx, width, height } = setup(canvas);
  if (width < 40 || height < 30) return;
  const { history = {}, aps = [], selectedBssid = null, good = -67, fair = -75 } = opts || {};

  const padL = 42;
  const padR = 52;
  const padT = 16;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 20 || plotH < 20) return;

  const now = Date.now();
  const windowMs = 120000;
  const yMin = -100;
  const yMax = -20;

  const xFor = (t) => padL + ((t - (now - windowMs)) / windowMs) * plotW;
  const yFor = (rssi) => padT + (1 - (rssi - yMin) / (yMax - yMin)) * plotH;

  ctx.save();

  // plot background
  ctx.fillStyle = cssVar('--bg-soft', '#0e141d');
  roundRectPath(ctx, padL, padT, plotW, plotH, 7);
  ctx.fill();

  // grid
  ctx.strokeStyle = cssVar('--border-soft', '#1b2434');
  ctx.lineWidth = 1;
  ctx.font = '9.5px Inter, Segoe UI, sans-serif';
  ctx.fillStyle = cssVar('--faint', '#5d6b80');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = -100; v <= -20; v += 10) {
    const y = Math.round(yFor(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(`${v}`, padL - 7, y);
  }

  // thresholds
  const threshold = (value, color, label) => {
    const y = Math.round(yFor(value)) + 0.5;
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.textAlign = 'left';
    ctx.font = '9px Inter, Segoe UI, sans-serif';
    ctx.fillText(label, padL + plotW + 6, y);
    ctx.globalAlpha = 1;
  };
  threshold(good, '#34d399', 'bom');
  threshold(fair, '#fbbf24', 'regular');

  // time axis
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = cssVar('--faint', '#5d6b80');
  for (let i = 0; i <= 4; i++) {
    const t = now - windowMs + (windowMs / 4) * i;
    const x = xFor(t);
    const seconds = Math.round((t - now) / 1000);
    ctx.fillText(seconds === 0 ? 'agora' : `${seconds}s`, x, padT + plotH + 8);
  }

  const series = [];
  if (selectedBssid) {
    const ap = aps.find((a) => a.bssid === selectedBssid);
    series.push({ bssid: selectedBssid, ssid: ap?.ssid || selectedBssid, data: history[selectedBssid] || [], selected: true });
  } else {
    const ranked = [...aps].filter((a) => (history[a.bssid] || []).length > 1).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)).slice(0, 5);
    for (const ap of ranked) series.push({ bssid: ap.bssid, ssid: ap.ssid || ap.bssid, data: history[ap.bssid] || [] });
  }

  let hasData = false;
  for (const item of series) {
    const points = item.data.filter((p) => p.t >= now - windowMs && Number.isFinite(p.rssi));
    if (points.length < 1) continue;
    hasData = true;
    const color = item.selected ? '#22d3ee' : colorForBssid(item.bssid);
    const alpha = item.selected ? 1 : 0.5;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = item.selected ? 2 : 1.3;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const coords = points.map((p) => [xFor(p.t), yFor(p.rssi)]);

    if (item.selected && coords.length > 1) {
      const gradient = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      gradient.addColorStop(0, 'rgba(34, 211, 238, 0.26)');
      gradient.addColorStop(1, 'rgba(34, 211, 238, 0.01)');
      ctx.beginPath();
      ctx.moveTo(coords[0][0], padT + plotH);
      for (const [x, y] of coords) ctx.lineTo(x, y);
      ctx.lineTo(coords[coords.length - 1][0], padT + plotH);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.beginPath();
    coords.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (item.selected) {
      const [lastX, lastY] = coords[coords.length - 1];
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // current value for the selected AP
  if (selectedBssid) {
    const data = (history[selectedBssid] || []).filter((p) => Number.isFinite(p.rssi));
    if (data.length) {
      const value = data[data.length - 1].rssi;
      const y = yFor(value);
      ctx.fillStyle = '#22d3ee';
      ctx.font = '600 12px Inter, Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${value} dBm`, padL + plotW + 6, Math.max(padT + 8, Math.min(padT + plotH - 8, y)));
    }
  }

  if (!hasData) {
    noData(ctx, width, height, 'Aguardando amostras de sinal…');
  }

  ctx.restore();
}

function bandConfig(band) {
  if (band === '2.4') {
    return {
      min: 2398,
      max: 2496,
      ticks: [1, 6, 11, 14],
      center: (ch) => (ch === 14 ? 2484 : 2412 + 5 * (ch - 1)),
      label: '2,4 GHz',
    };
  }
  if (band === '6') {
    return {
      min: 5945,
      max: 7125,
      ticks: [1, 37, 69, 101, 133, 165, 197, 229],
      center: (ch) => 5950 + 5 * ch,
      label: '6 GHz',
    };
  }
  return {
    min: 5150,
    max: 5850,
    ticks: [36, 52, 68, 100, 116, 132, 149, 165],
    center: (ch) => 5000 + 5 * ch,
    label: '5 GHz',
  };
}

export function drawChannelChart(canvas, opts) {
  const { ctx, width, height } = setup(canvas);
  if (width < 40 || height < 30) return;
  const { aps = [], band = '5', selectedBssid = null, good = -67, fair = -75 } = opts || {};
  const cfg = bandConfig(band);
  const padL = 42;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 20 || plotH < 20) return;

  const yMin = -100;
  const yMax = -20;
  const xFor = (freq) => padL + ((freq - cfg.min) / (cfg.max - cfg.min)) * plotW;
  const yFor = (rssi) => padT + (1 - (rssi - yMin) / (yMax - yMin)) * plotH;

  ctx.save();
  ctx.fillStyle = cssVar('--bg-soft', '#0e141d');
  roundRectPath(ctx, padL, padT, plotW, plotH, 7);
  ctx.fill();

  ctx.strokeStyle = cssVar('--border-soft', '#1b2434');
  ctx.lineWidth = 1;
  ctx.font = '9.5px Inter, Segoe UI, sans-serif';
  ctx.fillStyle = cssVar('--faint', '#5d6b80');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = -100; v <= -20; v += 10) {
    const y = Math.round(yFor(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(`${v}`, padL - 7, y);
  }

  // channel ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const ch of cfg.ticks) {
    const freq = cfg.center(ch);
    if (freq < cfg.min || freq > cfg.max) continue;
    const x = Math.round(xFor(freq)) + 0.5;
    ctx.save();
    ctx.strokeStyle = cssVar('--border-soft', '#1b2434');
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = cssVar('--muted', '#8492a8');
    ctx.fillText(`${ch}`, x, padT + plotH + 6);
  }
  ctx.fillStyle = cssVar('--muted', '#8492a8');
  ctx.textAlign = 'left';
  ctx.fillText('canal', padL, padT + plotH + 16);
  ctx.textAlign = 'right';
  ctx.fillText(cfg.label, padL + plotW, padT + plotH + 16);

  const drawable = aps
    .filter((ap) => ap.freq && ap.rssi != null && ap.band === band)
    .sort((a, b) => (a.bssid === selectedBssid ? 1 : 0) - (b.bssid === selectedBssid ? 1 : 0) || (a.rssi - b.rssi));

  if (!drawable.length) {
    noData(ctx, width, height, `Nenhuma rede detectada em ${cfg.label}`);
    ctx.restore();
    return;
  }

  const labels = [];
  for (const ap of drawable) {
    const color = colorForBssid(ap.bssid);
    const selected = ap.bssid === selectedBssid;
    const half = (ap.width && ap.width !== 8080 ? ap.width : 20) / 2;
    const center = ap.freq;
    const from = Math.max(cfg.min, center - half - 3);
    const to = Math.min(cfg.max, center + half + 3);
    if (to <= from) continue;

    const coords = [];
    for (let f = from; f <= to; f += 2) {
      const d = Math.abs(f - center);
      let att = 0;
      if (d > half * 0.62) att = 26 * Math.pow((d - half * 0.62) / (half * 0.38 + 3), 2);
      const value = Math.max(-100, ap.rssi - att);
      coords.push([xFor(f), yFor(value)]);
    }
    if (coords.length < 2) continue;

    ctx.save();
    const gradient = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = selected ? 0.42 : 0.2;
    ctx.beginPath();
    ctx.moveTo(coords[0][0], padT + plotH);
    for (const [x, y] of coords) ctx.lineTo(x, y);
    ctx.lineTo(coords[coords.length - 1][0], padT + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = selected ? 1 : 0.72;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2.2 : 1.2;
    ctx.beginPath();
    coords.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    if (selected || ap.rssi > -70) {
      labels.push({ x: xFor(center), y: yFor(ap.rssi), text: ap.ssid || '(oculta)', color, selected, rssi: ap.rssi });
    }
  }

  labels.sort((a, b) => b.rssi - a.rssi);
  const placed = [];
  ctx.font = '9.5px Inter, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const label of labels.slice(0, 12)) {
    let y = label.y - 6;
    for (const prev of placed) {
      if (Math.abs(prev.x - label.x) < 58 && Math.abs(prev.y - y) < 12) y = prev.y - 13;
    }
    if (y < padT + 10) y = padT + 10;
    placed.push({ x: label.x, y });

    const text = label.text.length > 14 ? `${label.text.slice(0, 13)}…` : label.text;
    const textWidth = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(10, 16, 26, 0.72)';
    roundRectPath(ctx, label.x - textWidth / 2 - 3, y - 10, textWidth + 6, 11, 3);
    ctx.fill();
    ctx.fillStyle = label.selected ? '#e8eef8' : label.color;
    ctx.fillText(text, label.x, y);
  }

  ctx.restore();
}

export function drawSparkline(canvas, history, quality = 'unknown') {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const data = (history || []).filter((p) => Number.isFinite(p.rssi)).slice(-40);
  if (data.length < 2) {
    ctx.strokeStyle = cssVar('--border', '#243044');
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    return;
  }

  const values = data.map((d) => d.rssi);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 6) {
    const mid = (max + min) / 2;
    min = mid - 3;
    max = mid + 3;
  }
  const xFor = (i) => (i / (data.length - 1)) * width;
  const yFor = (v) => height - 2 - ((v - min) / (max - min)) * (height - 4);
  const color = qualityColor(quality);

  ctx.beginPath();
  ctx.moveTo(0, height);
  data.forEach((d, i) => ctx.lineTo(xFor(i), yFor(d.rssi)));
  ctx.lineTo(width, height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${color}55`);
  gradient.addColorStop(1, `${color}00`);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  data.forEach((d, i) => {
    const x = xFor(i);
    const y = yFor(d.rssi);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();
}
