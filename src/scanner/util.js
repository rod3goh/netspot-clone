'use strict';

const fs = require('fs');
const path = require('path');

let OUI = {};
try {
  OUI = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'oui.json'), 'utf8'));
} catch {
  OUI = {};
}

function vendorFor(bssid) {
  if (!bssid) return '';
  const prefix = bssid.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
  return OUI[prefix] || '';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function channelToFreq(channel, band) {
  const ch = Number(channel);
  if (!Number.isFinite(ch) || ch <= 0) return null;
  if (band === '2.4' || ch <= 14) return ch === 14 ? 2484 : 2412 + 5 * (ch - 1);
  if (band === '6' || ch > 180) return 5950 + 5 * ch;
  return 5000 + 5 * ch;
}

function freqToChannel(freq) {
  const f = Number(freq);
  if (!Number.isFinite(f)) return null;
  if (f === 2484) return 14;
  if (f >= 2400 && f < 2500) return Math.round((f - 2412) / 5) + 1;
  if (f >= 4900 && f < 5925) return Math.round((f - 5000) / 5);
  if (f >= 5925 && f <= 7125) return Math.round((f - 5950) / 5);
  return null;
}

function freqToBand(freq) {
  const f = Number(freq);
  if (!Number.isFinite(f)) return null;
  if (f >= 2400 && f < 2500) return '2.4';
  if (f >= 4900 && f < 5925) return '5';
  if (f >= 5925 && f <= 7125) return '6';
  return null;
}

function bandForChannel(channel, freq) {
  if (freq) {
    const band = freqToBand(freq);
    if (band) return band;
  }
  const ch = Number(channel);
  if (!Number.isFinite(ch)) return null;
  if (ch <= 14) return '2.4';
  if (ch >= 180) return '6';
  return '5';
}

function percentToDbm(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.round(p / 2 - 100);
}

function dbmToPercent(dbm) {
  const v = Math.max(-100, Math.min(-20, Number(dbm) || -100));
  return Math.max(0, Math.min(100, Math.round(2 * (v + 100))));
}

function qualityFor(dbm) {
  if (!Number.isFinite(dbm)) return 'unknown';
  if (dbm >= -50) return 'excellent';
  if (dbm >= -60) return 'good';
  if (dbm >= -70) return 'fair';
  if (dbm >= -80) return 'weak';
  return 'bad';
}

function normalizeSecurity(raw, privacy) {
  const text = normalizeText(raw);
  if (!text) return privacy ? 'WEP' : 'Aberta';
  if (/wpa3|sae|owe/.test(text)) return /enterprise|802\.?1x|eap/.test(text) ? 'WPA3-Enterprise' : 'WPA3';
  if (/wpa2/.test(text)) {
    if (/enterprise|802\.?1x|eap|empresa/.test(text)) return 'WPA2-Enterprise';
    return 'WPA2';
  }
  if (/wpa/.test(text)) {
    if (/enterprise|802\.?1x|eap|empresa/.test(text)) return 'WPA-Enterprise';
    return 'WPA';
  }
  if (/wep/.test(text)) return 'WEP';
  if (/aberta|open|none|nenhuma|desativad|sem seguranca/.test(text)) return 'Aberta';
  const cleaned = String(raw).trim().replace(/\s+/g, ' ');
  return cleaned || (privacy ? 'WEP' : 'Aberta');
}

function normalizePhy(raw) {
  const text = String(raw || '').toLowerCase();
  if (/be|wi-?fi\s*7|eht/.test(text)) return 'Wi-Fi 7 (be)';
  if (/ax|wi-?fi\s*6|he/.test(text)) return 'Wi-Fi 6 (ax)';
  if (/ac|vht/.test(text)) return 'Wi-Fi 5 (ac)';
  if (/(^|\W)n($|\W)|ht/.test(text)) return 'Wi-Fi 4 (n)';
  if (/ofdm|(^|\W)a($|\W)/.test(text)) return '802.11a';
  if (/erp|(^|\W)g($|\W)/.test(text)) return '802.11g';
  if (/dsss|(^|\W)b($|\W)/.test(text)) return '802.11b';
  return raw ? String(raw).trim() : '—';
}

function phyFromCode(code) {
  const map = {
    0: 'Desconhecido',
    1: 'FHSS',
    2: 'DSSS (b)',
    3: 'IR',
    4: '802.11a (OFDM)',
    5: '802.11b (HR-DSSS)',
    6: '802.11g (ERP)',
    7: 'Wi-Fi 4 (n)',
    8: 'Wi-Fi 5 (ac)',
    9: '802.11ad (DMG)',
    10: 'Wi-Fi 6 (ax)',
    11: 'Wi-Fi 7 (be)',
  };
  return map[code] || 'Desconhecido';
}

function widthLabel(width) {
  if (!width) return '—';
  if (width === 8080) return '80+80 MHz';
  return `${width} MHz`;
}

function normalizeAp(raw) {
  const bssid = String(raw.bssid || '').toLowerCase();
  const freq = Number(raw.freq) || channelToFreq(raw.channel, raw.band) || null;
  const band = raw.band || bandForChannel(raw.channel, freq);
  const channel = Number(raw.channel) || freqToChannel(freq);
  const rssi = Number.isFinite(raw.rssi) ? Math.round(raw.rssi) : null;
  const ssid = (raw.ssid == null ? '' : String(raw.ssid)).replace(/\0/g, '').trimEnd();
  return {
    bssid,
    ssid: ssid || '',
    hidden: !ssid,
    vendor: raw.vendor || vendorFor(bssid),
    rssi,
    signalPct: rssi != null ? dbmToPercent(rssi) : 0,
    quality: qualityFor(rssi),
    rssiEstimated: !!raw.rssiEstimated,
    channel: channel || null,
    freq: freq || null,
    band,
    width: raw.width || null,
    security: normalizeSecurity(raw.security, raw.privacy),
    phy: raw.phy ? normalizePhy(raw.phy) : '—',
    rates: raw.rates || null,
    active: !!raw.active,
    stale: false,
    firstSeen: raw.firstSeen || Date.now(),
    lastSeen: raw.lastSeen || Date.now(),
    samples: raw.samples || 1,
  };
}

function overlapFactor(a, b) {
  if (!a || !b || !a.freq || !b.freq) return 0;
  const aw = a.width && a.width !== 8080 ? a.width : 20;
  const bw = b.width && b.width !== 8080 ? b.width : 20;
  const a0 = a.freq - aw / 2;
  const a1 = a.freq + aw / 2;
  const b0 = b.freq - bw / 2;
  const b1 = b.freq + bw / 2;
  const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  if (!overlap) return 0;
  return overlap / Math.min(aw, bw);
}

function interferenceAt(apList) {
  const usable = apList.filter((ap) => Number.isFinite(ap.rssi) && ap.rssi >= -88);
  if (usable.length < 2) return 0;
  const strengthOf = (rssi) => Math.max(0, Math.min(1, (rssi + 95) / 50));
  let total = 0;
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const overlap = overlapFactor(usable[i], usable[j]);
      if (!overlap) continue;
      total += overlap * Math.max(strengthOf(usable[i].rssi), strengthOf(usable[j].rssi));
    }
  }
  return Math.max(0, Math.min(100, Math.round(total * 45)));
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

module.exports = {
  vendorFor,
  normalizeText,
  channelToFreq,
  freqToChannel,
  freqToBand,
  bandForChannel,
  percentToDbm,
  dbmToPercent,
  qualityFor,
  normalizeSecurity,
  normalizePhy,
  phyFromCode,
  widthLabel,
  normalizeAp,
  overlapFactor,
  interferenceAt,
  roundRect,
};
