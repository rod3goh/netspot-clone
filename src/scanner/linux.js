'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizeText, normalizeSecurity, channelToFreq, freqToChannel, bandForChannel, percentToDbm, dbmToPercent } = require('./util');

function run(file, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`Tempo esgotado ao executar ${file}`));
    }, timeout);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size < 16 * 1024 * 1024) out.push(d);
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) reject(new Error(stderr.trim() || `${file} terminou com código ${code}`));
      else resolve(stdout);
    });
  });
}

function splitTerse(line) {
  const parts = [];
  let current = '';
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === ':') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseNmcliList(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = splitTerse(line);
    if (parts.length < 8) continue;
    const [bssid, ssid, chan, signal, freq, rate, security, active] = parts;
    const freqNum = Number((freq.match(/(\d{4,5})/) || [])[1]) || null;
    const chanNum = Number((chan.match(/(\d{1,4})/) || [])[1]) || (freqNum ? freqToChannel(freqNum) : null);
    const signalNum = Number((signal.match(/(\d{1,3})/) || [])[1]);
    const band = bandForChannel(chanNum, freqNum);
    const securityText = security && security !== '--' ? security : 'Aberta';
    rows.push({
      ssid: ssid === '--' ? '' : ssid,
      bssid: bssid.toLowerCase(),
      rssi: Number.isFinite(signalNum) ? percentToDbm(signalNum) : null,
      rssiEstimated: true,
      channel: chanNum,
      freq: freqNum || channelToFreq(chanNum, band),
      band,
      width: null,
      security: normalizeSecurity(securityText, /wep/i.test(securityText)),
      phy: null,
      privacy: !/aberta|open|none|--/i.test(securityText),
      active: /yes|sim/i.test(active),
      rates: rate && rate !== '--' ? rate : null,
    });
  }
  return rows;
}

function parseIwScan(text, fallbackAdapter) {
  const aps = [];
  let current = null;

  const push = () => {
    if (!current) return;
    const freq = current.freq;
    const channel = current.primaryChannel || (freq ? freqToChannel(freq) : null);
    const band = bandForChannel(channel, freq);
    let width = current.width || null;
    if (!width && freq) {
      const centerChannel = freqToChannel(freq);
      if (band === '5') {
        if ([50, 114, 163].includes(centerChannel)) width = 160;
        else if ([42, 58, 106, 122, 138, 155, 171].includes(centerChannel)) width = 80;
        else if ([38, 46, 54, 62, 102, 110, 118, 126, 134, 142, 151, 159, 167, 175].includes(centerChannel)) width = 40;
      } else if (band === '6') {
        if ([31, 63, 95, 127, 159, 191].includes(centerChannel)) width = 320;
        else if ([15, 47, 79, 111, 143, 175, 207].includes(centerChannel)) width = 160;
        else if ([7, 23, 39, 55, 71, 87, 103, 119, 135, 151, 167, 183, 199, 215].includes(centerChannel)) width = 80;
      }
    }
    if (!width) width = 20;

    const phy = current.eht ? 'Wi-Fi 7 (be)' : current.he ? 'Wi-Fi 6 (ax)' : current.vht ? 'Wi-Fi 5 (ac)' : current.ht ? 'Wi-Fi 4 (n)' : null;
    let security = 'Aberta';
    if (current.rsn) {
      security = current.sae ? 'WPA3' : current.enterprise ? 'WPA2-Enterprise' : 'WPA2';
    } else if (current.wpa) {
      security = 'WPA';
    } else if (current.privacy) {
      security = 'WEP';
    }

    aps.push({
      ssid: current.ssid || '',
      bssid: current.bssid,
      rssi: current.signal != null ? Math.round(current.signal) : null,
      rssiEstimated: false,
      channel,
      freq,
      band,
      width,
      security,
      phy,
      privacy: !!current.privacy,
      active: !!(fallbackAdapter && fallbackAdapter.bssid === current.bssid),
      rates: current.rates || null,
    });
    current = null;
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const bss = line.match(/^BSS\s+([0-9a-f:]{17})/i);
    if (bss) {
      push();
      current = { bssid: bss[1].toLowerCase(), signal: null, freq: null, width: null, primaryChannel: null };
      continue;
    }
    if (!current) continue;
    const signal = line.match(/^\s*signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/i);
    if (signal) {
      current.signal = Number(signal[1]);
      continue;
    }
    const freq = line.match(/^\s*freq:\s*(\d+(?:\.\d+)?)/i);
    if (freq) {
      current.freq = Math.round(Number(freq[1]));
      continue;
    }
    const ssid = line.match(/^\s*SSID:\s*(.*)$/i);
    if (ssid) {
      current.ssid = ssid[1].trim();
      continue;
    }
    if (/^\s*RSN:/i.test(line)) {
      current.rsn = true;
      continue;
    }
    if (/^\s*WPA:/i.test(line)) {
      current.wpa = true;
      continue;
    }
    if (/^\s*\* Capabilities:.*Privacy/i.test(line)) current.privacy = true;
    if (/^\s*\* Authentication suites:/i.test(line)) {
      // Following lines list suites; the simple flags below are set by the summary parser.
    }
    if (/SAE/i.test(line)) current.sae = true;
    if (/802\.1X|EAP/i.test(line)) current.enterprise = true;
    if (/^\s*HE Operation:/i.test(line)) current.he = true;
    if (/^\s*EHT Operation:/i.test(line)) current.eht = true;
    if (/^\s*VHT Operation:/i.test(line)) current.vht = true;
    if (/^\s*HT Operation:/i.test(line)) current.ht = true;
    const ds = line.match(/^\s*DS Parameter set:\s*channel\s*(\d+)/i);
    if (ds) current.primaryChannel = Number(ds[1]);
    const primary = line.match(/^\s*\* primary channel:\s*(\d+)/i);
    if (primary) current.primaryChannel = Number(primary[1]);
    const vhtWidth = line.match(/^\s*\* channel width:\s*(\d+)/i);
    if (vhtWidth) {
      const code = Number(vhtWidth[1]);
      if (code === 1) current.width = 80;
      else if (code === 2) current.width = 160;
      else if (code === 3) current.width = 8080;
      else if (!current.width) current.width = 40;
    }
    if (/^\s*\* STA channel width:\s*any/i.test(line) && !current.width) current.width = 40;
    const rate = line.match(/^\s*\*?\s*(\d+(?:\.\d+)?)\s*MBit\/s/i);
    if (rate) current.rates = `${rate[1]} Mbit/s`;
  }
  push();
  return aps;
}

