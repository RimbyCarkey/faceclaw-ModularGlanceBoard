const fs = require("node:fs");
const path = require("node:path");
const source = path.resolve(process.argv[2] || path.join(__dirname, "../.."));
const ts = require(process.env.PEG_TYPESCRIPT || require.resolve("typescript", { paths: [source] }));
const app = path.join(source, "app");
const entry = "apps/peg-bounce/peg-bounce.worker";
const replaced = new Set([
  "@nativescript/core", "@nativescript/core/globals",
  "native/active-display", "native/frame-timings", "native/lvgl-font",
  "native/settings-store", "native/worker-buzzer", "native/texture-atlas",
  "native/font-renderer", "graphics/ui-fonts",
]);
const modules = new Map();
const resolve = (from, request) => request.startsWith(".")
  ? path.posix.normalize(path.posix.join(path.posix.dirname(from), request))
  : request;

function bundle(id) {
  if (modules.has(id) || replaced.has(id)) return;
  const filename = path.join(app, id + ".ts");
  let input = fs.readFileSync(filename, "utf8");
  if (id === entry) {
    const adjustments = [
      ["const scale = Math.max(0.05, Math.min", "const scale = global.previewLayout.scale * Math.max(0.05, Math.min"],
      ["const ox = Math.round", "const ox = global.previewLayout.x + Math.round"],
      ["const oy = hud + line;", "const oy = hud + line + global.previewLayout.y;"],
    ];
    for (const [before, after] of adjustments) {
      if (!input.includes(before)) throw new Error("Peg-Bounce layout changed: " + before);
      input = input.replace(before, after);
    }
  }
  const js = ts.transpileModule(input, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  modules.set(id, js);
  for (const match of js.matchAll(/\brequire\(["']([^"']+)["']\)/g)) bundle(resolve(id, match[1]));
}

bundle(entry);
bundle("graphics/ttf-font");
const bundled = [...modules]
  .map(([id, js]) => `${JSON.stringify(id)}: (module, exports, require, global) => {\n${js}\n}`).join(",\n");
const uiFont = fs.readFileSync(path.join(app, "fonts/ttf/Roboto-Light.ttf")).toString("base64");
const template = fs.readFileSync(path.join(__dirname, "window.html"), "utf8");
const host = fs.readFileSync(path.join(__dirname, "host.js"), "utf8");
const html = template.replace("/* UI FONT */", () => uiFont)
  .replace("/* MODULES */", () => bundled.replace(/<\/script/gi, "<\\/script"))
  .replace("/* HOST */", () => host);
fs.writeFileSync(process.argv[3] || "Peg-Bounce Standalone.html", html);
