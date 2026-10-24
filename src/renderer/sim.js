// Radio-propagation helpers shared by the survey and planning views.
// These are deliberately simple, deterministic models: free-space loss at 1 m
// plus a log-distance exponent and per-obstacle attenuation.

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function channelFreq(channel, band) {
  const ch = Number(channel);
  if (!Number.isFinite(ch) || ch <= 0) return band === '5' ? 5180 : 2437;
  if (band === '2.4' || ch <= 14) return ch === 14 ? 2484 : 2412 + 5 * (ch - 1);
  if (band === '6' || ch >= 180) return 5950 + 5 * ch;
  return 5000 + 5 * ch;
}

function orientation(ax, ay, bx, by, cx, cy) {
  const value = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(ax, ay, bx, by, cx, cy) {
  return (
    Math.min(ax, bx) - 1e-9 <= cx && cx <= Math.max(ax, bx) + 1e-9 &&
    Math.min(ay, by) - 1e-9 <= cy && cy <= Math.max(ay, by) + 1e-9
  );
}

export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = orientation(ax, ay, bx, by, cx, cy);
  const o2 = orientation(ax, ay, bx, by, dx, dy);
  const o3 = orientation(cx, cy, dx, dy, ax, ay);
  const o4 = orientation(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  if (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

export function attenuationFor(type, attenuation) {
  const defaults = { wall: 7, door: 2, window: 3 };
  const value = attenuation && attenuation[type];
  return Number.isFinite(Number(value)) ? Number(value) : defaults[type] ?? 0;
}

export function wallLoss(ax, ay, bx, by, obstacles, attenuation) {
  let loss = 0;
  for (const obstacle of obstacles || []) {
    if (segmentsIntersect(ax, ay, bx, by, obstacle.x1, obstacle.y1, obstacle.x2, obstacle.y2)) {
      loss += attenuationFor(obstacle.type, attenuation);
    }
  }
  return loss;
}

export function rssiForAp(ap, x, y, obstacles = [], attenuation = null) {
  const distance = Math.max(0.5, Math.hypot(x - ap.x, y - ap.y));
  const freq = channelFreq(ap.channel, ap.band);
  // Free-space loss at 1 m (32.45 + 20log10(fMHz) - 60) plus an 8 dB
  // indoor offset (antenna gain, body loss, multipath) and a 2.5 exponent.
  const reference = 32.45 + 20 * Math.log10(freq) - 60 + 8;
  const loss = reference + 10 * 2.5 * Math.log10(distance);
  const walls = wallLoss(ap.x, ap.y, x, y, obstacles, attenuation);
  const power = Number.isFinite(Number(ap.power)) ? Number(ap.power) : 20;
  return clamp(power - loss - walls, -100, -20);
}

export function coverageAt(aps, x, y, obstacles, attenuation, selectedApId = null) {
  let best = -Infinity;
  for (const ap of aps || []) {
    if (selectedApId && ap.id !== selectedApId) continue;
    const value = rssiForAp(ap, x, y, obstacles, attenuation);
    if (value > best) best = value;
  }
  return Number.isFinite(best) ? best : NaN;
}

export function overlapFactor(a, b) {
  const aFreq = a.freq || channelFreq(a.channel, a.band);
  const bFreq = b.freq || channelFreq(b.channel, b.band);
  const aWidth = a.width && a.width !== 8080 ? a.width : 20;
  const bWidth = b.width && b.width !== 8080 ? b.width : 20;
  const overlap = Math.max(0, Math.min(aFreq + aWidth / 2, bFreq + bWidth / 2) - Math.max(aFreq - aWidth / 2, bFreq - bWidth / 2));
  if (!overlap) return 0;
  return overlap / Math.min(aWidth, bWidth);
}

export function interferenceOf(networks) {
  const usable = (networks || []).filter((network) => Number.isFinite(network.rssi) && network.rssi >= -88);
  if (usable.length < 2) return 0;
  const strengthOf = (rssi) => clamp((rssi + 95) / 50, 0, 1);
  let total = 0;
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const overlap = overlapFactor(usable[i], usable[j]);
      if (!overlap) continue;
      total += overlap * Math.max(strengthOf(usable[i].rssi), strengthOf(usable[j].rssi));
    }
  }
  // 0 % = no overlapping neighbour, 100 % = saturated channel occupancy.
  return clamp(Math.round(total * 45), 0, 100);
}
