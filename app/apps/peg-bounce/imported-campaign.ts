import type { Board } from "./boards";
import { BALL_RADIUS, HEIGHT, LEGACY_HEIGHT, WIDTH, removeHitPieces, type Piece } from "./physics";

export const CAMPAIGN_SETTING = "peg-bounce.importedCampaign";
const toRadians = (angle: number) => angle * Math.PI / 180;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a project object.");
  return value as Record<string, unknown>;
}

function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error("A piece has a missing or out-of-range dimension.");
  }
  return value;
}

function decodePiece(value: unknown, index: number, sourceHeight: number): Piece[] {
  const data = object(value);
  const x = number(data.x, 0, WIDTH);
  const y = number(data.y, 0, sourceHeight) * HEIGHT / sourceHeight;
  const role = data.role;
  if (role !== "standard" && role !== "target" && role !== "bonus" && role !== "power" && role !== "blocker") {
    throw new Error("Unknown piece role.");
  }
  if (data.kind === "peg") return [{ role, path: [{ x, y }], radius: number(data.radius, 1, 300) }];
  const angle = toRadians(number(data.rotation, -360, 360));
  const thickness = number(data.thickness, 2, 50) / 2;
  if (data.kind === "brick") {
    const half = number(data.length, 4, 550) / 2;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    return [{ role, geometry: "brick", radius: 0, path: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
      ({ x: x + dx * half * a! - dy * thickness * b!, y: y + dy * half * a! + dx * thickness * b! })) }];
  }
  if (data.kind !== "arc") throw new Error("Unknown piece shape.");
  const radius = number(data.radius, BALL_RADIUS + thickness + 1, 300);
  const span = toRadians(number(data.span, 5, 360));
  const count = Math.ceil(radius * span / 16);
  const tileSpan = span / count;
  const targets: unknown[] = Array.isArray(data.targets) ? data.targets : [];
  const guide = typeof data.group === "number" && Number.isSafeInteger(data.group) && data.group >= 0 ? data.group : -1 - index;
  return Array.from({ length: count }, (_, i) => {
    const start = angle + i * tileSpan;
    return {
      role: role === "standard" && targets.includes(i) ? "target" : role,
      radius: thickness,
      geometry: { center: { x, y }, radius, start, span: tileSpan, guide, caps: [true, true] },
      path: Array.from({ length: 7 }, (_, j) => ({
        x: x + radius * Math.cos(start + tileSpan * j / 6),
        y: y + radius * Math.sin(start + tileSpan * j / 6),
      })),
    };
  });
}

export function parseImportedCampaign(text: string): Board[] {
  const data = object(JSON.parse(text));
  const levels: unknown = data.version === 1 ? [data] : data.version === 2 ? data.levels : undefined;
  if (!Array.isArray(levels) || !levels.length) throw new Error("Choose a saved Peg-bounce project or level.");
  const sourceHeight = data.boardHeight === undefined ? LEGACY_HEIGHT : number(data.boardHeight, 1, 2000);
  return levels.map((value, index) => {
    try {
      const level = object(value);
      if (!Array.isArray(level.pieces) || !level.pieces.length || level.pieces.length > 500) {
        throw new Error("Each board needs 1–500 editable pieces.");
      }
      const pieces = level.pieces.flatMap((piece, index) => decodePiece(piece, index, sourceHeight));
      if (pieces.length > 2200) throw new Error("This board has too many collision pieces.");
      const marked = pieces.filter(piece => piece.role === "target").length;
      const cap = level.targetCount === undefined ? marked || 1 : number(level.targetCount, 0, 250);
      if (!Number.isInteger(cap)) throw new Error("Target count must be a whole number.");
      const balls = level.balls === undefined ? undefined : number(level.balls, 1, 999);
      if (balls !== undefined && !Number.isInteger(balls)) throw new Error("Ball count must be a whole number.");
      const connected = removeHitPieces(pieces, new Set());
      const name = typeof level.name === "string" && level.name.trim() ? level.name.trim().slice(0, 80) : `Level ${index + 1}`;
      return { name, pieces: connected, targetCount: cap, balls, power: pieces.some(piece => piece.role === "power") ? "Long Guide" : null };
    } catch (error) {
      throw new Error(`Level ${index + 1}. ${error instanceof Error ? error.message : "Invalid board."}`);
    }
  });
}

export function importedBoard(board: Board, seed: number): Board {
  const pieces = board.pieces.map(piece => ({ ...piece }));
  const pool = pieces.filter(piece => piece.role === "standard" || piece.role === "target");
  const cap = board.targetCount ?? pool.filter(piece => piece.role === "target").length;
  for (let i = pool.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const j = Math.floor((seed >>> 0) / 0x100000000 * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  pool.forEach((piece, i) => { piece.role = i < cap ? "target" : "standard"; });
  return { ...board, pieces };
}

export const CAMPAIGN_LIBRARY_SETTING = "peg-bounce.campaignLibrary";

export interface SavedCampaign {
  name: string;
  text: string;
}

export function campaignLibrary(saved: string, legacy: string): SavedCampaign[] {
  if (!saved) return legacy ? [{ name: "Imported Campaign", text: legacy }] : [];
  const value: unknown = JSON.parse(saved);
  if (!Array.isArray(value)) throw new Error("The campaign library could not be read.");
  return value.filter((entry): entry is SavedCampaign =>
    entry && typeof entry.name === "string" && typeof entry.text === "string");
}

export function progressKey(text: string): string {
  if (!text) return "peg-bounce.progress.builtin";
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `peg-bounce.progress.${text.length}.${hash >>> 0}`;
}


export function importedCampaignName(text: string): string {
  const data = object(JSON.parse(text));
  return typeof data.campaignName === "string" ? data.campaignName.trim().slice(0, 70) : "";
}
