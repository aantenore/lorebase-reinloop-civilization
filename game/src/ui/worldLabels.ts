import { h } from './dom';

/** Overlay elements that world labels must never cover. */
const OBSTACLE_SELECTOR = '#ui .px, #ui .toolbar';
/** Minimum distance of a bubble from the viewport edge (px). */
const EDGE = 8;

export interface Anchor {
  /** Returns world-pixel position, or null when the anchor is gone. */
  pos(): { x: number; y: number } | null;
}

interface Label {
  el: HTMLElement;
  anchor: Anchor;
  dy: number;
  until: number;
}

/**
 * Crisp DOM text anchored to world positions (speech bubbles, name tags, floating numbers).
 * Kept out of the canvas so text stays readable at every zoom level.
 */
export class WorldLabels {
  private root = document.getElementById('labels')!;
  private bubbles = new Map<string, Label>();
  private tags = new Map<string, Label>();
  private floaters: Label[] = [];

  bubble(id: string, anchor: Anchor, text: string, opts: { kind?: 'speech' | 'thought' | 'stream' | 'consult' | 'offer' | 'offer-ok' | 'offer-no'; to?: string; ms?: number; dy?: number } = {}): void {
    let b = this.bubbles.get(id);
    if (!b) {
      b = { el: h('div', { class: 'bubble' }), anchor, dy: -46, until: 0 };
      this.root.append(b.el);
      this.bubbles.set(id, b);
    }
    b.anchor = anchor;
    b.dy = opts.dy ?? -46;
    b.el.className = `bubble ${opts.kind ?? 'speech'}`;
    b.el.replaceChildren(...(opts.to ? [h('span', { class: 'to' }, `→ ${opts.to} `)] : []), text.length > 140 ? `${text.slice(0, 137)}…` : text);
    b.until = performance.now() + (opts.ms ?? Math.min(9000, 2600 + text.length * 55));
  }

  /** Name tag with a tiny health bar; pass anchor=null to remove. Only touches the DOM when content changes. */
  tag(id: string, anchor: Anchor | null, name = '', pct = 100): void {
    let t = this.tags.get(id);
    if (!anchor) {
      if (t) {
        t.el.remove();
        this.tags.delete(id);
      }
      return;
    }
    if (!t) {
      t = { el: h('div', { class: 'tag' }), anchor, dy: -42, until: Infinity };
      this.root.append(t.el);
      this.tags.set(id, t);
    }
    t.anchor = anchor;
    const sig = `${name}|${Math.round(pct)}`;
    if (t.el.dataset.sig !== sig) {
      t.el.dataset.sig = sig;
      t.el.replaceChildren(name, h('span', { class: 'mini' }, h('i', { style: `width:${Math.round(pct)}%` })));
    }
  }

  /** True while a bubble with this key is on screen. */
  hasBubble(id: string): boolean {
    return this.bubbles.has(id);
  }

  floater(anchor: Anchor, text: string | (Node | string)[], color: string, ms = 1400): void {
    const el = h('div', { class: 'floater', style: `color:${color};animation-duration:${ms}ms` }, ...(Array.isArray(text) ? text : [text]));
    this.root.append(el);
    this.floaters.push({ el, anchor, dy: -34 - this.floaters.length * 4, until: performance.now() + ms });
  }

  /** Content that flies from one anchor to another (a gift or a barter changing hands). */
  traveler(from: Anchor, to: Anchor, content: (Node | string)[], ms = 1300): void {
    const el = h('div', { class: 'traveler' }, ...content);
    this.root.append(el);
    this.travelers.push({ el, from, to, start: performance.now(), ms });
  }

  private travelers: { el: HTMLElement; from: Anchor; to: Anchor; start: number; ms: number }[] = [];

  /** Screen rects of open overlay panels, refreshed a few times per second. */
  private obstacles: DOMRect[] = [];
  private obstaclesAt = 0;