function findIwInterfaces(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*Interface\s+(\S+)/i);
    if (m) out.push(m[1]);
  }
  return out;
}

async function enrichAdapter(adapter) {
  if (!adapter || !adapter.name) return adapter;
  const ifname = adapter.ifname || adapter.name;
  const sysfs = path.join('/sys/class/net', ifname, 'device');
  try {
    const real = await fs.promises.realpath(sysfs);
    const usbDir = path.dirname(real);
    const read = async (file) => {
      try {
        return (await fs.promises.readFile(path.join(usbDir, file), 'utf8')).trim() || null;
      } catch {
        return null;
      }
    };
    const [idVendor, idProduct, product, manufacturer] = await Promise.all([
      read('idVendor'), read('idProduct'), read('product'), read('manufacturer'),
    ]);
    let driver = null;
    try {
      driver = path.basename(await fs.promises.readlink(path.join(sysfs, 'driver')));
    } catch {}
    let mac = null;
    try {
      mac = (await fs.promises.readFile(path.join('/sys/class/net', ifname, 'address'), 'utf8')).trim() || null;
    } catch {}

    adapter.ifname = ifname;
    adapter.vendor = manufacturer;
    adapter.product = product;
    adapter.driver = driver;
    adapter.mac = mac;
    adapter.usbId = idVendor && idProduct ? `${idVendor}:${idProduct}` : null;
    if (product) {
      adapter.description = product;
      adapter.name = manufacturer && !product.toLowerCase().includes(manufacturer.toLowerCase())
        ? `${manufacturer} ${product}`
        : product;
    }
  } catch {
    adapter.ifname = ifname;
  }
  return adapter;
}

async function wifiBlockReason() {
  try {
    const text = await run('rfkill', ['list', 'wifi'], 5000);
    if (/Hard blocked:\s*yes/i.test(text)) return 'hard';
    if (/Soft blocked:\s*yes/i.test(text)) return 'soft';
  } catch {
    // rfkill é opcional; sem ele seguimos com nmcli/iw.
  }
  return null;
}

