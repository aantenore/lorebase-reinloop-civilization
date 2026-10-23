/** Limited shared palette: every procedural texture picks from here so the world reads as one piece. */
export const P = {
  outline: '#2a1d2b',
  outlineSoft: '#3d2b3a',
  white: '#fbf5ef',
  black: '#17111a',

  grass: ['#4f9447', '#5ea94f', '#6fbb57', '#86cc63'],
  grassDark: '#3b733f',
  grassAutumn: ['#6f9a45', '#7ea84c', '#90b256', '#b2b85e'],
  forestFloor: ['#2f5c37', '#36683c', '#3e7442', '#4a8248'],
  dirt: ['#8a5a3c', '#744a32', '#5e3b2c', '#47302a'],
  sand: ['#d9b77e', '#e4c58c', '#edd49e', '#c9a46a'],
  rock: ['#7d7a88', '#8f8c99', '#a7a4b0', '#625f6e', '#4b4858'],
  water: ['#2f63b8', '#3874c9', '#4a8bd9', '#77b6ec', '#c5ecfb'],
  ice: ['#a9d3ea', '#bfe1f2', '#d6eef8', '#8fbcd8'],
  snow: ['#e6edf6', '#f4f8fc', '#ffffff', '#c3d1e6', '#a5b8d4'],

  trunk: ['#7a4c2c', '#5d3820', '#9a6a3f'],
  leaf: ['#2d6e43', '#3a8a4f', '#4fa65a', '#6fc265'],
  leafAutumn: ['#a8481f', '#c8642a', '#e08a35', '#f2b84b'],
  blossom: '#f4a8c0',
  berry: '#d8344a',
  berryLight: '#ff7088',
  flowerY: '#f6d84a',
  flowerW: '#fbf5ef',
  flowerP: '#c58ad8',

  hide: ['#c9a272', '#b08656', '#e0bf8c', '#8c6440'],
  thatch: ['#c79a46', '#a77c34', '#e2b85e', '#7f5c28'],
  log: ['#8b5a32', '#6b4429', '#b07a46', '#d6a670'],
  fire: ['#fff3a8', '#ffd24a', '#ff9a3c', '#e2512f', '#a8321f'],
  stone: ['#77737f', '#9a96a2', '#55525f'],

  skin: ['#f2c8a0', '#e0a979', '#b97a4f', '#8a5636'],
  hair: ['#3a2a22', '#6b3f24', '#c9a050', '#d8d2c8', '#a3402a', '#22202e'],

  gold: ['#ffd84a', '#e8a92a', '#fff2a0', '#a8701c'],
  silver: ['#dfe6ee', '#a9b4c2', '#ffffff', '#6f7a8a'],
  bronze: ['#d8894a', '#a8602e', '#f2b07a', '#6e3c1c'],
};

/** Shirt / pants palettes per role. Unknown roles get a stable hashed pick. */
export const ROLE_COLORS: Record<string, { shirt: [string, string]; pants: string; accent: string }> = {
  chief: { shirt: ['#b8323a', '#86222c'], pants: '#3d2b3a', accent: '#ffd84a' },
  elder: { shirt: ['#6f4aa8', '#4f3480'], pants: '#3a3046', accent: '#d8d2c8' },
  gatherer: { shirt: ['#d98a2b', '#a8641c'], pants: '#5b4636', accent: '#d8344a' },
  forager: { shirt: ['#d98a2b', '#a8641c'], pants: '#5b4636', accent: '#d8344a' },
  woodcutter: { shirt: ['#3f7d4a', '#2c5a36'], pants: '#5a3a2a', accent: '#c08a52' },
  builder: { shirt: ['#c9a040', '#9a7428'], pants: '#4a4a5a', accent: '#8b5a32' },
  healer: { shirt: ['#e6e0d6', '#b8b0a4'], pants: '#5a7a8a', accent: '#d8344a' },
  scout: { shirt: ['#3a7aa8', '#285a80'], pants: '#3d3a2e', accent: '#86cc63' },
  hunter: { shirt: ['#7a5a3a', '#5a3f28'], pants: '#3a3028', accent: '#c9a272' },
  farmer: { shirt: ['#a8b84a', '#7f8c34'], pants: '#5a4a3a', accent: '#f6d84a' },
  villager: { shirt: ['#9a8a74', '#76685a'], pants: '#4e4640', accent: '#c9a272' },
  human: { shirt: ['#2f8fd8', '#1f68a8'], pants: '#2a2a3a', accent: '#ff7088' },
};
const EXTRA_SHIRTS: [string, string][] = [
  ['#d0607a', '#a2445a'],
  ['#4ab0a0', '#33807a'],
  ['#8a6ad0', '#644aa2'],
  ['#e07a3a', '#b0582a'],
  ['#6a8ad8', '#4a68a8'],
];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function roleColors(role: string) {
  const r = ROLE_COLORS[role.toLowerCase()];
  if (r) return r;
  const h = hash(role);
  return { shirt: EXTRA_SHIRTS[h % EXTRA_SHIRTS.length], pants: '#3d3a46', accent: '#ffd84a' };
}

export function hexToInt(c: string): number {
  return parseInt(c.replace('#', '').slice(0, 6), 16);
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Family colours: the server's (`family.color`) when sent, else stable per family id. */
const FAMILY_COLORS = ['#e8b04a', '#5ac0a8', '#d86aa0', '#7a9ae8', '#c8d860', '#e07a5a', '#a07ad8', '#60c0e0'];

export function familyColor(id: string, color?: string): string {
  return color ?? FAMILY_COLORS[hash(id) % FAMILY_COLORS.length];
}

/** Opinion score (-1..1) to a red -> grey -> green colour. */
export function scoreColor(score: number): string {
  const s = Math.max(-1, Math.min(1, score));
  const mix = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
  const [r, g, b] = s < 0 ? [mix(150, 230, -s), mix(140, 80, -s), mix(150, 60, -s)] : [mix(150, 110, s), mix(140, 210, s), mix(150, 90, s)];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