  private refreshObstacles(now: number): void {
    if (now - this.obstaclesAt < 150) return;
    this.obstaclesAt = now;
    this.obstacles = [...document.querySelectorAll<HTMLElement>(OBSTACLE_SELECTOR)]
      .filter((el) => !el.closest('.hidden'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
  }

  private underPanel(x: number, y: number): boolean {
    return this.obstacles.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  private overlapsPanel(l: number, t: number, w: number, h: number): boolean {
    return this.obstacles.some((r) => l < r.right && l + w > r.left && t < r.bottom && t + h > r.top);
  }

  /** Reposition everything. `toScreen` maps world pixels to CSS pixels. */
  update(toScreen: (x: number, y: number) => { x: number; y: number }, zoom: number): void {
    const now = performance.now();
    this.refreshObstacles(now);
    const vw = this.root.clientWidth;
    const vh = this.root.clientHeight;
    /** Anchored labels: centred above the anchor, hidden when the anchor is under a panel. */
    const place = (l: Label, extra = 0) => {
      const p = l.anchor.pos();
      if (!p) return false;
      const s = toScreen(p.x, p.y);
      const y = s.y + (l.dy + extra) * zoom;
      l.el.style.left = `${Math.round(s.x)}px`;
      l.el.style.top = `${Math.round(y)}px`;
      l.el.classList.toggle('occluded', this.underPanel(s.x, s.y - 10 * zoom));
      return true;
    };
    /** Bubbles: clamped inside the viewport, tail kept on the speaker, faded where they overlap a panel. */
    const placeBubble = (l: Label) => {
      const p = l.anchor.pos();
      if (!p) return false;
      const s = toScreen(p.x, p.y);
      const w = l.el.offsetWidth;
      const h = l.el.offsetHeight;
      const ax = s.x;
      const ay = s.y + l.dy * zoom;
      const left = Math.max(EDGE, Math.min(vw - w - EDGE, ax - w / 2));
      const top = Math.max(EDGE, Math.min(vh - h - EDGE, ay - h));
      l.el.style.left = `${Math.round(left)}px`;
      l.el.style.top = `${Math.round(top)}px`;
      l.el.style.setProperty('--tail', `${Math.round(Math.max(8, Math.min(w - 8, ax - left)))}px`);
      const hidden = this.underPanel(ax, s.y - 10 * zoom) || ax < 0 || ax > vw || s.y < 0 || s.y > vh;
      l.el.classList.toggle('occluded', hidden);
      l.el.classList.toggle('behind', !hidden && this.overlapsPanel(left, top, w, h));
      return true;
    };
    for (const [id, b] of this.bubbles) {
      if (now > b.until || !placeBubble(b)) {
        b.el.remove();
        this.bubbles.delete(id);
      }
    }
    for (const [id, t] of this.tags) {
      if (!place(t, 0)) {
        t.el.remove();
        this.tags.delete(id);
      } else t.el.style.visibility = this.bubbles.has(id) ? 'hidden' : 'visible';
    }
    this.travelers = this.travelers.filter((tr) => {
      const a = tr.from.pos();
      const b = tr.to.pos();
      const k = (now - tr.start) / tr.ms;
      if (k >= 1 || !a || !b) {
        tr.el.remove();
        return false;
      }
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const sa = toScreen(a.x, a.y);
      const sb = toScreen(b.x, b.y);
      const arc = Math.sin(Math.PI * e) * 26 * zoom;
      tr.el.style.left = `${Math.round(sa.x + (sb.x - sa.x) * e)}px`;
      tr.el.style.top = `${Math.round(sa.y + (sb.y - sa.y) * e - 22 * zoom - arc)}px`;
      tr.el.style.opacity = String(k < 0.1 ? k * 10 : k > 0.85 ? (1 - k) / 0.15 : 1);
      return true;
    });
    this.floaters = this.floaters.filter((f) => {
      if (now > f.until || !place(f)) {
        f.el.remove();
        return false;
      }
      return true;
    });
  }

  clearAll(): void {
    this.root.replaceChildren();
    this.bubbles.clear();
    this.tags.clear();
    this.floaters = [];
    this.travelers = [];
  }
}
