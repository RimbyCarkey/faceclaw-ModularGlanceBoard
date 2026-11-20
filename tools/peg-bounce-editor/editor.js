const { WIDTH, HEIGHT, LEGACY_HEIGHT, STEP, BALL_RADIUS, TRAY_Y, launch, advance, aimGuide, catcher } = require("./physics");
const { campaignBoard, campaignShots, CAMPAIGN_LENGTH, STANDARD_TARGET_COUNT, hasClearingRoute } = require("./boards");
const $ = id => document.getElementById(id);
const canvas = $("board");
const ctx = canvas.getContext("2d");
const radians = degrees => degrees * Math.PI / 180;
const degrees = angle => angle * 180 / Math.PI;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roles = ["standard", "target", "bonus", "power", "blocker"];
const limits = { x: [0, WIDTH], y: [0, HEIGHT], radius: [1, 300], rotation: [-360, 360],
  length: [4, 550], span: [5, 360], thickness: [2, 50], amplitude: [0, 180],
  cycles: [0.5, 8], turns: [0.25, 4], pitch: [0, 130] };
const PEG_RADIUS = 5.75;
const PINCH_GAP = 2.5 * BALL_RADIUS;
const defaults = { radius: 65, length: 75, rotation: 28, span: 180, thickness: 6, amplitude: 35, cycles: 2.5, turns: 1.25, pitch: 66 };
const STORAGE = "peg-bounce-project-v2";
const blankLevel = name => ({ name, balls: 10, targetCount: STANDARD_TARGET_COUNT, grid: true, gridStep: 20, pieces: [] });
let levels = [blankLevel("Level 1")];
let active = 0;
let campaignName = "Untitled campaign";
let scene = levels[0].pieces;
let dirty = false;
let previewTimer;
let selected = -1;
let pieces = [];
let owners = [];
let shot = null;
let clock = 0;
let playing = false;
let pointer = null;
let elapsed = 0;
let lastFrame = null;

const isGuide = shape => shape.kind === "wave" || shape.kind === "spiral";
const pieceNames = { peg: "Peg", brick: "Straight ramp", arc: "Curved ramp", wave: "Wave", spiral: "Spiral" };
const wrapAngle = angle => ((angle + 180) % 360 + 360) % 360 - 180;

function normalize(shape) {
  if (!shape || !Object.hasOwn(pieceNames, shape.kind) || !roles.includes(shape.role)) throw new Error("Invalid piece");
  const normalized = { kind: shape.kind, role: shape.role };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const value = shape[key] ?? (key === "radius" && shape.kind === "peg" ? PEG_RADIUS : defaults[key]);
    if (!Number.isFinite(value)) throw new Error("Invalid " + key);
    normalized[key] = clamp(value, min, max);
  }
  if (shape.kind === "arc") normalized.thickness = Math.min(normalized.thickness, Math.max(2, (normalized.radius - BALL_RADIUS - 1) * 2));
  if (shape.kind === "arc" && normalized.radius <= BALL_RADIUS + normalized.thickness / 2) {
    normalized.radius = BALL_RADIUS + normalized.thickness / 2 + 1;
  }
  normalized.snap = shape.snap === true;
  if (isGuide(shape)) normalized.mirrored = shape.mirrored === true;
  if ((isGuide(shape) || shape.kind === "arc") && Array.isArray(shape.targets)) {
    normalized.targets = [...new Set(shape.targets.filter(tile => Number.isInteger(tile) && tile >= 0 && tile < 2200))];
  }
  if (Number.isSafeInteger(shape.link) && shape.link >= 0) normalized.link = shape.link;
  if (Number.isInteger(shape.group) && shape.group >= 0) normalized.group = shape.group;
  return normalized;
}

function pieceGeometry(shape, index) {
  if (isGuide(shape)) {
    let tile = 0;
    return guideParts(shape, -1 - index).flatMap(part =>
      pieceGeometry(part, index).map(piece => {
        const target = shape.targets?.includes(tile++);
        if (target && piece.role === "standard") piece.role = "target";
        return piece;
      }));
  }
  const { x, y, role } = shape;
  if (shape.kind === "peg") return [{ role, radius: shape.radius, path: [{ x, y }] }];
  const angle = radians(shape.rotation);
  if (shape.kind === "brick") {
    const along = { x: Math.cos(angle) * shape.length / 2, y: Math.sin(angle) * shape.length / 2 };
    const normal = { x: -Math.sin(angle) * shape.thickness / 2, y: Math.cos(angle) * shape.thickness / 2 };
    return [{ role, geometry: "brick", radius: 0, path: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
      ({ x: x + along.x * a + normal.x * b, y: y + along.y * a + normal.y * b })) }];
  }
  const span = radians(shape.span);
  const count = Math.ceil(shape.radius * span / 16);
  const tileSpan = span / count;
  return Array.from({ length: count }, (_, i) => {
    const start = angle + i * tileSpan;
    return {
      role: role === "standard" && shape.targets?.includes(i) ? "target" : role, radius: shape.thickness / 2,
      geometry: { center: { x, y }, radius: shape.radius, start, span: tileSpan,
        caps: [true, true], guide: shape.group ?? -1 - index },
      path: Array.from({ length: 7 }, (_, j) => ({
        x: x + Math.cos(start + j * tileSpan / 6) * shape.radius,
        y: y + Math.sin(start + j * tileSpan / 6) * shape.radius,
      })),
    };
  });
}

