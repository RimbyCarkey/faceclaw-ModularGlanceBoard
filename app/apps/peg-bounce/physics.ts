export const WIDTH = 600;
export const LEGACY_HEIGHT = 400;
export const HEIGHT = WIDTH * 8 / 9;
export const STEP = 1 / 120;
export const PEG_RADIUS = 5.5;
export const BALL_RADIUS = 4;
export const MAX_ANGLE = 75;
export const TRAY_Y = HEIGHT - 15;
const GRAVITY = 445;
const LAUNCH_SPEED = 285;
const RIM_RADIUS = 4;


export type Point = { x: number; y: number };
export type Role = "standard" | "target" | "bonus" | "power" | "blocker";
export type Power = "Long Guide" | "Wide Catcher" | "Soft Bounce";
type ArcTile = {
  center: Point;
  radius: number;
  start: number;
  span: number;
  caps: readonly [boolean, boolean];
  guide: number;
};

export type Piece = {
  role: Role;
  // A peg center, brick vertices, or sampled tile centerline.
  // Analytic tile geometry controls collision independently of sampling.
  path: Point[];
  radius: number;
  geometry?: "brick" | ArcTile;
};

type Contact = { time: number; normal: Point };
type Ball = { position: Point; velocity: Point; age: number };
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const addScaled = (a: Point, b: Point, scale: number): Point =>
  ({ x: a.x + b.x * scale, y: a.y + b.y * scale });

function sweepCircle(start: Point, velocity: Point, center: Point, radius: number, limit: number): Contact | undefined {
  const offset = sub(start, center);
  const a = dot(velocity, velocity);
  const b = dot(offset, velocity);
  const c = dot(offset, offset) - radius * radius;
  const discriminant = b * b - a * c;
  if (a === 0 || b >= 0 || discriminant < 0) return;
  const time = Math.max(0, (-b - Math.sqrt(discriminant)) / a);
  if (time > limit) return;
  const normal = addScaled(offset, velocity, time);
  const length = Math.hypot(normal.x, normal.y);
  return length > 0 ? { time, normal: { x: normal.x / length, y: normal.y / length } } : undefined;
}

// Board geometry is immutable through a shot. Cache expanded bounds so
// distant pegs and curves skip the narrow-phase collision calculations.
type Bounds = { left: number; right: number; top: number; bottom: number };
const boundsByPiece = new WeakMap<Piece, Bounds>();

function boundsFor(piece: Piece): Bounds {
  let bounds = boundsByPiece.get(piece);
  if (bounds) return bounds;
  const radius = BALL_RADIUS + piece.radius;
  const first = piece.path[0]!;
  bounds = { left: first.x - radius, right: first.x + radius, top: first.y - radius, bottom: first.y + radius };
  for (const point of piece.path) {
    bounds.left = Math.min(bounds.left, point.x - radius);
    bounds.right = Math.max(bounds.right, point.x + radius);
    bounds.top = Math.min(bounds.top, point.y - radius);
    bounds.bottom = Math.max(bounds.bottom, point.y + radius);
  }
  boundsByPiece.set(piece, bounds);
  return bounds;
}

// Sweeping the ball against a convex brick expands its faces by the ball
// radius and rounds the four corners, preserving flat-face normals.
function sweepBrick(start: Point, velocity: Point, path: Point[], limit: number): Contact | undefined {
  let best: Contact | undefined;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const edge = sub(path[(i + 1) % path.length]!, a);
    const length = Math.hypot(edge.x, edge.y);
    const normal = { x: edge.y / length, y: -edge.x / length };
    const offset = sub(start, a);
    const speed = dot(velocity, normal);
    const distance = dot(offset, normal);
    if (speed < 0 && distance >= -0.001) {
      const time = Math.max(0, (BALL_RADIUS - distance) / speed);
      const along = dot(addScaled(offset, velocity, time), edge);
      if (time <= (best?.time ?? limit) && along >= 0 && along <= length * length) best = { time, normal };
    }
    const corner = sweepCircle(start, velocity, a, BALL_RADIUS, best?.time ?? limit);
    if (corner) best = corner;
  }
  return best;
}

