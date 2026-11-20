import { GrayImage, type UiFont } from "../../graphics/image";
import { BLITZ_TIERS } from "./game";

const FRAME = 88;
const TEXT = 230;

const fittedLabels = new WeakMap<UiFont, Map<string, { display: string; width: number }>>();

function fitLabel(font: UiFont, text: string, maxWidth: number): { display: string; width: number } {
  let cache = fittedLabels.get(font);
  if (!cache) {
    cache = new Map();
    fittedLabels.set(font, cache);
  }
  const key = maxWidth + ":" + text;
  const cached = cache.get(key);
  if (cached) return cached;

  let display = text;
  let width = font.measureText(display);
  if (width > maxWidth) {
    const characters = Array.from(text);
    do {
      characters.pop();
      display = characters.join("") + "...";
      width = font.measureText(display);
    } while (characters.length && width > maxWidth);
  }

  const fitted = { display, width };
  // Score strings change throughout play. Bound the cache for long sessions.
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, fitted);
  return fitted;
}

function label(image: GrayImage, font: UiFont, text: string, x: number, y: number,
    maxWidth: number, alignment: "left" | "center" | "right" = "center", gray = TEXT): void {
  const { display, width } = fitLabel(font, text, maxWidth);
  if (width <= maxWidth) {
    font.drawText(image, Math.round(alignment === "left" ? x : alignment === "right" ? x - width : x - width / 2), y, display, gray);
  }
}

function ring(image: GrayImage, x: number, y: number, radius: number, gray: number): void {
  const segments = Math.max(12, Math.round(radius * 5));
  let lastX = x + radius;
  let lastY = y;
  for (let step = 1; step <= segments; step++) {
    const angle = step * Math.PI * 2 / segments;
    const nextX = x + radius * Math.cos(angle);
    const nextY = y + radius * Math.sin(angle);
    image.drawLine(lastX, lastY, nextX, nextY, gray);
    lastX = nextX;
    lastY = nextY;
  }
}

export function drawLauncher(image: GrayImage, x: number, y: number, angle: number, scale: number): void {
  ring(image, x, y, Math.max(5, 23 * scale), 255);
  ring(image, x, y, Math.max(3, 15 * scale), TEXT);
  const length = 22 * scale;
  const halfWidth = Math.max(2, 6 * scale);
  const sideX = Math.cos(angle) * halfWidth;
  const sideY = -Math.sin(angle) * halfWidth;
  const endX = x + Math.sin(angle) * length;
  const endY = y + Math.cos(angle) * length;
  const inner = Math.max(0, Math.floor(halfWidth) - 1);
  for (let offset = -inner; offset <= inner; offset++) {
    const dx = Math.cos(angle) * offset;
    const dy = -Math.sin(angle) * offset;
    image.drawLine(x + dx, y + dy, endX + dx, endY + dy, 0);
  }
  image.drawLine(x - sideX, y - sideY, endX - sideX, endY - sideY, 255);
  image.drawLine(x + sideX, y + sideY, endX + sideX, endY + sideY, 255);
  image.drawLine(endX - sideX, endY - sideY, endX + sideX, endY + sideY, 255);
}

type Hud = {
  blitzProgress: number; blitzTier: number;
  balls: number; score: number; top: number; bottom: number; rail: number;
  power: string | null; canPause: boolean;
};

function hudLayout(width: number, top: number, bottom: number, rail: number) {
  const left = 9;
  const boxWidth = rail - 15;
  const right = width - left - boxWidth;
  const center = Math.round(width / 2);
  const railTop = top + 27;
  const countTop = railTop + 37;
  const countHeight = Math.max(18, Math.min(42, bottom - countTop - 50));
  const controlsTop = bottom - 43;
  return {
    left, right, boxWidth, center, railTop, countTop, countHeight, controlsTop,
    headerWidth: center - rail - 48, scoreX: rail + 4, topScoreX: center + 48,
    trackTop: countTop + countHeight + 6, trackBottom: controlsTop - 5,
  };
}

export function drawPlayfieldHudFrame(image: GrayImage, top: number, bottom: number, rail: number): void {
  const { left, right, boxWidth, headerWidth, scoreX, topScoreX, countTop, countHeight,
    controlsTop, trackTop, trackBottom } = hudLayout(image.width, top, bottom, rail);
  image.drawRect(3, 3, image.width - 6, image.height - 6, FRAME);
  for (const x of [scoreX, topScoreX]) {
    image.drawLine(x, top + 29, x + headerWidth, top + 29, FRAME);
  }
  image.drawRect(left, countTop, boxWidth, countHeight, FRAME);
  for (const x of [left, right]) {
    image.drawRect(x, controlsTop, boxWidth, 43, FRAME);
    if (trackBottom > trackTop) {
      image.drawLine(x + 6, trackTop, x + 6, trackBottom, FRAME);
      image.drawLine(x + boxWidth - 6, trackTop, x + boxWidth - 6, trackBottom, FRAME);
    }
  }
}

