import "@nativescript/core/globals";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { getActiveDisplay } from "../../native/active-display";
import { playWorkerBuzzerSequence } from "../../native/worker-buzzer";
import { buildSoundSequencePayload, phraseDurationMs, type Step } from "../../ui/sound-effects";
import * as frameTimings from "../../native/frame-timings";
import { finishWorkerShutdown } from "../../ui/shell/worker-lifecycle";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import type { InputEvent } from "../../ui/gestures";
import type { Viewport } from "../../ui/viewport";
import { drawCoin, drawLauncher, drawPlayfieldHud, drawPlayfieldHudFrame } from "./playfield-hud";
import { COIN_SPIN_SECONDS, MODES, PAUSE_OPTIONS, PegBounceGame, type Cue } from "./game";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { CAMPAIGN_LIBRARY_SETTING, CAMPAIGN_SETTING, campaignLibrary, parseImportedCampaign, progressKey, type SavedCampaign } from "./imported-campaign";
import { aimGuide, BALL_RADIUS, catcher, FINALE_BIN_LIP, FINALE_BIN_VALUES, FINALE_BIN_WIDTH, FINALE_DIVIDER_RADIUS, HEIGHT, STEP, TRAY_Y, WIDTH, type Piece, type Point } from "./physics";

declare const global: {
  onmessage: (event: { data: WorkerAppMessage }) => void;
  postMessage: (reply: WorkerAppReply) => void;
};

const FRAME_MS = 50;
const CUES: Record<Cue, Step[]> = {
  peg: [{ freq: 1190, duty: 19, ms: 24 }],
  target: [{ freq: 1648, duty: 27, ms: 48 }],
  power: [{ freq: 1319, duty: 25, ms: 55 }, { freq: 2093, duty: 27, ms: 105 }],
  catch: [{ freq: 1047, duty: 23, ms: 55 }, { freq: 1568, duty: 27, ms: 115 }],
  clear: [
    { freq: 1047, duty: 28, ms: 90 },
    { freq: 1319, duty: 28, ms: 90 },
    { freq: 1760, duty: 30, ms: 125 },
    { freq: 1, duty: 0, ms: 60 },
    { freq: 1568, duty: 30, ms: 100 },
    { freq: 2093, duty: 32, ms: 270 },
  ],
};
const PRIORITY: Record<Cue, number> = { peg: 0, target: 1, power: 2, catch: 3, clear: 4 };

type GameWindow = {
  windowId: string;
  surfaceId: string;
  viewport: Viewport;
  game: PegBounceGame;
  foreground: boolean;
  focused: boolean;
  timer: ReturnType<typeof setInterval> | null;
  generation: ReturnType<typeof setTimeout> | null;
  time: number;
  remainder: number;
  fingerprint: string;
  prefersArm: boolean;
  soundUntil: number;
  boardRaster?: { pieces: Piece[]; image: GrayImage };
};

const windows = new Map<string, GameWindow>();
let screenOn = true;

function circle(image: GrayImage, x: number, y: number, radius: number, gray: number): void {
  x = Math.round(x);
  y = Math.round(y);
  radius = Math.max(1, Math.round(radius));
  for (let dy = -radius; dy <= radius; dy++) {
    const dx = Math.floor(Math.sqrt(radius * radius - dy * dy));
    image.drawLine(x - dx, y + dy, x + dx, y + dy, gray);
  }
}

function stroke(image: GrayImage, path: readonly Point[], radius: number, gray: number): void {
  let previous = path[0]!;
  circle(image, previous.x, previous.y, radius, gray);
  for (const point of path.slice(1)) {
    const steps = Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / Math.max(1, radius / 2));
    for (let i = 1; i <= steps; i++) {
      const fraction = i / steps;
      circle(image, previous.x + (point.x - previous.x) * fraction,
        previous.y + (point.y - previous.y) * fraction, radius, gray);
    }
    previous = point;
  }
}

