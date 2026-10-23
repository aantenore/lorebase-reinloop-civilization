import type { AgeStage, Anim, Dir, EntityKind } from '../net/protocol';
import { P, hash, roleColors } from './palette';
import { addStrip, Pix } from './pixel';
import { darken, lighten } from './textures';

/** Frame layout inside each character strip (per view). */
export const CHAR_W = 28;
export const CHAR_H = 30;
/** Ground line (feet) inside the frame, used as sprite origin. */
export const CHAR_FEET = 28;
const FRAMES_PER_VIEW = 11;
const FRAME = { idle: [0, 1], walk: [2, 3, 4, 5], work: [6, 7], eat: [8, 9], sleep: [10] } as const;

type ArmPose = 'down' | 'fwd' | 'back' | 'up' | 'swing' | 'mouth';
interface Pose {
  bob: number;
  liftL: number;
  liftR: number;
  armL: ArmPose;
  armR: ArmPose;
  tool: 'axe' | 'berry' | null;
  eyesClosed?: boolean;
}

interface Look {
  skin: string;
  hair: string;
  style: number;
  shirt: [string, string];
  pants: string;
  accent: string;
  /** Elders lean on a walking stick. */
  cane?: boolean;
}

const CX = 14;

function drawArm(p: Pix, side: -1 | 1, pose: ArmPose, look: Look, bob: number, front: boolean) {
  const x = side < 0 ? CX - 7 : CX + 5;
  const top = 16 + bob;
  const sleeve = side < 0 ? look.shirt[0] : look.shirt[1];
  const hand = look.skin;
  switch (pose) {
    case 'down':
    case 'fwd':
    case 'back': {
      const dy = pose === 'fwd' ? -1 : pose === 'back' ? 1 : 0;
      p.rect(x, top + dy, 2, 4, sleeve);
      p.rect(x, top + 4 + dy, 2, 2, hand);
      break;
    }
    case 'up':
      p.rect(x, top - 4, 2, 5, sleeve);
      p.rect(x, top - 6, 2, 2, hand);
      break;
    case 'swing':
      p.rect(x, top, 2, 3, sleeve);
      p.rect(x + side, top + 3, 2, 2, hand);
      break;
    case 'mouth':
      p.rect(x, top, 2, 3, sleeve);
      p.rect(x - side * 2, top - 1, 2, 2, hand);
      break;
  }
  void front;
}

function drawTool(p: Pix, pose: Pose, bob: number) {
  const hx = CX + 6;
  if (pose.tool === 'axe') {
    if (pose.armR === 'up') {
      p.line(hx, 9 + bob, hx + 2, 3 + bob, P.log[1]);
      p.rect(hx + 1, 1 + bob, 4, 3, P.stone[1]);
      p.set(hx + 4, 1 + bob, P.white);
    } else {
      p.line(hx + 1, 20 + bob, hx + 6, 17 + bob, P.log[1]);
      p.rect(hx + 5, 18 + bob, 3, 4, P.stone[1]);
      p.set(hx + 7, 18 + bob, P.white);
    }
  } else if (pose.tool === 'berry') {
    p.rect(CX + 1, 13 + bob, 2, 2, P.berry);
    p.set(CX + 1, 13 + bob, P.berryLight);
  }
}

