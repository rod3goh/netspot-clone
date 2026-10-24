'use strict';

const { spawn } = require('child_process');
const iconv = require('iconv-lite');
const { WlanApiClient } = require('./wlanapi');
const {
  normalizeText,
  channelToFreq,
  freqToChannel,
  bandForChannel,
  percentToDbm,
  phyFromCode,
  normalizeSecurity,
} = require('./util');

const wlanApi = new WlanApiClient();

function runCommand(file, args, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let size = 0;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error(`Tempo esgotado ao executar ${file}`));
    }, timeout);

    child.stdout.on('data', (d) => {
      size += d.length;
      if (size < 24 * 1024 * 1024) out.push(d);
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      if (code !== 0) {
        reject(new Error(decode(stderr).trim() || `${file} terminou com código ${code}`));
      } else {
        resolve(decode(buf));
      }
    });
  });
}

function decode(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return iconv.decode(buffer, 'cp850');
}

function cleanMac(value) {
  const match = String(value || '').match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
  return match ? match[0].replace(/-/g, ':').toLowerCase() : null;
}

function keyName(raw) {
  return normalizeText(raw).replace(/[^a-z0-9]+/g, ' ').trim();
}

const KEY_ALIASES = {
  name: ['name', 'nome', 'nom', 'nombre'],
  description: ['description', 'descricao', 'beschreibung', 'descrizione', 'descripcion'],
  state: ['state', 'estado', 'etat', 'status', 'stato'],
  ssid: ['ssid'],
  bssid: ['bssid'],
  channel: ['channel', 'canal', 'kanal', 'canale', 'canal'],
  signal: ['signal', 'sinal', 'senal', 'signalstarke', 'segnale'],
  radio: ['radio type', 'tipo de radio', 'tipo de rádio', 'type de radio', 'funktyp', 'tipo di radio'],
  authentication: ['authentication', 'autenticacao', 'autenticacion', 'authentification', 'authentifizierung', 'autenticazione'],
  encryption: ['encryption', 'criptografia', 'cifrado', 'chiffrement', 'verschlusselung', 'cifratura'],
  receiveRate: ['receive rate mbps', 'receive rate', 'taxa de recepcao mbps', 'taxa de recepcao', 'debit de reception mbps'],
  transmitRate: ['transmit rate mbps', 'transmit rate', 'taxa de transmissao mbps', 'taxa de transmissao', 'debit de transmission mbps'],
  profile: ['profile', 'perfil', 'profil'],
  guid: ['guid'],
};

const ALIAS_TO_KEY = {};
for (const [key, aliases] of Object.entries(KEY_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_KEY[alias] = key;
}

function parseInterfaces(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = ALIAS_TO_KEY[keyName(match[1])];
    if (!key) continue;
    if (key === 'name') {
      if (current && Object.keys(current).length > 0) blocks.push(current);
      current = {};
    }
    if (!current) current = {};
    if (current[key] === undefined) current[key] = match[2];
  }
  if (current && Object.keys(current).length) blocks.push(current);

  const interfaces = blocks.map((raw) => {
    const signalPct = raw.signal ? Number(String(raw.signal).replace(/[^\d]/g, '')) : null;
    const channel = raw.channel ? Number(String(raw.channel).replace(/[^\d]/g, '')) : null;
    const bssid = cleanMac(raw.bssid);
    const stateText = normalizeText(raw.state);
    const state = /conect|connect/.test(stateText)
      ? 'connected'
      : /desconect|disconnect/.test(stateText)
        ? 'disconnected'
        : stateText || 'unknown';
    return {
      name: raw.name || raw.description || 'Wi-Fi',
      description: raw.description || raw.name || 'Interface Wi-Fi',
      guid: raw.guid || null,
      state,
      ssid: raw.ssid == null ? null : String(raw.ssid),
      bssid,
      channel: Number.isFinite(channel) ? channel : null,
      signalPct: Number.isFinite(signalPct) ? signalPct : null,
      rssi: Number.isFinite(signalPct) ? percentToDbm(signalPct) : null,
      radio: raw.radio || null,
      authentication: raw.authentication || null,
      receiveRate: raw.receiveRate || null,
      transmitRate: raw.transmitRate || null,
    };
  });

  if (!interfaces.length) return null;
  return interfaces.find((i) => i.state === 'connected') || interfaces[0];
}

