import { channelFreq, rssiForAp, interferenceOf } from './sim.js';

const PX_W = 1600;
const PX_H = 1000;
export const SAMPLE_WIDTH = 18;
export const SAMPLE_HEIGHT = 11.25;

const mx = (value) => (value / PX_W) * SAMPLE_WIDTH;
const my = (value) => (value / PX_H) * SAMPLE_HEIGHT;

// Architectural segments in image pixels. Gaps are doors and windows.
const WALLS = [
  // outer walls
  [60, 60, 250, 60], [450, 60, 750, 60], [950, 60, 1540, 60],
  [60, 940, 250, 940], [450, 940, 1100, 940], [1270, 940, 1540, 940],
  [60, 60, 60, 250], [60, 430, 60, 940],
  [1540, 60, 1540, 650], [1540, 850, 1540, 940],
  // vertical spine
  [600, 60, 600, 300], [600, 380, 600, 700], [600, 780, 600, 940],
  // living / kitchen
  [60, 520, 300, 520], [380, 520, 600, 520],
  // bedrooms divider
  [600, 520, 1050, 520],
  // bedrooms / service block
  [1050, 60, 1050, 520],
  [1050, 300, 1300, 300], [1370, 300, 1540, 300],
  // office / meeting
  [1050, 520, 1200, 520], [1280, 520, 1540, 520],
  [1050, 520, 1050, 700], [1050, 780, 1050, 940],
];

const WINDOWS = [
  [250, 60, 450, 60],
  [750, 60, 950, 60],
  [250, 940, 450, 940],
  [60, 250, 60, 430],
  [1540, 650, 1540, 850],
];

const DOORS = [
  { x1: 1100, y1: 940, x2: 1270, y2: 940, swing: -1 },
  { x1: 600, y1: 300, x2: 600, y2: 380, swing: 1 },
  { x1: 300, y1: 520, x2: 380, y2: 520, swing: 1 },
  { x1: 1300, y1: 300, x2: 1370, y2: 300, swing: -1 },
  { x1: 1200, y1: 520, x2: 1280, y2: 520, swing: 1 },
  { x1: 1050, y1: 700, x2: 1050, y2: 780, swing: 1 },
  { x1: 600, y1: 700, x2: 600, y2: 780, swing: -1 },
];

let cachedImage = null;

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