function drawHead(p: Pix, look: Look, bob: number, back: boolean, eyesClosed: boolean) {
  const cy = 9 + bob;
  const style = look.style;
  const hairLight = lighten(look.hair, 0.1);
  p.ellipse(CX - 0.5 + 0.5, cy + 0.5, 6.6, 6.1, (nx, ny) => {
    if (back) return ny > 0.55 && Math.abs(nx) < 0.5 && style !== 1 ? darken(look.skin, 0.08) : nx < -0.3 && ny < -0.3 ? hairLight : look.hair;
    // Hair line per style (front view).
    const fringe = ny < -0.25 + (Math.abs(nx) > 0.75 ? 0.6 : 0) + (nx > 0.1 && nx < 0.5 ? 0.12 : 0);
    const longSides = style === 1 && Math.abs(nx) > 0.72 && ny < 0.8;
    if (style === 3) return ny < -0.75 ? look.hair : nx > 0.55 ? darken(look.skin, 0.08) : look.skin;
    if (fringe || longSides) return nx < -0.3 && ny < -0.3 ? hairLight : look.hair;
    return nx > 0.6 ? darken(look.skin, 0.08) : look.skin;
  });
  if (style === 2) {
    p.ellipse(CX, cy - 6.5, 2.6, 2.2, look.hair);
    p.set(CX - 1, cy - 7, hairLight);
  }
  if (back) return;
  // eyes shifted one pixel toward the facing side (right in the base view)
  const ey = cy + 1;
  if (eyesClosed) {
    p.rect(CX - 3, ey + 1, 2, 1, P.outline);
    p.rect(CX + 2, ey + 1, 2, 1, P.outline);
  } else {
    p.rect(CX - 2, ey, 1, 2, P.black);
    p.rect(CX + 3, ey, 1, 2, P.black);
    p.set(CX - 2, ey, '#4a3a5a');
    p.set(CX + 3, ey, '#4a3a5a');
  }
  p.set(CX - 4, ey + 2, '#f09a9a');
  p.set(CX + 4, ey + 2, '#f09a9a');
  if (style === 3) {
    // beard
    p.rect(CX - 3, ey + 3, 7, 2, look.hair);
    p.rect(CX - 2, ey + 5, 5, 1, look.hair);
    p.set(CX, ey + 6, look.hair);
  }
}

function drawBody(p: Pix, look: Look, bob: number, back: boolean) {
  const top = 15 + bob;
  for (let y = top; y < 23; y++) {
    for (let x = CX - 5; x < CX + 5; x++) {
      const right = x >= CX + 2;
      p.set(x, y, right ? look.shirt[1] : look.shirt[0]);
    }
  }
  // belt + accent sash
  p.rect(CX - 5, 22, 10, 1, darken(look.pants, 0.1));
  if (!back) {
    p.line(CX - 4, top + 1, CX + 2, 21, look.accent);
    p.set(CX - 1, top, lighten(look.shirt[0], 0.12));
    p.set(CX, top, lighten(look.shirt[0], 0.12));
  } else {
    p.line(CX + 3, top + 1, CX - 3, 21, darken(look.accent, 0.1));
  }
}

function drawLegs(p: Pix, look: Look, liftL: number, liftR: number) {
  const leg = (x: number, lift: number) => {
    p.rect(x, 23, 3, 4 - lift, look.pants);
    p.rect(x, 27 - lift, 3, 1, P.log[1]);
  };
  leg(CX - 4, liftL);
  leg(CX + 1, liftR);
}

function drawCane(p: Pix, bob: number) {
  const x = CX - 8;
  p.line(x, 17 + bob, x, 27, P.log[1]);
  p.set(x + 1, 16 + bob, P.log[1]);
  p.set(x + 2, 16 + bob, P.log[0]);
}

function drawFigure(look: Look, pose: Pose, back: boolean): Pix {
  const p = new Pix(CHAR_W, CHAR_H);
  const b = pose.bob;
  if (back) {
    drawLegs(p, look, pose.liftL, pose.liftR);
    drawBody(p, look, b, true);
    drawArm(p, -1, pose.armL, look, b, false);
    drawArm(p, 1, pose.armR, look, b, false);
    drawTool(p, pose, b);
    drawHead(p, look, b, true, false);
  } else {
    drawTool(p, pose, b);
    drawLegs(p, look, pose.liftL, pose.liftR);
    drawBody(p, look, b, false);
    drawHead(p, look, b, false, !!pose.eyesClosed);
    drawArm(p, -1, pose.armL, look, b, true);
    drawArm(p, 1, pose.armR, look, b, true);
    if (pose.tool === 'berry') drawTool(p, pose, b);
  }
  if (look.cane && !pose.tool) drawCane(p, b);
  p.outline(P.outline);
  return p;
}

