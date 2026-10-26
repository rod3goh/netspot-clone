import { MapView } from './map.js';
import { drawSignalChart, drawChannelChart, drawSparkline, colorForBssid } from './charts.js';
import { computeSurface, surfaceToCanvas, legendColors } from './heatmap.js';
import { rssiForAp, interferenceOf, channelFreq } from './sim.js';
import { createSampleFloorplan, sampleSurveyPoints, samplePlanning } from './sample.js';

const DEFAULTS = {
  theme: 'dark',
  intervalSeconds: 5,
  units: 'm',
  goodRssi: -67,
  fairRssi: -75,
  autoStart: true,
  showHidden: true,
  lastMode: 'inspector',
};

const QUALITY_LABEL = {
  excellent: 'Excelente',
  good: 'Bom',
  fair: 'Regular',
  weak: 'Fraco',
  bad: 'Ruim',
  unknown: 'Sem sinal',
};

const BAND_LABEL = { '2.4': '2,4 GHz', '5': '5 GHz', '6': '6 GHz' };
const ADAPTER_STATE_LABEL = {
  connected: 'Conectado',
  conectado: 'Conectado',
  disconnected: 'Desconectado',
  desconectado: 'Desconectado',
  unavailable: 'Indisponível',
  unmanaged: 'Não gerenciado',
  disabled: 'Desativado',
  desconhecido: 'Desconhecido',
  unknown: 'Desconhecido',
};
const OBSTACLE_LABEL = { wall: 'Parede', door: 'Porta', window: 'Janela' };

const $ = (id) => document.getElementById(id);

const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short',
});

const state = {
  info: null,
  settings: null,
  snapshot: null,
  status: null,
  paused: false,
  view: 'inspector',
  selectedBssid: null,
  query: '',
  band: 'all',
  sort: { key: 'rssi', dir: 'desc' },
  chart: 'signal',
  chartBand: '2.4',
  apCache: new Map(),
  survey: {
    name: 'Novo levantamento',
    width: 20,
    height: 12.5,
    image: null,
    imageData: null,
    started: false,
    points: [],
    selectedId: null,
    tool: 'measure',
    metric: 'coverage',
    apBssid: null,
    min: -90,
    max: -30,
    threshold: -75,
    smooth: 2,
    isolines: false,
    showPoints: true,
    showPath: true,
    showLabels: true,
    surface: null,
    heatmap: null,
    domain: { min: -90, max: -30 },
    undo: [],
  },
  planning: {
    name: 'Novo planejamento',
    width: 18,
    height: 11.25,
    image: null,
    imageData: null,
    started: false,
    obstacles: [],
    aps: [],
    selectedKind: null,
    selectedId: null,
    tool: 'select',
    metric: 'best',
    apId: null,
    min: -90,
    max: -30,
    isolines: false,
    showObstacles: true,
    showLabels: true,
    surface: null,
    heatmap: null,
    domain: { min: -90, max: -30 },
    undo: [],
  },
};

let toastTimer = null;
let planRaf = 0;
let surveyRaf = 0;
let pointCounter = 0;
let apCounter = 0;

// ---------------------------------------------------------------------------
// generic helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function icon(name, className = '') {
  return `<svg class="${className}"><use href="#i-${name}"/></svg>`;
}

