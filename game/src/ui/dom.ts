/** Minimal DOM builder used by the overlay components. */
type Attrs = Record<string, string | number | boolean | ((ev: Event) => void) | undefined | null>;
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const uiRoot = () => document.getElementById('ui')!;

/** True when keystrokes belong to a text field, not the game. */
export function isTyping(ev: KeyboardEvent): boolean {
  const t = ev.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function fmtClock(minute: number): string {
  const m = Math.floor(minute);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Run `fn` at most every `ms` milliseconds (trailing call guaranteed). */
export function throttle(fn: () => void, ms: number): () => void {
  let last = 0;
  let timer: number | null = null;
  return () => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn();
    } else if (timer === null) {
      timer = window.setTimeout(() => {
        timer = null;
        last = performance.now();
        fn();
      }, ms - (now - last));
    }
  };
}