function compileScene(shapes) {
  const pieces = [];
  const owners = [];
  const guides = new Map();
  shapes.forEach((shape, index) => {
    for (const piece of pieceGeometry(shape, index)) {
      pieces.push(piece);
      owners.push(index);
      const arc = piece.geometry;
      if (typeof arc !== "object") continue;
      if (!guides.has(arc.guide)) guides.set(arc.guide, []);
      guides.get(arc.guide).push(arc);
    }
  });
  for (const guide of guides.values()) {
    for (const arc of guide) {
      const endpoint = (tile, angle) => ({
        x: tile.center.x + tile.radius * Math.cos(angle),
        y: tile.center.y + tile.radius * Math.sin(angle),
      });
      const connected = (a, angle) => {
        const point = endpoint(a, angle);
        return guide.some(other => other !== a && [other.start, other.start + other.span].some(theta => {
          const end = endpoint(other, theta);
          return Math.hypot(point.x - end.x, point.y - end.y) < 0.2 &&
            Math.abs(Math.sin(theta - angle)) < 0.28;
        }));
      };
      arc.caps = [!connected(arc, arc.start), !connected(arc, arc.start + arc.span)];
    }
  }
  return { pieces, owners };
}

let pinchPairs = [];
const routeResults = new WeakMap();

function rebuild() {
  ({ pieces, owners } = compileScene(scene));
  pinchPairs = [];
  const solids = pieces.map((piece, index) => ({ piece, index })).filter(({ piece, index }) =>
    typeof piece.geometry !== "object" && !isGuide(scene[owners[index]]));
  for (let i = 0; i < solids.length; i++) {
    const a = solids[i];
    for (let j = i + 1; j < solids.length; j++) {
      const b = solids[j];
      const gap = Math.min(
        ...a.piece.path.map(point => distanceToPiece(point, b.piece) - a.piece.radius),
        ...b.piece.path.map(point => distanceToPiece(point, a.piece) - b.piece.radius),
      );
      if (gap < PINCH_GAP || bricksOverlap(a.piece, b.piece)) pinchPairs.push([a.index, b.index]);
    }
  }
}

function levelWarnings(level, actual) {
  const warnings = [];
  if (!actual) warnings.push("No targets to clear.");
  if (actual !== level.targetCount) warnings.push(`Target count mismatch (${actual} placed, ${level.targetCount} requested).`);
  if (actual > level.balls * 3) warnings.push("Tight ball budget (more than 3 targets per ball).");
  return warnings;
}

function checkRoute(level, collisionPieces) {
  const signature = JSON.stringify([level.balls, collisionPieces]);
  const previous = routeResults.get(level);
  if (previous?.signature === signature) return previous.message;
  const message = !collisionPieces.some(piece => piece.role === "target") ? "Route check skipped for a board with zero targets."
    : hasClearingRoute({ name: level.name, pieces: collisionPieces, power: null }, null, level.balls)
      ? `Simulator found a clearing route within ${level.balls} balls.`
      : `Simulator found no clearing route within ${level.balls} balls. The search samples angles, so a manual route may exist.`;
  routeResults.set(level, { signature, message });
  return message;
}

function fromPreset(piece) {
  const { geometry, path, radius, role } = piece;
  if (typeof geometry === "object") return normalize({
    kind: "arc", ...geometry.center, role, radius: geometry.radius, thickness: radius * 2,
    rotation: degrees(geometry.start), span: degrees(geometry.span), group: geometry.guide,
  });
  if (geometry === "brick") {
    const [a, b, c] = path;
    return normalize({ kind: "brick", role, x: (a.x + c.x) / 2, y: (a.y + c.y) / 2,
      length: Math.hypot(b.x - a.x, b.y - a.y), thickness: Math.hypot(c.x - b.x, c.y - b.y),
      rotation: degrees(Math.atan2(b.y - a.y, b.x - a.x)) });
  }
  return normalize({ kind: "peg", ...path[0], role, radius });
}

