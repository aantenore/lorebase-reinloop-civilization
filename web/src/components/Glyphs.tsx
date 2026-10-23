import { t as tr } from '../i18n';
import { roleStyle, TIER_STYLE } from '../theme/tokens';
const tierTitle = tr.tierTitle;
import type { Shape } from '../theme/tokens';
import type { Tier } from '../types';

export function shapePath(shape: Shape, r: number): string {
  switch (shape) {
    case 'circle':
      return `M ${-r} 0 a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
    case 'square':
      return `M ${-r * 0.85} ${-r * 0.85} h ${r * 1.7} v ${r * 1.7} h ${-r * 1.7} z`;
    case 'triangle':
      return `M 0 ${-r} L ${r * 0.95} ${r * 0.75} L ${-r * 0.95} ${r * 0.75} z`;
    case 'diamond':
      return `M 0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 z`;
    case 'cross': {
      const t = r * 0.38;
      return `M ${-t} ${-r} h ${2 * t} v ${r - t} h ${r - t} v ${2 * t} h ${-(r - t)} v ${r - t} h ${-2 * t} v ${-(r - t)} h ${-(r - t)} v ${-2 * t} h ${r - t} z`;
    }
    case 'hex':
    default: {
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        return `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
      });
      return `M ${pts.join(' L ')} z`;
    }
  }
}

export function RoleGlyph({ role, size = 18, dead = false }: { role: string; size?: number; dead?: boolean }) {
  const st = roleStyle(role);
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20" aria-label={st.label} role="img">
      <path d={shapePath(st.shape, 7)} fill={dead ? '#55585c' : st.color} stroke="rgba(0,0,0,.45)" strokeWidth={1.2} />
    </svg>
  );
}

export function TierBadge({ tier, compact = false }: { tier?: Tier; compact?: boolean }) {
  if (!tier) return null;
  const t = TIER_STYLE[tier];
  return (
    <span className={`tier-badge tier-${tier}`} title={tierTitle(t.label)}>
      <TierMark tier={tier} />
      {!compact && t.label}
    </span>
  );
}

/** Tiny emblem: crown (opus), half-moon (sonnet), leaf/dot (haiku). */
export function TierMark({ tier, size = 11 }: { tier: Tier; size?: number }) {
  const c = TIER_STYLE[tier].color;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      {tier === 'opus' && <path d="M1 9 L1.8 3.2 L4.3 6 L6 2 L7.7 6 L10.2 3.2 L11 9 Z" fill={c} />}
      {tier === 'sonnet' && <path d="M6 1.5 A4.5 4.5 0 1 0 10.5 6 A3.4 3.4 0 1 1 6 1.5 Z" fill={c} />}
      {tier === 'haiku' && <circle cx="6" cy="6" r="3.2" fill={c} />}
    </svg>
  );
}