/** Lying pose: the idle figure rotated 90 degrees, resting on the ground line. */
function sleeping(look: Look): Pix {
  const upright = drawFigure(look, { bob: 0, liftL: 0, liftR: 0, armL: 'down', armR: 'down', tool: null, eyesClosed: true }, false);
  const p = new Pix(CHAR_W, CHAR_H);
  // rotate clockwise: (x,y) -> (H-1-y, x), then crop the figure rows 0..28 into the lower band
  for (let y = 0; y < CHAR_H; y++) {
    for (let x = 0; x < CHAR_W; x++) {
      const c = upright.get(x, y);
      if (!c) continue;
      const nx = CHAR_H - 1 - y - 1;
      const ny = x + 4;
      if (ny < CHAR_H) p.set(nx, ny, c);
    }
  }
  return p;
}

const POSES: Pose[] = [
  { bob: 0, liftL: 0, liftR: 0, armL: 'down', armR: 'down', tool: null },
  { bob: 1, liftL: 0, liftR: 0, armL: 'down', armR: 'down', tool: null },
  { bob: 0, liftL: 1, liftR: 0, armL: 'back', armR: 'fwd', tool: null },
  { bob: 1, liftL: 0, liftR: 0, armL: 'down', armR: 'down', tool: null },
  { bob: 0, liftL: 0, liftR: 1, armL: 'fwd', armR: 'back', tool: null },
  { bob: 1, liftL: 0, liftR: 0, armL: 'down', armR: 'down', tool: null },
  { bob: 0, liftL: 0, liftR: 0, armL: 'down', armR: 'up', tool: 'axe' },
  { bob: 1, liftL: 0, liftR: 0, armL: 'fwd', armR: 'swing', tool: 'axe' },
  { bob: 0, liftL: 0, liftR: 0, armL: 'down', armR: 'mouth', tool: 'berry' },
  { bob: 1, liftL: 0, liftR: 0, armL: 'down', armR: 'fwd', tool: null },
];

export interface CharacterDesc {
  name: string;
  role: string;
  kind: EntityKind;
  age?: { stage: AgeStage };
}

function lookFor(d: CharacterDesc): { look: Look; key: string } {
  const h = hash(d.name);
  const rc = roleColors(d.kind === 'crowd' ? 'villager' : d.role);
  const stage = d.age?.stage;
  const elder = stage === 'elder' || (!stage && /elder|anzian|saggi/i.test(d.role));
  const skinIdx = h % P.skin.length;
  // elders: grey hair (index 3); children: no beard style
  const hairIdx = elder ? 3 : (h >>> 3) % P.hair.length;
  const style = elder ? 3 : stage === 'child' ? (h >>> 7) % 2 : (h >>> 7) % 3;
  const cane = stage === 'elder';
  const look: Look = { skin: P.skin[skinIdx], hair: P.hair[hairIdx], style, shirt: rc.shirt, pants: rc.pants, accent: rc.accent, cane };
  const key = `char_${d.kind === 'crowd' ? 'villager' : d.role}_${skinIdx}_${hairIdx}_${style}${cane ? '_cane' : ''}`;
  return { look, key };
}

/** Builds (once) the sprite strip for a character look and returns its texture key. */
export function ensureCharacter(scene: Phaser.Scene, d: CharacterDesc): string {
  const { look, key } = lookFor(d);
  if (scene.textures.exists(key)) return key;
  const frames: Pix[] = [];
  for (const back of [false, true]) {
    for (const pose of POSES) frames.push(drawFigure(look, pose, back));
    frames.push(sleeping(look));
  }
  addStrip(scene, key, frames);
  return key;
}

/** Frame index for an animation at time t (ms). */
export function frameFor(anim: Anim, dir: Dir, t: number, phase: number): { frame: number; flip: boolean } {
  const back = dir === 'n' || dir === 'w';
  const flip = dir === 's' || dir === 'w';
  const seq = FRAME[anim] ?? FRAME.idle;
  const fps = anim === 'walk' ? 8 : anim === 'work' ? 4 : anim === 'eat' ? 3 : 1.6;
  const i = Math.floor(((t + phase) / 1000) * fps) % seq.length;
  // sleeping always uses the front strip
  const view = anim === 'sleep' ? 0 : back ? 1 : 0;
  return { frame: view * FRAMES_PER_VIEW + seq[i], flip: anim === 'sleep' ? false : flip };
}