function updateSelection() {
  const shape = scene[selected];
  $("scene").replaceChildren(...scene.map((item, i) =>
    new Option(`${i + 1}. ${pieceNames[item.kind]} · ${item.role}`, i)));
  $("scene").selectedIndex = selected;
  $("scene").hidden = !scene.length;
  $("empty").hidden = !!shape;
  $("properties").hidden = !shape;
  if (!shape) return;
  $("radius-field").hidden = shape.kind === "brick" || shape.kind === "wave";
  $("radius-label").textContent = shape.kind === "spiral" ? "Inner radius" : "Radius";
  $("rotation-field").hidden = shape.kind === "peg";
  $("length-field").hidden = shape.kind !== "brick" && shape.kind !== "wave";
  for (const key of ["amplitude", "cycles"]) $(key + "-field").hidden = shape.kind !== "wave";
  for (const key of ["turns", "pitch"]) $(key + "-field").hidden = shape.kind !== "spiral";
  $("ungroup").hidden = shape.group === undefined;
  $("span-field").hidden = shape.kind !== "arc";
  $("thickness-field").hidden = shape.kind === "peg";
  for (const key of Object.keys(limits)) $(key).value = +shape[key].toFixed(2);
  $("role").value = shape.role;
  $("solid-field").hidden = shape.kind === "peg";
  $("solid").checked = shape.role === "blocker";
  $("snap").checked = shape.snap;
  $("rotation-dial").hidden = shape.kind === "peg";
  $("partner").replaceChildren(new Option("None", ""), ...scene.flatMap((item, i) =>
    i !== selected && item.kind === shape.kind ? [new Option(`Piece ${i + 1}`, i)] : []));
  const partner = partnerOf(selected);
  $("partner").value = partner < 0 ? "" : String(partner);
  $("mirror").disabled = partner >= 0;
  for (const knob of document.querySelectorAll("[data-dial]")) {
    const key = knob.dataset.dial;
    knob.style.setProperty("--turn", (key === "rotation" ? shape.rotation : shape[key] / limits[key][1] * 270 - 135) + "deg");
    knob.title = `${key.toUpperCase()} ${Math.round(shape[key])}, drag or use arrow keys`;
  }
}

function reset() {
  playing = false;
  shot = null;
  elapsed = 0;
  lastFrame = null;
  clock = 0;
}

function persist() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({ version: 2, boardHeight: HEIGHT, campaignName, levels, active, dirty }));
    $("save-status").textContent = dirty ? "Draft kept in this browser · Save project for a file" : "Draft kept in this browser";
  } catch {
    $("save-status").textContent = "Browser storage unavailable · Save project for a file";
  }
}

function paintThumbnail(canvas, level) {
  const ink = canvas.getContext("2d");
  ink.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ink.clearRect(0, 0, WIDTH, HEIGHT);
  level.pieces.forEach((shape, index) => pieceGeometry(shape, index).forEach(piece => {
    ink.strokeStyle = piece.role === "target" ? "#e1ff98" : "#79af88";
    ink.fillStyle = ink.strokeStyle;
    ink.lineWidth = piece.geometry === "brick" ? 5 : Math.max(5, piece.radius * 2);
    ink.beginPath();
    const [first, ...rest] = piece.path;
    if (!rest.length) {
      ink.arc(first.x, first.y, Math.max(piece.radius, 5), 0, Math.PI * 2);
      ink.fill();
    } else {
      ink.moveTo(first.x, first.y);
      for (const point of rest) ink.lineTo(point.x, point.y);
      if (piece.geometry === "brick") ink.closePath();
      ink.stroke();
    }
  }));
}

function renderLevels() {
  const list = $("levels");
  const scroll = list.scrollTop;
  list.replaceChildren(...levels.map((level, index) => {
    const button = document.createElement("button");
    button.className = "level";
    button.setAttribute("aria-current", String(index === active));
    const canvas = document.createElement("canvas");
    canvas.width = 140;
    canvas.height = Math.round(canvas.width * HEIGHT / WIDTH);
    canvas.setAttribute("aria-hidden", "true");
    paintThumbnail(canvas, level);
    const name = document.createElement("span");
    name.textContent = `${index + 1}. ${level.name}`;
    button.append(canvas, name);
    button.onclick = () => selectLevel(index);
    return button;
  }));
  list.scrollTop = scroll;
}

function changed() {
  $("validation").textContent = "";
  dirty = true;
  persist();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderLevels, 160);
}

function refresh(save = true) {
  reset();
  rebuild();
  updateSelection();
  draw();
  if (save) changed();
}

function selectLevel(index) {
  $("validation").textContent = "";
  active = index;
  const level = levels[index];
  scene = level.pieces;
  selected = -1;
  pointer = null;
  $("level-name").value = level.name;
  $("target-count").value = level.targetCount;
  $("ball-count").value = level.balls;
  $("grid-step").value = level.gridStep;
  $("grid").checked = level.grid;
  refresh(false);
  renderLevels();
  persist();
}

function appendLevel(level) {
  levels.push(level);
  dirty = true;
  selectLevel(levels.length - 1);
}

function loadPreset() {
  const board = campaignBoard(Number($("preset").value));
  appendLevel({
    ...blankLevel(board.name),
    balls: campaignShots(Number($("preset").value)),
    targetCount: board.pieces.filter(piece => piece.role === "target").length,
    pieces: board.pieces.map(fromPreset),
  });
}

function partnerOf(index) {
  const link = scene[index]?.link;
  return link === undefined ? -1 : scene.findIndex((shape, i) => i !== index && shape.link === link);
}

