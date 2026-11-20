import { advance, BALL_RADIUS, PEG_RADIUS, HEIGHT, LEGACY_HEIGHT, launch, MAX_ANGLE, removeHitPieces, STEP, WIDTH, type Piece, type Point, type Power } from "./physics";

export const POWERS: readonly Power[] = ["Long Guide", "Wide Catcher", "Soft Bounce"];
export const SHOTS_PER_BOARD = 10;
export const STANDARD_TARGET_COUNT = 25;
const boardY = (y: number) => y * HEIGHT / LEGACY_HEIGHT;

type Row = readonly [y: number, spacing: number, first: number, last: number, rise?: number];
type Layout = {
  name: string;
  rows: readonly Row[];
  banks: readonly [y: number, slope: number];
  bowls: readonly [y: number, radius: number];
  rings?: readonly number[];
};

// Each row is the left half of a formation, counted outward from the
// centerline. Omitting inner positions leaves a deliberately open lane.
const CAMPAIGN: readonly Layout[] = [
  {
    name: "First Arc",
    rows: [
      [118, 49, 0, 3, 43], [223, 51, 0, 4, -30], [302, 53, 1, 4, 17],
    ],
    banks: [166, 24], bowls: [262, 17],
  },
  {
    name: "Open Gates",
    rows: [
      [111, 45, 1, 4, 28], [176, 49, 2, 4, -12], [219, 51, 0, 3, 38],
      [315, 44, 1, 4],
    ],
    banks: [139, 29], bowls: [251, 18],
  },
  {
    name: "Twin Ramps",
    rows: [
      [108, 43, 0, 4, 35], [168, 45, 1, 4, 35], [226, 50, 2, 4, -22],
      [306, 45, 0, 4, -38],
    ],
    banks: [155, 38], bowls: [266, 19],
  },
  {
    name: "Crescent Gates",
    rows: [
      [99, 44, 1, 4, 32], [163, 51, 1, 4, 32], [224, 40, 0, 4, 30],
      [310, 47, 1, 4, -27],
    ],
    banks: [182, 24], bowls: [123, 20],
  },
  {
    name: "Signal Ridge",
    rows: [
      [80, 37, 0, 5, 54], [116, 38, 0, 5, 54], [152, 39, 0, 5, 54],
      [188, 41, 0, 5, 54], [225, 44, 0, 5, 51], [262, 42, 0, 5, 48],
      [299, 37, 0, 5, 43], [350, 45, 1, 4],
    ],
    banks: [192, 33], bowls: [265, 20],
  },
  {
    name: "Fan Out",
    rows: [
      [82, 33, 0, 3], [118, 35, 0, 4], [154, 38, 0, 4, 15],
      [190, 41, 0, 5, 19], [227, 44, 0, 5, 21], [264, 46, 0, 5, 22],
      [302, 49, 0, 5, 22], [348, 42, 1, 4],
    ],
    banks: [152, 28], bowls: [220, 19],
  },
  {
    name: "Lock Gates",
    rows: [
      [82, 46, 0, 5], [119, 46, 2, 5], [156, 46, 0, 5],
      [193, 46, 2, 5], [230, 46, 0, 5], [267, 46, 2, 5],
      [304, 46, 0, 5], [344, 46, 1, 5],
    ],
    banks: [126, 21], bowls: [280, 22],
  },
  {
    name: "Long Reach",
    rows: [
      [84, 50, 0, 4], [120, 41, 0, 5, -14], [157, 50, 0, 4],
      [194, 46, 0, 5, -13], [231, 51, 0, 4], [269, 46, 0, 5, -12],
      [307, 52, 0, 4], [345, 46, 0, 5, -10],
    ],
    banks: [161, 34], bowls: [287, 21],
  },
  {
    name: "Crescent",
    rows: [],
    rings: [43, 78, 113, 148],
    banks: [148, 30], bowls: [250, 22],
  },
  {
    name: "Tide Pool",
    rows: [
      [88, 42, 0, 5, -16], [128, 44, 0, 5, -16], [168, 44, 1, 5, -16],
      [208, 42, 0, 5, -16], [248, 43, 0, 5, -16], [287, 46, 0, 5, -16],
      [327, 48, 0, 5, -16], [355, 40, 1, 4],
    ],
    banks: [218, 24], bowls: [146, 24],
  },
  {
    name: "Braid",
    rows: [
      [83, 39, 0, 5, 26], [133, 48, 1, 5, -10], [171, 39, 0, 5, 22],
      [216, 48, 1, 5, -9], [254, 39, 0, 5, 20], [296, 48, 1, 5, -8],
      [337, 40, 0, 5, 12],
    ],
    banks: [129, 33], bowls: [246, 21],
  },
  {
    name: "Spillway",
    rows: [
      [82, 48, 0, 5], [119, 45, 0, 5], [157, 42, 0, 5],
      [195, 39, 0, 5], [233, 37, 0, 5], [271, 35, 0, 5],
      [309, 34, 0, 5], [347, 33, 0, 5],
    ],
    banks: [175, 43], bowls: [281, 24],
  },
  {
    name: "Corners",
    rows: [
      [82, 44, 0, 5], [119, 44, 0, 5], [156, 44, 0, 5],
      [195, 44, 0, 2], [232, 44, 0, 2], [269, 44, 0, 5],
      [306, 44, 0, 5], [343, 44, 0, 5],
    ],
    banks: [187, 39], bowls: [115, 19],
  },
  {
    name: "Ripple",
    rows: [
      [82, 42, 0, 5, 19], [120, 44, 0, 5, 19], [158, 46, 0, 5, 19],
      [196, 43, 0, 5, 19], [234, 41, 0, 5, 19], [272, 44, 0, 5, 19],
      [310, 46, 0, 5, 19], [348, 43, 0, 5],
    ],
    banks: [162, 25], bowls: [260, 25],
  },
  {
    name: "The Weave",
    rows: [
      [84, 45, 0, 5, 14], [123, 49, 0, 5, -9], [162, 43, 0, 5, 15],
      [201, 49, 1, 5, -9], [240, 42, 0, 5, 15], [279, 49, 1, 5, -9],
      [318, 43, 0, 5, 14], [354, 45, 1, 5, -8],
    ],
    banks: [244, 35], bowls: [148, 22],
  },
];
export const CAMPAIGN_LENGTH = CAMPAIGN.length;
export const campaignName = (level: number): string => CAMPAIGN[level - 1]!.name;