function parseNetworks(text, adapter) {
  const lines = String(text || '').split(/\r?\n/);
  const results = [];
  let ssid = '';
  let ssidMeta = {};
  let current = null;

  const pushCurrent = () => {
    if (!current) return;
    const fields = current.fields;
    const signalRaw = fields.signal || '';
    const signalPct = Number((signalRaw.match(/(\d{1,3})\s*%/) || [])[1]);
    if (!Number.isFinite(signalPct)) {
      current = null;
      return;
    }
    const channelText = fields.channel || '';
    const channel = Number((channelText.match(/(\d{1,4})/) || [])[1]);
    const radio = fields.radio || ssidMeta.radio || null;
    const auth = fields.authentication || ssidMeta.authentication || '';
    const cipher = fields.encryption || ssidMeta.encryption || '';
    const security = normalizeSecurity(`${auth} ${cipher}`, /wep/i.test(cipher));
    const bssid = current.bssid;
    const freq = Number.isFinite(channel) ? channelToFreq(channel, bandForChannel(channel)) : null;
    results.push({
      ssid,
      bssid,
      rssi: percentToDbm(signalPct),
      rssiEstimated: true,
      channel: Number.isFinite(channel) ? channel : null,
      freq,
      band: bandForChannel(channel, freq),
      width: null,
      security,
      phy: radio || null,
      privacy: !/aberta|open|none|nenhuma/i.test(security),
      active: !!(adapter && adapter.bssid && bssid === adapter.bssid),
      rates: adapter && adapter.bssid === bssid ? adapter.receiveRate : null,
    });
    current = null;
  };

  for (const line of lines) {
    const ssidMatch = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/i);
    if (ssidMatch) {
      pushCurrent();
      ssid = ssidMatch[1].trim();
      ssidMeta = {};
      continue;
    }
    const bssidMatch = line.match(/^\s*BSSID\s+\d+\s*:\s*(.+)$/i);
    if (bssidMatch) {
      pushCurrent();
      const mac = cleanMac(bssidMatch[1]);
      current = mac ? { bssid: mac, fields: {} } : null;
      continue;
    }
    const pair = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!pair) continue;
    const key = ALIAS_TO_KEY[keyName(pair[1])];
    if (!key) continue;
    if (current) current.fields[key] = pair[2];
    else ssidMeta[key] = pair[2];
  }
  pushCurrent();

  // Deduplicate by BSSID, keeping the strongest observation.
  const map = new Map();
  for (const ap of results) {
    if (!ap.bssid) continue;
    const prev = map.get(ap.bssid);
    if (!prev || (ap.rssi || -999) > (prev.rssi || -999)) map.set(ap.bssid, ap);
  }
  return [...map.values()];
}

function mapWlanApiEntry(entry, adapter) {
  const freq = Number(entry.freq) || null;
  const band = freq ? (freq >= 5925 ? '6' : freq >= 4900 ? '5' : '2.4') : '5';
  const channel = Number(entry.channel) || (freq ? freqToChannel(freq) : null);
  return {
    ssid: entry.ssid || '',
    bssid: entry.bssid,
    rssi: Number(entry.rssi),
    rssiEstimated: false,
    channel,
    freq,
    band,
    width: Number(entry.width) || null,
    security: normalizeSecurity(entry.security, entry.privacy),
    phy: phyFromCode(entry.phyCode),
    privacy: !!entry.privacy,
    active: !!(adapter && adapter.bssid && entry.bssid === adapter.bssid),
    rates: entry.rate > 0 ? `${entry.rate} Mbps` : null,
    adapter: entry.adapter || null,
  };
}

async function scanWindows() {
  const warnings = [];

  const [networksResult, interfacesResult] = await Promise.allSettled([
    runCommand('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul & netsh wlan show networks mode=bssid']),
    runCommand('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul & netsh wlan show interfaces']),
  ]);

  if (networksResult.status === 'rejected' && interfacesResult.status === 'rejected') {
    throw new Error(
      'Não foi possível consultar o serviço WLAN do Windows. Verifique se o adaptador Wi-Fi está habilitado e o serviço "WLAN AutoConfig" está em execução.'
    );
  }

  let adapter = null;
  if (interfacesResult.status === 'fulfilled') {
    adapter = parseInterfaces(interfacesResult.value);
  } else {
    warnings.push(`netsh wlan show interfaces: ${interfacesResult.reason.message}`);
  }

  let viaWlanApi = null;
  let wlanApiError = null;
  if (wlanApi.available) {
    try {
      viaWlanApi = await wlanApi.scan(25000);
      if (viaWlanApi && viaWlanApi.adapters && viaWlanApi.adapters.length) {
        const connected = viaWlanApi.adapters.find((a) => a.state === 1) || viaWlanApi.adapters[0];
        const stateNames = {
          0: 'not_ready',
          1: 'connected',
          2: 'ad_hoc',
          3: 'disconnecting',
          4: 'disconnected',
          5: 'hardware_not_present',
          6: 'hardware_disabled',
          7: 'authenticating',
          8: 'background_scan',
          9: 'initializing',
          10: 'invalid',
        };
        adapter = {
          ...(adapter || {}),
          name: adapter?.name || 'Wi-Fi',
          description: connected.description || adapter?.description || 'Interface Wi-Fi',
          state: stateNames[connected.state] || 'unknown',
          ssid: adapter?.ssid ?? null,
          bssid: adapter?.bssid ?? null,
        };
      }
    } catch (err) {
      wlanApiError = err.message;
      warnings.push(`WLAN API: ${err.message}`);
    }
  }

  let aps = [];
  let source = 'netsh';

  if (viaWlanApi && Array.isArray(viaWlanApi.aps) && viaWlanApi.aps.length) {
    aps = viaWlanApi.aps.map((entry) => mapWlanApiEntry(entry, adapter));
    source = 'wlanapi';
  }

  if (!aps.length && networksResult.status === 'fulfilled') {
    aps = parseNetworks(networksResult.value, adapter);
    source = 'netsh';
  }

  if (!aps.length && networksResult.status === 'rejected') {
    throw new Error(networksResult.reason.message);
  }

  if (!adapter) {
    adapter = {
      name: 'Wi-Fi',
      description: 'Adaptador Wi-Fi',
      state: aps.length ? 'connected' : 'unknown',
      ssid: null,
      bssid: null,
      channel: null,
      rssi: null,
      signalPct: null,
    };
  }

  // Fill adapter connection details from the active BSS when netsh did not report them.
  if (!adapter.bssid) {
    const active = aps.find((ap) => ap.active);
    if (active) {
      adapter.bssid = active.bssid;
      adapter.ssid = active.ssid;
      adapter.channel = active.channel;
      adapter.rssi = active.rssi;
      adapter.signalPct = active.signalPct;
    }
  }

  return { aps, adapter, source, warnings, wlanApiError };
}

module.exports = { scanWindows, wlanApi };
