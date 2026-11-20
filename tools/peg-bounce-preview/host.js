const $ = id => document.getElementById(id);
const screen = $("screen");
const context = screen.getContext("2d", { alpha: false });
const glyphContext = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
const worker = { isAndroid: true, previewLayout: { scale: 1, x: 0, y: 0 }, postMessage: onReply };
const settings = new Map();
let uiFontFamily = "PegUi";
let uiFontRevision = 0;
let frame = null;
let submitted = 0;
let ready = false;
const windowId = "peg-bounce:main";
const surfaceId = "peg-bounce:preview";
const noop = () => {};

function onReply(message) {
  if (message.type === "worker-ready") ready = true;
  if (message.type === "yield-focus") restart();
}

function submitSurfaceFrame(buffer, id, x, y, width, height) {
  if (id !== surfaceId) return;
  if (!frame || frame.width !== width || frame.height !== height) frame = context.createImageData(width, height);
  const gray = new Uint8Array(buffer);
  for (let i = 0, offset = 0; i < gray.length; i++, offset += 4) {
    frame.data[offset + 1] = grayToNibble(gray[i]) * 17;
    frame.data[offset + 3] = 255;
  }
  context.putImageData(frame, x, y);
  screen.dataset.frames = String(++submitted);
}

function setFont(size) {
  glyphContext.font = size + "px " + uiFontFamily;
  glyphContext.textBaseline = "alphabetic";
}

function renderGlyphCell(path, size, cp, gamma) {
  const char = String.fromCodePoint(cp);
  setFont(size);
  const metrics = glyphContext.measureText(char);
  const left = -Math.ceil(metrics.actualBoundingBoxLeft);
  const top = Math.ceil(metrics.actualBoundingBoxAscent);
  const width = Math.max(0, Math.ceil(metrics.actualBoundingBoxRight) - left);
  const height = Math.max(0, top + Math.ceil(metrics.actualBoundingBoxDescent));
  const result = new Uint8Array(10 + width * height);
  const header = new DataView(result.buffer);
  header.setUint16(0, Math.round(metrics.width * 64), true);
  header.setInt16(2, left, true);
  header.setInt16(4, Math.ceil(metrics.fontBoundingBoxAscent) - top, true);
  header.setUint16(6, width, true);
  header.setUint16(8, height, true);
  if (width === 0 || height === 0) return result;
  glyphContext.canvas.width = width;
  glyphContext.canvas.height = height;
  setFont(size);
  glyphContext.fillText(char, -left, top);
  const { data } = glyphContext.getImageData(0, 0, width, height);
  for (let i = 0; i < width * height; i++) result[10 + i] = Math.round(255 * (data[i * 4 + 3] / 255) ** gamma);
  return result;
}

const virtualFolder = { path: "/", getFile: name => ({ path: name }) };
const adapters = {
  "@nativescript/core/globals": {},
  "@nativescript/core": { knownFolders: { documents: () => virtualFolder, currentApp: () => virtualFolder } },
  "graphics/ui-fonts": {
    getDefaultSmallFont: () => localRequire("graphics/ttf-font").TtfFont.load("preview-ui/" + uiFontRevision, 16),
  },
  "native/active-display": { getActiveDisplay: () => ({ submitSurfaceFrame }) },
  "native/frame-timings": { startFrame: () => 1, finishFrame: noop },
  "native/settings-store": {
    getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
    setStringSetting: (key, value) => settings.set(key, value),
    disposeSettingsStore: noop,
  },
  "native/worker-buzzer": { playWorkerBuzzerSequence: noop },
  "native/texture-atlas": { textureAtlasAvailable: () => false },
  "native/font-renderer": {
    fontRenderer: {
      getFontMetrics(path, size) {
        setFont(size);
        const metrics = glyphContext.measureText("M");
        return `${metrics.fontBoundingBoxAscent} ${metrics.fontBoundingBoxDescent} 0`;
      },
      measureTextExact(path, text, size) {
        setFont(size);
        return glyphContext.measureText(text).width;
      },
      renderGlyphCell,
    },
  },
};