export type Board = { name: string; pieces: Piece[]; power: Power | null; targetCount?: number; balls?: number };

function peg(x: number, y: number, role: Piece["role"] = "standard", radius = PEG_RADIUS): Piece {
  return { role, path: [{ x, y }], radius };
}

function brick(a: Point, b: Point): Piece {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const dx = 4 * (b.y - a.y) / length;
  const dy = 4 * (a.x - b.x) / length;
  return {
    role: "standard", radius: 0, geometry: "brick",
    path: [{ x: a.x + dx, y: a.y + dy }, { x: b.x + dx, y: b.y + dy },
      { x: b.x - dx, y: b.y - dy }, { x: a.x - dx, y: a.y - dy }],
  };
}

function curve(x: number, y: number, radius: number, start: number, span: number, guide: number): Piece[] {
  const count = Math.ceil(radius * span / 16);
  const tileSpan = span / count;
  return Array.from({ length: count }, (_, tile) => {
    const from = start + tile * tileSpan;
    return {
      role: "standard", radius: 2.75,
      geometry: { center: { x, y }, radius, start: from, span: tileSpan, caps: [tile === 0, tile === count - 1], guide },
      path: Array.from({ length: 7 }, (_, i) => {
        const angle = from + tileSpan * i / 6;
        return { x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) };
      }),
    };
  });
}

function extent(piece: Piece) {
  return {
    left: Math.min(...piece.path.map(p => p.x)) - piece.radius,
    right: Math.max(...piece.path.map(p => p.x)) + piece.radius,
    top: Math.min(...piece.path.map(p => p.y)) - piece.radius,
    bottom: Math.max(...piece.path.map(p => p.y)) + piece.radius,
  };
}

