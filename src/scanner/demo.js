'use strict';

const { channelToFreq, dbmToPercent, qualityFor, vendorFor } = require('./util');

const BASE_APS = [
  { ssid: 'Casa-5G', bssid: '24:0a:c4:1a:2b:3c', vendor: 'Ubiquiti', channel: 36, width: 80, security: 'WPA2', phy: 'Wi-Fi 6 (ax)', base: -46, active: true },
  { ssid: 'Casa-2.4', bssid: '3c:84:6a:8f:11:02', vendor: 'TP-Link', channel: 6, width: 20, security: 'WPA2', phy: 'Wi-Fi 4 (n)', base: -58 },
  { ssid: 'Casa-IoT', bssid: 'a4:2b:b0:77:cd:10', vendor: 'TP-Link', channel: 6, width: 20, security: 'WPA2', phy: 'Wi-Fi 4 (n)', base: -67 },
  { ssid: 'Vizinha_2G', bssid: 'f4:f5:d8:2a:9b:71', vendor: 'Google', channel: 11, width: 20, security: 'WPA2', phy: 'Wi-Fi 5 (ac)', base: -74 },
  { ssid: 'Vizinha_5G', bssid: 'f4:f5:d8:2a:9b:72', vendor: 'Google', channel: 149, width: 80, security: 'WPA2', phy: 'Wi-Fi 5 (ac)', base: -79 },
  { ssid: 'Escritorio', bssid: '00:1a:2b:3c:4d:5e', vendor: 'Cisco', channel: 44, width: 40, security: 'WPA2-Enterprise', phy: 'Wi-Fi 5 (ac)', base: -71 },
  { ssid: 'NETGEAR-Guest', bssid: '8c:85:90:12:34:56', vendor: 'Apple', channel: 1, width: 20, security: 'Aberta', phy: 'Wi-Fi 4 (n)', base: -83 },
  { ssid: 'Starlink', bssid: 'dc:a6:32:aa:bb:cc', vendor: 'Raspberry Pi', channel: 100, width: 80, security: 'WPA3', phy: 'Wi-Fi 6 (ax)', base: -76 },
  { ssid: 'eduroam', bssid: 'b0:be:76:10:20:30', vendor: 'Ruckus Wireless', channel: 6, width: 20, security: 'WPA2-Enterprise', phy: 'Wi-Fi 4 (n)', base: -86 },
  { ssid: 'Casa-6E', bssid: '24:0a:c4:1a:2b:3d', vendor: 'Ubiquiti', channel: 37, width: 160, security: 'WPA3', phy: 'Wi-Fi 7 (be)', base: -62, band: '6' },
];

function demoScan(tick = 0) {
  const now = Date.now();
  const aps = [];
  for (let i = 0; i < BASE_APS.length; i++) {
    const base = BASE_APS[i];
    if (base.ssid === 'eduroam' && Math.floor(tick / 6) % 3 === 0) continue;
    if (base.ssid === 'Vizinha_5G' && tick % 11 === 0) continue;
    const wave = Math.sin((tick + i * 3.7) / 2.1) * 2.6 + Math.cos((tick + i) / 4.3) * 1.4;
    const rssi = Math.max(-95, Math.min(-30, Math.round(base.base + wave)));
    const freq = channelToFreq(base.channel, base.band || (base.channel > 180 ? '6' : base.channel <= 14 ? '2.4' : '5'));
    aps.push({
      ssid: base.ssid,
      bssid: base.bssid,
      vendor: base.vendor || vendorFor(base.bssid),
      rssi,
      rssiEstimated: false,
      channel: base.channel,
      freq,
      band: base.band || (base.channel <= 14 ? '2.4' : base.channel > 180 ? '6' : '5'),
      width: base.width,
      security: base.security,
      phy: base.phy,
      active: !!base.active,
      rates: base.active ? '1.2 Gbps' : null,
      quality: qualityFor(rssi),
      signalPct: dbmToPercent(rssi),
      lastSeen: now,
    });
  }

  const active = aps.find((ap) => ap.active) || aps[0];
  return {
    aps,
    adapter: {
      name: 'Wi-Fi (demonstração)',
      description: 'Adaptador simulado',
      state: 'connected',
      ssid: active ? active.ssid : null,
      bssid: active ? active.bssid : null,
      channel: active ? active.channel : null,
      rssi: active ? active.rssi : null,
      signalPct: active ? active.signalPct : null,
      radio: '802.11ax',
      receiveRate: '1.2 Gbps',
      transmitRate: '1.2 Gbps',
    },
    source: 'demo',
    warnings: [],
  };
}

module.exports = { demoScan };