function sweepArc(start: Point, velocity: Point, piece: Piece, arc: ArcTile, limit: number): Contact | undefined {
  const offset = sub(start, arc.center);
  const a = dot(velocity, velocity);
  if (!a) return;
  const b = dot(offset, velocity);
  let best: Contact | undefined;
  for (const face of [1, -1]) {
    const radius = arc.radius + face * (piece.radius + BALL_RADIUS);
    const d = b * b - a * (dot(offset, offset) - radius * radius);
    if (d < 0) continue;
    const time = (-b - face * Math.sqrt(d)) / a;
    if (time < 0 || time > (best?.time ?? limit)) continue;
    const point = addScaled(offset, velocity, time);
    const middle = arc.start + arc.span / 2;
    if (point.x * Math.cos(middle) + point.y * Math.sin(middle) >= radius * Math.cos(arc.span / 2) - 1e-7) {
      best = { time, normal: { x: face * point.x / radius, y: face * point.y / radius } };
    }
  }
  for (const [i, end] of [piece.path[0]!, piece.path[piece.path.length - 1]!].entries()) {
    if (!arc.caps[i]) continue;
    const contact = sweepCircle(start, velocity, end, piece.radius + BALL_RADIUS, best?.time ?? limit);
    if (contact) best = contact;
  }
  return best;
}

export function sweepPiece(start: Point, velocity: Point, piece: Piece, limit: number): Contact | undefined {
  if (piece.geometry === "brick") return sweepBrick(start, velocity, piece.path, limit);
  if (piece.geometry) return sweepArc(start, velocity, piece, piece.geometry, limit);
  const radius = BALL_RADIUS + piece.radius;
  let best: Contact | undefined;
  for (let i = 0; i < piece.path.length; i++) {
    const point = piece.path[i]!;
    const end = sweepCircle(start, velocity, point, radius, best?.time ?? limit);
    if (end) best = end;
    if (i === 0) continue;
    const segment = sub(point, piece.path[i - 1]!);
    const length = Math.hypot(segment.x, segment.y);
    if (length === 0) continue;
    const axis = { x: segment.x / length, y: segment.y / length };
    const offset = sub(start, point);
    const left = { x: -axis.y, y: axis.x };
    const side = dot(offset, left) < 0 ? -1 : 1;
    const normal = { x: left.x * side, y: left.y * side };
    const speed = dot(velocity, normal);
    if (speed >= 0) continue;
    const time = Math.max(0, (radius - dot(offset, normal)) / speed);
    if (time > (best?.time ?? limit)) continue;
    const along = dot(addScaled(offset, velocity, time), axis);
    if (along >= -length && along <= 0) best = { time, normal };
  }
  return best;
}

/** Expose rounded caps when a cleared tile opens a hole in a guide. */
export function removeHitPieces(pieces: readonly Piece[], hit: ReadonlySet<number>): Piece[] {
  const remaining = pieces.filter((_, index) => !hit.has(index));
  const arcGroups = new Map<number, ArcTile[]>();
  for (const { geometry } of remaining) {
    if (typeof geometry !== "object") continue;
    const group = arcGroups.get(geometry.guide) ?? [];
    group.push(geometry);
    arcGroups.set(geometry.guide, group);
  }
  return remaining.map(piece => {
    const arc = piece.geometry;
    if (typeof arc !== "object") return piece;
    const group = arcGroups.get(arc.guide)!;
    const connected = (angle: number) => group.some(other => other !== arc &&
      [other.start, other.start + other.span].some(theta =>
        Math.abs(Math.sin(theta - angle)) < 0.28 &&
        Math.hypot(arc.center.x + arc.radius * Math.cos(angle) - other.center.x - other.radius * Math.cos(theta),
          arc.center.y + arc.radius * Math.sin(angle) - other.center.y - other.radius * Math.sin(theta)) < 0.2));
    const startOpen = !connected(arc.start);
    const endOpen = !connected(arc.start + arc.span);
    return arc.caps[0] === startOpen && arc.caps[1] === endOpen ? piece
      : { ...piece, geometry: { ...arc, caps: [startOpen, endOpen] } };
  });
}

