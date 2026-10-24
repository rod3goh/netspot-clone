import { colorForValue, drawIsolines } from './heatmap.js';
import { colorForBssid } from './charts.js';

const MARGIN = 28;
const MIN_SCALE = 3;
const MAX_SCALE = 800;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lengthSq, 0, 1);
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

function niceDistance(candidates, minPx, maxPx, scale, units) {
  for (const value of candidates) {
    const meters = units === 'ft' ? value / 3.28084 : value;
    const px = meters * scale;
    if (px >= minPx && px <= maxPx) {
      return { px, label: units === 'ft' ? `${value} ft` : `${value} m` };
    }
  }
  const meters = 50 / scale;
  const label = units === 'ft' ? `${(meters * 3.28084).toFixed(0)} ft` : `${meters.toFixed(0)} m`;
  return { px: 50, label };
}

function apColor(ap) {
  return colorForBssid(ap.bssid || ap.id || ap.ssid || '');
}

function obstacleStyle(type, colors) {
  if (type === 'door') return { width: 4, color: colors.door, dash: [6, 5] };
  if (type === 'window') return { width: 4, color: colors.window, dash: [] };
  return { width: 5, color: colors.wall, dash: [] };
}

/**
 * Interactive floor-plan canvas shared by Survey and Planning.
 * World coordinates are metres, y grows downwards, origin is the top-left of the plan.
 */