async function scanLinux() {
  const warnings = [];
  let adapter = null;
  let aps = [];
  let source = null;

  let devices = null;
  try {
    devices = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device', 'status'], 12000);
  } catch (err) {
    warnings.push(`nmcli indisponível: ${err.message}`);
  }

  if (devices) {
    const wifi = devices
      .split(/\r?\n/)
      .map((line) => splitTerse(line))
      .find((parts) => parts[1] === 'wifi');
    if (wifi) {
      const [dev, , state] = wifi;
      adapter = { name: dev, description: dev, state, ssid: null, bssid: null, channel: null, rssi: null, signalPct: null };
      try {
        const list = await run(
          'nmcli',
          ['-t', '-f', 'BSSID,SSID,CHAN,SIGNAL,FREQ,RATE,SECURITY,ACTIVE', 'device', 'wifi', 'list', 'ifname', dev, '--rescan', 'yes'],
          35000
        );
        aps = parseNmcliList(list);
        source = 'nmcli';
      } catch (err) {
        warnings.push(`Falha na varredura nmcli: ${err.message}`);
      }

      if (process.getuid && process.getuid() === 0) {
        try {
          const iwScan = await run('iw', ['dev', dev, 'scan'], 25000);
          const iwAps = parseIwScan(iwScan, adapter);
          const byBssid = new Map(iwAps.map((ap) => [ap.bssid, ap]));
          for (const ap of aps) {
            const extra = byBssid.get(ap.bssid);
            if (extra) {
              ap.width = extra.width;
              ap.phy = extra.phy;
              ap.security = extra.security;
              ap.rssi = extra.rssi;
              ap.rssiEstimated = false;
            }
          }
          if (!aps.length) {
            aps = iwAps;
            source = 'iw';
          }
        } catch (err) {
          warnings.push(`iw scan (opcional): ${err.message}`);
        }
      }
    } else {
      warnings.push('Nenhum adaptador Wi-Fi encontrado pelo NetworkManager.');
    }
  }

  if (!aps.length) {
    try {
      const devText = await run('iw', ['dev'], 8000);
      const interfaces = findIwInterfaces(devText);
      if (interfaces.length) {
        const dev = interfaces[0];
        adapter = adapter || { name: dev, description: dev, state: 'unknown', ssid: null, bssid: null, channel: null, rssi: null, signalPct: null };
        const iwScan = await run('iw', ['dev', dev, 'scan'], 30000);
        aps = parseIwScan(iwScan, adapter);
        source = 'iw';
      }
    } catch (err) {
      warnings.push(`iw indisponível: ${err.message}`);
    }
  }

  if (!aps.length) {
    const blocked = await wifiBlockReason();
    if (blocked) {
      const message = blocked === 'hard'
        ? 'O Wi-Fi está desativado por uma chave física ou botão do notebook. Ative-o e tente novamente.'
        : 'O adaptador Wi-Fi está bloqueado por software (rfkill). Execute "sudo rfkill unblock wifi" e tente novamente.';
      const error = new Error(message);
      error.adapter = adapter;
      throw error;
    }
    const detail = warnings.length ? ` (${warnings[warnings.length - 1]})` : '';
    const error = new Error(
      `Não foi possível escanear redes Wi-Fi no Linux${detail}. Verifique se o adaptador está conectado e se o NetworkManager (nmcli) está ativo.`
    );
    error.adapter = adapter;
    throw error;
  }

  if (!adapter) {
    adapter = { name: 'Wi-Fi', description: 'Adaptador Wi-Fi', state: 'connected', ssid: null, bssid: null, channel: null, rssi: null, signalPct: null };
  }

  const connected = /connected|conectado/i.test(String(adapter.state || ''));
  const active = connected ? (aps.find((ap) => ap.active) || aps[0]) : null;
  if (connected && !adapter.bssid && active) {
    adapter.bssid = active.bssid;
    adapter.ssid = active.ssid;
    adapter.channel = active.channel;
    adapter.rssi = active.rssi;
    adapter.signalPct = dbmToPercent(active.rssi);
    if (adapter.state === 'connected' || adapter.state === 'conectado') adapter.state = 'connected';
  }

  if (!connected) {
    adapter.ssid = null;
    adapter.bssid = null;
    adapter.channel = null;
    adapter.rssi = null;
    adapter.signalPct = null;
  }
  await enrichAdapter(adapter);
  return { aps, adapter, source, warnings };
}

module.exports = { scanLinux };