export function catcher(time: number, power: Power | null): { x: number; velocity: number; half: number } {
  const phase = time * 1.18;
  return {
    x: WIDTH / 2 + Math.sin(phase) * 213,
    velocity: Math.cos(phase) * 213 * 1.18,
    half: power === "Wide Catcher" ? 60 : 45,
  };
}

export const FINALE_BIN_VALUES = [10_000, 50_000, 100_000, 50_000, 10_000] as const;
export const FINALE_BIN_WIDTH = WIDTH / FINALE_BIN_VALUES.length;
export const FINALE_BIN_LIP = TRAY_Y - 16;
export const FINALE_DIVIDER_RADIUS = 6;

export type Shot = {
  ball: Ball;
  hit: Set<number>;
  touchedPiece: boolean;
  finale: boolean;
  bin: number | null;
  outcome: "flying" | "caught" | "drained" | "binned";
  trail: Point[];
  escaped: Set<number>;
  progressY: number;
  progressAge: number;
  lastHit: { index: number; age: number } | null;
};
export function launch(angle: number): Shot {
  const radians = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, angle)) * Math.PI / 180;
  const direction = { x: Math.sin(radians), y: Math.cos(radians) };
  return {
    ball: {
      position: addScaled({ x: WIDTH / 2, y: 16 }, direction, 20),
      velocity: { x: direction.x * LAUNCH_SPEED, y: direction.y * LAUNCH_SPEED },
      age: 0,
    },
    hit: new Set(),
    touchedPiece: false,
    finale: false,
    bin: null,
    outcome: "flying",
    trail: [],
    escaped: new Set(),
    progressY: 16,
    progressAge: 0,
    lastHit: null,
  };
}