function furniture(ctx, x, y, w, h, fill = '#ddd5c6', stroke = '#c6bcaa', radius = 6) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function ellipse(ctx, x, y, rx, ry, fill, stroke) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function drawTiles(ctx, x, y, w, h, size, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let gx = x; gx < x + w; gx += size) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
    ctx.stroke();
  }
  for (let gy = y; gy < y + h; gy += size) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWindow(ctx, [x1, y1, x2, y2]) {
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#f5f2ea';
  ctx.lineWidth = 20;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = '#9db9cc';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = '#f8fbfd';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const horizontal = Math.abs(x2 - x1) > Math.abs(y2 - y1);
  ctx.strokeStyle = '#7f9bad';
  ctx.lineWidth = 2;
  for (const [px, py] of [[x1, y1], [x2, y2]]) {
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(px, py - 9);
      ctx.lineTo(px, py + 9);
    } else {
      ctx.moveTo(px - 9, py);
      ctx.lineTo(px + 9, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawDoor(ctx, door) {
  const { x1, y1, x2, y2 } = door;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const swing = door.swing || 1;
  const nx = -uy * swing;
  const ny = ux * swing;

  ctx.save();
  ctx.strokeStyle = '#f5f2ea';
  ctx.lineWidth = 20;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = '#b7935c';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + nx * length, y1 + ny * length);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(183,147,92,0.65)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const start = Math.atan2(ny, nx);
  const end = Math.atan2(uy, ux);
  let delta = end - start;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  ctx.arc(x1, y1, length, start, start + delta);
  ctx.stroke();
  ctx.restore();
}

function drawFixtures(ctx) {
  // living room
  furniture(ctx, 120, 140, 230, 72, '#d9d1c2');
  ctx.strokeStyle = '#c2b8a5';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(128, 152);
  ctx.lineTo(342, 152);
  ctx.stroke();
  ellipse(ctx, 370, 340, 72, 42, '#e3dbc9', '#c6bca8');
  furniture(ctx, 500, 170, 52, 170, '#d5ccbc');
  ellipse(ctx, 180, 400, 34, 26, '#dcd3c1', '#c3b9a6');
  ellipse(ctx, 520, 430, 22, 18, '#cfd7c7', '#b3bda9');

  // bedroom 1
  furniture(ctx, 700, 110, 250, 220, '#e0d8ca', '#c7bca9', 4);
  furniture(ctx, 712, 122, 100, 46, '#f4efe6', '#d5cbb9', 10);
  furniture(ctx, 824, 122, 100, 46, '#f4efe6', '#d5cbb9', 10);
  ctx.strokeStyle = '#cabfa9';
  ctx.beginPath();
  ctx.moveTo(712, 250);
  ctx.lineTo(938, 250);
  ctx.stroke();
  furniture(ctx, 655, 110, 36, 46, '#d7cebd', '#c0b5a1', 3);
  furniture(ctx, 960, 110, 36, 46, '#d7cebd', '#c0b5a1', 3);
  furniture(ctx, 930, 415, 82, 100, '#d7cebd', '#c0b5a1', 2);

  // bathroom
  drawTiles(ctx, 1058, 68, 476, 226, 26, 'rgba(151,180,193,0.20)');
  furniture(ctx, 1095, 88, 205, 92, '#f2f7f8', '#a9c2ce', 24);
  ellipse(ctx, 1230, 134, 30, 22, '#e4f0f3', '#a9c2ce');
  furniture(ctx, 1420, 82, 96, 66, '#e9e2d6', '#c5baa7');
  ellipse(ctx, 1468, 115, 24, 17, '#fbfdfe', '#a9c2ce');
  ellipse(ctx, 1450, 220, 30, 40, '#fbfdfe', '#a9c2ce');
  furniture(ctx, 1432, 182, 36, 20, '#e2ebee', '#a9c2ce', 4);

  // office
  furniture(ctx, 1100, 395, 285, 72, '#dbd2c2', '#c3b8a5');
  ellipse(ctx, 1242, 492, 28, 24, '#d7cebd', '#bdb29e');
  furniture(ctx, 1458, 325, 62, 160, '#d5ccbc', '#bfb4a0', 3);
  ctx.strokeStyle = '#bcb19d';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(1464, 350 + i * 36);
    ctx.lineTo(1514, 350 + i * 36);
    ctx.stroke();
  }

  // kitchen
  drawTiles(ctx, 68, 528, 526, 406, 34, 'rgba(190,168,126,0.16)');
  furniture(ctx, 80, 538, 375, 62, '#e4dccd', '#c6baa4');
  furniture(ctx, 80, 538, 64, 330, '#e4dccd', '#c6baa4');
  furniture(ctx, 242, 718, 212, 92, '#ded5c4', '#c1b5a0');
  ellipse(ctx, 292, 764, 26, 20, '#f7fafb', '#a9c2ce');
  ellipse(ctx, 388, 764, 26, 20, '#f7fafb', '#a9c2ce');
  ctx.strokeStyle = '#bfb39d';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(96, 552 + i * 18);
    ctx.lineTo(430, 552 + i * 18);
    ctx.stroke();
  }

  // bedroom 2
  furniture(ctx, 700, 620, 250, 215, '#e0d8ca', '#c7bca9', 4);
  furniture(ctx, 712, 632, 100, 44, '#f4efe6', '#d5cbb9', 10);
  furniture(ctx, 824, 632, 100, 44, '#f4efe6', '#d5cbb9', 10);
  ctx.strokeStyle = '#cabfa9';
  ctx.beginPath();
  ctx.moveTo(712, 756);
  ctx.lineTo(938, 756);
  ctx.stroke();
  furniture(ctx, 900, 862, 130, 56, '#d7cebd', '#c0b5a1', 2);

  // meeting room
  ellipse(ctx, 1288, 720, 158, 88, '#ded5c4', '#c1b5a0');
  const chairPositions = [
    [1160, 620], [1288, 612], [1416, 620],
    [1160, 820], [1288, 828], [1416, 820],
    [1108, 720], [1468, 720],
  ];
  for (const [cx, cy] of chairPositions) {
    ellipse(ctx, cx, cy, 17, 15, '#d8cfbd', '#c2b7a2');
  }
  ctx.save();
  ctx.strokeStyle = '#c0b5a0';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(1140, 688 + i * 32);
    ctx.lineTo(1436, 688 + i * 32);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabels(ctx) {
  const rooms = [
    ['SALA DE ESTAR', '31 m²', 330, 255],
    ['QUARTO 1', '27 m²', 830, 275],
    ['BANHEIRO', '15 m²', 1290, 168],
    ['ESCRITÓRIO', '15 m²', 1290, 465],
    ['COZINHA', '32 m²', 320, 820],
    ['QUARTO 2', '27 m²', 830, 830],
    ['SALA DE REUNIÃO', '33 m²', 1290, 880],
  ];
  ctx.save();
  ctx.textAlign = 'center';
  for (const [title, area, x, y] of rooms) {
    try {
      ctx.letterSpacing = '3px';
    } catch {
      // older Chromium
    }
    ctx.font = '600 19px Inter, Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(112,124,138,0.82)';
    ctx.fillText(title, x, y);
    try {
      ctx.letterSpacing = '0px';
    } catch {
      // ignore
    }
    ctx.font = '12px Inter, Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(141,151,163,0.9)';
    ctx.fillText(area, x, y + 20);
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = 'rgba(137,147,160,0.85)';
  ctx.font = '11px Inter, Segoe UI, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('PLANTA BAIXA  ·  18,0 × 11,3 m', 63, 978);
  ctx.textAlign = 'right';
  ctx.fillText('Escritório modelo / piso térreo', 1537, 978);
  ctx.restore();
}

export function createSampleFloorplan() {
  if (cachedImage) return cachedImage;
  const canvas = document.createElement('canvas');
  canvas.width = PX_W;
  canvas.height = PX_H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f5f2ea';
  ctx.fillRect(0, 0, PX_W, PX_H);

  // faint plotting grid on the paper margin
  ctx.save();
  ctx.strokeStyle = 'rgba(120,130,143,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x < PX_W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, PX_H);
    ctx.stroke();
  }
  for (let y = 0; y < PX_H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(PX_W, y);
    ctx.stroke();
  }
  ctx.restore();

  // warm floor tint inside the plan
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(60, 60, 1480, 880);

  drawFixtures(ctx);

  ctx.save();
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = '#68717c';
  ctx.lineWidth = 15;
  for (const [x1, y1, x2, y2] of WALLS) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 1.5;
  for (const [x1, y1, x2, y2] of WALLS) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();

  for (const windowSegment of WINDOWS) drawWindow(ctx, windowSegment);
  for (const door of DOORS) drawDoor(ctx, door);
  drawLabels(ctx);

  cachedImage = canvas.toDataURL('image/png');
  return cachedImage;
}

export function sampleObstacles() {
  const segments = [
    ...WALLS.map(([x1, y1, x2, y2]) => ({ type: 'wall', x1, y1, x2, y2 })),
    ...WINDOWS.map(([x1, y1, x2, y2]) => ({ type: 'window', x1, y1, x2, y2 })),
    ...DOORS.map(({ x1, y1, x2, y2 }) => ({ type: 'door', x1, y1, x2, y2 })),
  ];
  return segments.map((segment, index) => ({
    id: `so${index + 1}`,
    type: segment.type,
    x1: mx(segment.x1),
    y1: my(segment.y1),
    x2: mx(segment.x2),
    y2: my(segment.y2),
  }));
}

export function sampleAps() {
  return [
    { id: 'sap1', ssid: 'CasaMelo', band: '2.4', channel: 6, power: 20, x: 4.6, y: 4.2 },
    { id: 'sap2', ssid: 'CasaMelo-5G', band: '5', channel: 44, power: 20, x: 13.6, y: 7.6 },
  ];
}

export function sampleSurveyPoints() {
  const aps = sampleAps();
  const obstacles = sampleObstacles();
  const attenuation = { wall: 7, door: 2, window: 3 };
  const extras = [
    { bssid: 'a4:2b:8c:11:04:21', ssid: 'Vizinho_2G', band: '2.4', channel: 6, width: 20, security: 'WPA2', base: -82 },
    { bssid: 'f0:9f:c2:88:31:0a', ssid: 'NETGEAR-5G', band: '5', channel: 44, width: 80, security: 'WPA2', base: -85 },
    { bssid: '8c:3b:ad:7e:52:10', ssid: 'IoT_Casa', band: '2.4', channel: 6, width: 20, security: 'WPA2', base: -75 },
  ];
  const positions = [
    [2.2, 2.2], [3.6, 3.4], [5.2, 4.6], [5.4, 2.6],
    [7.6, 2.0], [8.9, 3.2], [10.2, 4.7], [11.2, 2.4],
    [12.2, 1.7], [13.6, 2.3],
    [12.0, 4.4], [14.2, 3.4], [16.2, 4.6],
    [2.2, 6.6], [3.8, 7.6], [5.2, 9.2],
    [7.4, 7.2], [9.0, 8.4], [11.2, 9.4],
    [12.4, 6.4], [14.6, 7.6], [16.4, 9.1],
  ];

  const rand = (seed) => {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  };

  const points = positions.map(([x, y], index) => {
    const networks = [];
    for (const ap of aps) {
      const rssi = Math.round(rssiForAp(ap, x, y, obstacles, attenuation) + (rand(index * 9 + ap.channel) - 0.5) * 2.5);
      networks.push({
        bssid: ap.id === 'sap1' ? 'b8:27:eb:4c:11:02' : 'b8:27:eb:4c:11:05',
        ssid: ap.ssid,
        band: ap.band,
        channel: ap.channel,
        freq: channelFreq(ap.channel, ap.band),
        width: ap.band === '2.4' ? 20 : 80,
        security: 'WPA2',
        rssi,
      });
    }
    extras.forEach((extra, extraIndex) => {
      const rssi = Math.round(Math.max(-96, Math.min(-48, extra.base + (rand(index * 13 + extraIndex * 31) - 0.5) * 8)));
      networks.push({
        bssid: extra.bssid,
        ssid: extra.ssid,
        band: extra.band,
        channel: extra.channel,
        freq: channelFreq(extra.channel, extra.band),
        width: extra.width,
        security: extra.security,
        rssi,
      });
    });
    networks.sort((a, b) => b.rssi - a.rssi);
    const best = networks[0];
    return {
      id: `sp${index + 1}`,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      rssi: best.rssi,
      bestSsid: best.ssid,
      bestBssid: best.bssid,
      interference: interferenceOf(networks),
      networks,
      timestamp: Date.now() - (positions.length - index) * 45000,
    };
  });

  return {
    name: 'Escritório — Levantamento',
    width: SAMPLE_WIDTH,
    height: SAMPLE_HEIGHT,
    image: createSampleFloorplan(),
    points,
    obstacles,
    aps,
  };
}

export function samplePlanning() {
  return {
    name: 'Escritório — Planejamento',
    width: SAMPLE_WIDTH,
    height: SAMPLE_HEIGHT,
    image: createSampleFloorplan(),
    obstacles: sampleObstacles(),
    aps: sampleAps(),
  };
}