/** Conservative spacing using the gap between the whole obstacle envelopes. */
export function hasClearance(piece: Piece, others: readonly Piece[]): boolean {
  const a = extent(piece);
  return a.top >= HEIGHT * 0.15 && a.bottom <= boardY(365) && a.left >= 0 && a.right <= WIDTH &&
    others.every(other => {
      if (typeof piece.geometry === "object" && typeof other.geometry === "object" &&
          piece.geometry.guide === other.geometry.guide) return true;
      const b = extent(other);
      return Math.hypot(Math.max(0, a.left - b.right, b.left - a.right),
        Math.max(0, a.top - b.bottom, b.top - a.bottom)) >= 5 * BALL_RADIUS - 1e-6;
    });
}

function build(layout: Layout, level: number, variation: number, stretch = 1): Board {
  const pieces: Piece[] = [];
  const addPair = (left: Piece, right: Piece) => {
    if (hasClearance(left, pieces) && hasClearance(right, [...pieces, left])) pieces.push(left, right);
  };
  const [bankY, slope] = layout.banks;
  const [bowlY, radius] = layout.bowls;
  const bank = (x: number, y: number, run: number, drop: number) =>
    addPair(brick({ x, y: boardY(y) }, { x: x + run, y: boardY(y) + drop }),
      brick({ x: WIDTH - x - run, y: boardY(y) + drop }, { x: WIDTH - x, y: boardY(y) }));
  let guide = 0;
  const arcs = (x: number, y: number, r: number, start: number, span: number) => {
    const left = curve(x, boardY(y), r, start, span, guide++);
    const right = curve(WIDTH - x, boardY(y), r, Math.PI - start - span, span, guide++);
    if (left.every(tile => hasClearance(tile, pieces)) &&
        right.every(tile => hasClearance(tile, [...pieces, ...left]))) pieces.push(...left, ...right);
  };

  // Cut short directional banks into the field, then fit the round pegs
  // around them. The curved tiles meet tangentially within each guide.
  bank(26, bankY, 23, slope * 0.52);
  bank(110, Math.max(88, bankY - 44), 24, -slope * 0.46);
  arcs(66, bowlY, radius + 9, 0.16, Math.PI * 0.78);
  if (layout.rings) {
    arcs(165, 220, 44, 0.1, Math.PI * 1.65);
  } else {
    arcs(161, Math.min(304, bowlY + 37), radius + 12, -0.31 + (bankY % 4) * 0.15, Math.PI * 0.82);
  }

  if (!pieces.some(piece => typeof piece.geometry === "object")) arcs(63, 313, 22, 0, Math.PI);

  const center: Piece[] = [];
  function addMirrored(x: number, y: number): void {
    y = boardY(y);
    const left = peg(x, y);
    if (Math.abs(x - WIDTH / 2) < 0.001) {
      if (hasClearance(left, pieces)) {
        pieces.push(left);
        center.push(left);
      }
    } else {
      const right = peg(WIDTH - x, y);
      addPair(left, right);
    }
  }

  if (layout.rings) {
    for (const radius of layout.rings) {
      const divisions = Math.floor(Math.PI * radius / 34);
      for (let i = 0; i <= divisions; i++) {
        const angle = Math.PI * i / divisions;
        addMirrored(WIDTH / 2 - radius * stretch * Math.sin(angle), 209 + radius * Math.cos(angle));
      }
    }
  } else {
    for (const [y, spacing, first, last, rise = 0] of layout.rows) {
      for (let col = first; col <= last; col++) {
        const offset = (col / last) ** 2 * rise;
        addMirrored(WIDTH / 2 - col * spacing * stretch, y + offset);
      }
    }
  }
  const unlocked = Math.min(POWERS.length, Math.floor(level / 5));
  const random = randomFor(variation);
  const power = unlocked ? POWERS[level % 5 === 0 && level <= 15 ? unlocked - 1 : Math.floor(random() * unlocked)]! : null;
  if (power) (center[2] ?? center[0] ?? pieces.find(piece => !piece.geometry)!)!.role = "power";

  // Sample individual pieces without replacement. Geometry remains
  // symmetrical, but a target does not require a matching target opposite it.
  const eligible = pieces.filter(piece => piece.role === "standard");
  for (let i = 0; i < Math.min(STANDARD_TARGET_COUNT, eligible.length); i++) {
    const index = i + Math.floor(random() * (eligible.length - i));
    [eligible[i], eligible[index]] = [eligible[index]!, eligible[i]!];
    eligible[i]!.role = "target";
  }
  return { name: layout.name, pieces, power };
}