function paintPiece(image: GrayImage, piece: Piece, path: Point[], radius: number): void {
  const center = path[Math.floor((path.length - 1) / 2)]!;
  if (piece.role === "power") {
    const { x, y } = center;
    const side = Math.max(4, Math.round(radius + 1));
    for (let dy = -side; dy <= side; dy++) {
      const dx = side - Math.abs(dy);
      image.drawLine(x - dx, y + dy, x + dx, y + dy, 230);
    }
    image.setPixel(Math.round(x), Math.round(y), 0);
    return;
  }
  const gray = piece.role === "standard" ? 142 : piece.role === "blocker" ? 112 : 250;
  if (piece.geometry === "brick") {
    paintBrick(image, path, gray, piece.role === "target");
  } else {
    const hollow = piece.role === "target";
    stroke(image, path, hollow ? Math.max(2, radius) : radius, gray);
    if (hollow) stroke(image, path, Math.max(1, radius - 1.5), 0);
  }
  if (piece.role === "bonus" || piece.role === "blocker") {
    for (const point of piece.role === "bonus" ? [center] : path) {
      image.drawLine(point.x - radius, point.y, point.x + radius, point.y, 30);
      image.drawLine(point.x, point.y - radius, point.x, point.y + radius, 30);
    }
  }
}

function paintBrick(image: GrayImage, path: Point[], gray: number, hollow: boolean): void {
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    image.drawLine(a.x, a.y, b.x, b.y, gray);
  }
  if (hollow) return;
  const top = Math.ceil(Math.min(...path.map(p => p.y)));
  const bottom = Math.floor(Math.max(...path.map(p => p.y)));
  for (let y = top; y <= bottom; y++) {
    const intersections: number[] = [];
    for (let i = 0; i < path.length; i++) {
      const a = path[i]!;
      const b = path[(i + 1) % path.length]!;
      if ((a.y > y) !== (b.y > y)) intersections.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
    }
    if (intersections.length === 2) image.drawLine(Math.min(...intersections), y, Math.max(...intersections), y, gray);
  }
}

function paintHit(image: GrayImage, piece: Piece, path: Point[], radius: number, hidden: boolean): void {
  // Erase the filled or hollow shape. A compact X stays legible on the
  // monochrome display for the rest of this shot, even after the ball moves.
  if (piece.geometry === "brick") paintBrick(image, path, 0, false);
  else stroke(image, path, Math.max(4, radius + (piece.role === "power" ? 2 : 0)), 0);
  if (hidden) return;
  const middle = Math.floor(path.length / 2);
  const first = path[piece.geometry === "brick" ? 0 : Math.floor((path.length - 1) / 2)]!;
  const last = path[middle]!;
  const x = Math.round((first.x + last.x) / 2);
  const y = Math.round((first.y + last.y) / 2);
  const half = Math.max(2, Math.round(radius * 0.67));
  image.drawLine(x - half, y - half, x + half, y + half, 255);
  image.drawLine(x - half, y + half, x + half, y - half, 255);
}

function centerText(image: GrayImage, font: UiFont, text: string, y: number, gray = 230): void {
  font.drawText(image, Math.max(0, Math.round((image.width - font.measureText(text)) / 2)), y, text, gray);
}

function levelPicker(window: GameWindow, font: UiFont): GrayImage {
  const { game, viewport } = window;
  const image = new GrayImage(viewport.width, viewport.height);
  const line = Math.max(24, font.lineHeight + 7);
  const top = Math.max(8, viewport.padding.top);
  const rows = Math.max(1, Math.floor((viewport.height - top - line * 2 - 8) / line));
  const selectedRow = Math.floor((game.levelSelection - 1) / 2);
  const first = Math.floor(selectedRow / rows) * rows * 2 + 1;
  const width = Math.floor((image.width - 20) / 2);
  centerText(image, font, "Campaign levels", top, 255);
  for (let level = first; level < first + rows * 2 && level <= game.campaignLength; level++) {
    const index = level - first;
    const x = 10 + (index % 2) * width;
    const y = top + line * (1 + Math.floor(index / 2));
    const locked = level > game.unlockedLevel;
    const selected = game.levelSelection === level;
    if (selected) image.drawRect(x, y, width - 3, line - 2, locked ? 95 : 155);
    const suffix = level <= game.cleared ? " +" : locked ? "" : " >";
    const full = `${level} - ${game.levelName(level)}`;
    let title = full;
    while (font.measureText(title + suffix + (title === full ? "" : "...")) > width - 16 && title.length > 1) title = title.slice(0, -1);
    font.drawText(image, x + 6, y + 2, title + (title === full ? "" : "...") + suffix, locked ? 72 : selected ? 255 : 196);
  }
  const hint = game.levelSelection > game.unlockedLevel ? "Locked · Clear the previous level"
    : window.prefersArm ? "Tap to scan or select · Double-tap back" : "Scroll or swipe · Tap to play · + cleared";
  centerText(image, font, hint, image.height - Math.max(font.lineHeight + 4, viewport.padding.bottom + font.lineHeight));
  return image;
}

