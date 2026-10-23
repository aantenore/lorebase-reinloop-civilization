import { hash, P } from '../render/palette';
import { makeCanvas, Pix } from '../render/pixel';

/**
 * Procedural pixel icons for any item code. Known families (matched on the code or its display
 * name, Italian or English) get a hand-made shape; anything else gets a stable hashed sack/gem.
 */
type Shape = (p: Pix, c: string[]) => void;

const S = 10;

/** Draw rows of characters: each char indexes the colour list ('.' = empty). */
function art(p: Pix, rows: string[], c: string[], ox = 0, oy = 0): void {
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const i = '0123456789'.indexOf(ch);
      if (i >= 0 && c[i]) p.set(ox + x, oy + y, c[i]);
    }),
  );
}

const SHAPES: { test: RegExp; colors: string[]; draw: Shape }[] = [
  {
    test: /smok|affum/,
    colors: ['#7a3a22', '#a8562e', '#e8d8c0', '#5a2a18'],
    draw: (p, c) => art(p, ['......22..', '.....2232.', '....0012..', '...0110...', '..01110...', '.01110....', '.0110.....', '..00......'], c, 0, 1),
  },
  {
    test: /meat|carn|hunt|selvagg/,
    colors: ['#a8321f', '#e2512f', '#f2e6d8', '#ff9a8a'],
    draw: (p, c) => art(p, ['......22..', '.....2222.', '....0012..', '...0131...', '..01110...', '.01110....', '.0110.....', '..00......'], c, 0, 1),
  },
  {
    test: /berr|bacc|food|cibo|fruit|frutt/,
    colors: [P.berry, P.berryLight, '#4fa65a', '#a8203a'],
    draw: (p, c) => art(p, ['....2.....', '...22.2...', '..00.22...', '.0100.00..', '.0003010..', '..00.000..', '...000....', '..01003...', '..0003....'], c, 0, 1),
  },
  {
    test: /herb|erb|leaf|fogli|medic/,
    colors: ['#2d6e43', '#4fa65a', '#86cc63', '#7a4c2c'],
    draw: (p, c) => art(p, ['......12..', '....1122..', '...1121...', '..1121....', '..121.....', '.121......', '.3........', '3.........'], c, 1, 1),
  },
  {
    test: /axe|asci|hatchet|tool|attrezz|utensil/,
    colors: ['#77737f', '#a7a4b0', '#8b5a32', '#d6a670'],
    draw: (p, c) => art(p, ['..001.....', '.0011.....', '.00132....', '..0.32....', '.....32...', '......32..', '.......32.', '........3.'], c, 0, 1),
  },
  {
    test: /pot|vas|ceram|jar|anfor|urn/,
    colors: ['#a8602e', '#d8894a', '#f2b07a', '#6e3c1c'],
    draw: (p, c) => art(p, ['..3333....', '...00.....', '..0120....', '.012210...', '.012210...', '.011110...', '..0110....', '..3333....'], c, 1, 1),
  },
  {
    test: /basket|cest|weav|intrecc/,
    colors: ['#a77c34', '#e2b85e', '#c79a46', '#7f5c28'],
    draw: (p, c) => art(p, ['..3333....', '.3....3...', '30101010..', '01212121..', '12121210..', '.212121...', '..0000....'], c, 0, 2),
  },
  {
    test: /rope|cord|fiber|fibr|string|spag/,
    colors: ['#c9a272', '#e0bf8c', '#8c6440', '#b08656'],
    draw: (p, c) => art(p, ['..0110....', '.0.22.0...', '1.2..2.1..', '1.2.32.1..', '1.2..2.1..', '.0.22.0...', '..0110.3..', '.......3..'], c, 0, 1),
  },
  {
    test: /poult|impiastr|salv|balm|unguent|bend/,
    colors: ['#e6e0d6', '#b8b0a4', '#d8344a', '#4fa65a'],
    draw: (p, c) => art(p, ['...33.....', '..0000....', '.011110...', '.012210...', '.022220...', '.012210...', '.011110...', '..0000....'], c, 1, 1),
  },
  {
    test: /clay|argill|mud|fang/,
    colors: ['#9a5a3a', '#c07a4a', '#e0a070', '#6e3c24'],
    draw: (p, c) => art(p, ['...122....', '..11220...', '.0111110..', '00111100..', '0001100033', '.00000033.'], c, 0, 3),
  },
  {
    test: /stone|pietr|rock|roccia|flint|selce|ston/,
    colors: [P.rock[3], P.rock[1], P.rock[2], P.rock[4]],
    draw: (p, c) => art(p, ['...112....', '..01122...', '.0011120..', '.0001110..', '30000100..', '.3330000..'], c, 0, 3),
  },
  {
    test: /wood|legn|log|tronc|plank|asse/,
    colors: [P.log[0], P.log[1], P.log[2], P.log[3]],
    draw: (p, c) => art(p, ['..........', '3200000...', '3320000...', '.21111111.', '3200000...', '3320000...', '.21111111.'], c, 0, 2),
  },
  {
    test: /fire|fuoc|charcoal|carbon/,
    colors: [P.fire[3], P.fire[2], P.fire[1], P.fire[0]],
    draw: (p, c) => art(p, ['....3.....', '...23.....', '..122.3...', '..1232....', '.011220...', '.012210...', '..0110....'], c, 1, 1),
  },
];

/** Hashed fallback: a tied sack in a stable colour. */
function fallback(p: Pix, code: string): void {
  const hues = ['#c58ad8', '#6fb5f0', '#86cc63', '#e8a92a', '#d0607a', '#4ab0a0', '#d8894a', '#a9b4c2'];
  const base = hues[hash(code) % hues.length];
  art(p, ['...33.....', '....3.....', '..0000....', '.000110...', '.001110...', '.000110...', '..0000....'], [base, '#ffffff', '', P.log[1]], 1, 1);
}

const cache = new Map<string, string>();

/** Data URL of the icon for an item code (cached). `hint` (display name) helps matching. */
export function itemIconUrl(code: string, hint = ''): string {
  const key = `${code}|${hint}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = new Pix(S, S);
  const probe = `${code} ${hint}`.toLowerCase();
  const shape = SHAPES.find((s) => s.test.test(probe));
  if (shape) shape.draw(p, shape.colors);
  else fallback(p, code);
  p.outline(P.outline);
  const { canvas, ctx } = makeCanvas(S, S);
  p.blit(ctx);
  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}

export function itemIcon(code: string, hint = '', cls = 'ico item-ico'): HTMLImageElement {
  const img = document.createElement('img');
  img.src = itemIconUrl(code, hint);
  img.className = cls;
  img.alt = hint || code;
  img.title = hint || code;
  return img;
}
