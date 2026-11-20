const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "peg-bounce-editor-"));
const output = resolve(process.argv[2] ?? "Peg-bounce Level Editor.html");

try {
  execFileSync(process.execPath, [
    process.env.PEG_TSC || join(root, "node_modules/typescript/bin/tsc"), "app/apps/peg-bounce/boards.ts",
    "--module", "commonjs", "--target", "es2020", "--skipLibCheck", "--strict", "--outDir", scratch,
  ], { cwd: root, stdio: "inherit" });
  const modules = ["physics", "boards"].map(name =>
    `modules["./${name}"] = (exports, require) => {\n${readFileSync(join(scratch, name + ".js"), "utf8")}\n};`,
  );
  const bundle = [
    "(() => {",
    "const modules = {}, cache = {};",
    ...modules,
    "function require(name) { if (!cache[name]) { cache[name] = {}; modules[name](cache[name], require); } return cache[name]; }",
    readFileSync(join(__dirname, "editor.js"), "utf8"),
    "})();",
  ].join("\n").replace(/<\/script/gi, "<\\/script");
  const html = readFileSync(join(__dirname, "editor.html"), "utf8").replace("/* EDITOR_BUNDLE */", () => bundle);
  writeFileSync(output, html);
  console.log(output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