function campaignPicker(window: GameWindow, font: UiFont): GrayImage {
  const { game, viewport } = window;
  const image = new GrayImage(viewport.width, viewport.height);
  const line = Math.max(26, font.lineHeight + 7);
  const top = Math.max(8, viewport.padding.top);
  const rows = Math.max(1, Math.floor((image.height - top - line * 2 - 8) / line));
  const first = Math.floor(game.campaignSelection / rows) * rows;
  centerText(image, font, "Campaigns", top, 255);
  game.campaignNames.slice(first, first + rows).forEach((name, i) => {
    const selected = first + i === game.campaignSelection;
    const y = top + line * (i + 1);
    if (selected) image.drawRect(12, y, image.width - 24, line - 2, 155);
    let title = name;
    while (font.measureText(title + (title === name ? "" : "...")) > image.width - 40 && title.length > 1) title = title.slice(0, -1);
    font.drawText(image, 20, y + 2, title + (title === name ? "" : "..."), selected ? 255 : 184);
  });
  centerText(image, font, window.prefersArm ? "Tap to scan or select · Double-tap back" : "Scroll or swipe · Tap to select",
    image.height - Math.max(font.lineHeight + 4, viewport.padding.bottom + font.lineHeight));
  return image;
}

function createGame(): PegBounceGame {
  let key = progressKey("");
  let library: SavedCampaign[] = [];
  return new PegBounceGame(index => {
    key = progressKey("");
    const saved = library[index - 1]?.text;
    if (!saved) return [];
    try {
      const campaign = parseImportedCampaign(saved);
      key = progressKey(saved);
      return campaign;
    } catch (error) {
      console.warn(`Saved Peg-bounce campaign could not be read: ${error}`);
      return [];
    }
  }, () => Number(getStringSetting(key, "0")), cleared => setStringSetting(key, String(cleared)), () => {
    try {
      library = campaignLibrary(getStringSetting(CAMPAIGN_LIBRARY_SETTING, ""), getStringSetting(CAMPAIGN_SETTING, ""));
    } catch (error) {
      console.warn(`Saved Peg-bounce library could not be read: ${error}`);
      library = [];
    }
    return library.map(pack => pack.name);
  });
}