function dbm(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} dBm` : '—';
}

function pct(value) {
  return Number.isFinite(Number(value)) ? `${Math.max(0, Math.min(100, Math.round(Number(value))))}%` : '—';
}

function fmt1(value) {
  return Number.isFinite(Number(value)) ? String(Number(value).toFixed(1)).replace('.', ',') : '—';
}

function bandLabel(band) {
  return BAND_LABEL[band] || '—';
}

function widthText(width) {
  if (!width) return '—';
  if (Number(width) === 8080) return '80+80 MHz';
  return `${width} MHz`;
}

function timeText(timestamp) {
  if (!timestamp) return '—';
  try {
    return timeFormatter.format(new Date(timestamp));
  } catch {
    return '—';
  }
}

function dateTimeText(timestamp) {
  if (!timestamp) return '—';
  try {
    return dateTimeFormatter.format(new Date(timestamp));
  } catch {
    return '—';
  }
}

function slugify(text) {
  return String(text || 'projeto')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'projeto';
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function toast(message, kind = '') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast show ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, kind === 'error' ? 6000 : 3600);
}

function seedNumber(value) {
  return `p${Date.now().toString(36)}${(pointCounter += 1).toString(36)}${value ? `-${value}` : ''}`;
}

function goodThreshold() {
  return Number(state.settings?.goodRssi ?? DEFAULTS.goodRssi);
}

function fairThreshold() {
  return Number(state.settings?.fairRssi ?? DEFAULTS.fairRssi);
}

function qualityForRssi(rssi) {
  if (!Number.isFinite(Number(rssi))) return { key: 'unknown', label: QUALITY_LABEL.unknown };
  const value = Number(rssi);
  const good = goodThreshold();
  const fair = fairThreshold();
  let key = 'bad';
  if (value >= good + 8) key = 'excellent';
  else if (value >= good) key = 'good';
  else if (value >= fair) key = 'fair';
  else if (value >= fair - 8) key = 'weak';
  return { key, label: QUALITY_LABEL[key] };
}

function signalPercent(rssi) {
  if (!Number.isFinite(Number(rssi))) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(rssi) + 100) * 2)));
}

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Não foi possível abrir a imagem da planta.'));
    image.src = src;
  });
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function debounce(fn, wait = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const surveyMap = new MapView($('surveyCanvas'), { mode: 'survey', tool: 'measure' });
const planMap = new MapView($('planCanvas'), { mode: 'planning', tool: 'select' });

// ---------------------------------------------------------------------------
// inspector
// ---------------------------------------------------------------------------

function visibleAps() {
  const query = normalizeText(state.query);
  const aps = state.snapshot?.aps || [];
  return aps
    .filter((ap) => {
      if (!state.settings?.showHidden && ap.hidden) return false;
      if (state.band !== 'all' && ap.band !== state.band) return false;
      if (query) {
        const haystack = normalizeText(`${ap.ssid} ${ap.bssid} ${ap.vendor}`);
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort(compareAps);
}

function compareAps(a, b) {
  const { key, dir } = state.sort;
  const numeric = key === 'rssi' || key === 'channel' || key === 'width';
  let first = a[key];
  let second = b[key];
  if (numeric) {
    first = Number.isFinite(Number(first)) ? Number(first) : -Infinity;
    second = Number.isFinite(Number(second)) ? Number(second) : -Infinity;
  } else {
    first = normalizeText(first);
    second = normalizeText(second);
  }
  if (first < second) return dir === 'asc' ? -1 : 1;
  if (first > second) return dir === 'asc' ? 1 : -1;
  return (b.rssi ?? -999) - (a.rssi ?? -999);
}

function signalBars(quality, percent) {
  const filled = Math.max(0, Math.min(4, Math.ceil(percent / 25)));
  return `<span class="signal-bars q-${quality}">${[0, 1, 2, 3]
    .map((index) => `<i class="${index < filled ? 'on' : ''}"></i>`)
    .join('')}</span>`;
}

function rowHtml(ap) {
  const quality = qualityForRssi(ap.rssi);
  const secure = ap.security && normalizeText(ap.security) !== 'aberta';
  const percent = ap.signalPct ?? signalPercent(ap.rssi);
  const name = ap.ssid
    ? `<span class="name">${esc(ap.ssid)}</span>`
    : '<span class="name hidden-name">(oculta)</span>';
  return `<tr data-bssid="${esc(ap.bssid)}" class="${ap.bssid === state.selectedBssid ? 'selected' : ''} ${ap.stale ? 'stale' : ''}">
    <td><div class="ssid-cell">${icon(secure ? 'lock' : 'unlock', `lock ${secure ? 'secure' : ''}`)}${name}${ap.active ? `<span class="band-tag" title="Rede conectada">conectada</span>` : ''}</div></td>
    <td><span class="bssid">${esc(ap.bssid)}</span></td>
    <td><span class="vendor" title="${esc(ap.vendor || '')}">${esc(ap.vendor || '—')}</span></td>
    <td class="num"><div class="signal-cell">${signalBars(quality.key, percent)}<span class="signal-dbm">${ap.rssi != null ? ap.rssi : '—'}</span></div></td>
    <td>${ap.channel ?? '—'}</td>
    <td>${bandLabel(ap.band)}</td>
    <td>${widthText(ap.width)}</td>
    <td><span class="sec-text">${esc(ap.security || '—')}</span></td>
    <td><span class="sec-text">${esc(ap.phy || '—')}</span></td>
    <td class="spark-cell"><canvas data-spark="${esc(ap.bssid)}"></canvas></td>
  </tr>`;
}

function renderInspector() {
  const rows = visibleAps();
  const tbody = $('apTbody');
  tbody.innerHTML = rows.map(rowHtml).join('');

  document.querySelectorAll('#apTable thead th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.dir === 'asc');
  });

  const empty = $('tableEmpty');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    const snapshot = state.snapshot;
    let message = 'Verifique se o adaptador Wi-Fi está habilitado.';
    if (snapshot?.error) message = snapshot.errorHint || snapshot.error;
    else if ((snapshot?.aps || []).length) message = 'Nenhuma rede corresponde aos filtros atuais.';
    else if (!snapshot) message = 'Aguardando a primeira varredura…';
    $('emptyMessage').textContent = message;
  }

  const history = state.snapshot?.history || {};
  for (const row of rows) {
    const canvas = tbody.querySelector(`canvas[data-spark="${CSS.escape(row.bssid)}"]`);
    if (canvas) drawSparkline(canvas, history[row.bssid] || [], qualityForRssi(row.rssi).key);
  }

  updateDetails();
  updateChrome();
  if (state.view === 'inspector') drawMainChart();
}

function updateDetails() {
  const placeholder = $('detailsPlaceholder');
  const content = $('detailsContent');
  const bssid = state.selectedBssid;
  const ap = bssid ? state.apCache.get(bssid) : null;
  if (!ap) {
    placeholder.hidden = false;
    content.hidden = true;
    return;
  }
  placeholder.hidden = true;
  content.hidden = false;

  const quality = qualityForRssi(ap.rssi);
  const percent = ap.signalPct ?? signalPercent(ap.rssi);
  const history = (state.snapshot?.history?.[ap.bssid] || []).filter((point) => Number.isFinite(point.rssi));
  const values = history.map((point) => point.rssi);
  const average = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const maximum = values.length ? Math.max(...values) : null;
  const minimum = values.length ? Math.min(...values) : null;

  $('dSsid').textContent = ap.ssid || '(rede oculta)';
  $('dBssid').textContent = ap.bssid || '—';
  $('dRssi').textContent = ap.rssi != null ? ap.rssi : '—';
  $('dMeter').style.width = `${percent}%`;
  $('dMeter').style.background = quality.key === 'bad'
    ? 'var(--bad)'
    : quality.key === 'weak'
      ? 'var(--weak)'
      : quality.key === 'fair'
        ? 'var(--fair)'
        : quality.key === 'excellent'
          ? 'var(--excellent)'
          : 'var(--good)';
  $('dPct').textContent = `${percent}%`;
  $('dQuality').textContent = quality.label;
  $('dQuality').className = `quality-pill q-${quality.key}`;
  $('dQualityText').textContent = quality.label;
  $('dVendor').textContent = ap.vendor || '—';
  $('dChannel').textContent = ap.channel ? `${ap.channel} · ${ap.freq || '—'} MHz` : '—';
  $('dWidth').textContent = widthText(ap.width);
  $('dBand').textContent = bandLabel(ap.band);
  $('dSecurity').textContent = ap.security || '—';
  $('dPhy').textContent = ap.phy || '—';
  $('dStats').textContent = values.length ? `${average} / ${maximum} / ${minimum} dBm` : 'Coletando…';
  $('dSeen').textContent = `${timeText(ap.firstSeen)} — ${timeText(ap.lastSeen)}`;
  $('dRate').textContent = Array.isArray(ap.rates) ? ap.rates.join(' / ') : (ap.rates || '—');
  $('dSamples').textContent = `${ap.samples || values.length || 0} amostras`;
}

function selectAp(bssid) {
  state.selectedBssid = bssid;
  renderInspector();
}

function drawMainChart() {
  const canvas = $('mainChart');
  if (!canvas || !state.snapshot) return;
  const options = {
    aps: state.snapshot.aps || [],
    selectedBssid: state.selectedBssid,
    good: goodThreshold(),
    fair: fairThreshold(),
  };
  if (state.chart === 'channels') {
    drawChannelChart(canvas, { ...options, band: state.chartBand });
  } else {
    drawSignalChart(canvas, { ...options, history: state.snapshot.history || {} });
  }
}

// ---------------------------------------------------------------------------
// scanning chrome
// ---------------------------------------------------------------------------

function updateAdapter() {
  const snapshot = state.snapshot;
  const adapter = snapshot?.adapter;
  let name = 'Adaptador Wi-Fi';
  let detail = 'Aguardando varredura';
  let title = '';

  if (adapter) {
    name = adapter.name || adapter.description || 'Adaptador Wi-Fi';
    const parts = [];
    if (adapter.ssid) parts.push(adapter.ssid);
    if (adapter.rssi != null) parts.push(dbm(adapter.rssi));
    else if (adapter.state) parts.push(ADAPTER_STATE_LABEL[adapter.state] || adapter.state);
    if (!parts.length) parts.push('Ativo');
    detail = parts.join(' · ');
    title = [
      adapter.usbId ? `USB ${adapter.usbId}` : null,
      adapter.ifname,
      adapter.mac,
      adapter.driver ? `driver ${adapter.driver}` : null,
    ].filter(Boolean).join(' · ');
  } else if (snapshot?.error) {
    name = 'Sem adaptador';
    detail = 'Falha na varredura';
    title = snapshot.error;
  } else if (snapshot) {
    name = 'Adaptador Wi-Fi';
    detail = `${snapshot.aps?.length || 0} redes visíveis`;
  }

  $('adapterName').textContent = name;
  $('adapterState').textContent = detail;
  $('adapterChip').title = title || detail;
}

function updateChrome() {
  const snapshot = state.snapshot;
  const status = state.status || {};
  const paused = state.paused || status.running === false;
  const scanning = !!status.scanning;
  const error = snapshot?.error || status.lastError || null;
  const aps = snapshot?.aps || [];

  const indicator = $('scanIndicator');
  indicator.classList.toggle('scanning', scanning && !paused);
  indicator.classList.toggle('paused', paused);
  indicator.classList.toggle('error', !!error && !paused);

  $('scanText').textContent = error
    ? 'Falha na varredura'
    : paused
      ? 'Pausado'
      : scanning
        ? 'Varrendo…'
        : snapshot
          ? `Atualizado ${timeText(snapshot.timestamp)}`
          : 'Aguardando…';

  const dot = $('statusDot');
  dot.classList.toggle('error', !!error);
  dot.classList.toggle('paused', paused && !error);
  $('statusText').textContent = error
    ? 'Erro na varredura'
    : paused
      ? 'Varredura pausada'
      : scanning
        ? 'Varrendo…'
        : 'Pronto';
  $('statusSource').textContent = snapshot?.source || '—';
  $('statusInterval').textContent = `intervalo ${state.settings?.intervalSeconds ?? 5} s`;
  $('statusCount').textContent = `${aps.length} ${aps.length === 1 ? 'rede' : 'redes'}`;
  $('statusLast').textContent = snapshot?.timestamp ? `última ${timeText(snapshot.timestamp)}` : '—';

  const pauseUse = $('pauseBtn').querySelector('use');
  pauseUse.setAttribute('href', paused ? '#i-play' : '#i-pause');
  $('pauseBtn').title = paused ? 'Retomar varredura' : 'Pausar varredura';

  updateAdapter();
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  for (const ap of snapshot.aps || []) state.apCache.set(ap.bssid, ap);
  if (state.selectedBssid && !state.apCache.has(state.selectedBssid)) state.selectedBssid = null;

  if (snapshot.error && snapshot.error !== state.lastErrorShown) {
    state.lastErrorShown = snapshot.error;
    toast(snapshot.errorHint || snapshot.error, 'error');
  }
  if (!snapshot.error) state.lastErrorShown = null;

  renderInspector();
  if (state.view === 'survey') updateSurveyAps();
}

function applyStatus(status) {
  state.status = { ...(state.status || {}), ...status };
  if (status.running !== undefined) state.paused = !status.running;
  updateChrome();
}

// ---------------------------------------------------------------------------
// survey
// ---------------------------------------------------------------------------

function surveyValue(point) {
  const survey = state.survey;
  if (survey.metric === 'count') {
    return (point.networks || []).filter((network) => Number.isFinite(network.rssi) && network.rssi >= survey.threshold).length;
  }
  if (survey.metric === 'interference') {
    return Number.isFinite(point.interference) ? point.interference : interferenceOf(point.networks || []);
  }
  if (survey.metric === 'rssi') {
    const network = (point.networks || []).find((item) => item.bssid === survey.apBssid);
    if (!network || !Number.isFinite(network.rssi)) return NaN;
    return network.rssi;
  }
  return Number.isFinite(point.rssi) ? point.rssi : NaN;
}

function surveyDomain(points) {
  const survey = state.survey;
  if (survey.metric === 'count') {
    const max = Math.max(1, ...points.map((point) => surveyValue(point)).filter(Number.isFinite));
    return { min: 0, max };
  }
  if (survey.metric === 'interference') return { min: 0, max: 100 };
  let min = Number(survey.min);
  let max = Number(survey.max);
  if (!Number.isFinite(min)) min = -90;
  if (!Number.isFinite(max)) max = -30;
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

function pushSurveyUndo() {
  const survey = state.survey;
  survey.undo.push(JSON.stringify({ points: survey.points }));
  if (survey.undo.length > 40) survey.undo.shift();
}

function addSurveyPoint(world) {
  const networks = captureNetworks();
  if (!networks.length) {
    toast('Nenhuma rede disponível. Verifique o adaptador Wi-Fi e aguarde uma varredura.', 'error');
    return;
  }
  pushSurveyUndo();
  const best = networks[0];
  const point = {
    id: seedNumber(),
    x: Number(world.x.toFixed(3)),
    y: Number(world.y.toFixed(3)),
    rssi: best.rssi,
    bestSsid: best.ssid,
    bestBssid: best.bssid,
    networks,
    interference: interferenceOf(networks),
    timestamp: Date.now(),
  };
  state.survey.points.push(point);
  state.survey.selectedId = point.id;
  scheduleSurvey();
}

function captureNetworks() {
  const aps = (state.snapshot?.aps || [])
    .filter((ap) => Number.isFinite(ap.rssi))
    .sort((a, b) => b.rssi - a.rssi)
    .slice(0, 18);
  return aps.map((ap) => ({
    bssid: ap.bssid,
    ssid: ap.ssid,
    band: ap.band,
    channel: ap.channel,
    freq: ap.freq || channelFreq(ap.channel, ap.band),
    width: ap.width,
    security: ap.security,
    rssi: ap.rssi,
  }));
}

function removeSurveyPoint(id) {
  pushSurveyUndo();
  state.survey.points = state.survey.points.filter((point) => point.id !== id);
  if (state.survey.selectedId === id) state.survey.selectedId = null;
  scheduleSurvey();
}

function scheduleSurvey() {
  if (surveyRaf) return;
  surveyRaf = requestAnimationFrame(() => {
    surveyRaf = 0;
    recomputeSurvey();
  });
}

function recomputeSurvey() {
  const survey = state.survey;
  if (!survey.points.some((point) => point.id === survey.selectedId)) survey.selectedId = null;
  const domain = surveyDomain(survey.points);
  survey.domain = domain;

  if (!survey.points.length) {
    survey.surface = null;
    survey.heatmap = null;
    surveyMap.clearHeatmap();
    updateSurveyUi();
    return;
  }

  const surface = computeSurface({
    points: survey.points,
    valueFn: surveyValue,
    mapW: survey.width,
    mapH: survey.height,
    cell: 4,
    power: 2.1,
    smoothing: survey.smooth,
    hullMask: true,
  });
  const heatmap = surface
    ? surfaceToCanvas(surface, { min: domain.min, max: domain.max, metric: survey.metric, alpha: 0.82 })
    : null;
  survey.surface = surface;
  survey.heatmap = heatmap;

  surveyMap.setSurvey({
    points: survey.points,
    selectedId: survey.selectedId,
    min: domain.min,
    max: domain.max,
    metric: survey.metric,
    valueFn: surveyValue,
    showPoints: survey.showPoints,
    showPath: survey.showPath,
    showLabels: survey.showLabels,
  });
  surveyMap.setHeatmap({
    canvas: heatmap,
    surface,
    min: domain.min,
    max: domain.max,
    metric: survey.metric,
    isolines: survey.isolines,
    levels: 5,
  });
  updateSurveyUi();
}

function surveyStatsData() {
  const surface = state.survey.surface;
  if (!surface) return null;
  let sum = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let above = 0;
  for (let i = 0; i < surface.values.length; i++) {
    const value = surface.values[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;
    if (value >= goodThreshold()) above += 1;
  }
  if (!count) return null;
  return {
    average: sum / count,
    min,
    max,
    count,
    abovePct: Math.round((above / count) * 100),
  };
}

function updateSurveyLegend() {
  const survey = state.survey;
  const domain = survey.domain || { min: survey.min, max: survey.max };
  const colors = legendColors(survey.metric);
  const bar = $('surveyLegend').querySelector('.legend-bar');
  bar.style.background = `linear-gradient(90deg, ${colors.join(', ')})`;
  if (survey.metric === 'count') {
    $('surveyLegendMin').textContent = '0 redes';
    $('surveyLegendMid').textContent = `${Math.round(domain.max / 2)}`;
    $('surveyLegendMax').textContent = `${Math.round(domain.max)} redes`;
  } else if (survey.metric === 'interference') {
    $('surveyLegendMin').textContent = '0%';
    $('surveyLegendMid').textContent = '50%';
    $('surveyLegendMax').textContent = '100%';
  } else {
    $('surveyLegendMin').textContent = `${Math.round(domain.min)} dBm`;
    $('surveyLegendMid').textContent = `${Math.round((domain.min + domain.max) / 2)} dBm`;
    $('surveyLegendMax').textContent = `${Math.round(domain.max)} dBm`;
  }
}

function updateSurveyStats() {
  const survey = state.survey;
  const node = $('surveyStats');
  if (!survey.points.length) {
    node.textContent = 'Sem medições.';
    return;
  }
  const stats = surveyStatsData();
  if (!stats) {
    node.textContent = survey.metric === 'rssi'
      ? 'A rede selecionada não aparece nas medições deste projeto.'
      : 'Sem dados suficientes para gerar o mapa.';
    return;
  }
  const pieces = [`${survey.points.length} ${survey.points.length === 1 ? 'medição' : 'medições'}`];
  if (survey.metric === 'coverage' || survey.metric === 'rssi') {
    pieces.push(`média ${Math.round(stats.average)} dBm`);
    pieces.push(`${stats.abovePct}% da área ≥ ${goodThreshold()} dBm`);
  } else if (survey.metric === 'count') {
    pieces.push(`média ${fmt1(stats.average)} redes`);
    pieces.push(`máx. ${Math.round(stats.max)}`);
  } else {
    pieces.push(`interferência média ${Math.round(stats.average)}%`);
    pieces.push(`pico ${Math.round(stats.max)}%`);
  }
  node.textContent = pieces.join(' · ');
}

function surveyNetworkList() {
  const map = new Map();
  const hasPoints = state.survey.points.length > 0;
  if (!hasPoints) {
    for (const ap of state.snapshot?.aps || []) {
      if (!ap.bssid) continue;
      map.set(ap.bssid, {
        bssid: ap.bssid,
        ssid: ap.ssid,
        rssi: ap.rssi,
        channel: ap.channel,
        band: ap.band,
        freq: ap.freq,
      });
    }
  }
  for (const point of state.survey.points) {
    for (const network of point.networks || []) {
      const current = map.get(network.bssid);
      if (!current) {
        map.set(network.bssid, {
          bssid: network.bssid,
          ssid: network.ssid,
          rssi: network.rssi,
          channel: network.channel,
          band: network.band,
          freq: network.freq,
        });
      } else if (!Number.isFinite(current.rssi) || (Number.isFinite(network.rssi) && network.rssi > current.rssi)) {
        current.rssi = network.rssi;
        if (!current.ssid) current.ssid = network.ssid;
        if (!current.channel) current.channel = network.channel;
        if (!current.band) current.band = network.band;
      }
    }
  }
  return [...map.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}

function updateSurveyAps() {
  const survey = state.survey;
  const list = surveyNetworkList().slice(0, 40);
  const container = $('surveyApList');
  container.innerHTML = list.length
    ? list.map((network) => `<div class="ap-item ${network.bssid === survey.apBssid ? 'selected' : ''}" data-bssid="${esc(network.bssid)}">
        <span class="ap-dot" style="background:${colorForBssid(network.bssid)}"></span>
        <div class="ap-info"><strong>${esc(network.ssid || '(oculta)')}</strong><span>${esc(network.bssid)} · ${network.channel ?? '—'} · ${bandLabel(network.band)}</span></div>
        <span class="ap-value">${network.rssi != null ? `${network.rssi}` : '—'}</span>
      </div>`).join('')
    : '<div class="empty-list">Nenhuma rede capturada até agora.</div>';

  const select = $('surveyApSelect');
  const current = survey.apBssid;
  select.innerHTML = list.length
    ? list.map((network) => `<option value="${esc(network.bssid)}">${esc(network.ssid || '(oculta)')} · ${esc(network.bssid)}</option>`).join('')
    : '<option value="">Sem redes</option>';
  if (current && list.some((network) => network.bssid === current)) {
    select.value = current;
  } else if (list.length) {
    select.value = list[0].bssid;
    if (survey.metric === 'rssi') survey.apBssid = list[0].bssid;
  } else {
    survey.apBssid = null;
  }
}

function updateSurveyList() {
  const survey = state.survey;
  $('surveyPointCount').textContent = String(survey.points.length);
  $('surveyBadgePoints').textContent = `${survey.points.length} ${survey.points.length === 1 ? 'ponto' : 'pontos'}`;
  const container = $('surveyPointList');
  container.innerHTML = survey.points.length
    ? survey.points.map((point, index) => `<div class="list-item ${point.id === survey.selectedId ? 'selected' : ''}" data-point="${esc(point.id)}">
        <span class="idx">${index + 1}</span>
        <span class="li-main"><strong>${dbm(point.rssi)} · ${esc(point.bestSsid || '—')}</strong><span>${timeText(point.timestamp)} · ${point.networks?.length || 0} redes</span></span>
        <button class="li-x" data-del="${esc(point.id)}" title="Remover ponto">${icon('trash')}</button>
      </div>`).join('')
    : '<div class="empty-list">Clique no mapa para adicionar a primeira medição.</div>';
}

function updateSurveyUi() {
  const survey = state.survey;
  $('surveyProjectName').value = survey.name;
  $('surveyMapWidth').value = String(survey.width);
  $('surveyEmpty').hidden = survey.started;
  $('surveyBadgeScale').textContent = survey.started
    ? `${fmt1(survey.width)} × ${fmt1(survey.height)} m`
    : '—';
  $('surveyApSelectWrap').hidden = survey.metric !== 'rssi';
  $('surveyCountThresholdWrap').hidden = survey.metric !== 'count';
  updateSurveyList();
  updateSurveyAps();
  updateSurveyLegend();
  updateSurveyStats();
  surveyMap.setSurvey({
    selectedId: survey.selectedId,
    points: survey.points,
    min: survey.domain.min,
    max: survey.domain.max,
    metric: survey.metric,
    showPoints: survey.showPoints,
    showPath: survey.showPath,
    showLabels: survey.showLabels,
  });
  surveyMap.requestDraw();
}

function setSurveyTool(tool) {
  state.survey.tool = tool;
  document.querySelectorAll('#surveyTools button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === tool);
  });
  surveyMap.setTool(tool);
  const hints = {
    measure: 'Clique no mapa para registrar o sinal do ponto. Role para dar zoom; arraste com o botão do meio para mover.',
    select: 'Clique em um ponto para destacá-lo. Arraste o mapa com o botão do meio.',
    pan: 'Arraste para mover o mapa. Role para aproximar ou afastar.',
    erase: 'Clique em um ponto de medição para removê-lo.',
  };
  $('surveyHint').textContent = hints[tool] || hints.measure;
}

async function setSurveyImage(source, width, height, { reset = true } = {}) {
  const survey = state.survey;
  const image = await loadImage(source);
  survey.image = image;
  survey.imageData = source;
  survey.width = Number(width) || 20;
  survey.height = Number(height) || survey.width * (image.height / image.width);
  survey.started = true;
  if (reset) {
    survey.points = [];
    survey.selectedId = null;
    survey.undo = [];
    survey.surface = null;
    survey.heatmap = null;
  }
  surveyMap.setWorld(survey.width, survey.height);
  surveyMap.setImage(image, survey.width, survey.height);
  surveyMap.fit();
  updateSurveyUi();
}

async function pickSurveyMap() {
  try {
    const result = await window.api.openMap();
    if (!result) return;
    const width = Number($('surveyMapWidth').value) || 20;
    const image = await loadImage(result.dataUrl);
    const height = width * (image.height / image.width);
    await setSurveyImage(result.dataUrl, width, height, { reset: true });
    recomputeSurvey();
    toast(`Planta “${result.name}” carregada.`);
  } catch (error) {
    toast(String(error.message || error), 'error');
  }
}

async function loadSurveySample() {
  const sample = sampleSurveyPoints();
  state.survey.name = sample.name;
  state.survey.metric = 'coverage';
  state.survey.apBssid = null;
  state.survey.min = -90;
  state.survey.max = -30;
  state.survey.threshold = -75;
  state.survey.smooth = 2;
  state.survey.isolines = false;
  state.survey.showPoints = true;
  state.survey.showPath = true;
  state.survey.showLabels = true;
  $('surveyMetric').value = 'coverage';
  $('surveyMin').value = '-90';
  $('surveyMax').value = '-30';
  $('surveyThreshold').value = '-75';
  $('surveySmooth').value = '2';
  $('surveySmoothVal').textContent = '2';
  $('surveyIsolines').checked = false;
  $('surveyShowPoints').checked = true;
  $('surveyShowPath').checked = true;
  $('surveyShowAps').checked = true;
  await setSurveyImage(sample.image, sample.width, sample.height, { reset: true });
  state.survey.points = sample.points;
  state.survey.selectedId = null;
  recomputeSurvey();
  toast('Projeto de exemplo carregado. Clique no mapa para adicionar medições.');
}

function newSurvey() {
  if (state.survey.points.length && !window.confirm('Criar um novo levantamento? As medições não salvas serão perdidas.')) return;
  const survey = state.survey;
  survey.name = 'Novo levantamento';
  survey.width = 20;
  survey.height = 12.5;
  survey.image = null;
  survey.imageData = null;
  survey.started = false;
  survey.points = [];
  survey.selectedId = null;
  survey.metric = 'coverage';
  survey.apBssid = null;
  survey.surface = null;
  survey.heatmap = null;
  survey.domain = { min: -90, max: -30 };
  survey.undo = [];
  surveyMap.clearHeatmap();
  surveyMap.setImage(null, 20, 12.5);
  surveyMap.setWorld(20, 12.5);
  surveyMap.fit();
  $('surveyMetric').value = 'coverage';
  updateSurveyUi();
}

function surveyProjectJson() {
  const survey = state.survey;
  return JSON.stringify({
    app: 'NetSpot Clone',
    format: 'survey',
    version: 1,
    name: survey.name,
    createdAt: new Date().toISOString(),
    map: { width: survey.width, height: survey.height, image: survey.imageData },
    points: survey.points,
    view: {
      metric: survey.metric,
      apBssid: survey.apBssid,
      min: survey.min,
      max: survey.max,
      threshold: survey.threshold,
      smooth: survey.smooth,
      isolines: survey.isolines,
      showPoints: survey.showPoints,
      showPath: survey.showPath,
      showLabels: survey.showLabels,
    },
  }, null, 2);
}

async function saveSurvey() {
  try {
    const result = await window.api.saveProject({
      json: surveyProjectJson(),
      suggestedName: `${slugify(state.survey.name)}.nspc`,
    });
    if (result) toast(`Projeto salvo em ${result.path}`);
  } catch (error) {
    toast(`Falha ao salvar: ${error.message || error}`, 'error');
  }
}

async function openSurvey() {
  try {
    const result = await window.api.openProject();
    if (!result) return;
    const data = JSON.parse(result.json);
    if (data.format !== 'survey' || !Array.isArray(data.points)) {
      toast('Este arquivo não é um projeto de levantamento.', 'error');
      return;
    }
    const survey = state.survey;
    survey.name = data.name || 'Levantamento importado';
    survey.points = data.points.map((point, index) => ({
      ...point,
      id: point.id || `import-${index + 1}`,
      networks: Array.isArray(point.networks) ? point.networks : [],
    }));
    survey.selectedId = null;
    survey.undo = [];
    survey.min = Number(data.view?.min ?? -90);
    survey.max = Number(data.view?.max ?? -30);
    survey.threshold = Number(data.view?.threshold ?? -75);
    survey.smooth = Number(data.view?.smooth ?? 2);
    survey.metric = data.view?.metric || 'coverage';
    survey.apBssid = data.view?.apBssid || null;
    survey.isolines = !!data.view?.isolines;
    survey.showPoints = data.view?.showPoints !== false;
    survey.showPath = data.view?.showPath !== false;
    survey.showLabels = data.view?.showLabels !== false;
    $('surveyMetric').value = survey.metric;
    $('surveyMin').value = String(survey.min);
    $('surveyMax').value = String(survey.max);
    $('surveyThreshold').value = String(survey.threshold);
    $('surveySmooth').value = String(survey.smooth);
    $('surveySmoothVal').textContent = String(survey.smooth);
    $('surveyIsolines').checked = survey.isolines;
    $('surveyShowPoints').checked = survey.showPoints;
    $('surveyShowPath').checked = survey.showPath;
    $('surveyShowAps').checked = survey.showLabels;
    const mapWidth = Number(data.map?.width) || 20;
    if (data.map?.image) {
      const image = await loadImage(data.map.image);
      const mapHeight = Number(data.map.height) || mapWidth * (image.height / image.width);
      await setSurveyImage(data.map.image, mapWidth, mapHeight, { reset: false });
    } else {
      survey.image = null;
      survey.imageData = null;
      survey.started = false;
      survey.width = mapWidth;
      survey.height = Number(data.map?.height) || mapWidth * 0.625;
      surveyMap.setImage(null, survey.width, survey.height);
      surveyMap.setWorld(survey.width, survey.height);
      surveyMap.fit();
    }
    recomputeSurvey();
    toast(`Projeto “${survey.name}” aberto.`);
  } catch (error) {
    toast(`Falha ao abrir: ${error.message || error}`, 'error');
  }
}

function undoSurvey() {
  const survey = state.survey;
  const previous = survey.undo.pop();
  if (!previous) {
    toast('Nada para desfazer.');
    return;
  }
  try {
    const data = JSON.parse(previous);
    survey.points = data.points || [];
    survey.selectedId = null;
    recomputeSurvey();
    toast('Ação desfeita.');
  } catch {
    toast('Não foi possível desfazer.', 'error');
  }
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

function planAttenuation() {
  return {
    wall: Number($('attWall').value) || 7,
    door: Number($('attDoor').value) || 2,
    window: Number($('attWindow').value) || 3,
  };
}

function pushPlanUndo() {
  const plan = state.planning;
  plan.undo.push(JSON.stringify({ obstacles: plan.obstacles, aps: plan.aps }));
  if (plan.undo.length > 40) plan.undo.shift();
}

function planDomain() {
  const plan = state.planning;
  let min = Number(plan.min);
  let max = Number(plan.max);
  if (!Number.isFinite(min)) min = -90;
  if (!Number.isFinite(max)) max = -30;
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

function planCoverageSurface() {
  const plan = state.planning;
  if (!plan.aps.length) return null;
  const selected = plan.metric === 'ap' ? plan.apId : null;
  if (plan.metric === 'ap' && !selected) return null;
  const cols = 240;
  const rows = Math.max(24, Math.min(620, Math.round((cols * plan.height) / plan.width)));
  const cellX = plan.width / cols;
  const cellY = plan.height / rows;
  const values = new Float32Array(cols * rows).fill(NaN);
  const attenuation = planAttenuation();
  let min = Infinity;
  let max = -Infinity;

  for (let row = 0; row < rows; row++) {
    const y = (row + 0.5) * cellY;
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cellX;
      let best = -Infinity;
      for (const ap of plan.aps) {
        if (selected && ap.id !== selected) continue;
        const value = rssiForAp(ap, x, y, plan.obstacles, attenuation);
        if (value > best) best = value;
      }
      if (!Number.isFinite(best)) continue;
      const index = row * cols + col;
      values[index] = best;
      if (best < min) min = best;
      if (best > max) max = best;
    }
  }
  if (!Number.isFinite(min)) return null;
  return {
    cols,
    rows,
    cellX,
    cellY,
    mapW: plan.width,
    mapH: plan.height,
    values,
    min,
    max,
    points: [],
  };
}

function planStatsData(surface) {
  if (!surface) return null;
  let sum = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let above = 0;
  for (let i = 0; i < surface.values.length; i++) {
    const value = surface.values[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;
    if (value >= goodThreshold()) above += 1;
  }
  if (!count) return null;
  return { average: sum / count, min, max, count, abovePct: Math.round((above / count) * 100) };
}

function recomputePlanning() {
  const plan = state.planning;
  const domain = planDomain();
  plan.domain = domain;

  const surface = planCoverageSurface();
  const heatmap = surface
    ? surfaceToCanvas(surface, { min: domain.min, max: domain.max, metric: 'coverage', alpha: 0.82 })
    : null;
  plan.surface = surface;
  plan.heatmap = heatmap;

  planMap.setPlanning({
    obstacles: plan.obstacles,
    aps: plan.aps,
    selectedKind: plan.selectedKind,
    selectedId: plan.selectedId,
    showObstacles: plan.showObstacles,
    showLabels: plan.showLabels,
    min: domain.min,
    max: domain.max,
  });
  planMap.setHeatmap({
    canvas: heatmap,
    surface,
    min: domain.min,
    max: domain.max,
    metric: 'coverage',
    isolines: plan.isolines,
    levels: 4,
  });
  updatePlanningUi();
}

function schedulePlanning() {
  if (planRaf) return;
  planRaf = requestAnimationFrame(() => {
    planRaf = 0;
    recomputePlanning();
  });
}

function updatePlanEditor() {
  const plan = state.planning;
  const editor = $('planApEditor');
  const ap = plan.selectedKind === 'ap' ? plan.aps.find((item) => item.id === plan.selectedId) : null;
  if (!ap) {
    editor.hidden = true;
    return;
  }
  editor.hidden = false;
  $('planApSsid').value = ap.ssid || '';
  $('planApBand').value = ap.band || '5';
  $('planApChannel').value = String(ap.channel ?? 36);
  $('planApPower').value = String(ap.power ?? 20);
  $('planApPowerVal').textContent = `${ap.power ?? 20} dBm`;
}

function updatePlanLists() {
  const plan = state.planning;
  $('planWallCount').textContent = String(plan.obstacles.length);
  $('planBadgeAps').textContent = `${plan.aps.length} ${plan.aps.length === 1 ? 'AP' : 'APs'}`;
  $('planBadgeWalls').textContent = `${plan.obstacles.length} ${plan.obstacles.length === 1 ? 'obstáculo' : 'obstáculos'}`;

  const objectList = $('planObjectList');
  objectList.innerHTML = plan.obstacles.length
    ? plan.obstacles.map((obstacle, index) => {
      const length = Math.hypot(obstacle.x2 - obstacle.x1, obstacle.y2 - obstacle.y1);
      const selected = plan.selectedKind === 'obstacle' && plan.selectedId === obstacle.id;
      return `<div class="list-item ${selected ? 'selected' : ''}" data-obstacle="${esc(obstacle.id)}">
        <span class="idx">${index + 1}</span>
        <span class="li-main"><strong>${OBSTACLE_LABEL[obstacle.type] || obstacle.type}</strong><span>${fmt1(length)} m · ${planAttenuation()[obstacle.type] ?? 0} dB</span></span>
        <button class="li-x" data-odel="${esc(obstacle.id)}" title="Remover">${icon('trash')}</button>
      </div>`;
    }).join('')
    : '<div class="empty-list">Nenhum obstáculo. Desenhe paredes, portas e janelas.</div>';

  const apList = $('planApList');
  apList.innerHTML = plan.aps.length
    ? plan.aps.map((ap) => `<div class="ap-item ${ap.id === plan.apId ? 'selected' : ''}" data-ap="${esc(ap.id)}">
        <span class="ap-dot" style="background:${colorForBssid(ap.id + ap.ssid)}"></span>
        <div class="ap-info"><strong>${esc(ap.ssid || 'Ponto de acesso')}</strong><span>Canal ${ap.channel ?? '—'} · ${bandLabel(ap.band)} · ${ap.power ?? 20} dBm</span></div>
      </div>`).join('')
    : '<div class="empty-list">Nenhum AP. Use a ferramenta AP ou o botão abaixo.</div>';

  const select = $('planApSelect');
  select.innerHTML = plan.aps.length
    ? plan.aps.map((ap) => `<option value="${esc(ap.id)}">${esc(ap.ssid || 'Ponto de acesso')}</option>`).join('')
    : '<option value="">Sem APs</option>';
  if (plan.apId && plan.aps.some((ap) => ap.id === plan.apId)) select.value = plan.apId;
  else if (plan.aps.length) {
    select.value = plan.aps[0].id;
    if (!plan.apId) plan.apId = plan.aps[0].id;
  } else {
    plan.apId = null;
  }
  $('planApSelectWrap').hidden = plan.metric !== 'ap';
}

function updatePlanStats() {
  const plan = state.planning;
  const node = $('planStats');
  if (!plan.aps.length) {
    node.textContent = 'Adicione um AP para simular a cobertura.';
    return;
  }
  const stats = planStatsData(plan.surface);
  if (!stats) {
    node.textContent = 'Sem cobertura calculada para a seleção atual.';
    return;
  }
  const metric = plan.metric === 'ap'
    ? plan.aps.find((ap) => ap.id === plan.apId)?.ssid || 'AP selecionado'
    : 'melhor cobertura';
  node.textContent = `${metric}: média ${Math.round(stats.average)} dBm · ${stats.abovePct}% da área ≥ ${goodThreshold()} dBm · pior ponto ${Math.round(stats.min)} dBm`;
}

function updatePlanningUi() {
  const plan = state.planning;
  $('planProjectName').value = plan.name;
  $('planMapWidth').value = String(plan.width);
  $('planEmpty').hidden = plan.started;
  $('planBadgeZoom').textContent = `${planMap.zoomPercent}%`;
  $('planMetric').value = plan.metric;
  updatePlanLists();
  updatePlanEditor();
  updatePlanStats();

  const domain = plan.domain || planDomain();
  $('planLegendMin').textContent = `${Math.round(domain.min)} dBm`;
  $('planLegendMid').textContent = `${Math.round((domain.min + domain.max) / 2)} dBm`;
  $('planLegendMax').textContent = `${Math.round(domain.max)} dBm`;
}

function setPlanTool(tool) {
  state.planning.tool = tool;
  document.querySelectorAll('#planTools button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === tool);
  });
  planMap.setTool(tool);
  const hints = {
    select: 'Clique em um AP para selecioná-lo e arraste para reposicionar. Clique em uma parede para inspecioná-la.',
    wall: 'Arraste no mapa para desenhar uma parede. Cada travessia adiciona a atenuação configurada.',
    door: 'Arraste sobre um vão para marcar uma porta (menor atenuação).',
    window: 'Arraste sobre uma janela para marcar o obstáculo correspondente.',
    ap: 'Clique no mapa para posicionar um ponto de acesso.',
    pan: 'Arraste para mover o mapa. Role para aproximar ou afastar.',
  };
  $('planHint').textContent = hints[tool] || hints.select;
}

function selectPlanAp(id) {
  const plan = state.planning;
  plan.selectedKind = id ? 'ap' : null;
  plan.selectedId = id;
  if (id) plan.apId = id;
  updatePlanEditor();
  updatePlanLists();
  planMap.setPlanning({ selectedKind: plan.selectedKind, selectedId: plan.selectedId });
  planMap.requestDraw();
  if (plan.metric === 'ap') schedulePlanning();
}

function selectPlanObstacle(id) {
  const plan = state.planning;
  plan.selectedKind = id ? 'obstacle' : null;
  plan.selectedId = id;
  updatePlanEditor();
  updatePlanLists();
  planMap.setPlanning({ selectedKind: plan.selectedKind, selectedId: plan.selectedId });
  planMap.requestDraw();
}

function addPlanApAt(x, y) {
  const plan = state.planning;
  pushPlanUndo();
  apCounter += 1;
  const ap = {
    id: `ap-${Date.now().toString(36)}-${apCounter}`,
    ssid: `AP ${plan.aps.length + 1}`,
    band: '5',
    channel: 36,
    power: 20,
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
  };
  plan.aps.push(ap);
  plan.selectedKind = 'ap';
  plan.selectedId = ap.id;
  plan.apId = ap.id;
  if (plan.metric === 'ap') $('planMetric').value = 'ap';
  schedulePlanning();
}

function addPlanObstacle(draft) {
  const plan = state.planning;
  pushPlanUndo();
  const obstacle = {
    id: `ob-${Date.now().toString(36)}-${Math.round(draft.x1 * 10)}-${Math.round(draft.y1 * 10)}`,
    type: draft.type,
    x1: Number(draft.x1.toFixed(3)),
    y1: Number(draft.y1.toFixed(3)),
    x2: Number(draft.x2.toFixed(3)),
    y2: Number(draft.y2.toFixed(3)),
  };
  plan.obstacles.push(obstacle);
  plan.selectedKind = 'obstacle';
  plan.selectedId = obstacle.id;
  schedulePlanning();
}

function deletePlanObstacle(id) {
  const plan = state.planning;
  pushPlanUndo();
  plan.obstacles = plan.obstacles.filter((obstacle) => obstacle.id !== id);
  if (plan.selectedId === id) {
    plan.selectedId = null;
    plan.selectedKind = null;
  }
  schedulePlanning();
}

function deleteSelectedPlanAp() {
  const plan = state.planning;
  const ap = plan.aps.find((item) => item.id === plan.selectedId);
  if (!ap) return;
  pushPlanUndo();
  plan.aps = plan.aps.filter((item) => item.id !== ap.id);
  if (plan.apId === ap.id) plan.apId = plan.aps[0]?.id || null;
  plan.selectedKind = null;
  plan.selectedId = null;
  schedulePlanning();
}

function defaultChannelForBand(band) {
  if (band === '2.4') return 6;
  if (band === '6') return 37;
  return 36;
}

async function setPlanImage(source, width, height, { reset = true } = {}) {
  const plan = state.planning;
  const image = await loadImage(source);
  plan.image = image;
  plan.imageData = source;
  plan.width = Number(width) || 18;
  plan.height = Number(height) || plan.width * (image.height / image.width);
  plan.started = true;
  if (reset) {
    plan.obstacles = [];
    plan.aps = [];
    plan.selectedKind = null;
    plan.selectedId = null;
    plan.apId = null;
    plan.undo = [];
    plan.surface = null;
    plan.heatmap = null;
  }
  planMap.setWorld(plan.width, plan.height);
  planMap.setImage(image, plan.width, plan.height);
  planMap.fit();
  updatePlanningUi();
}

async function pickPlanMap() {
  try {
    const result = await window.api.openMap();
    if (!result) return;
    const width = Number($('planMapWidth').value) || 18;
    const image = await loadImage(result.dataUrl);
    const height = width * (image.height / image.width);
    await setPlanImage(result.dataUrl, width, height, { reset: true });
    recomputePlanning();
    toast(`Planta “${result.name}” carregada.`);
  } catch (error) {
    toast(String(error.message || error), 'error');
  }
}

async function loadPlanSample() {
  const sample = samplePlanning();
  state.planning.name = sample.name;
  state.planning.metric = 'best';
  state.planning.apId = sample.aps[0]?.id || null;
  state.planning.min = -90;
  state.planning.max = -30;
  state.planning.isolines = false;
  state.planning.showObstacles = true;
  state.planning.showLabels = true;
  $('planMetric').value = 'best';
  $('planMin').value = '-90';
  $('planMax').value = '-30';
  $('planIsolines').checked = false;
  $('planWallsVisible').checked = true;
  $('planLabels').checked = true;
  await setPlanImage(sample.image, sample.width, sample.height, { reset: true });
  state.planning.obstacles = sample.obstacles;
  state.planning.aps = sample.aps;
  state.planning.started = true;
  recomputePlanning();
  planMap.fit();
  toast('Projeto de exemplo carregado. Arraste os APs para simular mudanças.');
}

function startPlanFromZero() {
  const plan = state.planning;
  plan.name = 'Novo planejamento';
  plan.width = 18;
  plan.height = 11.25;
  plan.image = null;
  plan.imageData = null;
  plan.started = true;
  plan.obstacles = [];
  plan.aps = [];
  plan.selectedKind = null;
  plan.selectedId = null;
  plan.apId = null;
  plan.surface = null;
  plan.heatmap = null;
  plan.undo = [];
  planMap.clearHeatmap();
  planMap.setImage(null, plan.width, plan.height);
  planMap.setWorld(plan.width, plan.height);
  planMap.fit();
  recomputePlanning();
}

function newPlan() {
  if ((state.planning.obstacles.length || state.planning.aps.length)
    && !window.confirm('Criar um novo planejamento? As alterações não salvas serão perdidas.')) return;
  const plan = state.planning;
  plan.name = 'Novo planejamento';
  plan.width = 18;
  plan.height = 11.25;
  plan.image = null;
  plan.imageData = null;
  plan.started = false;
  plan.obstacles = [];
  plan.aps = [];
  plan.selectedKind = null;
  plan.selectedId = null;
  plan.apId = null;
  plan.surface = null;
  plan.heatmap = null;
  plan.undo = [];
  state.planning.metric = 'best';
  $('planMetric').value = 'best';
  planMap.clearHeatmap();
  planMap.setImage(null, plan.width, plan.height);
  planMap.setWorld(plan.width, plan.height);
  planMap.fit();
  updatePlanningUi();
}

function planProjectJson() {
  const plan = state.planning;
  return JSON.stringify({
    app: 'NetSpot Clone',
    format: 'planning',
    version: 1,
    name: plan.name,
    createdAt: new Date().toISOString(),
    map: { width: plan.width, height: plan.height, image: plan.imageData },
    obstacles: plan.obstacles,
    aps: plan.aps,
    attenuation: planAttenuation(),
    view: {
      metric: plan.metric,
      apId: plan.apId,
      min: plan.min,
      max: plan.max,
      isolines: plan.isolines,
      showObstacles: plan.showObstacles,
      showLabels: plan.showLabels,
    },
  }, null, 2);
}

async function savePlan() {
  try {
    const result = await window.api.saveProject({
      json: planProjectJson(),
      suggestedName: `${slugify(state.planning.name)}.nspc`,
    });
    if (result) toast(`Projeto salvo em ${result.path}`);
  } catch (error) {
    toast(`Falha ao salvar: ${error.message || error}`, 'error');
  }
}

async function openPlan() {
  try {
    const result = await window.api.openProject();
    if (!result) return;
    const data = JSON.parse(result.json);
    if (data.format !== 'planning' || !Array.isArray(data.aps) || !Array.isArray(data.obstacles)) {
      toast('Este arquivo não é um projeto de planejamento.', 'error');
      return;
    }
    const plan = state.planning;
    plan.name = data.name || 'Planejamento importado';
    plan.obstacles = data.obstacles;
    plan.aps = data.aps;
    plan.selectedKind = null;
    plan.selectedId = null;
    plan.apId = data.view?.apId || plan.aps[0]?.id || null;
    plan.metric = data.view?.metric || 'best';
    plan.min = Number(data.view?.min ?? -90);
    plan.max = Number(data.view?.max ?? -30);
    plan.isolines = !!data.view?.isolines;
    plan.showObstacles = data.view?.showObstacles !== false;
    plan.showLabels = data.view?.showLabels !== false;
    plan.undo = [];
    const attenuation = data.attenuation || {};
    $('attWall').value = String(attenuation.wall ?? 7);
    $('attDoor').value = String(attenuation.door ?? 2);
    $('attWindow').value = String(attenuation.window ?? 3);
    $('planMetric').value = plan.metric;
    $('planMin').value = String(plan.min);
    $('planMax').value = String(plan.max);
    $('planIsolines').checked = plan.isolines;
    $('planWallsVisible').checked = plan.showObstacles;
    $('planLabels').checked = plan.showLabels;
    const mapWidth = Number(data.map?.width) || 18;
    if (data.map?.image) {
      const image = await loadImage(data.map.image);
      const mapHeight = Number(data.map.height) || mapWidth * (image.height / image.width);
      await setPlanImage(data.map.image, mapWidth, mapHeight, { reset: false });
    } else {
      plan.image = null;
      plan.imageData = null;
      plan.started = true;
      plan.width = mapWidth;
      plan.height = Number(data.map?.height) || mapWidth * 0.625;
      planMap.setImage(null, plan.width, plan.height);
      planMap.setWorld(plan.width, plan.height);
      planMap.fit();
    }
    recomputePlanning();
    toast(`Projeto “${plan.name}” aberto.`);
  } catch (error) {
    toast(`Falha ao abrir: ${error.message || error}`, 'error');
  }
}

function undoPlan() {
  const plan = state.planning;
  const previous = plan.undo.pop();
  if (!previous) {
    toast('Nada para desfazer.');
    return;
  }
  try {
    const data = JSON.parse(previous);
    plan.obstacles = data.obstacles || [];
    plan.aps = data.aps || [];
    plan.selectedKind = null;
    plan.selectedId = null;
    if (!plan.aps.some((ap) => ap.id === plan.apId)) plan.apId = plan.aps[0]?.id || null;
    recomputePlanning();
    toast('Ação desfeita.');
  } catch {
    toast('Não foi possível desfazer.', 'error');
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

function surveyCsvText(survey = state.survey) {
  const rows = [[
    'ponto', 'x_m', 'y_m', 'ssid', 'bssid', 'canal', 'faixa',
    'rssi_dbm', 'largura_mhz', 'seguranca',
  ]];
  survey.points.forEach((point, index) => {
    const networks = point.networks?.length ? point.networks : [{}];
    for (const network of networks) {
      rows.push([
        index + 1,
        point.x,
        point.y,
        network.ssid || '',
        network.bssid || '',
        network.channel ?? '',
        network.band || '',
        network.rssi ?? '',
        network.width ?? '',
        network.security || '',
      ]);
    }
  });
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}`;
}

