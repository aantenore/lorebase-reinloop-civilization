import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { t } from '../i18n';
import { useSim } from '../state/store';
import type { State } from '../state/reducer';
import { BIOME_COLOR, SEASON_STYLE, TIER_STYLE, roleStyle } from '../theme/tokens';
import type { Agent, Season, World } from '../types';
import { shapePath } from './Glyphs';

// Canvas world renderer: cached terrain layer + per-frame animated layer
// (tinting, snow, agents with interpolated motion, speech bubbles, camera follow).

interface Pos { x: number; y: number }
interface Rect { x: number; y: number; w: number; h: number }
interface Flake { x: number; y: number; s: number; v: number; d: number }

const hash = (x: number, y: number, k = 0) => {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const pathCache = new Map<string, Path2D>();
function glyphPath(shape: string, r: number) {
  const k = `${shape}:${r.toFixed(1)}`;
  let p = pathCache.get(k);
  if (!p) {
    p = new Path2D(shapePath(shape as never, r));
    pathCache.set(k, p);
  }
  return p;
}

function renderTerrain(world: World, cell: number, season: Season): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(world.w * cell);
  c.height = Math.ceil(world.h * cell);
  const g = c.getContext('2d')!;
  const winter = season === 'winter';
  const autumn = season === 'autumn';
  // berry flecks scale to the world's own food range so any backend scale reads the same
  let maxFood = 0;
  for (const t of world.tiles) if (t.biome === 'grass' && t.food > maxFood) maxFood = t.food;
  for (const t of world.tiles) {
    const px = t.x * cell;
    const py = t.y * cell;
    const [r0, g0, b0] = BIOME_COLOR[t.biome];
    const n = (hash(t.x, t.y) - 0.5) * 14;
    let r = r0 + n;
    let gg = g0 + n;
    let b = b0 + n;
    if (t.biome === 'grass') {
      const f = maxFood ? Math.min(1, t.food / maxFood) : 0;
      r += f * 10;
      gg += f * 26;
      b += f * 4;
      if (autumn) { r += 22; gg += 4; b -= 6; }
    }
    if (winter && t.biome === 'grass') { r = r * 0.45 + 92; gg = gg * 0.45 + 100; b = b * 0.45 + 112; }
    if (winter && t.biome === 'forest') { r = r * 0.7 + 30; gg = gg * 0.7 + 38; b = b * 0.7 + 48; }
    if (winter && t.biome === 'rock') { r += 26; gg += 28; b += 34; }
    if (winter && t.biome === 'water') { r = r * 0.8 + 14; gg = gg * 0.8 + 36; b = b * 0.8 + 62; }
    g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
    g.fillRect(px, py, cell + 0.5, cell + 0.5);

    const rel = maxFood ? t.food / maxFood : 0;
    if (t.biome === 'grass' && rel > config.map.berryMinShare) {
      // sparse flecks: only rich tiles get several
      const dots = Math.round(rel * config.map.berryMaxDots);
      for (let i = 0; i < dots; i++) {
        const dx = hash(t.x, t.y, i + 1) * (cell - 4) + 2;
        const dy = hash(t.x, t.y, i + 11) * (cell - 4) + 2;
        g.fillStyle = winter ? 'rgba(220,120,140,.4)' : autumn ? 'rgba(255,170,70,.55)' : 'rgba(255,214,110,.5)';
        g.beginPath();
        g.arc(px + dx, py + dy, Math.max(0.8, cell * 0.045), 0, Math.PI * 2);
        g.fill();
      }
    }
    if (t.biome === 'forest') {
      const trees = Math.min(4, Math.ceil(t.wood / 4));
      for (let i = 0; i < trees; i++) {
        const dx = hash(t.x, t.y, i + 3) * (cell * 0.6) + cell * 0.2;
        const dy = hash(t.x, t.y, i + 7) * (cell * 0.6) + cell * 0.2;
        const rr = cell * (0.16 + hash(t.x, t.y, i + 9) * 0.1);
        g.fillStyle = winter ? 'rgba(22,52,40,.95)' : autumn ? `rgba(${150 + i * 20},${70 + i * 10},30,.9)` : 'rgba(18,70,40,.95)';
        g.beginPath();
        g.arc(px + dx, py + dy, rr, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = winter ? 'rgba(236,244,250,.9)' : 'rgba(0,0,0,.25)';
        g.beginPath();
        if (winter) g.arc(px + dx - rr * 0.2, py + dy - rr * 0.25, rr * 0.6, 0, Math.PI * 2);
        else g.arc(px + dx + rr * 0.3, py + dy + rr * 0.35, rr * 0.7, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (t.biome === 'rock') {
      g.fillStyle = 'rgba(255,255,255,.06)';
      g.fillRect(px + cell * 0.2, py + cell * 0.25, cell * 0.35, cell * 0.2);
    }
    if (t.biome === 'water') {
      g.strokeStyle = 'rgba(160,210,255,.10)';
      g.lineWidth = 1;
      g.beginPath();
      const wy = py + cell * (0.35 + hash(t.x, t.y, 5) * 0.3);
      g.moveTo(px + cell * 0.15, wy);
      g.quadraticCurveTo(px + cell * 0.5, wy - 2, px + cell * 0.85, wy);
      g.stroke();
    }
  }
  // grid hairlines
  g.strokeStyle = 'rgba(0,0,0,.10)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= world.w; x++) { g.moveTo(x * cell + 0.5, 0); g.lineTo(x * cell + 0.5, c.height); }
  for (let y = 0; y <= world.h; y++) { g.moveTo(0, y * cell + 0.5); g.lineTo(c.width, y * cell + 0.5); }
  g.stroke();
  return c;
}

function drawShelter(g: CanvasRenderingContext2D, cx: number, cy: number, cell: number, glow: boolean, now: number) {
  const s = cell * 0.36;
  if (glow) {
    const flick = 0.75 + Math.sin(now / 180 + cx) * 0.1 + Math.sin(now / 67 + cy) * 0.05;
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, cell * 1.4);
    rg.addColorStop(0, `rgba(255,180,80,${0.35 * flick})`);
    rg.addColorStop(1, 'rgba(255,180,80,0)');
    g.fillStyle = rg;
    g.fillRect(cx - cell * 1.5, cy - cell * 1.5, cell * 3, cell * 3);
  }
  g.fillStyle = '#6b4a2e';
  g.fillRect(cx - s, cy - s * 0.1, s * 2, s * 1.1);
  g.fillStyle = '#a7653a';
  g.beginPath();
  g.moveTo(cx - s * 1.3, cy);
  g.lineTo(cx, cy - s * 1.15);
  g.lineTo(cx + s * 1.3, cy);
  g.closePath();
  g.fill();
  g.fillStyle = glow ? '#ffcf73' : '#3a2a1c';
  g.fillRect(cx - s * 0.25, cy + s * 0.25, s * 0.5, s * 0.75);
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = t;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  return lines;
}

export function WorldMap() {
  const { state, focusId, setFocus } = useSim();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<State>(state);
  const focusRef = useRef<string | null>(focusId);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const terrainRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const posRef = useRef<Record<string, Pos>>({});
  const camRef = useRef({ x: 0, y: 0, z: 1 });
  const flakes = useRef<Flake[]>([]);
  const hoverRef = useRef<string | null>(null);

  stateRef.current = state;
  focusRef.current = focusId;
  followRef.current = follow;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(160, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // layout: fit world into box
  const world = state.world;
  const cell = world ? Math.max(6, Math.min(size.w / world.w, size.h / world.h)) : 20;
  const mapW = world ? world.w * cell : size.w;
  const mapH = world ? world.h * cell : size.h;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(mapW * dpr);
    canvas.height = Math.round(mapH * dpr);
    canvas.style.width = `${mapW}px`;
    canvas.style.height = `${mapH}px`;
    const g = canvas.getContext('2d')!;
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = stateRef.current;
      const w = s.world;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#0b0f0d';
      g.fillRect(0, 0, mapW, mapH);
      if (!w) {
        raf = requestAnimationFrame(frame);
        return;
      }
      // terrain cache
      const key = `${s.worldVersion}:${s.season}:${cell.toFixed(2)}`;
      if (!terrainRef.current || terrainRef.current.key !== key) {
        terrainRef.current = { key, canvas: renderTerrain(w, cell, s.season) };
      }

      // agent interpolation
      const pos = posRef.current;
      const k = 1 - Math.exp(-dt * 5);
      for (const id of s.order) {
        const a = s.agents[id];
        if (!a) continue;
        const tx = (a.x + 0.5) * cell;
        const ty = (a.y + 0.5) * cell;
        const p = pos[id];
        if (!p) pos[id] = { x: tx, y: ty };
        else {
          p.x += (tx - p.x) * k;
          p.y += (ty - p.y) * k;
        }
      }

      // camera
      const cam = camRef.current;
      const f = focusRef.current && followRef.current ? pos[focusRef.current] : null;
      const tz = f ? 1.75 : 1;
      cam.z += (tz - cam.z) * (1 - Math.exp(-dt * 3));
      const cxT = f ? f.x : mapW / 2;
      const cyT = f ? f.y : mapH / 2;
      cam.x += (cxT - cam.x) * (1 - Math.exp(-dt * 3));
      cam.y += (cyT - cam.y) * (1 - Math.exp(-dt * 3));
      const halfW = mapW / 2 / cam.z;
      const halfH = mapH / 2 / cam.z;
      const camX = Math.max(halfW, Math.min(mapW - halfW, cam.x));
      const camY = Math.max(halfH, Math.min(mapH - halfH, cam.y));
      g.save();
      g.translate(mapW / 2, mapH / 2);
      g.scale(cam.z, cam.z);
      g.translate(-camX, -camY);

      g.drawImage(terrainRef.current.canvas, 0, 0);

      // season tint
      const ss = SEASON_STYLE[s.season];
      g.globalAlpha = ss.alpha;
      g.fillStyle = ss.tint;
      g.fillRect(0, 0, mapW, mapH);
      g.globalAlpha = 1;

      const winter = s.season === 'winter';
      for (const t of w.tiles) if (t.shelter) drawShelter(g, (t.x + 0.5) * cell, (t.y + 0.5) * cell, cell, winter || s.season === 'autumn', now);

      // agents: dead first, then alive; focused last
      const ids = [...s.order].sort((a, b) => {
        const A = s.agents[a];
        const B = s.agents[b];
        return (A?.alive ? 1 : 0) - (B?.alive ? 1 : 0) || (a === focusRef.current ? 1 : 0) - (b === focusRef.current ? 1 : 0);
      });
      const R = Math.max(5, cell * 0.42);
      for (const id of ids) {
        const a = s.agents[id];
        const p = pos[id];
        if (!a || !p) continue;
        drawAgent(g, a, p, R, now, id === focusRef.current, id === hoverRef.current, cam.z);
      }

      // speech bubbles
      g.font = `500 ${Math.max(10, Math.min(13, cell * 0.5)) / Math.sqrt(cam.z)}px "IBM Plex Sans", sans-serif`;
      const placed: Rect[] = [];
      for (const b of s.bubbles.slice(-config.maxBubbles)) {
        const p = pos[b.agentId];
        const a = s.agents[b.agentId];
        if (!p || !a) continue;
        const age = (Date.now() - b.at) / 1000;
        const alpha = Math.min(1, age * 6) * Math.min(1, (config.bubbleMs / 1000 - age) * 1.5);
        if (alpha <= 0) continue;
        const toName = b.to === 'all' ? '' : s.agents[b.to]?.name;
        const text = toName ? `@${toName} ${b.text}` : b.text;
        drawBubble(g, text, p.x, p.y - R * 1.9, alpha, cell * 6 / Math.sqrt(cam.z), roleStyle(a.role).color, placed);
      }
      g.restore();

      // snow (screen space)
      const fl = flakes.current;
      const target = winter ? Math.round((mapW * mapH) / 2600) : 0;
      while (fl.length < target) fl.push({ x: Math.random() * mapW, y: Math.random() * mapH, s: 0.6 + Math.random() * 1.8, v: 14 + Math.random() * 30, d: Math.random() * 6 });
      if (fl.length > target) fl.splice(0, Math.max(1, Math.ceil((fl.length - target) * 0.04)));
      g.fillStyle = 'rgba(240,248,255,.85)';
      for (const p of fl) {
        p.y += p.v * dt;
        p.x += Math.sin(now / 900 + p.d) * 8 * dt;
        if (p.y > mapH) { p.y = -4; p.x = Math.random() * mapW; }
        g.globalAlpha = 0.35 + p.s * 0.3;
        g.beginPath();
        g.arc(p.x, p.y, p.s, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;

      // vignette
      const vg = g.createRadialGradient(mapW / 2, mapH / 2, Math.min(mapW, mapH) * 0.35, mapW / 2, mapH / 2, Math.max(mapW, mapH) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, winter ? 'rgba(10,20,40,.55)' : 'rgba(0,0,0,.5)');
      g.fillStyle = vg;
      g.fillRect(0, 0, mapW, mapH);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [mapW, mapH, cell]);

  // reset interpolation on world reset
  useEffect(() => {
    posRef.current = {};
  }, [state.world]);

  const toWorld = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cam = camRef.current;
    const halfW = mapW / 2 / cam.z;
    const halfH = mapH / 2 / cam.z;
    const camX = Math.max(halfW, Math.min(mapW - halfW, cam.x));
    const camY = Math.max(halfH, Math.min(mapH - halfH, cam.y));
    return {
      x: (e.clientX - rect.left - mapW / 2) / cam.z + camX,
      y: (e.clientY - rect.top - mapH / 2) / cam.z + camY,
    };
  };
  const hit = (e: React.MouseEvent) => {
    const p = toWorld(e);
    let best: string | null = null;
    let bd = Math.max(10, cell * 0.6);
    for (const [id, q] of Object.entries(posRef.current)) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };

  const focused = focusId ? state.agents[focusId] : null;

  return (
    <div className="map-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="map-canvas"
        onMouseMove={(e) => {
          hoverRef.current = hit(e);
          (e.target as HTMLCanvasElement).style.cursor = hoverRef.current ? 'pointer' : 'default';
        }}
        onMouseLeave={() => (hoverRef.current = null)}
        onClick={(e) => setFocus(hit(e))}
      />
      {!state.ready && <div className="map-loading">{t.map.loading}</div>}
      <div className="map-hud">
        {focused && (
          <div className="map-chip">
            <span>{t.map.following} <b>{focused.name}</b></span>
            <button className={`chip-btn ${follow ? 'on' : ''}`} onClick={() => setFollow((f) => !f)}>{follow ? t.map.cameraFollow : t.map.cameraFree}</button>
            <button className="chip-btn" onClick={() => setFocus(null)}>✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

function drawAgent(g: CanvasRenderingContext2D, a: Agent, p: Pos, R: number, now: number, focused: boolean, hovered: boolean, z: number) {
  const rs = roleStyle(a.role);
  if (!a.alive) {
    // grave
    g.fillStyle = 'rgba(150,150,160,.55)';
    g.beginPath();
    g.moveTo(p.x - R * 0.55, p.y + R * 0.7);
    g.lineTo(p.x - R * 0.55, p.y - R * 0.2);
    g.arc(p.x, p.y - R * 0.2, R * 0.55, Math.PI, 0);
    g.lineTo(p.x + R * 0.55, p.y + R * 0.7);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(40,40,45,.8)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(p.x, p.y - R * 0.45);
    g.lineTo(p.x, p.y + R * 0.3);
    g.moveTo(p.x - R * 0.22, p.y - R * 0.18);
    g.lineTo(p.x + R * 0.22, p.y - R * 0.18);
    g.stroke();
    return;
  }
  const tier = a.tier ? TIER_STYLE[a.tier] : null;
  const bob = Math.sin(now / 380 + p.x * 0.1) * R * 0.06;
  const y = p.y + bob;

  // tier aura
  if (tier) {
    const pulse = a.tier === 'opus' ? 0.75 + Math.sin(now / 420) * 0.25 : 0.8;
    const rg = g.createRadialGradient(p.x, y, R * 0.6, p.x, y, R * (a.tier === 'opus' ? 2.3 : 1.8));
    rg.addColorStop(0, tier.glow.replace(/[\d.]+\)$/, `${(parseFloat(tier.glow.match(/[\d.]+\)$/)![0]) * pulse).toFixed(2)})`));
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(p.x, y, R * 2.4, 0, Math.PI * 2);
    g.fill();
  }
  // thinking glow
  if (a.status === 'thinking') {
    const t = (now / 1000) % 1;
    g.strokeStyle = `rgba(190,230,255,${0.6 * (1 - t)})`;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(p.x, y, R * (1.2 + t * 0.9), 0, Math.PI * 2);
    g.stroke();
  }
  // shadow
  g.fillStyle = 'rgba(0,0,0,.35)';
  g.beginPath();
  g.ellipse(p.x, p.y + R * 0.95, R * 0.75, R * 0.25, 0, 0, Math.PI * 2);
  g.fill();

  // hp ring
  const hpFrac = Math.max(0, Math.min(1, a.hp / (a.maxHp || 100)));
  g.lineWidth = Math.max(2, R * 0.22);
  g.strokeStyle = 'rgba(0,0,0,.5)';
  g.beginPath();
  g.arc(p.x, y, R * 1.08, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = hpFrac > 0.6 ? '#7ee08a' : hpFrac > 0.3 ? '#f2c14b' : '#ff5d5d';
  g.beginPath();
  g.arc(p.x, y, R * 1.08, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hpFrac);
  g.stroke();

  // body
  g.save();
  g.translate(p.x, y);
  if (a.role === 'explorer') g.rotate(Math.sin(now / 600) * 0.08);
  const body = glyphPath(rs.shape, R * 0.78);
  g.fillStyle = rs.color;
  g.fill(body);
  g.lineWidth = 1.4;
  g.strokeStyle = 'rgba(10,10,10,.7)';
  g.stroke(body);
  g.restore();

  // tier emblem above
  if (tier) {
    const ey = y - R * 1.55;
    g.fillStyle = tier.color;
    if (a.tier === 'opus') {
      const s = R * 0.55;
      g.beginPath();
      g.moveTo(p.x - s, ey + s * 0.45);
      g.lineTo(p.x - s * 0.85, ey - s * 0.5);
      g.lineTo(p.x - s * 0.35, ey);
      g.lineTo(p.x, ey - s * 0.75);
      g.lineTo(p.x + s * 0.35, ey);
      g.lineTo(p.x + s * 0.85, ey - s * 0.5);
      g.lineTo(p.x + s, ey + s * 0.45);
      g.closePath();
      g.fill();
    } else if (a.tier === 'sonnet') {
      g.beginPath();
      g.arc(p.x, ey, R * 0.26, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(11,15,13,.9)';
      g.beginPath();
      g.arc(p.x + R * 0.12, ey - R * 0.06, R * 0.2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.arc(p.x, ey + R * 0.1, R * 0.17, 0, Math.PI * 2);
      g.fill();
    }
  }

  if (a.sheltered) {
    g.fillStyle = 'rgba(255,207,115,.9)';
    g.beginPath();
    g.arc(p.x + R * 0.95, y - R * 0.85, R * 0.18, 0, Math.PI * 2);
    g.fill();
  }

  if (focused || hovered) {
    g.strokeStyle = focused ? '#fff4d6' : 'rgba(255,244,214,.5)';
    g.lineWidth = 1.5;
    g.setLineDash([4, 3]);
    g.lineDashOffset = -now / 60;
    g.beginPath();
    g.arc(p.x, y, R * 1.55, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  }

  // name label
  const fs = Math.max(9, R * 0.95) / Math.sqrt(z);
  g.font = `600 ${fs}px "IBM Plex Sans", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.fillStyle = 'rgba(0,0,0,.6)';
  g.fillText(a.name, p.x + 0.8, y + R * 1.35 + 0.8);
  g.fillStyle = focused ? '#fff4d6' : 'rgba(240,235,220,.9)';
  g.fillText(a.name, p.x, y + R * 1.35);
}

function drawBubble(g: CanvasRenderingContext2D, text: string, x: number, y: number, alpha: number, maxW: number, accent: string, placed: Rect[]) {
  const lines = wrap(g, text, Math.max(90, maxW), 3);
  const lh = parseFloat(g.font.match(/([\d.]+)px/)?.[1] ?? '12') * 1.3;
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 14;
  const h = lines.length * lh + 10;
  const bx = x - w / 2;
  let by = y - h;
  // stack upward instead of overlapping earlier bubbles
  for (let guard = 0; guard < 6; guard++) {
    const hit = placed.find((r) => bx < r.x + r.w && bx + w > r.x && by < r.y + r.h && by + h > r.y);
    if (!hit) break;
    by = hit.y - h - 6;
  }
  placed.push({ x: bx, y: by, w, h });
  const tailY = Math.min(y, by + h);
  g.globalAlpha = alpha;
  g.fillStyle = 'rgba(244,236,214,.96)';
  g.beginPath();
  g.roundRect(bx, by, w, h, 7);
  g.moveTo(x - 5, tailY);
  g.lineTo(x, tailY + 6);
  g.lineTo(x + 5, tailY);
  g.fill();
  g.fillStyle = accent;
  g.fillRect(bx + 3, by + 4, 2, h - 8);
  g.fillStyle = '#1c1a16';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  lines.forEach((l, i) => g.fillText(l, bx + 9, by + 5 + i * lh));
  g.globalAlpha = 1;
}