function unlink(index) {
  const partner = partnerOf(index);
  if (partner >= 0) delete scene[partner].link;
  delete scene[index].link;
}

function mirrorInto(index, partner) {
  const source = scene[index];
  const rotation = 180 - source.rotation - (source.kind === "arc" ? source.span : 0);
  scene[partner] = normalize({ ...source, x: WIDTH - source.x, rotation: wrapAngle(rotation), mirrored: !source.mirrored,
    role: scene[partner].role, targets: scene[partner].targets, snap: scene[partner].snap, group: scene[partner].group });
}

function edit(values) {
  if (selected < 0) return;
  const shape = normalize({ ...scene[selected], ...values });
  if (shape.snap) for (const key of ["x", "y"]) {
    if (key in values) shape[key] = clamp(Math.round(shape[key] / levels[active].gridStep) * levels[active].gridStep, ...limits[key]);
  }
  const original = scene[selected];
  if (original.group !== undefined && ("x" in values || "y" in values || "rotation" in values)) {
    const members = scene.filter(item => item.group === original.group);
    const angle = radians(shape.rotation - original.rotation);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotated = members.map(item => {
      const x = item.x - original.x, y = item.y - original.y;
      return { x: x * cos - y * sin, y: x * sin + y * cos };
    });
    // Keep the entire group together when the requested move reaches a wall.
    const xs = rotated.map(point => point.x), ys = rotated.map(point => point.y);
    if (Math.max(...xs) - Math.min(...xs) > WIDTH || Math.max(...ys) - Math.min(...ys) > HEIGHT) return;
    shape.x = clamp(shape.x, -Math.min(...xs), WIDTH - Math.max(...xs));
    shape.y = clamp(shape.y, -Math.min(...ys), HEIGHT - Math.max(...ys));
    members.forEach((item, i) => {
      if (item === original) return;
      item.x = shape.x + rotated[i].x;
      item.y = shape.y + rotated[i].y;
      item.rotation = wrapAngle(item.rotation + degrees(angle));
    });
  }
  scene[selected] = shape;
  const partner = partnerOf(selected);
  if (partner >= 0) mirrorInto(selected, partner);
  refresh();
}

function linkTo(partner) {
  unlink(selected);
  if (partner >= 0) {
    unlink(partner);
    const link = Math.max(0, ...scene.map(shape => (shape.link ?? -1) + 1));
    scene[selected].link = link;
    scene[partner].link = link;
    mirrorInto(selected, partner);
  }
  refresh();
}

function line(path, color, thickness, close = false) {
  ctx.beginPath();
  path.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  if (close) ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.stroke();
}

function circle(x, y, radius, color) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function pieceCenter({ path, geometry }) {
  return geometry === "brick" ? {
    x: (path[0].x + path[2].x) / 2, y: (path[0].y + path[2].y) / 2,
  } : path[Math.floor(path.length / 2)];
}

