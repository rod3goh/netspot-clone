'use strict';

const { EventEmitter } = require('events');
const { normalizeAp, qualityFor, dbmToPercent } = require('./util');
const { scanWindows, wlanApi } = require('./windows');
const { scanLinux } = require('./linux');
const { demoScan } = require('./demo');

const HISTORY_LIMIT = 180;
const REMOVE_AFTER_MS = 180000;

class Scanner extends EventEmitter {
  constructor({ settings = {} } = {}) {
    super();
    this.settings = settings;
    this.aps = new Map();
    this.history = new Map();
    this.timer = null;
    this.running = false;
    this.scanning = false;
    this.demo = false;
    this.intervalSeconds = Math.max(2, Number(settings.intervalSeconds) || 5);
    this.tick = 0;
    this.lastSnapshot = null;
    this.lastError = null;
    this.lastScanAt = null;
    this.scanCount = 0;
  }

  start({ intervalSeconds, demo } = {}) {
    const nextInterval = Math.max(2, Number(intervalSeconds) || this.intervalSeconds || 5);
    const nextDemo = demo === undefined ? this.demo : !!demo;
    const changed = !this.running || nextDemo !== this.demo || nextInterval !== this.intervalSeconds;
    this.intervalSeconds = nextInterval;
    this.demo = nextDemo;
    this.running = true;
    this.clearTimer();
    this.emit('status', this.getState());
    if (changed) {
      this.scanNow({ manual: false });
    }
    this.schedule();
  }

  stop() {
    this.running = false;
    this.clearTimer();
    this.emit('status', this.getState());
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule() {
    this.clearTimer();
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.scanNow({ manual: false });
      this.schedule();
    }, this.intervalSeconds * 1000);
  }

  async scanNow({ manual = false } = {}) {
    if (this.scanning) return this.lastSnapshot;
    this.scanning = true;
    this.emit('status', this.getState());
    let result;
    try {
      if (this.demo) {
        this.tick += 1;
        result = demoScan(this.tick);
      } else if (process.platform === 'win32') {
        result = await scanWindows();
      } else if (process.platform === 'linux') {
        result = await scanLinux();
      } else {
        throw new Error(`Plataforma não suportada: ${process.platform}`);
      }
      this.lastError = null;
      this.apply(result);
      this.scanCount += 1;
      this.lastScanAt = Date.now();
    } catch (err) {
      this.lastError = String(err.message || err);
      const snapshot = {
        ...(this.lastSnapshot || this.emptySnapshot()),
        error: this.lastError,
        errorHint: hintFor(this.lastError),
        scanning: false,
        manual,
        timestamp: Date.now(),
      };
      this.lastSnapshot = snapshot;
      this.emit('snapshot', snapshot);
    } finally {
      this.scanning = false;
      this.emit('status', this.getState());
    }
    return this.lastSnapshot;
  }

  emptySnapshot() {
    return {
      aps: [],
      history: {},
      adapter: null,
      demo: this.demo,
      error: null,
      source: null,
      warnings: [],
      timestamp: Date.now(),
      intervalSeconds: this.intervalSeconds,
      scanCount: this.scanCount,
    };
  }

  apply(result) {
    const now = Date.now();
    const seen = new Set();
    const adapter = result.adapter || null;
    const connectedBssid = adapter && adapter.bssid ? String(adapter.bssid).toLowerCase() : null;

    for (const raw of result.aps || []) {
      if (!raw || !raw.bssid) continue;
      const bssid = String(raw.bssid).toLowerCase();
      const previous = this.aps.get(bssid);
      const normalized = normalizeAp({
        ...raw,
        bssid,
        firstSeen: previous ? previous.firstSeen : now,
        lastSeen: now,
        samples: previous ? previous.samples + 1 : 1,
        active: connectedBssid ? bssid === connectedBssid : !!raw.active,
      });
      if (normalized.rssi == null && previous) normalized.rssi = previous.rssi;
      normalized.quality = qualityFor(normalized.rssi);
      normalized.signalPct = normalized.rssi != null ? dbmToPercent(normalized.rssi) : 0;
      if (!normalized.width && previous && previous.width) normalized.width = previous.width;
      if (!normalized.freq && previous && previous.freq) normalized.freq = previous.freq;
      this.aps.set(bssid, normalized);
      seen.add(bssid);

      const list = this.history.get(bssid) || [];
      if (normalized.rssi != null) list.push({ t: now, rssi: normalized.rssi });
      while (list.length > HISTORY_LIMIT) list.shift();
      this.history.set(bssid, list);
    }

    for (const [bssid, ap] of this.aps) {
      if (seen.has(bssid)) continue;
      ap.stale = true;
      if (now - ap.lastSeen > REMOVE_AFTER_MS) {
        this.aps.delete(bssid);
        this.history.delete(bssid);
      }
    }

    if (adapter && connectedBssid) {
      adapter.ssid = adapter.ssid || this.aps.get(connectedBssid)?.ssid || null;
      adapter.channel = adapter.channel || this.aps.get(connectedBssid)?.channel || null;
      adapter.rssi = adapter.rssi ?? this.aps.get(connectedBssid)?.rssi ?? null;
      adapter.signalPct = adapter.signalPct ?? this.aps.get(connectedBssid)?.signalPct ?? null;
      adapter.state = adapter.state || 'connected';
    }

    const aps = [...this.aps.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
    const history = {};
    for (const [bssid, list] of this.history) history[bssid] = list.slice(-HISTORY_LIMIT);

    const snapshot = {
      aps,
      history,
      adapter,
      demo: this.demo,
      source: result.source || null,
      warnings: result.warnings || [],
      error: null,
      errorHint: null,
      timestamp: now,
      intervalSeconds: this.intervalSeconds,
      scanCount: this.scanCount,
    };
    this.lastSnapshot = snapshot;
    this.emit('snapshot', snapshot);
  }

  getState() {
    return {
      running: this.running,
      scanning: this.scanning,
      demo: this.demo,
      intervalSeconds: this.intervalSeconds,
      scanCount: this.scanCount,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
    };
  }

  dispose() {
    this.stop();
    wlanApi.stop();
  }
}

function hintFor(message) {
  const text = String(message || '');
  if (/WLAN AutoConfig|serviço WLAN|wlanapi|WlanOpenHandle/i.test(text)) {
    return 'Abra "Serviços" do Windows, inicie o serviço WLAN AutoConfig e confirme que o adaptador Wi-Fi está habilitado.';
  }
  if (/nmcli|NetworkManager/i.test(text)) {
    return 'Instale/ative o NetworkManager (nmcli). Em muitas distribuições: sudo systemctl enable --now NetworkManager.';
  }
  if (/permiss|Permission|Operation not permitted|CAP_NET_ADMIN/i.test(text)) {
    return 'A varredura iw exige privilégios. Execute com sudo ou use o NetworkManager (nmcli).';
  }
  if (/Tempo esgotado/i.test(text)) {
    return 'A varredura demorou demais. Aproxime-se do roteador, desative o modo avião e tente novamente.';
  }
  return 'Verifique se o adaptador Wi-Fi está ligado e se o aplicativo tem permissão para escanear redes.';
}

module.exports = { Scanner };