export function campaignShots(level: number): number {
  return Math.max(SHOTS_PER_BOARD, Math.min(15, 19 - level));
}

// Variations verified against the shot simulator.
const VERIFIED_TARGET_SEEDS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1, 0, 1];

export function campaignBoard(level: number, runSeed?: number, startingPower: Power | null = null): Board {
  const layout = CAMPAIGN[level - 1]!;
  if (runSeed !== undefined) {
    const random = randomFor(runSeed ^ Math.imul(level, 1597334677));
    for (let attempt = 0; attempt < 5; attempt++) {
      const board = build(layout, level, Math.floor(random() * 0x100000000));
      if (hasClearingRoute(board, startingPower, campaignShots(level))) return board;
    }
  }
  return build(layout, level, VERIFIED_TARGET_SEEDS[level - 1]!);
}

export function endlessFallback(seed: number, level: number): Board {
  // Both motifs were checked under each eligible carryover power. Future
  // stages share the same power pool, so they can reuse the late fallback.
  const powerLevel = level < 5 ? 1 : level < 10 ? 5 : level < 15 ? 10 : level === 15 ? 15 : 16;
  const motif = (seed ^ level) & 1;
  return build(CAMPAIGN[4 + motif]!, powerLevel, 0);
}

export function tutorialBoard(): Board {
  return {
    name: "First shot",
    pieces: [
      { role: "target", path: [{ x: 300, y: 120 }], radius: 7 },
      { role: "standard", path: [{ x: 282, y: 167 }], radius: 6 },
      { role: "standard", path: [{ x: 318, y: 167 }], radius: 6 },
    ],
    power: null,
  };
}

function randomFor(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 0x100000000;
  };
}

export function markBonus(pieces: Piece[], turn: number): void {
  const previous = pieces.find(piece => piece.role === "bonus");
  if (previous) previous.role = "standard";
  const eligible = pieces.filter(piece => piece.role === "standard" && piece !== previous);
  if (eligible.length) eligible[(turn * 31 + 19) % eligible.length]!.role = "bonus";
}

/** Find a reproducible clearing route using the same launch angles as play. */
export function hasClearingRoute(board: Board, startingPower: Power | null = null, shotBudget = SHOTS_PER_BOARD): boolean {
  let pieces = board.pieces;
  let active = startingPower;
  let boardTime = 0;
  for (let turn = 0; turn < shotBudget; turn++) {
    if (!pieces.some(piece => piece.role === "target")) return true;
    let bestHits = new Set<number>();
    let bestScore = 0;
    let bestFrames = 0;
    for (let angle = -MAX_ANGLE; angle <= MAX_ANGLE; angle += 3) {
      const shot = launch(angle);
      let frames = 0;
      while (shot.outcome === "flying") {
        advance(shot, pieces, boardTime + frames * STEP, active);
        frames++;
      }
      let score = 0;
      for (const index of shot.hit) {
        const role = pieces[index]!.role;
        score += role === "target" ? 20 : role === "power" ? 2 : 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestHits = shot.hit;
        bestFrames = frames;
      }
    }
    if (bestHits.size === 0) return false;
    boardTime += (bestFrames + bestHits.size * 6) * STEP;
    active = [...bestHits].some(index => pieces[index]!.role === "power") ? board.power : null;
    pieces = removeHitPieces(pieces, bestHits);
  }
  return !pieces.some(piece => piece.role === "target");
}

export function endlessCandidate(seed: number, level: number, attempt: number): Board {
  const random = randomFor(seed ^ Math.imul(level, 1597334677) ^ Math.imul(attempt, 3812015801));
  // Endless samples the denser motifs and varies their width and target
  // placements. The same seed and board number reproduce the entire field.
  const layout = CAMPAIGN[4 + Math.floor(random() * (CAMPAIGN.length - 4))]!;
  const board = build(layout, level, Math.floor(random() * 100), 0.9 + random() * 0.2);
  board.name = `Endless ${level}`;
  return board;
}