export function advance(
  shot: Shot,
  pieces: readonly Piece[],
  time: number,
  power: Power | null,
  onContact?: () => boolean,
): void {
  if (shot.outcome !== "flying") return;
  const ball = shot.ball;
  ball.age += STEP;
  ball.velocity.y += GRAVITY * STEP / 2;
  let remaining = STEP;
  for (let impact = 0; impact < 8 && remaining > 1e-7; impact++) {
    const { position, velocity } = ball;
    let hitTime = remaining;
    let normal: Point | undefined;
    let index = -1;
    let surfaceSpeed = 0;
    let exit: Shot["outcome"] = "flying";
    function contact(result: Contact, piece = -1, speed = 0): void {
      if (result.time > hitTime) return;
      ({ time: hitTime, normal } = result);
      index = piece;
      surfaceSpeed = speed;
      exit = "flying";
    }

    if (velocity.x !== 0) {
      const boundary = velocity.x < 0 ? BALL_RADIUS : WIDTH - BALL_RADIUS;
      contact({ time: Math.max(0, (boundary - position.x) / velocity.x), normal: { x: velocity.x < 0 ? 1 : -1, y: 0 } });
    }
    if (velocity.y < 0) {
      contact({ time: Math.max(0, (BALL_RADIUS - position.y) / velocity.y), normal: { x: 0, y: 1 } });
    }
    if (shot.finale) {
      if (velocity.y > 0) {
        const crossing = Math.max(0, (FINALE_BIN_LIP + 7 - position.y) / velocity.y);
        if (crossing <= hitTime) {
          hitTime = crossing;
          normal = undefined;
          exit = "binned";
        }
      }
      for (let i = 1; i < FINALE_BIN_VALUES.length; i++) {
        const rim = sweepCircle(position, velocity, { x: i * FINALE_BIN_WIDTH, y: FINALE_BIN_LIP },
          BALL_RADIUS + FINALE_DIVIDER_RADIUS, hitTime);
        if (rim) contact(rim);
      }
    } else {
      const bucket = catcher(time + STEP - remaining, power);
      if (velocity.y > 0) {
        const crossing = (TRAY_Y - position.y) / velocity.y;
        const offset = position.x - bucket.x + (velocity.x - bucket.velocity) * crossing;
        if (crossing >= 0 && crossing <= hitTime && Math.abs(offset) < bucket.half - RIM_RADIUS - BALL_RADIUS) {
          hitTime = crossing;
          normal = undefined;
          exit = "caught";
        }
      }
      const relative = { x: velocity.x - bucket.velocity, y: velocity.y };
      for (const side of [-1, 1]) {
        const rim = sweepCircle(position, relative, { x: bucket.x + side * bucket.half, y: TRAY_Y }, BALL_RADIUS + RIM_RADIUS, hitTime);
        if (rim) contact(rim, -1, bucket.velocity);
      }
    }
    const endX = position.x + velocity.x * hitTime;
    const endY = position.y + velocity.y * hitTime;
    const left = Math.min(position.x, endX);
    const right = Math.max(position.x, endX);
    const top = Math.min(position.y, endY);
    const bottom = Math.max(position.y, endY);
    for (let i = 0; i < pieces.length; i++) {
      if (shot.escaped.has(i)) continue;
      const piece = pieces[i]!;
      const bounds = boundsFor(piece);
      if (left > bounds.right || right < bounds.left || top > bounds.bottom || bottom < bounds.top) continue;
      const hit = sweepPiece(position, velocity, piece, hitTime);
      if (hit) contact(hit, i);
    }
    ball.position = addScaled(position, velocity, hitTime);
    if (exit === "binned") {
      shot.bin = Math.max(0, Math.min(FINALE_BIN_VALUES.length - 1, Math.floor(ball.position.x / FINALE_BIN_WIDTH)));
      shot.outcome = exit;
      return;
    }
    if (exit === "caught" || ball.position.y > HEIGHT + BALL_RADIUS) {
      shot.outcome = exit === "caught" ? exit : "drained";
      return;
    }
    remaining -= hitTime;
    if (!normal) break;
    if (index >= 0) shot.touchedPiece = true;
    if (index >= 0 && pieces[index]!.role !== "blocker") {
      shot.hit.add(index);
      shot.lastHit = { index, age: ball.age };
    }
    const approach = dot({ x: velocity.x - surfaceSpeed, y: velocity.y }, normal);
    const geometry = index >= 0 ? pieces[index]!.geometry : undefined;
    const slides = typeof geometry === "object" || (geometry === "brick" && Math.abs(normal.x) < 0.5);
    // Drop the normal rebound on shallow ramp contacts. Tangential velocity
    // stays intact, so gravity can carry the ball smoothly along the guide.
    const bounce = slides && -approach < 78 ? 0 : power === "Soft Bounce" && index >= 0 ? 0.48 : index >= 0 ? 0.82 : 0.88;
    ball.velocity = addScaled(velocity, normal, -(1 + bounce) * approach);
    ball.position = addScaled(ball.position, normal, 0.035);
    if (onContact?.()) return;
  }
  ball.velocity.y += GRAVITY * STEP / 2;
  if (ball.position.y >= shot.progressY + BALL_RADIUS) {
    shot.progressY = ball.position.y;
    shot.progressAge = ball.age;
  }
  if (ball.age - shot.progressAge >= 2.5) {
    const last = shot.lastHit;
    const bounds = last && boundsFor(pieces[last.index]!);
    if (last && bounds && ball.age - last.age <= 1.1 &&
        ball.position.x >= bounds.left && ball.position.x <= bounds.right) {
      shot.escaped.add(last.index);
    } else {
      // A short sideways impulse gets off permanent flat faces without
      // disabling their collision or teleporting through the board.
      ball.velocity.x += ball.position.x < WIDTH / 2 ? -55 : 55;
    }
    ball.velocity.y = Math.max(ball.velocity.y, 35);
    shot.progressAge = ball.age;
  }
  if (!shot.finale && ball.age >= 14) shot.outcome = "drained";
}

export function aimGuide(angle: number, pieces: readonly Piece[], time: number, power: Power | null): Point[] {
  const shot = launch(angle);
  const points = [shot.ball.position];
  let contacts = 0;
  for (let frame = 0; frame < 90 && shot.outcome === "flying"; frame++) {
    advance(shot, pieces, time + frame * STEP, power, () => ++contacts >= (power === "Long Guide" ? 2 : 1));
    if (frame % 6 === 5 || contacts >= (power === "Long Guide" ? 2 : 1)) points.push(shot.ball.position);
    if (contacts >= (power === "Long Guide" ? 2 : 1)) break;
  }
  return points;
}