export class MapView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = opts.mode || 'survey';
    this.tool = opts.tool || 'measure';
    this.units = 'm';
    this.callbacks = {};
    this.world = { w: opts.mapW || 20, h: opts.mapH || 12 };
    this.scale = 40;
    this.offsetX = 0;
    this.offsetY = 0;
    this.dpr = 1;
    this.image = null;
    this.heatmap = null;
    this.heatmapSurface = null;
    this.isolines = false;
    this.isolineLevels = 5;
    this.survey = {
      points: [],
      selectedId: null,
      showPoints: true,
      showPath: true,
      showLabels: true,
      min: -90,
      max: -40,
      metric: 'coverage',
      valueFn: null,
      pointColor: null,
    };
    this.plan = {
      obstacles: [],
      aps: [],
      selectedId: null,
      selectedKind: null,
      showObstacles: true,
      showLabels: true,
      min: -90,
      max: -40,
    };
    this.hover = null;
    this.drag = null;
    this.draft = null;
    this._raf = null;
    this._resizeObserver = null;
    this._initialized = false;
    this._bindEvents();
    this._observeResize();
    this.resize();
  }

  setCallbacks(callbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.style.cursor = this._cursorFor(tool);
    this.requestDraw();
  }

  setUnits(units) {
    this.units = units === 'ft' ? 'ft' : 'm';
    this.requestDraw();
  }

  setWorld(width, height) {
    this.world = { w: Math.max(1, width), h: Math.max(1, height) };
    this.requestDraw();
  }

  setImage(image, width, height) {
    this.image = image || null;
    if (width && height) this.setWorld(width, height);
    this.requestDraw();
  }

  setSurvey(patch) {
    Object.assign(this.survey, patch);
    this.requestDraw();
  }

  setPlanning(patch) {
    Object.assign(this.plan, patch);
    this.requestDraw();
  }

  setHeatmap({ canvas = null, surface = null, min = -90, max = -40, metric = 'coverage', isolines = false, levels = 5 } = {}) {
    this.heatmap = canvas;
    this.heatmapSurface = surface;
    this.heatmapMin = min;
    this.heatmapMax = max;
    this.heatmapMetric = metric;
    this.isolines = isolines;
    this.isolineLevels = levels;
    this.requestDraw();
  }

  clearHeatmap() {
    this.heatmap = null;
    this.heatmapSurface = null;
    this.requestDraw();
  }

  get zoomPercent() {
    return Math.round((this.scale / (this._baseScale || this.scale || 1)) * 100);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * this.dpr);
    const pixelHeight = Math.round(height * this.dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.width = width;
    this.height = height;
    if (!this._initialized && width > 10 && height > 10) {
      this._initialized = true;
      this.fit(false);
    }
    this.requestDraw();
  }

  _observeResize() {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', () => this.resize());
      return;
    }
    const target = this.canvas.parentElement || this.canvas;
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(target);
  }

  _cursorFor(tool) {
    if (tool === 'pan') return 'grab';
    if (tool === 'measure' || tool === 'ap') return 'crosshair';
    if (tool === 'erase') return 'cell';
    if (tool === 'wall' || tool === 'door' || tool === 'window') return 'crosshair';
    return 'default';
  }

  fit(redraw = true) {
    if (!this.width || !this.height) return;
    const w = this.world.w;
    const h = this.world.h;
    const scale = Math.min((this.width - MARGIN * 2) / w, (this.height - MARGIN * 2) / h);
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this._baseScale = this.scale;
    this.offsetX = (this.width - w * this.scale) / 2;
    this.offsetY = (this.height - h * this.scale) / 2;
    if (redraw) this.requestDraw();
    this._emitZoom();
  }

  zoomBy(factor) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    this._zoomAt(cx, cy, factor);
  }

  _zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    this.offsetX = screenX - before.x * this.scale;
    this.offsetY = screenY - before.y * this.scale;
    this._clampOffsets();
    this.requestDraw();
    this._emitZoom();
  }

  _emitZoom() {
    if (this.callbacks.onZoom) this.callbacks.onZoom(this.zoomPercent);
  }

  _clampOffsets() {
    const w = this.world.w * this.scale;
    const h = this.world.h * this.scale;
    const padX = Math.min(this.width * 0.5, Math.max(60, this.width * 0.2));
    const padY = Math.min(this.height * 0.5, Math.max(60, this.height * 0.2));
    if (w + padX * 2 < this.width) {
      this.offsetX = (this.width - w) / 2;
    } else {
      this.offsetX = clamp(this.offsetX, this.width - w - padX, padX);
    }
    if (h + padY * 2 < this.height) {
      this.offsetY = (this.height - h) / 2;
    } else {
      this.offsetY = clamp(this.offsetY, this.height - h - padY, padY);
    }
  }

  worldToScreen(x, y) {
    return { x: x * this.scale + this.offsetX, y: y * this.scale + this.offsetY };
  }

  screenToWorld(x, y) {
    return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale };
  }

  _pointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { screen: { x, y }, world: this.screenToWorld(x, y) };
  }

  _inWorld(point) {
    return point.x >= 0 && point.y >= 0 && point.x <= this.world.w && point.y <= this.world.h;
  }

  _hitPoint(world) {
    const radius = 12 / this.scale;
    let best = null;
    let bestDistance = radius;
    for (const point of this.survey.points) {
      const distance = Math.hypot(point.x - world.x, point.y - world.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
    return best;
  }

  _hitAp(world) {
    const radius = 18 / this.scale;
    let best = null;
    let bestDistance = radius;
    for (const ap of this.plan.aps) {
      const distance = Math.hypot(ap.x - world.x, ap.y - world.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = ap;
      }
    }
    return best;
  }

  _hitObstacle(world) {
    const tolerance = 9 / this.scale;
    let best = null;
    let bestDistance = tolerance;
    for (const obstacle of this.plan.obstacles) {
      const distance = distanceToSegment(world.x, world.y, obstacle.x1, obstacle.y1, obstacle.x2, obstacle.y2);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = obstacle;
      }
    }
    return best;
  }

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', (event) => this._onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this._onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this._onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this._onPointerUp(event));
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.drag && this.hover) {
        this.hover = null;
        this.requestDraw();
      }
    });
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const { screen } = this._pointer(event);
      const factor = Math.exp(-event.deltaY * 0.0016);
      this._zoomAt(screen.x, screen.y, factor);
    }, { passive: false });
    this.canvas.addEventListener('dblclick', (event) => {
      if (this.tool === 'pan' || this.tool === 'select') {
        const { screen } = this._pointer(event);
        this._zoomAt(screen.x, screen.y, 1.5);
      }
    });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  _onPointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // pointer capture is a convenience, not a requirement
    }
    const { screen, world } = this._pointer(event);

    if (event.button === 1 || this.tool === 'pan') {
      this.drag = { kind: 'pan', startX: screen.x, startY: screen.y, offsetX: this.offsetX, offsetY: this.offsetY };
      this.canvas.style.cursor = 'grabbing';
      event.preventDefault();
      return;
    }

    if (this.tool === 'measure') {
      if (this._inWorld(world)) this.callbacks.onMeasure?.(world);
      return;
    }

    if (this.tool === 'ap') {
      if (this._inWorld(world)) this.callbacks.onPlaceAp?.(world);
      return;
    }

    if (this.tool === 'erase') {
      const point = this._hitPoint(world);
      if (point) {
        this.callbacks.onErasePoint?.(point.id);
        return;
      }
      const obstacle = this._hitObstacle(world);
      if (obstacle) {
        this.callbacks.onEraseObstacle?.(obstacle.id);
        return;
      }
      return;
    }

    if (this.tool === 'wall' || this.tool === 'door' || this.tool === 'window') {
      if (!this._inWorld(world)) return;
      this.draft = {
        type: this.tool,
        x1: clamp(world.x, 0, this.world.w),
        y1: clamp(world.y, 0, this.world.h),
        x2: clamp(world.x, 0, this.world.w),
        y2: clamp(world.y, 0, this.world.h),
      };
      this.requestDraw();
      return;
    }

    // select tool
    if (this.mode === 'planning') {
      const ap = this._hitAp(world);
      if (ap) {
        this.callbacks.onSelectAp?.(ap.id);
        this.drag = {
          kind: 'ap',
          id: ap.id,
          dx: ap.x - world.x,
          dy: ap.y - world.y,
          moved: false,
        };
        return;
      }
      const obstacle = this._hitObstacle(world);
      if (obstacle) {
        this.callbacks.onSelectObstacle?.(obstacle.id);
        return;
      }
      this.callbacks.onSelectAp?.(null);
      this.callbacks.onSelectObstacle?.(null);
      return;
    }

    const point = this._hitPoint(world);
    if (point) {
      this.callbacks.onSelectPoint?.(point.id);
      return;
    }
    this.callbacks.onSelectPoint?.(null);
  }

  _onPointerMove(event) {
    const { screen, world } = this._pointer(event);

    if (this.drag && this.drag.kind === 'pan') {
      this.offsetX = this.drag.offsetX + (screen.x - this.drag.startX);
      this.offsetY = this.drag.offsetY + (screen.y - this.drag.startY);
      this._clampOffsets();
      this.requestDraw();
      return;
    }

    if (this.drag && this.drag.kind === 'ap') {
      const ap = this.plan.aps.find((item) => item.id === this.drag.id);
      if (ap) {
        const x = clamp(world.x + this.drag.dx, 0, this.world.w);
        const y = clamp(world.y + this.drag.dy, 0, this.world.h);
        if (!this.drag.moved && Math.hypot(x - ap.x, y - ap.y) > 0.01) {
          this.drag.moved = true;
          this.callbacks.onMoveApStart?.(ap.id);
        }
        ap.x = x;
        ap.y = y;
        this.callbacks.onMoveAp?.(ap.id, x, y, false);
        this.requestDraw();
      }
      return;
    }

    if (this.draft) {
      this.draft.x2 = clamp(world.x, 0, this.world.w);
      this.draft.y2 = clamp(world.y, 0, this.world.h);
      this.requestDraw();
      return;
    }

    // hover feedback
    let nextHover = null;
    if (this.mode === 'survey' && (this.tool === 'select' || this.tool === 'erase')) {
      const point = this._hitPoint(world);
      if (point) nextHover = { kind: 'point', id: point.id };
    }
    if (!nextHover && this.mode === 'planning' && (this.tool === 'select' || this.tool === 'erase')) {
      const ap = this._hitAp(world);
      if (ap) nextHover = { kind: 'ap', id: ap.id };
      else {
        const obstacle = this._hitObstacle(world);
        if (obstacle) nextHover = { kind: 'obstacle', id: obstacle.id };
      }
    }
    const previous = this.hover ? `${this.hover.kind}:${this.hover.id}` : '';
    const current = nextHover ? `${nextHover.kind}:${nextHover.id}` : '';
    if (previous !== current) {
      this.hover = nextHover;
      this.requestDraw();
    }
    if (this.tool === 'select') {
      this.canvas.style.cursor = nextHover ? 'pointer' : 'default';
    } else if (this.tool === 'erase') {
      this.canvas.style.cursor = nextHover ? 'not-allowed' : 'cell';
    }
  }

  _onPointerUp(event) {
    if (this.draft) {
      const draft = this.draft;
      this.draft = null;
      const length = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1);
      if (length >= 0.18) {
        this.callbacks.onCreateObstacle?.(draft);
      }
      this.requestDraw();
    }
    if (this.drag && this.drag.kind === 'ap' && this.drag.moved) {
      this.callbacks.onMoveAp?.(this.drag.id, null, null, true);
    }
    if (this.drag && this.drag.kind === 'pan') {
      this.canvas.style.cursor = this._cursorFor(this.tool);
    }
    this.drag = null;
    try {
      this.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // ignore unsupported capture state
    }
  }

  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.draw();
    });
  }

  draw() {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const planBg = cssVar('--map-bg', cssVar('--bg-soft', '#0e141d'));
    ctx.fillStyle = planBg;
    ctx.fillRect(0, 0, this.width, this.height);

    const origin = this.worldToScreen(0, 0);
    const planW = this.world.w * this.scale;
    const planH = this.world.h * this.scale;

    // plan paper / drop shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = cssVar('--map-paper', cssVar('--panel', '#131a24'));
    ctx.fillRect(origin.x, origin.y, planW, planH);
    ctx.restore();

    if (this.image) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(origin.x, origin.y, planW, planH);
      ctx.clip();
      ctx.globalAlpha = cssVar('--map-image-alpha', '1') === '1' ? 1 : 0.92;
      ctx.drawImage(this.image, origin.x, origin.y, planW, planH);
      ctx.restore();
    } else {
      this._drawGrid(ctx, origin, planW, planH);
    }

    if (this.heatmap) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.heatmap, origin.x, origin.y, planW, planH);
      ctx.restore();
      if (this.isolines && this.heatmapSurface) {
        drawIsolines(ctx, this.heatmapSurface, {
          min: this.heatmapMin,
          max: this.heatmapMax,
          levels: this.isolineLevels,
          toScreen: (x, y) => this.worldToScreen(x, y),
          color: cssVar('--isoline', 'rgba(255,255,255,0.5)'),
        });
      }
    }

    // plan outline
    ctx.save();
    ctx.strokeStyle = cssVar('--map-outline', 'rgba(148,163,184,0.5)');
    ctx.lineWidth = 1.5;
    ctx.strokeRect(origin.x + 0.5, origin.y + 0.5, planW - 1, planH - 1);
    ctx.restore();

    if (this.mode === 'planning') {
      if (this.plan.showObstacles) this._drawObstacles(ctx);
      this._drawAps(ctx);
    } else {
      this._drawSurvey(ctx);
    }

    if (this.draft) this._drawDraft(ctx);
    this._drawScaleBar(ctx);
  }

  _drawGrid(ctx, origin, planW, planH) {
    const step = this.scale >= 28 ? 1 : this.scale >= 12 ? 2 : 5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(origin.x, origin.y, planW, planH);
    ctx.clip();
    ctx.strokeStyle = cssVar('--map-grid', 'rgba(148,163,184,0.10)');
    ctx.lineWidth = 1;
    for (let x = step; x < this.world.w; x += step) {
      const sx = Math.round(origin.x + x * this.scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, origin.y);
      ctx.lineTo(sx, origin.y + planH);
      ctx.stroke();
    }
    for (let y = step; y < this.world.h; y += step) {
      const sy = Math.round(origin.y + y * this.scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(origin.x, sy);
      ctx.lineTo(origin.x + planW, sy);
      ctx.stroke();
    }
    // metre labels
    if (this.scale >= 14) {
      ctx.fillStyle = cssVar('--faint', '#5d6b80');
      ctx.font = '9px Inter, Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      for (let x = step; x < this.world.w; x += step * 2) {
        ctx.fillText(`${x} m`, origin.x + x * this.scale + 3, origin.y + planH - 3);
      }
    }
    ctx.restore();
  }

  _drawSurvey(ctx) {
    const { points, showPath, showPoints } = this.survey;
    if (!points.length) return;

    if (showPath && points.length > 1 && this.survey.showPath) {
      ctx.save();
      ctx.beginPath();
      points.forEach((point, index) => {
        const { x, y } = this.worldToScreen(point.x, point.y);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = cssVar('--survey-path', 'rgba(148,163,184,0.5)');
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 5]);
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    if (!showPoints) return;

    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      const { x, y } = this.worldToScreen(point.x, point.y);
      const value = this.survey.valueFn ? this.survey.valueFn(point) : point.rssi;
      const color = this.survey.pointColor
        ? this.survey.pointColor(point, value)
        : Number.isFinite(value)
          ? colorForValue(value, this.survey.min, this.survey.max, this.survey.metric, 0.95)
          : 'rgba(148,163,184,0.8)';
      const selected = point.id === this.survey.selectedId;
      const hovered = this.hover && this.hover.kind === 'point' && this.hover.id === point.id;

      ctx.save();
      if (hovered || selected) {
        ctx.beginPath();
        ctx.arc(x, y, selected ? 11 : 10, 0, Math.PI * 2);
        ctx.strokeStyle = selected ? cssVar('--accent-2', '#22d3ee') : 'rgba(255,255,255,0.75)';
        ctx.lineWidth = selected ? 2.2 : 1.4;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = 'rgba(9,14,22,0.85)';
      ctx.stroke();

      // tiny index
      if (this.scale > 18) {
        ctx.fillStyle = 'rgba(8,13,21,0.9)';
        ctx.font = '600 8px Inter, Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(index + 1), x, y + 0.5);
      }
      ctx.restore();

      if (this.survey.showLabels && this.scale > 16) {
        // Labels are added after the loop, limited to the strongest unique SSIDs.
      }
    }

    if (this.survey.showLabels && this.scale > 15) {
      const candidates = points
        .map((point) => ({
          point,
          value: this.survey.valueFn ? this.survey.valueFn(point) : point.rssi,
        }))
        .filter((item) => Number.isFinite(item.value))
        .sort((a, b) => b.value - a.value);
      const placed = [];
      const used = new Set();
      const metric = this.survey.metric;
      const unit = (value) => {
        if (metric === 'count') return `${Math.round(value)} redes`;
        if (metric === 'interference') return `${Math.round(value)}%`;
        return `${Math.round(value)} dBm`;
      };
      for (const item of candidates) {
        if (placed.length >= 5) break;
        const ssid = item.point.bestSsid || '';
        if (used.has(ssid)) continue;
        const { x, y } = this.worldToScreen(item.point.x, item.point.y);
        if (placed.some((other) => Math.hypot(other.x - x, other.y - y) < 84)) continue;
        used.add(ssid);
        placed.push({ x, y });
        this._label(ctx, x, y + 15, ssid || unit(item.value), 'rgba(9,14,22,0.82)', '#e8eef8', unit(item.value));
      }
    }
  }

  _drawObstacles(ctx) {
    const colors = {
      wall: cssVar('--wall', '#cbd5e1'),
      door: cssVar('--door', '#fbbf24'),
      window: cssVar('--window', '#38bdf8'),
    };
    const selected = this.plan.selectedKind === 'obstacle' ? this.plan.selectedId : null;
    for (const obstacle of this.plan.obstacles) {
      const a = this.worldToScreen(obstacle.x1, obstacle.y1);
      const b = this.worldToScreen(obstacle.x2, obstacle.y2);
      const style = obstacleStyle(obstacle.type, colors);
      const isSelected = obstacle.id === selected;
      const isHovered = this.hover && this.hover.kind === 'obstacle' && this.hover.id === obstacle.id;

      ctx.save();
      if (isSelected || isHovered) {
        ctx.strokeStyle = isSelected ? cssVar('--accent-2', '#22d3ee') : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = style.width + 7;
        ctx.globalAlpha = 0.28;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (obstacle.type === 'door') {
        // wall stubs on both ends, opening in the middle
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const stub = Math.min(length * 0.22, 18);
        ctx.strokeStyle = colors.wall;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + ux * stub, a.y + uy * stub);
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - ux * stub, b.y - uy * stub);
        ctx.stroke();

        ctx.strokeStyle = style.color;
        ctx.lineWidth = 3.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x + ux * stub, a.y + uy * stub);
        ctx.lineTo(b.x - ux * stub, b.y - uy * stub);
        ctx.stroke();
        ctx.setLineDash([]);

        // door swing arc
        const radius = Math.min(length * 0.55, 34);
        ctx.strokeStyle = 'rgba(251,191,36,0.55)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(a.x + ux * stub, a.y + uy * stub, radius, Math.atan2(uy, ux), Math.atan2(uy, ux) + Math.PI / 2);
        ctx.stroke();
      } else {
        // dark halo keeps walls readable over the heatmap
        ctx.strokeStyle = 'rgba(8,13,21,0.55)';
        ctx.lineWidth = style.width + 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.width;
        ctx.setLineDash(style.dash);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        if (obstacle.type === 'window') {
          ctx.strokeStyle = 'rgba(8,13,21,0.7)';
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          // double glazing
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy) || 1;
          const nx = (-dy / length) * 3;
          const ny = (dx / length) * 3;
          ctx.strokeStyle = colors.window;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(a.x + nx, a.y + ny);
          ctx.lineTo(b.x + nx, b.y + ny);
          ctx.moveTo(a.x - nx, a.y - ny);
          ctx.lineTo(b.x - nx, b.y - ny);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  _drawAps(ctx) {
    for (const ap of this.plan.aps) {
      const { x, y } = this.worldToScreen(ap.x, ap.y);
      const color = apColor(ap);
      const selected = this.plan.selectedKind === 'ap' && ap.id === this.plan.selectedId;
      const hovered = this.hover && this.hover.kind === 'ap' && this.hover.id === ap.id;

      ctx.save();
      // signal rings
      for (let i = 3; i >= 1; i--) {
        ctx.beginPath();
        ctx.arc(x, y, 17 + i * 8, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.07 + (4 - i) * 0.03;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (selected || hovered) {
        ctx.beginPath();
        ctx.arc(x, y, 21, 0, Math.PI * 2);
        ctx.strokeStyle = cssVar('--accent-2', '#22d3ee');
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.fillStyle = cssVar('--panel', '#131a24');
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();

      // router glyph
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.rect(x - 7, y + 2, 14, 7);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 4, y + 5.5);
      ctx.lineTo(x - 4, y + 5.5);
      ctx.moveTo(x, y + 5.5);
      ctx.lineTo(x, y + 5.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - 1);
      ctx.lineTo(x, y - 4);
      ctx.moveTo(x - 4.5, y - 1.5);
      ctx.arc(x, y - 4, 4.5, Math.PI * 0.82, Math.PI * 0.18, true);
      ctx.moveTo(x - 7.5, y - 3);
      ctx.arc(x, y - 4, 7.5, Math.PI * 0.82, Math.PI * 0.18, true);
      ctx.stroke();
      ctx.restore();

      if (this.plan.showLabels) {
        const title = ap.ssid || 'Ponto de acesso';
        const sub = `${ap.channel || '—'} · ${ap.band === '6' ? '6' : ap.band === '2.4' ? '2,4' : '5'} GHz`;
        this._label(ctx, x, y - 25, title, 'rgba(9,14,22,0.84)', '#e8eef8', sub);
      }
    }
  }

  _label(ctx, x, y, text, background, foreground, sub = null) {
    ctx.save();
    ctx.font = '600 10.5px Inter, Segoe UI, sans-serif';
    const width = Math.min(180, ctx.measureText(text).width);
    const height = sub ? 26 : 16;
    const left = x - width / 2 - 5;
    const top = y;
    ctx.fillStyle = background;
    roundRectPath(ctx, left, top, width + 10, height, 4);
    ctx.fill();
    ctx.fillStyle = foreground;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, top + 3, width);
    if (sub) {
      ctx.fillStyle = 'rgba(185,197,216,0.8)';
      ctx.font = '9px Inter, Segoe UI, sans-serif';
      ctx.fillText(sub, x, top + 14, width);
    }
    ctx.restore();
  }

  _drawDraft(ctx) {
    const a = this.worldToScreen(this.draft.x1, this.draft.y1);
    const b = this.worldToScreen(this.draft.x2, this.draft.y2);
    const colors = {
      wall: cssVar('--wall', '#cbd5e1'),
      door: cssVar('--door', '#fbbf24'),
      window: cssVar('--window', '#38bdf8'),
    };
    const style = obstacleStyle(this.draft.type, colors);
    ctx.save();
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.lineCap = 'round';
    ctx.setLineDash(style.dash.length ? style.dash : [7, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const length = Math.hypot(this.draft.x2 - this.draft.x1, this.draft.y2 - this.draft.y1);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const text = this.units === 'ft' ? `${(length * 3.28084).toFixed(1)} ft` : `${length.toFixed(2)} m`;
    this._label(ctx, mid.x, mid.y - 22, text, 'rgba(9,14,22,0.85)', '#e8eef8');
    ctx.restore();
  }

  _drawScaleBar(ctx) {
    const candidates = this.units === 'ft'
      ? [1, 2, 5, 10, 20, 50, 100, 200, 500]
      : [0.5, 1, 2, 5, 10, 20, 50, 100, 200];
    const bar = niceDistance(candidates, 58, 150, this.scale, this.units);
    const x = 16;
    const y = this.height - 22;
    ctx.save();
    ctx.fillStyle = 'rgba(9,14,22,0.66)';
    roundRectPath(ctx, x - 8, y - 16, bar.px + 46, 26, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,238,248,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + bar.px, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + bar.px, y - 4);
    ctx.lineTo(x + bar.px, y + 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(232,238,248,0.9)';
    ctx.font = '10px Inter, Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(bar.label, x + bar.px + 7, y);
    ctx.restore();
  }

  exportDataUrl() {
    return this.canvas.toDataURL('image/png');
  }
}

export { niceDistance };