function paintPiece(piece, index) {
  const { path, role, radius, geometry } = piece;
  const center = pieceCenter(piece);
  const hit = shot?.hit.has(index);
  if (shot?.escaped.has(index)) return;
  const group = scene[selected]?.group;
  const highlighted = selected === owners[index] || (group !== undefined && scene[owners[index]]?.group === group);
  const color = highlighted ? "#e7ff9f" : role === "target" ? "#b5ffbe" : role === "blocker" ? "#659673" : role === "power" ? "#f8d777" : role === "bonus" ? "#78d8ff" : "#70a783";
  if (hit) {
    line([{ x: center.x - 3, y: center.y - 3 }, { x: center.x + 3, y: center.y + 3 }], "#f4fff4", 1.7);
    line([{ x: center.x - 3, y: center.y + 3 }, { x: center.x + 3, y: center.y - 3 }], "#f4fff4", 1.7);
  } else if (geometry === "brick") {
    line(path, color, 1.7, true);
    if (role !== "target") { ctx.fillStyle = color; ctx.fill(); }
  } else if (path.length === 1) {
    circle(center.x, center.y, radius, color);
    if (role === "target") circle(center.x, center.y, Math.max(0.5, radius - 1.5), "#0c140f");
  } else {
    const trim = p => ({ x: p.x + (center.x - p.x) * 0.07, y: p.y + (center.y - p.y) * 0.07 });
    const tile = [trim(path[0]), ...path.slice(1, -1), trim(path.at(-1))];
    line(tile, color, radius * 2);
    if (role === "target") line(tile, "#0c140f", Math.max(1, radius * 2 - 2.5));
  }
  if (role === "blocker") {
    if (geometry === "brick") {
      ctx.save();
      line(path, color, 1.7, true);
      ctx.clip();
      const left = Math.min(...path.map(point => point.x));
      const top = Math.min(...path.map(point => point.y));
      const right = Math.max(...path.map(point => point.x));
      const bottom = Math.max(...path.map(point => point.y));
      for (let x = left; x <= right + bottom - top; x += 4) {
        line([{ x, y: top }, { x: x - bottom + top, y: bottom }], "#0c140f", 1.2);
      }
      ctx.restore();
    } else {
      const slash = radius * 0.6;
      const marks = path.length === 1 ? [center] : [path[1], center, path.at(-2)];
      for (const { x, y } of marks) {
        line([{ x: x - slash, y: y + slash }, { x: x + slash, y: y - slash }], "#0c140f", Math.min(1.4, radius / 2));
      }
    }
  }
  if (!hit && role === "power") circle(center.x, center.y, 2, "#0c140f");
  if (!hit && role === "bonus") {
    ctx.beginPath();
    ctx.arc(center.x, center.y, 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = "#0c140f";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function draw() {
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fillStyle = "#142219";
  ctx.fillRect(0, 0, WIDTH, HEIGHT * 0.15);
  if (levels[active].grid) {
    const step = levels[active].gridStep;
    for (let x = step; x < WIDTH; x += step) line([{ x, y: 0 }, { x, y: HEIGHT }], "#1e3426", 0.6);
    for (let y = step; y < HEIGHT; y += step) line([{ x: 0, y }, { x: WIDTH, y }], "#1e3426", 0.6);
  }
  ctx.setLineDash([4, 6]);
  line([{ x: 0, y: HEIGHT * 0.15 }, { x: WIDTH, y: HEIGHT * 0.15 }], "#355441", 1);
  ctx.setLineDash([]);
  pieces.forEach(paintPiece);
  ctx.setLineDash([2, 2]);
  for (const [a, b] of pinchPairs) {
    line([pieceCenter(pieces[a]), pieceCenter(pieces[b])], "#ffad60", 1.5);
  }
  ctx.setLineDash([]);
  const angle = Number($("aim").value);
  $("angle").textContent = angle + "°";
  const theta = radians(angle);
  circle(WIDTH / 2, 16, 11, "#92cba1");
  line([{ x: WIDTH / 2, y: 16 }, { x: WIDTH / 2 + 17 * Math.sin(theta), y: 16 + 17 * Math.cos(theta) }], "#dbffe2", 5);
  if (!shot) aimGuide(angle, pieces, clock, null).forEach((point, i) => circle(point.x, point.y, 1.7 - i * 0.055, "#9dddac"));
  if (shot?.outcome === "flying") circle(shot.ball.position.x, shot.ball.position.y, BALL_RADIUS, "#f2fff3");
  const tray = catcher(clock, null);
  const left = tray.x - tray.half;
  const right = tray.x + tray.half;
  line([{ x: left, y: TRAY_Y }, { x: left + 5, y: TRAY_Y + 10 },
    { x: right - 5, y: TRAY_Y + 10 }, { x: right, y: TRAY_Y }], "#7eb78c", 2);
  $("pause").textContent = playing ? "Pause" : "Resume";
  $("pause").disabled = !shot || shot.outcome !== "flying";
  $("step").disabled = !shot || shot.outcome !== "flying";
  const targetCount = pieces.filter(piece => piece.role === "target").length;
  const warnings = levelWarnings(levels[active], targetCount);
  if (pinchPairs.length) warnings.push(`${pinchPairs.length} potential pinch points (orange dashes).`);
  const warningText = warnings.join(" ");
  if ($("warnings").textContent !== warningText) $("warnings").textContent = warningText;
  const status = shot ? `${shot.outcome === "flying" ? (playing ? "In flight" : "Paused") : shot.outcome === "caught" ? "Caught" : "Drained"} · ${shot.ball.age.toFixed(2)} s · ${shot.hit.size} hits · ${shot.escaped.size} stall releases`
    : `${scene.length} editable pieces · ${targetCount} / ${levels[active].targetCount} targets`;
  if ($("status").textContent !== status) $("status").textContent = status;
}

function tick() {
  advance(shot, pieces, clock, null);
  clock += STEP;
  if (shot.outcome !== "flying") playing = false;
}
function animate(timestamp) {
  if (playing) {
    const dt = lastFrame === null ? 0 : Math.min(0.1, (timestamp - lastFrame) / 1000);
    elapsed += dt * Number($("speed").value);
    while (elapsed >= STEP && playing) { tick(); elapsed -= STEP; }
    lastFrame = timestamp;
    draw();
  } else lastFrame = null;
  requestAnimationFrame(animate);
}

function position(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) * WIDTH / bounds.width,
    y: (event.clientY - bounds.top) * HEIGHT / bounds.height };
}

function bricksOverlap(a, b) {
  if (a.geometry !== "brick" || b.geometry !== "brick") return false;
  return [a, b].every(({ path }) => [0, 1].every(i => {
    const nx = path[i + 1].y - path[i].y;
    const ny = path[i].x - path[i + 1].x;
    const project = piece => piece.path.map(point => point.x * nx + point.y * ny);
    const first = project(a), second = project(b);
    return Math.max(...first) >= Math.min(...second) && Math.max(...second) >= Math.min(...first);
  }));
}

function distanceToPiece(point, piece) {
  if (piece.geometry === "brick" && piece.path.every((a, i) => {
    const b = piece.path[(i + 1) % piece.path.length];
    return (b.x - a.x) * (point.y - a.y) >= (b.y - a.y) * (point.x - a.x);
  })) return 0;
  const path = piece.geometry === "brick" ? [...piece.path, piece.path[0]] : piece.path;
  let distance = Math.hypot(point.x - path[0].x, point.y - path[0].y);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return Math.max(0, distance - piece.radius);
}

canvas.addEventListener("pointerdown", event => {
  const point = position(event);
  let closest = 9;
  selected = -1;
  pieces.forEach((piece, index) => {
    const distance = distanceToPiece(point, piece);
    if (distance < closest) { closest = distance; selected = owners[index]; }
  });
  if (selected >= 0) {
    const shape = scene[selected];
    pointer = { x: shape.x - point.x, y: shape.y - point.y, id: event.pointerId };
    canvas.setPointerCapture(event.pointerId);
  }
  updateSelection();
  draw();
});
canvas.addEventListener("pointermove", event => {
  if (!pointer || event.pointerId !== pointer.id) return;
  const point = position(event);
  edit({ x: point.x + pointer.x, y: point.y + pointer.y });
});
canvas.addEventListener("lostpointercapture", () => { pointer = null; });

for (const button of document.querySelectorAll("[data-add]")) {
  button.onclick = () => {
    const kind = button.dataset.add;
    scene.push(normalize({ kind, role: "standard", x: WIDTH / 2, y: 190,
      ...(kind === "peg" ? { radius: PEG_RADIUS } : kind === "arc" ? { rotation: 0 } : {}) }));
    selected = scene.length - 1;
    refresh();
  };
}
for (const key of [...Object.keys(limits), "role"]) {
  $(key).onchange = () => {
    const input = $(key);
    const value = key === "role" ? input.value : input.valueAsNumber;
    if (key === "role" || Number.isFinite(value)) edit({ [key]: value });
    else updateSelection();
  };
}
$("scene").onchange = () => { selected = $("scene").selectedIndex; updateSelection(); draw(); };
$("duplicate").onclick = () => {
  scene.push(normalize({ ...scene[selected], group: undefined, link: undefined, x: scene[selected].x + 15, y: scene[selected].y + 15 }));
  selected = scene.length - 1;
  refresh();
};
$("delete").onclick = () => {
  unlink(selected);
  scene.splice(selected, 1);
  selected = Math.min(selected, scene.length - 1);
  refresh();
};
$("aim").oninput = draw;
$("fire").onclick = () => {
  $("validation").textContent = checkRoute(levels[active], pieces);
  reset();
  shot = launch(Number($("aim").value));
  playing = true;
  draw();
};
$("pause").onclick = () => { playing = !playing; lastFrame = null; draw(); };
$("step").onclick = () => { playing = false; tick(); draw(); };
$("reset").onclick = () => { reset(); draw(); };
$("load").onclick = loadPreset;
$("preset").append(...Array.from({ length: CAMPAIGN_LENGTH }, (_, i) =>
  new Option(`${i + 1} · ${campaignBoard(i + 1).name}`, String(i + 1))));
$("add-level").onclick = () => appendLevel(blankLevel(`Level ${levels.length + 1}`));
$("duplicate-level").onclick = () => {
  const level = levels[active];
  appendLevel({ ...level, name: level.name + " copy", pieces: level.pieces.map(shape => ({ ...shape })) });
};
$("delete-level").onclick = () => {
  if (!confirm(`Delete “${levels[active].name}” from this project?`)) return;
  levels.splice(active, 1);
  if (!levels.length) levels.push(blankLevel("Level 1"));
  dirty = true;
  selectLevel(Math.min(active, levels.length - 1));
};
$("level-name").onchange = () => {
  levels[active].name = $("level-name").value.trim() || `Level ${active + 1}`;
  $("level-name").value = levels[active].name;
  changed();
};
for (const [id, property, min, max] of [["target-count", "targetCount", 0, 250], ["ball-count", "balls", 1, 999], ["grid-step", "gridStep", 2, 100]]) {
  $(id).onchange = () => {
    const value = $(id).valueAsNumber;
    if (Number.isFinite(value)) levels[active][property] = clamp(Math.round(value), min, max);
    $(id).value = levels[active][property];
    changed();
    draw();
  };
}
$("grid").onchange = () => { levels[active].grid = $("grid").checked; changed(); draw(); };
$("snap").onchange = () => edit({ snap: $("snap").checked });
$("solid").onchange = () => edit({ role: $("solid").checked ? "blocker" : "standard" });
$("partner").onchange = () => linkTo($("partner").value === "" ? -1 : Number($("partner").value));
$("mirror").onclick = () => {
  scene.push(normalize({ ...scene[selected], group: undefined, link: undefined }));
  linkTo(scene.length - 1);
};
$("deal").onclick = () => {
  for (const shape of scene) if (shape.role === "target") shape.role = "standard";
  const eligible = [];
  scene.forEach((shape, index) => {
    if (shape.role !== "standard") return;
    pieceGeometry(shape, index).forEach((_, tile) => eligible.push({ index, tile }));
  });
  const selectedTiles = new Map();
  for (let i = 0; i < Math.min(levels[active].targetCount, eligible.length); i++) {
    const j = i + Math.floor(Math.random() * (eligible.length - i));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    const entry = eligible[i];
    if (!selectedTiles.has(entry.index)) selectedTiles.set(entry.index, new Set());
    selectedTiles.get(entry.index).add(entry.tile);
  }
  // A curved guide can contain several collision tiles. Store target
  // overrides per tile so the draw respects the exact count.
  scene.forEach((shape, i) => {
    delete shape.targets;
    const tiles = selectedTiles.get(i);
    if (!tiles) return;
    if (shape.kind === "arc" || isGuide(shape)) shape.targets = [...tiles];
    else shape.role = "target";
  });
  refresh();
};

for (const knob of document.querySelectorAll("[data-dial]")) {
  const key = knob.dataset.dial;
  let drag;
  const nudge = (from, amount) => {
    const step = key !== "rotation" && scene[selected].snap ? levels[active].gridStep : 1;
    edit({ [key]: from + Math.round(amount) * step });
  };
  knob.onpointerdown = event => {
    knob.setPointerCapture(event.pointerId);
    drag = { from: scene[selected][key], x: event.clientX, y: event.clientY };
  };
  knob.onpointermove = event => {
    if (drag) nudge(drag.from, (event.clientX - drag.x - (event.clientY - drag.y)) / 4);
  };
  knob.onlostpointercapture = () => { drag = undefined; };
  knob.onkeydown = event => {
    const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
    if (direction) {
      event.preventDefault();
      nudge(scene[selected][key], direction * (event.shiftKey ? 5 : 1));
    }
  };
}

function addGuide(kind) {
  selected = scene.length;
  scene.push(normalize({ kind, role: "standard", x: WIDTH / 2, y: HEIGHT / 2,
    rotation: 0, length: 365, radius: 25 }));
  refresh();
}
$("wave").onclick = () => addGuide("wave");
$("spiral").onclick = () => addGuide("spiral");
$("ungroup").onclick = () => {
  const group = scene[selected].group;
  for (const shape of scene) if (shape.group === group) delete shape.group;
  refresh();
};

function fitSegment(a, b, c, thickness) {
  // Determine a circle through the start, midpoint and end. Use a short
  // straight ramp where the curve is nearly flat or its center is off-board.
  const bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
  const determinant = 2 * (bx * cy - by * cx);
  const midpoint = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
  if (midpoint.x < 0 || midpoint.x > WIDTH || midpoint.y < 0 || midpoint.y > HEIGHT) return null;
  if (Math.abs(determinant) > 1e-6) {
    const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const offsetX = (b2 * cy - c2 * by) / determinant;
    const offsetY = (c2 * bx - b2 * cx) / determinant;
    const x = a.x + offsetX, y = a.y + offsetY;
    const radius = Math.hypot(offsetX, offsetY);
    const start = determinant > 0 ? a : c, end = determinant > 0 ? c : a;
    const rotation = degrees(Math.atan2(start.y - y, start.x - x));
    const span = (degrees(Math.atan2(end.y - y, end.x - x)) - rotation + 360) % 360;
    if (radius >= BALL_RADIUS + thickness / 2 + 1 && radius <= 300 && span >= 5 && span <= 180 &&
        x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT) {
      return { kind: "arc", x, y, radius, rotation, span };
    }
  }
  const length = Math.hypot(cx, cy);
  return length >= 4 ? { kind: "brick", ...midpoint, length, rotation: degrees(Math.atan2(cy, cx)) } : null;
}

function guideParts(shape, group) {
  const angle = radians(shape.rotation);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const point = t => {
    const theta = t * 2 * Math.PI * shape.turns;
    const radius = shape.radius + t * shape.turns * shape.pitch;
    const x = shape.kind === "wave" ? (t - 0.5) * shape.length : radius * Math.cos(theta);
    const rawY = shape.kind === "wave" ? shape.amplitude * Math.sin(t * 2 * Math.PI * shape.cycles) : radius * Math.sin(theta);
    const y = shape.mirrored ? -rawY : rawY;
    return { x: shape.x + x * cos - y * sin, y: shape.y + x * sin + y * cos };
  };
  const steps = shape.kind === "wave"
    ? Math.max(1, Math.min(Math.ceil(shape.cycles * 12), Math.floor(shape.length / 4)))
    : Math.ceil(shape.turns * 24);
  return Array.from({ length: steps }, (_, i) => fitSegment(point(i / steps),
    point((i + 0.5) / steps), point((i + 1) / steps), shape.thickness))
    .filter(Boolean).map(part => ({ ...part, role: shape.role, group, thickness: shape.thickness }));
}

function exportLevel(level) {
  if (!level.pieces.some(isGuide)) return level;
  let group = Math.max(0, ...level.pieces.map(shape => (shape.group ?? -1) + 1));
  const pieces = level.pieces.flatMap((shape, index) => {
    if (!isGuide(shape)) return [shape];
    let offset = 0;
    return guideParts(shape, group++).map(part => {
      const count = pieceGeometry(part, index).length;
      const targets = shape.targets?.filter(tile => tile >= offset && tile < offset + count).map(tile => tile - offset);
      offset += count;
      if (part.kind === "brick" && targets?.length && part.role === "standard") part.role = "target";
      return { ...part, targets };
    });
  });
  if (pieces.length > 500) throw new Error(`${level.name} has more than 500 expanded pieces. Shorten a guide or reduce its turns.`);
  return { ...level, pieces, editorPieces: level.pieces };
}

function decodeProject(data) {
  const sourceHeight = data?.boardHeight ?? LEGACY_HEIGHT;
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0 || sourceHeight > 2000) throw new Error("Invalid board height");
  const migrate = pieces => normalizePieces(pieces.map(shape => ({ ...shape, y: shape.y * HEIGHT / sourceHeight })));
  if (data?.version === 1) {
    return [{ ...blankLevel("Imported level"), pieces: migrate(data.pieces) }];
  }
  if (data?.version !== 2 || !Array.isArray(data.levels) || !data.levels.length) {
    throw new Error("Expected a Peg-bounce project or level file");
  }
  return data.levels.map((level, i) => ({
    name: typeof level.name === "string" && level.name.trim() ? level.name.trim().slice(0, 80) : `Level ${i + 1}`,
    balls: Number.isFinite(level.balls) ? clamp(Math.round(level.balls), 1, 999) : 10,
    targetCount: Number.isFinite(level.targetCount) ? clamp(Math.round(level.targetCount), 0, 250) : 7,
    gridStep: Number.isFinite(level.gridStep) ? clamp(Math.round(level.gridStep), 2, 100) : 20,
    grid: level.grid !== false,
    pieces: migrate(level.editorPieces ?? level.pieces),
  }));
}