function paint(window: GameWindow): GrayImage {
  const { game, viewport } = window;
  const font = getDefaultSmallFont();
  let image: GrayImage;
  if (game.phase === "campaigns") return campaignPicker(window, font);
  if (game.phase === "levels") return levelPicker(window, font);
  if (game.phase === "menu") {
    image = new GrayImage(viewport.width, viewport.height);
    const top = Math.max(8, Math.floor(image.height / 2) - 86);
    centerText(image, font, "Peg-bounce", top, 255);
    MODES.forEach((mode, index) => {
      const selected = game.selection === index;
      centerText(image, font, selected ? `> ${mode} <` : mode, top + 42 + 25 * index, selected ? 255 : 135);
    });
    centerText(image, font, window.prefersArm ? "Tap to scan, tap to select" : "Swipe or scroll, then tap", top + 132);
    return image;
  }
  if (game.phase === "loading") {
    image = new GrayImage(viewport.width, viewport.height);
    centerText(image, font, "Building board...", Math.floor(image.height / 2));
    return image;
  }
  const pad = viewport.padding;
  const top = Math.max(8, Math.min(pad.top, viewport.height - 180));
  const footer = viewport.height - Math.max(12, pad.bottom + 8);
  const rail = Math.max(52, Math.round(viewport.width * 0.128), pad.left, pad.right);
  const hud = top + 30;
  const line = 8;
  const scale = Math.max(0.05, Math.min((viewport.width - 2 * rail) / WIDTH, (footer - hud - line) / HEIGHT));
  const ox = Math.round((viewport.width - WIDTH * scale) / 2);
  const oy = hud + line;
  const right = Math.round(ox + WIDTH * scale);
  const bottom = Math.round(oy + HEIGHT * scale);
  const place = (point: Point): Point => ({ x: ox + point.x * scale, y: oy + point.y * scale });

  if (window.boardRaster?.pieces !== game.pieces) {
    const board = new GrayImage(viewport.width, viewport.height);
    board.drawRect(ox, oy, right - ox, bottom - oy, 88);
    for (const piece of game.pieces) paintPiece(board, piece, piece.path.map(place), piece.radius * scale);
    for (const piece of game.pieces) {
      const arc = piece.geometry;
      if (typeof arc !== "object" || arc.caps[0]) continue;
      const edge = place(piece.path[0]!);
      const dx = Math.cos(arc.start) * piece.radius * scale;
      const dy = Math.sin(arc.start) * piece.radius * scale;
      board.drawLine(edge.x - dx, edge.y - dy, edge.x + dx, edge.y + dy, 0);
    }
    drawPlayfieldHudFrame(board, top, footer, rail);
    window.boardRaster = { pieces: game.pieces, image: board };
  }
  image = window.boardRaster.image.clone();
  for (const index of game.shot?.hit ?? []) {
    const piece = game.pieces[index]!;
    paintHit(image, piece, piece.path.map(place), piece.radius * scale, game.shot!.escaped.has(index));
  }

  const power = game.queued ?? game.active;
  drawPlayfieldHud(image, font, {
    balls: game.balls, score: game.score, top, bottom: footer, rail,
    blitzProgress: game.blitzProgress, blitzTier: game.blitzTier,
    power, canPause: !game.shot?.finale && (game.phase === "aim" || game.phase === "flight" || game.phase === "sweep"),
  });
  const pivot = place({ x: WIDTH / 2, y: 16 });
  const angle = Math.round(game.angle) * Math.PI / 180;
  drawLauncher(image, pivot.x, pivot.y, angle, scale);

  if (game.phase === "aim") {
    aimGuide(Math.round(game.angle), game.pieces, game.boardTime, game.queued).forEach((point, index) => {
      const pixel = place(point);
      circle(image, pixel.x, pixel.y, Math.max(1, (2 - index * 0.06) * scale), 215 - index * 8);
    });
  }
  if (game.shot?.outcome === "flying") {
    const ghosts = [
      { point: game.shot.trail.at(-9), radius: BALL_RADIUS - 2, gray: 65 },
      { point: game.shot.trail.at(-5), radius: BALL_RADIUS - 1, gray: 125 },
    ];
    for (const ghost of ghosts) {
      if (!ghost.point) continue;
      const pixel = place(ghost.point);
      circle(image, pixel.x, pixel.y, ghost.radius * scale, ghost.gray);
    }
    const ball = place(game.shot.ball.position);
    circle(image, ball.x, ball.y, BALL_RADIUS * scale, 255);
  }

  const finale = game.mode !== "Tutorial" && (game.shot?.finale || game.landedBin !== null);
  if (finale) {
    const lip = place({ x: 0, y: FINALE_BIN_LIP }).y;
    const floor = place({ x: 0, y: HEIGHT }).y;
    const binWidth = FINALE_BIN_WIDTH * scale;
    for (const [index, value] of FINALE_BIN_VALUES.entries()) {
      const x = ox + index * binWidth;
      if (game.landedBin === index || game.shot?.bin === index) {
        image.fillRect(Math.round(x + 1), Math.round(lip + 1), Math.floor(binWidth - 1), Math.floor(floor - lip), 44);
      }
      image.drawLine(x, lip, x, floor, 168);
      if (index > 0) circle(image, x, lip, FINALE_DIVIDER_RADIUS * scale, 210);
      const label = `${value / 1000}k`;
      if (font.measureText(label) < binWidth - 4) {
        font.drawText(image, Math.round(x + (binWidth - font.measureText(label)) / 2),
          Math.round((lip + floor - font.lineHeight) / 2), label, 230);
      }
    }
    image.drawLine(ox, floor, right, floor, 168);
  } else {
    const bucket = catcher(game.boardTime, power);
    const lip = TRAY_Y;
    stroke(image, [
      place({ x: bucket.x - bucket.half, y: lip }),
      place({ x: bucket.x - bucket.half, y: lip + 7 }),
      place({ x: bucket.x - bucket.half + 6, y: lip + 11 }),
      place({ x: bucket.x + bucket.half - 6, y: lip + 11 }),
      place({ x: bucket.x + bucket.half, y: lip + 7 }),
      place({ x: bucket.x + bucket.half, y: lip }),
    ], 2 * scale, 210);
  }

  if (game.phase === "clear" && game.mode !== "Tutorial" && game.celebration < 1.3) {
    const t = game.celebration;
    const burstX = image.width / 2;
    const burstY = (oy + bottom) / 2;
    for (let i = 0; i < 30; i++) {
      const angle = i * 2.39996;
      const speed = scale * (55 + i % 5 * 30);
      const x = burstX + (35 * scale + t * speed) * Math.cos(angle);
      const y = burstY + (25 * scale + t * speed) * Math.sin(angle) + 34 * scale * t * t;
      const gray = Math.round(220 * (1 - t / 1.4));
      if (x > ox && x < right && y > oy && y < bottom) circle(image, x, y, i % 4 === 0 ? 2 : 1, gray);
    }
  }

  if (finale && game.phase !== "clear") {
    const bannerY = Math.ceil(pivot.y + Math.max(5, 23 * scale) + 5);
    centerText(image, font, "BLITZ FINALE  ×100", bannerY, 255);
  }
  if (game.phase === "coin" && game.coin) {
    drawCoin(image, font, Math.round(image.width / 2), Math.round((oy + bottom) / 2),
      game.coin.time / COIN_SPIN_SECONDS, game.coin.won);
  }
  if (game.phase === "paused") {
    const lineHeight = font.lineHeight + 2;
    const panelHeight = lineHeight * (PAUSE_OPTIONS.length + 1) + 16;
    const panelY = Math.round((oy + bottom - panelHeight) / 2);
    const panelWidth = Math.min(180, image.width - 4);
    const panelX = Math.round((image.width - panelWidth) / 2);
    image.fillRect(panelX, panelY, panelWidth, panelHeight, 0);
    image.drawRect(panelX, panelY, panelWidth, panelHeight, 88);
    centerText(image, font, "Paused", panelY + 8, 255);
    PAUSE_OPTIONS.forEach((option, index) => {
      const selected = game.pauseSelection === index;
      centerText(image, font, selected ? `> ${option} <` : option, panelY + 8 + (index + 1) * lineHeight, selected ? 255 : 170);
    });
  }
  if (game.phase === "clear" || game.phase === "lost") {
    const finished = game.mode === "Campaign" && game.level === game.campaignLength;
    const label = game.phase === "lost" ? "Out of balls"
        : game.mode === "Tutorial" && game.tutorialStep === 1 ? (game.caught ? "Ball returned" : "Catcher demo complete")
          : finished ? "Campaign cleared" : "Board cleared";
    const dialogY = Math.floor((oy + bottom) / 2);
    const bonus = game.phase === "clear" && game.mode !== "Tutorial" && game.blitzTier === 100
      ? `Unused balls  +${game.unusedBallBonus.toLocaleString("en-US")}` : "";
    const bin = bonus ? `Ball bin  +${game.binBonus.toLocaleString("en-US")}` : "";
    const panelWidth = Math.min(image.width - 4, Math.max(145, font.measureText(label) + 26, font.measureText(bonus) + 26, font.measureText(bin) + 26));
    image.fillRect(Math.round((image.width - panelWidth) / 2), dialogY - 9, panelWidth, font.lineHeight * (bonus ? 4 : 2) + 12, 0);
    centerText(image, font, label, dialogY, 255);
    const hint = game.phase === "lost" ? "Tap to retry" : "Tap to continue";
    if (bonus) {
      centerText(image, font, bin, dialogY + font.lineHeight, 230);
      centerText(image, font, bonus, dialogY + 2 * font.lineHeight, 230);
    }
    centerText(image, font, hint, dialogY + font.lineHeight * (bonus ? 3 : 1), 195);
  }

  return image;
}