const moduleCache = new Map();
function localRequire(id) {
  if (Object.hasOwn(adapters, id)) return adapters[id];
  if (moduleCache.has(id)) return moduleCache.get(id).exports;
  const load = moduleFactories[id];
  if (!load) throw new Error("Missing preview dependency " + id);
  const module = { exports: {} };
  moduleCache.set(id, module);
  load(module, module.exports, request => {
    if (!request.startsWith(".")) return localRequire(request);
    const parts = id.split("/").slice(0, -1);
    for (const part of request.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    return localRequire(parts.join("/"));
  }, worker);
  return module.exports;
}

const { grayToNibble } = localRequire("graphics/image");
const { CAMPAIGN_LIBRARY_SETTING, parseImportedCampaign, importedCampaignName } =
  localRequire("apps/peg-bounce/imported-campaign");

function send(type, data = {}) {
  if (ready) worker.onmessage({ data: { type, windowId, ...data } });
}

function number(id) {
  const field = $(id);
  const value = Number.isFinite(field.valueAsNumber) ? field.valueAsNumber : Number(field.defaultValue);
  return Math.round(Math.min(Number(field.max), Math.max(Number(field.min), value)));
}

function viewport() {
  const width = number("width");
  const height = number("height");
  if (screen.width !== width) screen.width = width;
  if (screen.height !== height) screen.height = height;
  screen.style.width = width + "px";
  screen.style.height = height + "px";
  worker.previewLayout = { scale: number("board-scale") / 100, x: number("board-x"), y: number("board-y") };
  $("scale-value").value = number("board-scale") + "%";
  return {
    width, height,
    edges: { top: "offscreen", right: "offscreen", bottom: "offscreen", left: "offscreen" },
    padding: { top: number("hud"), right: 0, bottom: 0, left: 0 },
  };
}

function restart() {
  send("close-window");
  send("open-window", { surfaceId, viewport: viewport() });
  send("foreground", { foreground: true, focused: true });
}

function input(type) {
  send("input", { focused: true, frameId: 0, event: { type, source: "ring" } });
}

for (const button of document.querySelectorAll("[data-input]")) {
  button.onclick = () => input(button.dataset.input);
}
$("restart").onclick = restart;
for (const id of ["width", "height", "board-scale", "board-x", "board-y", "hud"]) {
  $(id).addEventListener(id === "board-scale" ? "input" : "change", () => send("resize-window", { viewport: viewport() }));
}

const keys = { ArrowUp: "scroll-up", ArrowDown: "scroll-down", ArrowLeft: "swipe-left",
  ArrowRight: "swipe-right", Enter: "click", " ": "click", Escape: "double-click" };
screen.onkeydown = event => {
  if (!keys[event.key]) return;
  event.preventDefault();
  input(keys[event.key]);
};

$("campaign").onchange = async ({ target }) => {
  if (!target.files[0]) return;
  try {
    const json = await target.files[0].text();
    parseImportedCampaign(json);
    const name = importedCampaignName(json) || target.files[0].name.replace(/\.json$/i, "");
    const library = JSON.parse(settings.get(CAMPAIGN_LIBRARY_SETTING) || "[]");
    if (!library.some(pack => pack.text === json)) library.push({ name, text: json });
    settings.set(CAMPAIGN_LIBRARY_SETTING, JSON.stringify(library));
    restart();
    $("status").textContent = `Loaded “${name}”. Select it in Campaign.`;
  } catch (error) {
    $("status").textContent = "Campaign import failed. " + error.message;
  }
};

$("ui-font").onchange = async ({ target }) => {
  if (!target.files[0]) return;
  try {
    const revision = uiFontRevision + 1;
    const family = "PegUi" + revision;
    const face = new FontFace(family, await target.files[0].arrayBuffer());
    document.fonts.add(await face.load());
    uiFontFamily = family;
    uiFontRevision = revision;
    send("render", { focused: true });
    $("status").textContent = "UI font loaded. " + target.files[0].name;
  } catch (error) {
    $("status").textContent = "UI font import failed. " + error.message;
  }
};

document.fonts.load("16px PegUi").then(() => {
  localRequire("apps/peg-bounce/peg-bounce.worker");
  if (!ready) throw new Error("The Peg-Bounce worker did not start.");
  restart();
  $("status").textContent = "Faceclaw worker running · Roboto Light";
  screen.focus();
}).catch(error => { $("status").textContent = error.message; });