export function drawPlayfieldHud(image: GrayImage, font: UiFont, hud: Hud): void {
  const { balls, score, top, bottom, rail, power, canPause } = hud;
  const { left, right, boxWidth, center, headerWidth, scoreX, topScoreX, railTop,
    countTop, countHeight, controlsTop, trackTop, trackBottom } = hudLayout(image.width, top, bottom, rail);
  const leftCenter = left + boxWidth / 2;
  const rightCenter = right + boxWidth / 2;
  const labelWidth = Math.min(122, Math.floor(headerWidth * 0.65));

  for (const [x, name, value] of [[scoreX, "QUICK SCORE", score.toLocaleString("en-US")], [topScoreX, "TOP SCORE", "—"]] as const) {
    label(image, font, name, x, top + 4, labelWidth, "left");
    label(image, font, value, x + headerWidth - 2, top + 4, headerWidth - labelWidth - 5, "right", 255);
  }
  label(image, font, power ?? "GUIDE", center, top, 88);

  const secondLine = railTop + Math.min(19, font.lineHeight);
  const titleWidth = boxWidth;
  const titleHeight = countTop - railTop;
  if (2 * font.lineHeight <= titleHeight &&
      fitLabel(font, "The Ball", Infinity).width <= titleWidth &&
      fitLabel(font, "-inator", Infinity).width <= titleWidth) {
    label(image, font, "The Ball", leftCenter, railTop, titleWidth);
    label(image, font, "-inator", leftCenter, railTop + font.lineHeight, titleWidth);
  } else {
    label(image, font, "Balls", leftCenter,
      railTop + Math.max(0, Math.floor((titleHeight - font.lineHeight) / 2)), titleWidth);
  }
  label(image, font, "Blitz", rightCenter, railTop, rail - 4);
  label(image, font, "Gauge", rightCenter, secondLine, rail - 4);
  label(image, font, String(balls), leftCenter, countTop + Math.max(0, Math.floor((countHeight - font.lineHeight) / 2)), boxWidth - 8, "center", 255);
  const finale = hud.blitzTier === 100;
  ring(image, rightCenter, countTop + countHeight / 2, Math.min(16, boxWidth / 3), finale ? 255 : 128);
  label(image, font, "×" + hud.blitzTier, rightCenter,
    countTop + Math.floor((countHeight - font.lineHeight) / 2), boxWidth - 6, "center", finale ? 255 : TEXT);

  const trackHeight = Math.max(0, trackBottom - trackTop);
  if (trackHeight >= 20) {
    const rows = Math.floor(trackHeight / 16);
    const columns = Math.min(Math.max(1, Math.floor((boxWidth - 14) / 14)), Math.max(1, Math.ceil(balls / rows)));
    const capacity = rows * columns;
    const count = balls > capacity ? capacity - columns : balls;
    for (let i = 0; i < count; i++) {
      const x = leftCenter + (i % columns - (columns - 1) / 2) * 14;
      const y = trackBottom - 8 - Math.floor(i / columns) * 16;
      ring(image, x, y, columns === 1 ? 6 : 5, 215);
    }
    if (balls > capacity) label(image, font, "+" + (balls - count), leftCenter, trackTop, boxWidth - 14);
    const fill = Math.round(trackHeight * hud.blitzProgress);
    if (fill > 0) {
      image.fillRect(right + 7, trackBottom - fill, 3, fill, 168);
      image.fillRect(right + boxWidth - 9, trackBottom - fill, 3, fill, 168);
    }
    const tiers = BLITZ_TIERS.slice(1).map((value, i) => ({
      value: "×" + value,
      reached: hud.blitzTier >= value,
      y: Math.round(trackBottom - trackHeight * (i + 1) / BLITZ_TIERS.length),
    }));
    for (const { value, reached, y } of tiers) {
      const gap = Math.ceil(fitLabel(font, value, Infinity).width / 2) + 4;
      for (let x = right + 10; x <= right + boxWidth - 10; x += 4) {
        if (Math.abs(x - rightCenter) > gap) image.setPixel(x, y, reached ? 168 : FRAME);
      }
      label(image, font, value, rightCenter, y - Math.floor(font.lineHeight / 2), boxWidth - 14, "center", reached ? 255 : 148);
    }
  }

  label(image, font, "••", leftCenter, controlsTop + 1, boxWidth);
  label(image, font, canPause ? "Pause" : "Back", leftCenter, controlsTop + 20, boxWidth - 6);
}


export function drawCoin(image: GrayImage, font: UiFont, x: number, y: number,
    progress: number, won: boolean): void {
  const radius = Math.min(40, Math.round(image.height / 8));
  const spinning = progress < 1;
  const width = Math.max(2, Math.round(radius * Math.abs(Math.cos(progress * Math.PI * 7))));
  const rx = spinning ? width : radius;
  image.fillRect(x - radius - 20, y - radius - 27, 2 * radius + 40, 2 * radius + 62, 0);
  for (let row = -radius; row <= radius; row++) {
    const dx = Math.round(rx * Math.sqrt(1 - (row / radius) ** 2));
    image.setPixel(x - dx, y + row, 255);
    image.setPixel(x + dx, y + row, 255);
  }
  if (!spinning && !won) {
    image.drawLine(x - 10, y - 10, x + 10, y + 10, 230);
    image.drawLine(x + 10, y - 10, x - 10, y + 10, 230);
  } else {
    const dx = Math.max(1, Math.round(rx * 0.43));
    image.drawLine(x, y - 18, x + dx, y, 230);
    image.drawLine(x + dx, y, x, y + 18, 230);
    image.drawLine(x, y + 18, x - dx, y, 230);
    image.drawLine(x - dx, y, x, y - 18, 230);
  }
  label(image, font, spinning ? "Coin flip" : won ? "Free Ball +1" : "Ball lost",
    x, y + radius + 6, 2 * radius + 38, "center", 255);
}