function render(window: GameWindow, inputFrameId = 0): void {
  const frameId = inputFrameId || frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const started = Date.now();
    const image = paint(window);
    const fingerprint = image.fingerprint();
    const display = getActiveDisplay();
    if (!display || fingerprint === window.fingerprint) {
      frameTimings.finishFrame(frameId, "discarded: no Peg-bounce frame change");
      return;
    }
    // As in Pinball, send a complete raster as well as the glyph metadata.
    // A menu containing only deferred text otherwise has a black pixel buffer.
    display.submitSurfaceFrame(image.withDrawsBaked(false).pixels.buffer, window.surfaceId, 0, 0, image.width,
      image.height, fingerprint, Date.now() - started, frameId, prepareFrameDraws(image.draws));
    window.fingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: Peg-bounce render failed");
    console.error(`Peg-bounce render failed: ${error}`);
  }
}

function sound(window: GameWindow, cue: Cue, now: number): void {
  if (PRIORITY[cue] < PRIORITY.power && now < window.soundUntil) return;
  const steps = CUES[cue];
  window.soundUntil = now + Math.max(85, phraseDurationMs(steps));
  try {
    playWorkerBuzzerSequence(buildSoundSequencePayload(steps));
  } catch (error) {
    console.warn(`Peg-bounce beeper unavailable: ${error}`);
  }
}