async function exportSurveyCsv() {
  const survey = state.survey;
  if (!survey.points.length) {
    toast('Adicione medições antes de exportar.', 'error');
    return;
  }
  const text = surveyCsvText(survey);
  try {
    const result = await window.api.saveText({
      text,
      suggestedName: `levantamento-${slugify(survey.name)}-${stamp()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result) toast(`CSV salvo em ${result.path}`);
  } catch (error) {
    toast(`Falha ao exportar: ${error.message || error}`, 'error');
  }
}

async function exportSurveyPng() {
  if (!state.survey.points.length) {
    toast('Adicione medições antes de exportar.', 'error');
    return;
  }
  try {
    const result = await window.api.saveDataUrl({
      dataUrl: surveyMap.exportDataUrl(),
      suggestedName: `mapa-calor-${slugify(state.survey.name)}-${stamp()}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (result) toast(`PNG salvo em ${result.path}`);
  } catch (error) {
    toast(`Falha ao exportar: ${error.message || error}`, 'error');
  }
}

function reportHtml() {
  const survey = state.survey;
  const stats = surveyStatsData();
  const mapImage = surveyMap.exportDataUrl();
  const networks = surveyNetworkList();
  const created = dateTimeFormatter.format(new Date());

  const pointRows = survey.points.map((point, index) => `<tr>
    <td>${index + 1}</td>
    <td>${fmt1(point.x)} m</td>
    <td>${fmt1(point.y)} m</td>
    <td>${dbm(point.rssi)}</td>
    <td>${esc(point.bestSsid || '—')}</td>
    <td>${(point.networks || []).filter((network) => network.rssi >= survey.threshold).length}</td>
    <td>${Number.isFinite(point.interference) ? `${point.interference}%` : '—'}</td>
  </tr>`).join('');

  const networkRows = networks.map((network) => `<tr>
    <td>${esc(network.ssid || '(oculta)')}</td>
    <td class="mono">${esc(network.bssid)}</td>
    <td>${network.channel ?? '—'}</td>
    <td>${bandLabel(network.band)}</td>
    <td>${dbm(network.rssi)}</td>
  </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Relatório — ${esc(survey.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 34px 38px; font-family: "Segoe UI", Arial, sans-serif; color: #1b2738; background: #fff; font-size: 11px; }
  h1 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
  h2 { margin: 26px 0 10px; font-size: 14px; color: #1e3a5f; }
  .head { display: flex; justify-content: space-between; gap: 20px; border-bottom: 3px solid #2563eb; padding-bottom: 14px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .mark { width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(140deg,#2563eb,#22d3ee); }
  .muted { color: #66788f; }
  .meta { text-align: right; font-size: 10px; color: #66788f; line-height: 1.6; }
  .cards { display: flex; gap: 10px; margin-top: 16px; }
  .card { flex: 1; border: 1px solid #dbe4f0; border-radius: 8px; padding: 10px 12px; background: #f8fafd; }
  .card span { display: block; text-transform: uppercase; letter-spacing: .07em; font-size: 8.5px; color: #7b8aa0; font-weight: 600; }
  .card strong { font-size: 17px; color: #122033; }
  .map { width: 100%; border: 1px solid #dbe4f0; border-radius: 8px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; background: #eef3fa; color: #42556d; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; padding: 6px 7px; border-bottom: 1px solid #d7e0ed; }
  td { padding: 5px 7px; border-bottom: 1px solid #e8eef6; }
  tr:nth-child(even) td { background: #fafcff; }
  .mono { font-family: Consolas, monospace; font-size: 9.5px; }
  .footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e0e7f1; font-size: 8.5px; color: #8b99ac; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 999px; background: #e8f7f1; color: #047857; font-weight: 600; }
  @page { size: A4; margin: 12mm; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand"><div class="mark"></div><div><strong style="font-size:17px">NetSpot Clone</strong><div class="muted">Analisador e planejador Wi-Fi</div></div></div>
      <h1 style="margin-top:14px">${esc(survey.name)}</h1>
      <div class="muted">Relatório de levantamento de cobertura</div>
    </div>
    <div class="meta">
      Gerado em ${esc(created)}<br>
      ${survey.points.length} pontos de medição<br>
      Área: ${fmt1(survey.width)} × ${fmt1(survey.height)} m<br>
      Faixa de cores: ${Math.round(survey.domain.min)} a ${Math.round(survey.domain.max)} dBm
    </div>
  </div>

  <div class="cards">
    <div class="card"><span>Sinal médio</span><strong>${stats ? `${Math.round(stats.average)} dBm` : '—'}</strong></div>
    <div class="card"><span>Área acima de ${goodThreshold()} dBm</span><strong>${stats ? `${stats.abovePct}%` : '—'}</strong></div>
    <div class="card"><span>Melhor / pior</span><strong>${stats ? `${Math.round(stats.max)} / ${Math.round(stats.min)}` : '—'}</strong></div>
    <div class="card"><span>Redes detectadas</span><strong>${networks.length}</strong></div>
  </div>

  <h2>Mapa de calor</h2>
  <img class="map" src="${mapImage}" alt="Mapa de calor da cobertura">

  <h2>Medições</h2>
  <table>
    <thead><tr><th>#</th><th>X</th><th>Y</th><th>Melhor sinal</th><th>Melhor rede</th><th>Redes ≥ limite</th><th>Interferência</th></tr></thead>
    <tbody>${pointRows}</tbody>
  </table>

  <h2>Redes detectadas</h2>
  <table>
    <thead><tr><th>SSID</th><th>BSSID</th><th>Canal</th><th>Faixa</th><th>Sinal</th></tr></thead>
    <tbody>${networkRows || '<tr><td colspan="5" class="muted">Nenhuma rede registrada.</td></tr>'}</tbody>
  </table>

  <div class="footer">
    Relatório gerado pelo NetSpot Clone — reimplementação independente para Windows e Linux. Este documento não é afiliado, endossado ou distribuído pela Etwok Inc.
    Valores de sinal são medições do adaptador Wi-Fi local e podem variar conforme hardware, orientação e obstáculos.
  </div>
</body>
</html>`;
}

async function exportSurveyPdf() {
  if (!state.survey.points.length) {
    toast('Adicione medições antes de exportar.', 'error');
    return;
  }
  try {
    const result = await window.api.saveReport({
      html: reportHtml(),
      suggestedName: `relatorio-${slugify(state.survey.name)}-${stamp()}.pdf`,
    });
    if (result) toast(`PDF salvo em ${result.path}`);
  } catch (error) {
    toast(`Falha ao gerar o PDF: ${error.message || error}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// settings and about
// ---------------------------------------------------------------------------

function applyTheme() {
  document.body.dataset.theme = state.settings?.theme === 'light' ? 'light' : 'dark';
  surveyMap.requestDraw();
  planMap.requestDraw();
  if (state.view === 'inspector') drawMainChart();
}

function fillSettingsForm() {
  const settings = state.settings || DEFAULTS;
  $('setInterval').value = String(settings.intervalSeconds || 5);
  $('setAutoStart').checked = settings.autoStart !== false;
  $('setTheme').value = settings.theme === 'light' ? 'light' : 'dark';
  $('setUnits').value = settings.units === 'ft' ? 'ft' : 'm';
  $('setGood').value = String(settings.goodRssi ?? -67);
  $('setFair').value = String(settings.fairRssi ?? -75);
  $('setHidden').checked = settings.showHidden !== false;
}

async function applySettingsFromDialog() {
  const patch = {
    intervalSeconds: Math.max(2, Number($('setInterval').value) || 5),
    autoStart: $('setAutoStart').checked,
    theme: $('setTheme').value === 'light' ? 'light' : 'dark',
    units: $('setUnits').value === 'ft' ? 'ft' : 'm',
    goodRssi: Number($('setGood').value) || -67,
    fairRssi: Number($('setFair').value) || -75,
    showHidden: $('setHidden').checked,
  };
  try {
    state.settings = { ...(state.settings || DEFAULTS), ...(await window.api.settings.set(patch)) };
    applyTheme();
    surveyMap.setUnits(state.settings.units);
    planMap.setUnits(state.settings.units);
    if (state.view === 'inspector') renderInspector();
    updateChrome();
    scheduleSurvey();
    schedulePlanning();
    toast('Configurações aplicadas.');
  } catch (error) {
    toast(`Falha ao salvar configurações: ${error.message || error}`, 'error');
  }
}

function showAbout() {
  const info = state.info || {};
  $('aboutVersion').textContent = `versão ${info.version || '1.0.0'}`;
  $('aboutElectron').textContent = info.electron || '—';
  $('aboutChrome').textContent = info.chrome || '—';
  $('aboutNode').textContent = info.node || '—';
  $('aboutPlatform').textContent = [info.platform, info.arch].filter(Boolean).join(' / ') || '—';
  openDialog($('aboutDialog'));
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

// ---------------------------------------------------------------------------
// view switching and shortcuts
// ---------------------------------------------------------------------------

async function switchView(view, { persist = true } = {}) {
  const modes = ['inspector', 'survey', 'planning'];
  if (!modes.includes(view)) return;
  state.view = view;
  document.querySelectorAll('#modeTabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === view);
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.id === `view-${view}`);
  });
  if (view === 'inspector') {
    requestAnimationFrame(() => {
      renderInspector();
      drawMainChart();
    });
  } else if (view === 'survey') {
    surveyMap.resize();
    setTimeout(() => {
      surveyMap.resize();
      if (!surveyMap._initialized) surveyMap.fit();
      surveyMap.requestDraw();
    }, 40);
  } else {
    planMap.resize();
    setTimeout(() => {
      planMap.resize();
      if (!planMap._initialized) planMap.fit();
      planMap.requestDraw();
    }, 40);
  }
  if (persist && state.settings) {
    state.settings.lastMode = view;
    window.api.settings.set({ lastMode: view }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// event wiring
// ---------------------------------------------------------------------------

function wireInspector() {
  $('netSearch').addEventListener('input', debounce((event) => {
    state.query = event.target.value;
    renderInspector();
  }, 90));

  $('bandChips').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-band]');
    if (!button) return;
    state.band = button.dataset.band;
    document.querySelectorAll('#bandChips button').forEach((chip) => {
      chip.classList.toggle('active', chip === button);
    });
    renderInspector();
  });

  $('apTable').querySelector('thead').addEventListener('click', (event) => {
    const th = event.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.sort.key = key;
      state.sort.dir = key === 'rssi' || key === 'channel' || key === 'width' ? 'desc' : 'asc';
    }
    renderInspector();
  });

  $('apTbody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-bssid]');
    if (!row) return;
    selectAp(row.dataset.bssid);
  });

  $('apTbody').addEventListener('dblclick', (event) => {
    const row = event.target.closest('tr[data-bssid]');
    if (!row) return;
    selectAp(row.dataset.bssid);
    useSelectedInSurvey();
  });

  $('chartTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-chart]');
    if (!button) return;
    state.chart = button.dataset.chart;
    document.querySelectorAll('#chartTabs button').forEach((tab) => {
      tab.classList.toggle('active', tab === button);
    });
    $('channelBands').hidden = state.chart !== 'channels';
    drawMainChart();
  });

  $('channelBands').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-cband]');
    if (!button) return;
    state.chartBand = button.dataset.cband;
    document.querySelectorAll('#channelBands button').forEach((tab) => {
      tab.classList.toggle('active', tab === button);
    });
    drawMainChart();
  });

  $('detailCopy').addEventListener('click', async () => {
    const bssid = state.selectedBssid;
    if (!bssid) return;
    try {
      await navigator.clipboard.writeText(bssid);
      toast('BSSID copiado.');
    } catch {
      const area = document.createElement('textarea');
      area.value = bssid;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('BSSID copiado.');
    }
  });

  $('detailMeasure').addEventListener('click', () => useSelectedInSurvey());
}

async function useSelectedInSurvey() {
  const ap = state.selectedBssid ? state.apCache.get(state.selectedBssid) : null;
  await switchView('survey');
  if (!state.survey.started) {
    await loadSurveySample();
    toast('Exemplo carregado. Use “Novo” para começar um levantamento em branco.');
  }
  if (!ap) return;
  const hasNetwork = state.survey.points.some((point) => (point.networks || []).some((network) => network.bssid === ap.bssid));
  if (hasNetwork) {
    state.survey.metric = 'rssi';
    state.survey.apBssid = ap.bssid;
    $('surveyMetric').value = 'rssi';
    updateSurveyAps();
    recomputeSurvey();
    toast(`Métrica alterada para ${ap.ssid || ap.bssid}.`);
  } else {
    toast('Esta rede não aparece no projeto atual; adicione pontos de medição nas áreas desejadas.');
  }
}

function wireSurvey() {
  surveyMap.setCallbacks({
    onMeasure: addSurveyPoint,
    onSelectPoint: (id) => {
      state.survey.selectedId = id;
      updateSurveyList();
      surveyMap.setSurvey({ selectedId: id });
      surveyMap.requestDraw();
    },
    onErasePoint: removeSurveyPoint,
    onZoom: (percent) => {
      $('surveyBadgeZoom').textContent = `${percent}%`;
    },
  });

  document.querySelectorAll('#surveyTools button').forEach((button) => {
    button.addEventListener('click', () => setSurveyTool(button.dataset.tool));
  });

  $('surveyZoomIn').addEventListener('click', () => surveyMap.zoomBy(1.22));
  $('surveyZoomOut').addEventListener('click', () => surveyMap.zoomBy(1 / 1.22));
  $('surveyFit').addEventListener('click', () => {
    surveyMap.fit();
    surveyMap.requestDraw();
  });

  $('surveyOpenMap').addEventListener('click', pickSurveyMap);
  $('surveyEmptyMap').addEventListener('click', pickSurveyMap);
  $('surveySample').addEventListener('click', loadSurveySample);
  $('surveyEmptySample').addEventListener('click', loadSurveySample);

  $('surveyMetric').addEventListener('change', (event) => {
    state.survey.metric = event.target.value;
    if (state.survey.metric === 'rssi' && !state.survey.apBssid) {
      updateSurveyAps();
    }
    $('surveyApSelectWrap').hidden = state.survey.metric !== 'rssi';
    $('surveyCountThresholdWrap').hidden = state.survey.metric !== 'count';
    recomputeSurvey();
  });

  $('surveyApSelect').addEventListener('change', (event) => {
    state.survey.apBssid = event.target.value || null;
    updateSurveyAps();
    recomputeSurvey();
  });

  for (const id of ['surveyMin', 'surveyMax']) {
    $(id).addEventListener('change', () => {
      state.survey.min = Number($('surveyMin').value) || -90;
      state.survey.max = Number($('surveyMax').value) || -30;
      recomputeSurvey();
    });
  }

  $('surveyThreshold').addEventListener('change', () => {
    state.survey.threshold = Number($('surveyThreshold').value) || -75;
    recomputeSurvey();
  });

  $('surveySmooth').addEventListener('input', (event) => {
    state.survey.smooth = Number(event.target.value);
    $('surveySmoothVal').textContent = event.target.value;
    scheduleSurvey();
  });

  $('surveyIsolines').addEventListener('change', (event) => {
    state.survey.isolines = event.target.checked;
    surveyMap.setHeatmap({
      canvas: state.survey.heatmap,
      surface: state.survey.surface,
      min: state.survey.domain.min,
      max: state.survey.domain.max,
      metric: state.survey.metric,
      isolines: state.survey.isolines,
      levels: 5,
    });
  });

  $('surveyShowPoints').addEventListener('change', (event) => {
    state.survey.showPoints = event.target.checked;
    surveyMap.setSurvey({ showPoints: state.survey.showPoints });
  });
  $('surveyShowPath').addEventListener('change', (event) => {
    state.survey.showPath = event.target.checked;
    surveyMap.setSurvey({ showPath: state.survey.showPath });
  });
  $('surveyShowAps').addEventListener('change', (event) => {
    state.survey.showLabels = event.target.checked;
    surveyMap.setSurvey({ showLabels: state.survey.showLabels });
  });

  $('surveyMapWidth').addEventListener('change', () => {
    const survey = state.survey;
    const width = Math.max(1, Number($('surveyMapWidth').value) || 20);
    const aspect = survey.image ? survey.image.height / survey.image.width : survey.height / survey.width;
    survey.width = width;
    survey.height = width * aspect;
    surveyMap.setWorld(survey.width, survey.height);
    surveyMap.fit();
    recomputeSurvey();
  });

  $('surveyPointList').addEventListener('click', (event) => {
    const del = event.target.closest('[data-del]');
    if (del) {
      removeSurveyPoint(del.dataset.del);
      return;
    }
    const item = event.target.closest('[data-point]');
    if (!item) return;
    state.survey.selectedId = item.dataset.point;
    updateSurveyList();
    surveyMap.setSurvey({ selectedId: state.survey.selectedId });
    surveyMap.requestDraw();
  });

  $('surveyApList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-bssid]');
    if (!item) return;
    state.survey.apBssid = item.dataset.bssid;
    state.survey.metric = 'rssi';
    $('surveyMetric').value = 'rssi';
    $('surveyApSelectWrap').hidden = false;
    $('surveyCountThresholdWrap').hidden = true;
    updateSurveyAps();
    recomputeSurvey();
  });

  $('surveyUndo').addEventListener('click', undoSurvey);
  $('surveyNew').addEventListener('click', newSurvey);
  $('surveySave').addEventListener('click', saveSurvey);
  $('surveyOpen').addEventListener('click', openSurvey);
  $('surveyProjectName').addEventListener('input', (event) => {
    state.survey.name = event.target.value;
  });
  $('surveyExportCsv').addEventListener('click', exportSurveyCsv);
  $('surveyExportPng').addEventListener('click', exportSurveyPng);
  $('surveyExportPdf').addEventListener('click', exportSurveyPdf);
}

function wirePlanning() {
  planMap.setCallbacks({
    onPlaceAp: (world) => addPlanApAt(world.x, world.y),
    onCreateObstacle: addPlanObstacle,
    onSelectAp: selectPlanAp,
    onSelectObstacle: selectPlanObstacle,
    onMoveApStart: () => pushPlanUndo(),
    onMoveAp: (id, x, y, final) => {
      if (x == null) {
        schedulePlanning();
        return;
      }
      const plan = state.planning;
      const ap = plan.aps.find((item) => item.id === id);
      if (!ap) return;
      ap.x = x;
      ap.y = y;
      if (plan.selectedKind === 'ap' && plan.selectedId === id) updatePlanEditor();
      schedulePlanning();
      if (final) updatePlanLists();
    },
    onZoom: (percent) => {
      $('planBadgeZoom').textContent = `${percent}%`;
    },
  });

  document.querySelectorAll('#planTools button').forEach((button) => {
    button.addEventListener('click', () => setPlanTool(button.dataset.tool));
  });

  $('planZoomIn').addEventListener('click', () => planMap.zoomBy(1.22));
  $('planZoomOut').addEventListener('click', () => planMap.zoomBy(1 / 1.22));
  $('planFit').addEventListener('click', () => {
    planMap.fit();
    planMap.requestDraw();
  });

  $('planOpenMap').addEventListener('click', pickPlanMap);
  $('planSample').addEventListener('click', loadPlanSample);
  $('planEmptySample').addEventListener('click', loadPlanSample);
  $('planEmptyStart').addEventListener('click', startPlanFromZero);
  $('planNew').addEventListener('click', newPlan);
  $('planSave').addEventListener('click', savePlan);
  $('planOpen').addEventListener('click', openPlan);
  $('planUndo').addEventListener('click', undoPlan);
  $('planProjectName').addEventListener('input', (event) => {
    state.planning.name = event.target.value;
  });

  $('planMetric').addEventListener('change', (event) => {
    state.planning.metric = event.target.value;
    if (state.planning.metric === 'ap' && !state.planning.apId) {
      state.planning.apId = state.planning.aps[0]?.id || null;
    }
    $('planApSelectWrap').hidden = state.planning.metric !== 'ap';
    recomputePlanning();
  });

  $('planApSelect').addEventListener('change', (event) => {
    state.planning.apId = event.target.value || null;
    state.planning.selectedKind = 'ap';
    state.planning.selectedId = state.planning.apId;
    updatePlanEditor();
    updatePlanLists();
    schedulePlanning();
  });

  for (const id of ['planMin', 'planMax']) {
    $(id).addEventListener('change', () => {
      state.planning.min = Number($('planMin').value) || -90;
      state.planning.max = Number($('planMax').value) || -30;
      recomputePlanning();
    });
  }

  $('planWallsVisible').addEventListener('change', (event) => {
    state.planning.showObstacles = event.target.checked;
    planMap.setPlanning({ showObstacles: state.planning.showObstacles });
  });

  $('planIsolines').addEventListener('change', (event) => {
    state.planning.isolines = event.target.checked;
    planMap.setHeatmap({
      canvas: state.planning.heatmap,
      surface: state.planning.surface,
      min: state.planning.domain.min,
      max: state.planning.domain.max,
      metric: 'coverage',
      isolines: state.planning.isolines,
      levels: 4,
    });
  });

  $('planLabels').addEventListener('change', (event) => {
    state.planning.showLabels = event.target.checked;
    planMap.setPlanning({ showLabels: state.planning.showLabels });
  });

  $('planMapWidth').addEventListener('change', () => {
    const plan = state.planning;
    const width = Math.max(1, Number($('planMapWidth').value) || 18);
    const aspect = plan.image ? plan.image.height / plan.image.width : plan.height / plan.width;
    plan.width = width;
    plan.height = width * aspect;
    planMap.setWorld(plan.width, plan.height);
    planMap.fit();
    recomputePlanning();
  });

  for (const id of ['attWall', 'attDoor', 'attWindow']) {
    $(id).addEventListener('change', schedulePlanning);
  }

  $('planObjectList').addEventListener('click', (event) => {
    const del = event.target.closest('[data-odel]');
    if (del) {
      deletePlanObstacle(del.dataset.odel);
      return;
    }
    const item = event.target.closest('[data-obstacle]');
    if (!item) return;
    selectPlanObstacle(item.dataset.obstacle);
  });

  $('planApList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-ap]');
    if (!item) return;
    selectPlanAp(item.dataset.ap);
  });

  $('planAddAp').addEventListener('click', () => {
    if (!state.planning.started) startPlanFromZero();
    const plan = state.planning;
    const offset = plan.aps.length * 0.8;
    addPlanApAt(plan.width / 2 + offset, plan.height / 2 + offset);
    if (plan.metric === 'ap') recomputePlanning();
  });

  $('planApSsid').addEventListener('input', (event) => {
    const plan = state.planning;
    const ap = plan.aps.find((item) => item.id === plan.selectedId);
    if (!ap) return;
    ap.ssid = event.target.value;
    updatePlanLists();
    planMap.requestDraw();
  });

  $('planApBand').addEventListener('change', (event) => {
    const plan = state.planning;
    const ap = plan.aps.find((item) => item.id === plan.selectedId);
    if (!ap) return;
    ap.band = event.target.value;
    ap.channel = defaultChannelForBand(ap.band);
    $('planApChannel').value = String(ap.channel);
    updatePlanLists();
    schedulePlanning();
  });

  $('planApChannel').addEventListener('change', (event) => {
    const plan = state.planning;
    const ap = plan.aps.find((item) => item.id === plan.selectedId);
    if (!ap) return;
    ap.channel = Number(event.target.value) || defaultChannelForBand(ap.band);
    event.target.value = String(ap.channel);
    updatePlanLists();
    schedulePlanning();
  });

  $('planApPower').addEventListener('input', (event) => {
    const plan = state.planning;
    const ap = plan.aps.find((item) => item.id === plan.selectedId);
    if (!ap) return;
    ap.power = Number(event.target.value);
    $('planApPowerVal').textContent = `${ap.power} dBm`;
    schedulePlanning();
  });

  $('planApDelete').addEventListener('click', deleteSelectedPlanAp);
}

function wireGlobal() {
  $('modeTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (button) switchView(button.dataset.mode);
  });

  $('pauseBtn').addEventListener('click', async () => {
    try {
      if (state.status?.running) {
        await window.api.scan.stop();
        state.paused = true;
      } else {
        await window.api.scan.start({ intervalSeconds: state.settings?.intervalSeconds || 5 });
        state.paused = false;
      }
      updateChrome();
    } catch (error) {
      toast(`Falha ao controlar a varredura: ${error.message || error}`, 'error');
    }
  });

  $('refreshBtn').addEventListener('click', async () => {
    try {
      const result = await window.api.scan.refresh();
      if (result?.error) toast(result.errorHint || result.error, 'error');
    } catch (error) {
      toast(`Falha na varredura: ${error.message || error}`, 'error');
    }
  });

  $('emptyRetry').addEventListener('click', async () => {
    try {
      const result = await window.api.scan.refresh();
      if (result?.error) toast(result.errorHint || result.error, 'error');
    } catch (error) {
      toast(String(error.message || error), 'error');
    }
  });

  $('settingsBtn').addEventListener('click', () => {
    fillSettingsForm();
    openDialog($('settingsDialog'));
  });

  $('settingsApply').addEventListener('click', async (event) => {
    event.preventDefault();
    await applySettingsFromDialog();
    $('settingsDialog').close();
  });

  $('aboutBtn').addEventListener('click', showAbout);
  $('aboutClose').addEventListener('click', () => $('aboutDialog').close());
  $('aboutOk').addEventListener('click', () => $('aboutDialog').close());

  // clicking the backdrop closes dialogs
  for (const dialog of [$('settingsDialog'), $('aboutDialog')]) {
    dialog.addEventListener('click', (event) => {
      const rect = dialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) dialog.close();
    });
  }

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
    const mod = event.ctrlKey || event.metaKey;

    if (event.key === 'Escape' && !typing) {
      if (state.survey.selectedId) {
        state.survey.selectedId = null;
        updateSurveyList();
        surveyMap.setSurvey({ selectedId: null });
      }
      if (state.planning.selectedId) {
        state.planning.selectedId = null;
        state.planning.selectedKind = null;
        updatePlanEditor();
        updatePlanLists();
        planMap.setPlanning({ selectedId: null, selectedKind: null });
      }
    }

    if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) {
      if (state.view === 'survey' && state.survey.selectedId) {
        event.preventDefault();
        removeSurveyPoint(state.survey.selectedId);
      } else if (state.view === 'planning' && state.planning.selectedKind === 'ap') {
        event.preventDefault();
        deleteSelectedPlanAp();
      } else if (state.view === 'planning' && state.planning.selectedKind === 'obstacle') {
        event.preventDefault();
        deletePlanObstacle(state.planning.selectedId);
      }
    }

    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (state.view === 'survey') saveSurvey();
      else if (state.view === 'planning') savePlan();
    }

    if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      if (state.view === 'survey') openSurvey();
      else if (state.view === 'planning') openPlan();
    }
  });

  window.addEventListener('resize', debounce(() => {
    drawMainChart();
    surveyMap.requestDraw();
    planMap.requestDraw();
  }, 120));

  setInterval(() => {
    if (state.view === 'inspector' && state.chart === 'signal') drawMainChart();
    if (!state.paused && state.snapshot?.timestamp) {
      $('statusLast').textContent = `última ${timeText(state.snapshot.timestamp)}`;
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function init() {
  wireInspector();
  wireSurvey();
  wirePlanning();
  wireGlobal();

  state.info = await window.api.info().catch(() => ({}));
  const loaded = await window.api.settings.get().catch(() => null);
  state.settings = { ...DEFAULTS, ...(loaded || {}) };
  applyTheme();
  surveyMap.setUnits(state.settings.units);
  planMap.setUnits(state.settings.units);
  surveyMap.setWorld(state.survey.width, state.survey.height);
  planMap.setWorld(state.planning.width, state.planning.height);

  $('setInterval').value = String(state.settings.intervalSeconds || 5);
  $('channelBands').hidden = true;
  $('surveyApSelectWrap').hidden = true;
  $('surveyCountThresholdWrap').hidden = true;
  $('planApSelectWrap').hidden = true;

  window.api.scan.onSnapshot(applySnapshot);
  window.api.scan.onStatus(applyStatus);

  const initial = state.info?.startupView && ['inspector', 'survey', 'planning'].includes(state.info.startupView)
    ? state.info.startupView
    : (state.settings.lastMode || 'inspector');
  await switchView(initial, { persist: false });

  try {
    const status = await window.api.scan.state();
    if (status) {
      state.status = status;
      state.paused = !status.running;
    }
  } catch {
    // scanner state is optional on first paint
  }
  updateChrome();
  renderInspector();
  updateSurveyUi();
  updatePlanningUi();

  if (state.status?.running) {
    window.api.scan.refresh().catch(() => {});
  }
}

window.__setView = async (view) => {
  if (!['inspector', 'survey', 'planning'].includes(view)) return;
  await switchView(view, { persist: false });
  if (view === 'survey' && !state.survey.started) await loadSurveySample();
  if (view === 'planning' && !state.planning.started) await loadPlanSample();
  await new Promise((resolve) => setTimeout(resolve, 180));
  $('toast').className = 'toast';
};

window.__app = {
  state,
  switchView,
  surveyMap,
  planMap,
  surveyCsvText,
  reportHtml,
  exportSurveyCsv,
  exportSurveyPng,
  exportSurveyPdf,
};

init().catch((error) => {
  console.error(error);
  const node = $('toast');
  node.textContent = `Falha ao iniciar a interface: ${error.message || error}`;
  node.className = 'toast show error';
});
