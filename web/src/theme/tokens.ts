import type { Biome, Season, Tier } from '../types';
import { roleLabel, t } from '../i18n';

// Visual vocabulary shared by canvas + DOM. Change the look here.

export type Shape = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'hex';

export const ROLE_STYLE: Record<string, { color: string; shape: Shape; label: string }> = {
  gatherer: { color: '#f2b84b', shape: 'circle', label: t.roles.gatherer },
  builder: { color: '#e9784e', shape: 'square', label: t.roles.builder },
  explorer: { color: '#5fcde4', shape: 'triangle', label: t.roles.explorer },
  elder: { color: '#b9a2f5', shape: 'diamond', label: t.roles.elder },
  healer: { color: '#f283ad', shape: 'cross', label: t.roles.healer },
};
export const FALLBACK_ROLE = { color: '#d7d2c4', shape: 'hex' as Shape, label: t.roleFallback };
export const roleStyle = (role: string) => ROLE_STYLE[role] ?? { ...FALLBACK_ROLE, label: roleLabel(role) };

// color/glow = metallic identity on map & badges; chart = validated categorical series color (dark surface).
export const TIER_STYLE: Record<Tier, { color: string; glow: string; chart: string; label: string; cost: string; rank: number }> = {
  opus: { color: '#f6cf6e', glow: 'rgba(246,207,110,0.55)', chart: '#b8891f', label: t.tiers.opus, cost: '$$$', rank: 3 },
  sonnet: { color: '#cfd8e4', glow: 'rgba(207,216,228,0.40)', chart: '#4f86d6', label: t.tiers.sonnet, cost: '$$', rank: 2 },
  haiku: { color: '#cf8d57', glow: 'rgba(207,141,87,0.38)', chart: '#c0532f', label: t.tiers.haiku, cost: '$', rank: 1 },
};

export const BIOME_COLOR: Record<Biome, [number, number, number]> = {
  grass: [52, 78, 46],
  forest: [27, 52, 34],
  water: [22, 46, 70],
  rock: [64, 62, 66],
};

export const SEASON_STYLE: Record<Season, { tint: string; alpha: number; label: string; accent: string; glyph: string }> = {
  spring: { tint: '#b7f08c', alpha: 0.05, label: t.seasons.spring, accent: '#a5e07f', glyph: '✿' },
  summer: { tint: '#ffd36b', alpha: 0.07, label: t.seasons.summer, accent: '#f7c65a', glyph: '☀' },
  autumn: { tint: '#ff8c3a', alpha: 0.12, label: t.seasons.autumn, accent: '#f0904a', glyph: '❦' },
  winter: { tint: '#cfe6ff', alpha: 0.26, label: t.seasons.winter, accent: '#bfe0ff', glyph: '❄' },
};

export const FEED_STYLE: Record<string, { color: string; label: string }> = {
  action: { color: '#8c9aa0', label: t.feed.kinds.action },
  message: { color: '#e9d8a6', label: t.feed.kinds.message },
  birth: { color: '#9be38f', label: t.feed.kinds.birth },
  death: { color: '#ff6b6b', label: t.feed.kinds.death },
  season: { color: '#bfe0ff', label: t.feed.kinds.season },
  rules: { color: '#f6cf6e', label: t.feed.kinds.rules },
  build: { color: '#e9784e', label: t.feed.kinds.build },
  starvation: { color: '#ff9f6b', label: t.feed.kinds.starvation },
  cold: { color: '#9ccfff', label: t.feed.kinds.cold },
};

export const CHART_SERIES = {
  population: { color: '#f2ead3', label: t.charts.population },
  food: { color: '#f2b84b', label: t.charts.food },
  wood: { color: '#a07b52', label: t.charts.wood },
  avgHp: { color: '#ff7b8a', label: t.charts.avgHp },
} as const;