function sync(window: GameWindow): void {
  const visible = screenOn && window.foreground && window.focused;
  if (!visible) {
    window.game.pause();
    window.game.menuScanning = false;
  }
  if (!visible && window.generation !== null) {
    clearTimeout(window.generation);
    window.generation = null;
  }
  if (visible && window.game.phase === "loading" && window.generation === null) {
    window.generation = setTimeout(() => {
      window.generation = null;
      window.game.loadBoard();
      sync(window);
      if (window.foreground && screenOn) render(window);
    }, 25);
  }
  if ((!visible || !window.game.animated) && window.timer !== null) {
    clearInterval(window.timer);
    window.timer = null;
  } else if (visible && window.game.animated && window.timer === null) {
    window.time = Date.now();
    window.remainder = 0;
    window.timer = setInterval(() => {
      const now = Date.now();
      window.remainder += Math.min(0.2, (now - window.time) / 1000);
      window.time = now;
      let cue: Cue | undefined;
      while (window.remainder >= STEP) {
        const next = window.game.step();
        if (next && (!cue || PRIORITY[next] > PRIORITY[cue])) cue = next;
        window.remainder -= STEP;
      }
      if (cue) sound(window, cue, now);
      sync(window);
      render(window);
    }, FRAME_MS);
  }
}

function close(window: GameWindow): void {
  if (window.timer !== null) clearInterval(window.timer);
  if (window.generation !== null) clearTimeout(window.generation);
  windows.delete(window.windowId);
}

global.onmessage = ({ data: message }) => {
  switch (message.type) {
    case "shutdown":
      for (const window of windows.values()) close(window);
      finishWorkerShutdown();
      return;
    case "check-idle":
      global.postMessage({ type: "worker-idle" });
      return;
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) sync(window);
      return;
    case "open-window":
      windows.set(message.windowId, {
        windowId: message.windowId, surfaceId: message.surfaceId, viewport: message.viewport,
        game: createGame(), foreground: false, focused: false, timer: null, generation: null,
        time: 0, remainder: 0, fingerprint: "", prefersArm: false, soundUntil: 0,
      });
      return;
    case "close-window":
    case "render":
    case "resize-window":
    case "input":
    case "input-focus":
    case "foreground":
      break;
    default:
      return;
  }
  const window = windows.get(message.windowId);
  if (!window) return;
  switch (message.type) {
    case "close-window":
      close(window);
      return;
    case "resize-window":
      window.viewport = message.viewport;
      window.boardRaster = undefined;
      window.fingerprint = "";
      break;
    case "foreground":
      window.foreground = message.foreground;
      window.focused = message.focused;
      break;
    case "input-focus":
      window.focused = message.focused;
      break;
    case "render":
    case "input":
      if (message.focused) window.foreground = true;
      window.focused = message.focused;
      break;
  }
  if (message.type === "input") {
    const { frameId } = message;
    const event = message.event as InputEvent;
    const { game } = window;
    if ("source" in event && event.source) {
      window.prefersArm = event.source === "left-arm" || event.source === "right-arm";
    }
    switch (event.type) {
      case "click":
        game.click(window.prefersArm, Date.now());
        break;
      case "scroll-up":
        game.move(-1);
        break;
      case "swipe-up":
        game.move(-1, true);
        break;
      case "scroll-down":
        game.move(1);
        break;
      case "swipe-down":
        game.move(1, true);
        break;
      case "swipe-left":
        game.move(-5);
        break;
      case "swipe-right":
        game.move(5);
        break;
      case "double-click":
        if (game.phase === "paused" || game.phase === "menu") {
          global.postMessage({ type: "yield-focus", windowId: window.windowId });
        } else if (game.phase === "levels") game.showCampaigns();
        else if (game.phase === "campaigns") game.menu();
        else if (game.phase === "clear" || game.phase === "lost") {
          if (game.mode === "Campaign") game.showLevels();
          else game.menu();
        }
        else game.pause();
        break;
      case "system-menu-opened":
        game.pause();
        break;
      case "short-then-long-press":
        global.postMessage({ type: "open-system-menu", windowId: window.windowId });
        break;
      default:
        frameTimings.finishFrame(frameId, "discarded: Peg-bounce ignored input");
        return;
    }
    sync(window);
    render(window, frameId);
    return;
  }
  sync(window);
  if (window.foreground && screenOn) render(window);
};

// The host holds open, render, and input messages until the handler is live.
global.postMessage({ type: "worker-ready" });