function normalizePieces(pieces) {
  if (!Array.isArray(pieces) || pieces.length > 500) throw new Error("Invalid piece list");
  return pieces.map(normalize);
}

$("import").onclick = () => $("file").click();
$("file").onchange = async () => {
  const input = $("file");
  try {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 8_000_000) throw new Error("File is too large");
    const data = JSON.parse(await file.text());
    const loaded = decodeProject(data);
    if (data.version === 1) {
      appendLevel(loaded[0]);
      return;
    }
    if (dirty && !confirm("Open this project and replace the current draft? Save the current project first if you want to keep it.")) return;
    levels = loaded;
    campaignName = typeof data.campaignName === "string" && data.campaignName.trim() ? data.campaignName.trim().slice(0, 70) : "Untitled campaign";
    $("campaign-name").value = campaignName;
    dirty = false;
    selectLevel(Number.isInteger(data.active) ? clamp(data.active, 0, levels.length - 1) : 0);
  } catch (error) {
    $("save-status").textContent = error.message;
  } finally {
    input.value = "";
  }
};

function saveProject() {
  const slug = campaignName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = slug ? `${slug}.json` : "peg-bounce-project.json";
  let exported, reports;
  try {
    exported = levels.map(exportLevel);
    reports = exported.map((level, index) => {
      const collisionPieces = compileScene(level.pieces).pieces;
      const actual = collisionPieces.filter(piece => piece.role === "target").length;
      const warnings = levelWarnings(level, actual);
      const route = checkRoute(levels[index], collisionPieces);
      return `${index + 1}. ${level.name} — ${[...warnings, route].join(" ")}`;
    });
  } catch (error) {
    $("save-status").textContent = error.message;
    return;
  }
  const blob = new Blob([JSON.stringify({ version: 2, boardHeight: HEIGHT, campaignName, levels: exported, active }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  dirty = false;
  persist();
  $("save-status").textContent = `Downloaded ${filename}`;
  $("validation").textContent = reports.join("\n");
}
$("export").onclick = saveProject;
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveProject();
  }
});
try {
  const previous = JSON.parse(localStorage.getItem(STORAGE));
  if (previous) {
    levels = decodeProject(previous);
    if (typeof previous.campaignName === "string" && previous.campaignName.trim()) campaignName = previous.campaignName.trim().slice(0, 70);
    active = Number.isInteger(previous.active) ? clamp(previous.active, 0, levels.length - 1) : 0;
    dirty = previous.dirty === true;
  }
} catch {
  // Opening a file still works when local storage is unavailable.
}
$("campaign-name").value = campaignName;
$("campaign-name").oninput = () => {
  campaignName = $("campaign-name").value.trim() || "Untitled campaign";
  changed();
};
$("y").max = HEIGHT;
selectLevel(active);
requestAnimationFrame(animate);
