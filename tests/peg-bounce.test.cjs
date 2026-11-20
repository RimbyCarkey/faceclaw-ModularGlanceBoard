const assert = require("node:assert/strict");
const test = require("node:test");
const { PegBounceGame } = require("../.test-build/app/apps/peg-bounce/game");
const { campaignBoard, campaignShots, CAMPAIGN_LENGTH, endlessCandidate, endlessFallback, hasClearance, hasClearingRoute } =
  require("../.test-build/app/apps/peg-bounce/boards");
const { advance, aimGuide, BALL_RADIUS, launch, STEP, sweepPiece } =
  require("../.test-build/app/apps/peg-bounce/physics");

function settle(game) {
  const cues = [];
  for (let frame = 0; (game.phase === "flight" || game.phase === "sweep" || game.phase === "coin") && frame < 1900; frame++) {
    const cue = game.step();
    if (cue) cues.push(cue);
  }
  assert.notEqual(game.phase, "flight");
  assert.notEqual(game.phase, "sweep");
  return cues;
}

test("tutorial teaches a hollow target followed by an actual catcher refund", () => {
  const game = new PegBounceGame();
  game.start("Tutorial", 12);
  game.click(false, 12);
  assert.ok(settle(game).includes("target"));
  assert.equal(game.phase, "clear");
  game.click(false, 12);
  game.click(false, 12);
  assert.ok(settle(game).includes("catch"));
  assert.equal(game.balls, 3);
  assert.equal(game.caught, true);
});

test("aim guide falls under gravity and ends at the simulated impact", () => {
  const piece = { role: "target", path: [{ x: 337, y: 115 }], radius: 15 };
  const shot = launch(25);
  const points = aimGuide(25, [piece], 0, null);
  for (let frame = 0; !shot.hit.size && frame < 125; frame++) {
    advance(shot, [piece], frame * STEP, null, () => true);
  }
  assert.equal(shot.hit.size, 1);
  assert.equal(points.length > 3, true);
  assert.deepEqual(points.at(-1), shot.ball.position);
  const first = points[0];
  const middle = points[2];
  const last = points.at(-1);
  assert.ok((middle.x - first.x) / (middle.y - first.y) > (last.x - first.x) / (last.y - first.y));
});

test("swept blocks catch high-speed passes and leave a smooth arc on glancing contact", () => {
  const curved = { role: "blocker", path: [{ x: 90, y: 106 }, { x: 100, y: 100 }, { x: 110, y: 106 }], radius: 4 };
  const hit = sweepPiece({ x: 94, y: 60 }, { x: 0, y: 8000 }, curved, STEP);
  assert.ok(hit.time > 0 && hit.time < STEP);
  assert.ok(hit.normal.x < 0 && hit.normal.y < 0);
});

test("a power is queued after contact, held while paused, and applied on the next shot", () => {
  const game = new PegBounceGame();
  game.start("Campaign", 1);
  game.level = 5;
  game.openBoard();
  game.pieces = [
    { role: "power", path: [{ x: 300, y: 120 }], radius: 9 },
    { role: "target", path: [{ x: 90, y: 290 }], radius: 5 },
  ];
  game.click(false, 1);
  assert.equal(game.active, null);
  assert.ok(settle(game).includes("power"));
  assert.equal(game.queued, "Long Guide");
  game.pause();
  game.step();
  assert.equal(game.queued, "Long Guide");
  game.click(false, 1);
  game.click(false, 1);
  assert.equal(game.queued, null);
  assert.equal(game.active, "Long Guide");
  assert.equal(game.phase, "flight");
});

test("the last-ball clear emits victory once and celebration ends", () => {
  const game = new PegBounceGame();
  game.start("Campaign", 1);
  game.pieces = [{ role: "target", path: [{ x: 300, y: 120 }], radius: 8 }];
  game.balls = 1;
  game.click(false, 1);
  const cues = settle(game);
  assert.equal(game.phase, "clear");
  assert.equal(cues.filter(cue => cue === "clear").length, 1);
  assert.equal(game.score, 100 + game.binBonus);
  assert.ok(game.binBonus > 0);
  assert.equal(game.animated, true);
  for (let frame = 0; frame < 160; frame++) assert.equal(game.step(), undefined);
  assert.equal(game.animated, false);
});


function assertBoardGeometry(board) {
  assert.ok(board.pieces.some(piece => piece.geometry === "brick"), board.name);
  assert.ok(board.pieces.some(piece => typeof piece.geometry === "object"), board.name);
  const signature = (piece, mirror = false) => JSON.stringify([
    piece.radius, piece.path.map(({ x, y }) =>
      [Math.round((mirror ? 600 - x : x) * 100), Math.round(y * 100)].join(",")).sort(),
  ]);
  const signatures = new Set(board.pieces.map(piece => signature(piece)));
  for (const [index, piece] of board.pieces.entries()) {
    assert.ok(hasClearance(piece, board.pieces.slice(0, index)), board.name);
    assert.ok(signatures.has(signature(piece, true)), board.name + " is symmetric");
  }
}

test("campaign layouts have clearance routes, density, and the intended power milestones", () => {
  for (let level = 1; level <= CAMPAIGN_LENGTH; level++) {
    const board = campaignBoard(level);
    assert.equal(board.pieces.filter(piece => piece.role === "target").length, 25);
    assert.equal(board.pieces.filter(piece => piece.role === "power").length, level >= 5 ? 1 : 0);
    assert.ok(hasClearingRoute(board, null, campaignShots(level)), board.name);
    assertBoardGeometry(board);
  }
  assert.deepEqual([5, 10, 15].map(level => campaignBoard(level).power), ["Long Guide", "Wide Catcher", "Soft Bounce"]);
  assert.deepEqual(endlessCandidate(42, 22, 2), endlessCandidate(42, 22, 2));
  assert.notDeepEqual(endlessCandidate(42, 22, 2), endlessCandidate(43, 22, 2));
});

test("arm-only input can choose a mode, aim, fire, and resume", () => {
  const game = new PegBounceGame();
  game.click(true, 1);
  assert.equal(game.phase, "menu");
  for (let frame = 0; frame < 200; frame++) game.step();
  assert.equal(game.selection, 1);
  game.click(true, 1);
  assert.equal(game.phase, "campaigns");
  game.click(true, 1);
  game.click(true, 1);
  assert.equal(game.mode, "Campaign");
  assert.equal(game.phase, "levels");
  game.click(true, 1);
  game.click(true, 1);
  game.click(true, 1);
  assert.equal(game.sweeping, true);
  assert.equal(game.balls, 15);
  for (let frame = 0; frame < 24; frame++) game.step();
  assert.ok(game.angle > 0);
  game.click(true, 1);
  assert.equal(game.balls, 14);
  assert.equal(game.phase, "flight");
  game.pause();
  const position = game.shot.ball.position;
  game.step();
  assert.deepEqual(game.shot.ball.position, position);
  game.click(true, 1);
  assert.equal(game.phase, "paused");
  game.click(true, 1);
  assert.equal(game.phase, "flight");
});

test("pause can retry the current board or exit to level selection", () => {
  const game = new PegBounceGame();
  game.start("Campaign", 42);
  const board = structuredClone(game.pieces);
  const balls = game.balls;
  game.click(false, 42);
  game.pause();
  game.move(1);
  game.click(false, 42);
  assert.equal(game.phase, "aim");
  assert.equal(game.balls, balls);
  assert.equal(game.shot, null);
  assert.deepEqual(game.pieces, board);
  game.pause();
  game.move(-1);
  game.click(false, 42);
  assert.equal(game.phase, "levels");
});

test("Endless templates preserve clearance and verified fallbacks across power milestones", () => {
  const powers = ["Long Guide", "Wide Catcher", "Soft Bounce"];
  for (const seed of [17, 18]) {
    for (const level of [1, 5, 6, 10, 11, 15, 80]) {
      const candidates = [0, 1, 2, 3].map(attempt => endlessCandidate(seed, level, attempt));
      const fallback = endlessFallback(seed, level);
      for (const board of [...candidates, fallback]) {
        assert.equal(board.pieces.filter(piece => piece.role === "target").length, 25);
        assert.equal(board.pieces.filter(piece => piece.role === "power").length, level < 5 ? 0 : 1);
        assertBoardGeometry(board);
      }
      for (const power of [null, ...powers.slice(0, Math.floor((level - 1) / 5))]) {
        assert.ok(hasClearingRoute(fallback, power), `seed ${seed}, board ${level}, power ${power}`);
      }
    }
  }
});

test("worker paints the first menu after readiness and marks a hit with an X", () => {
  const { loader } = require("./helpers/load-typescript.cjs");
  const { GrayImage } = require("../.test-build/app/graphics/image");
  const replies = [];
  const surfaces = [];
  const text = [];
  const glyphMetadata = new ArrayBuffer(1);
  let now = 0;
  let tick;
  const worker = {
    postMessage(message) {
      assert.equal(typeof worker.onmessage, "function");
      replies.push(message.type);
    },
  };
  const font = {
    lineHeight: 16,
    measureText: value => value.length * 8,
    drawText: (image, x, y, value, gray) => {
      text.push(value);
      const ink = new GrayImage(1, 1, gray);
      image.drawImage(ink, x, y);
    },
  };
  loader({
    global: worker,
    Date: { now: () => now },
    setInterval: callback => { tick = callback; return 1; },
    clearInterval: () => { tick = undefined; },
  }, {
    "@nativescript/core/globals": {},
    "../../native/settings-store": { getStringSetting: () => "" },
    "../../graphics/image": { GrayImage },
    "../../graphics/glyph-wire": { prepareFrameDraws: draws => draws.length ? glyphMetadata : null },
    "../../graphics/ui-fonts": { getDefaultSmallFont: () => font },
    "../../native/active-display": {
      getActiveDisplay: () => ({
        submitSurfaceFrame: (buffer, id, _x, _y, _width, _height, _hash, _ms, _frame, metadata) =>
          surfaces.push([new Uint8Array(buffer), id, metadata]),
      }),
    },
    "../../native/worker-buzzer": { playWorkerBuzzerSequence() {} },
    "../../native/frame-timings": { startFrame: () => 1, finishFrame() {} },
    "../../ui/sound-effects": { buildSoundSequencePayload: () => new Uint8Array(), phraseDurationMs: () => 0 },
    "../../ui/shell/worker-lifecycle": {},
  })("app/apps/peg-bounce/peg-bounce.worker.ts");
  assert.deepEqual(replies, ["worker-ready"]);
  const windowId = "peg-bounce:main";
  worker.onmessage({ data: {
    type: "open-window", windowId, surfaceId: "board",
    viewport: { width: 576, height: 444, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  } });
  worker.onmessage({ data: { type: "foreground", windowId, foreground: true, focused: true } });
  assert.deepEqual(surfaces.map(([pixels, id]) => [pixels.length, id]), [[576 * 444, "board"]]);
  assert.equal(surfaces[0][2], glyphMetadata);
  assert.ok(surfaces[0][0].some(pixel => pixel !== 0), "the menu has visible ink in the submitted raster");
  assert.ok(text.includes("Peg-bounce"));
  assert.ok(text.includes("> Tutorial <"));
  const click = () => worker.onmessage({ data: {
    type: "input", windowId, focused: true, frameId: 1, event: { type: "click", source: "ring" },
  } });
  const boardScale = (576 - 2 * Math.round(576 * 0.128)) / 600;
  const targetCenter = Math.round(46 + 120 * boardScale) * 576 + 288;
  click();
  assert.equal(surfaces.at(-1)[0][targetCenter], 0, "target starts hollow");
  click();
  for (let i = 0; i < 6; i++) { now += 50; tick(); }
  const hitRaster = surfaces.at(-1)[0];
  assert.equal(hitRaster[targetCenter], 255, "the X fills the center");
  assert.equal(hitRaster[targetCenter + 5], 0, "the old ring is gone");
  assert.ok(text.includes("×100"));
});


test("the aim cone clamps to 75 degrees and unobstructed dots follow the ballistic arc", () => {
  const game = new PegBounceGame();
  game.start("Campaign", 1);
  game.move(101);
  assert.equal(game.angle, 75);
  game.move(-200);
  assert.equal(game.angle, -75);
  const shot = launch(90);
  assert.deepEqual(shot, launch(75));
  const guide = aimGuide(75, [], 0, null);
  assert.ok(guide.length >= 12 && guide.length <= 18);
  for (const [index, point] of guide.entries()) {
    const t = index * STEP * 6;
    assert.ok(Math.abs(point.x - (shot.ball.position.x + shot.ball.velocity.x * t)) < 1e-6);
    assert.ok(Math.abs(point.y - (shot.ball.position.y + shot.ball.velocity.y * t + 0.5 * 445 * t * t)) < 1e-6);
  }
});

test("flat faces and the inside of a curved ramp have correct swept normals", () => {
  const brick = {
    role: "standard", radius: 0, geometry: "brick",
    path: [{ x: 275, y: 100 }, { x: 325, y: 100 }, { x: 325, y: 108 }, { x: 275, y: 108 }],
  };
  const contact = sweepPiece({ x: 300, y: 80 }, { x: 0, y: 4000 }, brick, STEP);
  assert.equal(contact.normal.y, -1);
  assert.ok(Math.abs(contact.time - (20 - BALL_RADIUS) / 4000) < 1e-8);
  const ramp = {
    role: "standard", radius: 3,
    geometry: { center: { x: 300, y: 100 }, radius: 30, start: 0, span: Math.PI, caps: [true, true], guide: 1 },
    path: [{ x: 330, y: 100 }, { x: 300, y: 130 }, { x: 270, y: 100 }],
  };
  const inner = sweepPiece({ x: 300, y: 110 }, { x: 0, y: 3000 }, ramp, STEP);
  assert.equal(inner.normal.y, -1);
  assert.ok(Math.abs(inner.time - (17 - BALL_RADIUS) / 3000) < 1e-8);
});

test("a stalled ball can pass a lit roof and scores only when its turn ends", () => {
  const game = new PegBounceGame();
  game.start("Campaign", 1);
  game.pieces = [{
    role: "target", radius: 0, geometry: "brick",
    path: [{ x: 175, y: 90 }, { x: 425, y: 90 }, { x: 425, y: 98 }, { x: 175, y: 98 }],
  }];
  game.click(false, 1);
  for (let i = 0; i < 490 && !game.shot.escaped.size; i++) game.step();
  assert.ok(game.shot.hit.has(0));
  assert.ok(game.shot.escaped.has(0));
  assert.equal(game.score, 0);
  settle(game);
  assert.equal(game.score, 100 + game.binBonus + game.unusedBallBonus);
});

test("the sweep pops one peg per 50 ms and commits combo scoring at the end", () => {
  const game = new PegBounceGame();
  game.start("Campaign", 1);
  game.click(false, 1);
  const shot = game.shot;
  const targets = game.pieces.flatMap((piece, index) => piece.role === "target" ? [index] : []);
  shot.hit.add(targets[0]);
  shot.hit.add(targets[1]);
  shot.outcome = "drained";
  game.step();
  assert.equal(game.phase, "sweep");
  for (let i = 0; i < 5; i++) game.step();
  assert.equal(game.score, 0);
  game.step();
  assert.equal(game.score, 0);
  assert.equal(shot.escaped.size, 1);
  for (let i = 0; i < 6; i++) game.step();
  assert.equal(game.score, 400);
  assert.equal(game.phase, "aim");
  assert.equal(game.pieces.filter(piece => piece.role === "target").length, 23);
});


test("Campaign and Endless sample individual round pegs, curved tiles, and angled bricks", () => {
  const targetPositions = board => board.pieces.flatMap((piece, index) => piece.role === "target" ? [index] : []);
  const campaign = campaignBoard(9, 17);
  assert.deepEqual(campaign, campaignBoard(9, 17), "a retry reproduces the draw");
  assert.notDeepEqual(targetPositions(campaign), targetPositions(campaignBoard(9, 18)));
  const seeds = [17, 18, 42, 373];
  const boards = seeds.flatMap(seed => [campaignBoard(12, seed), endlessCandidate(seed, 12, 0)]);
  const targets = boards.flatMap(board => board.pieces.filter(piece => piece.role === "target"));
  assert.ok(targets.some(piece => piece.geometry === undefined));
  assert.ok(targets.some(piece => piece.geometry === "brick"));
  assert.ok(targets.some(piece => typeof piece.geometry === "object"));
  for (const board of boards) {
    assert.equal(targetPositions(board).length, 25);
    for (const piece of board.pieces) {
      if (typeof piece.geometry === "object") {
        assert.ok(piece.geometry.radius * piece.geometry.span <= 16 + 1e-6);
      } else if (piece.geometry === "brick") {
        assert.notEqual(piece.path[0].y, piece.path[1].y, "a brick presents a sloped face");
      }
    }
  }
});

test("clearing a curved tile exposes the neighboring collision caps", () => {
  const { removeHitPieces } = require("../.test-build/app/apps/peg-bounce/physics");
  const board = campaignBoard(9);
  const first = board.pieces.findIndex(piece => typeof piece.geometry === "object" && !piece.geometry.caps[1]);
  const arc = board.pieces[first].geometry;
  const next = removeHitPieces(board.pieces, new Set([first])).find(piece =>
    piece.geometry?.guide === arc.guide && Math.abs(piece.geometry.start - arc.start - arc.span) < 1e-6);
  assert.equal(next.geometry.caps[0], true);
});

test("editor projects import all levels, and Campaign advances past the built-in ending", () => {
  const { parseImportedCampaign, importedBoard } = require("../.test-build/app/apps/peg-bounce/imported-campaign");
  const fixture = {
    targetCount: 2,
    balls: 21,
    pieces: [
      { kind: "peg", role: "target", x: 120, y: 140, radius: 5 },
      { kind: "brick", role: "blocker", x: 100, y: 180, length: 40, rotation: 30, thickness: 8 },
      { kind: "arc", role: "standard", x: 400, y: 200, radius: 30, rotation: 0, span: 180, thickness: 6, targets: [0] },
    ],
  };
  const levels = Array.from({ length: 120 }, (_, i) => ({ ...fixture, name: `Custom ${i + 1}` }));
  const pack = parseImportedCampaign(JSON.stringify({ version: 2, levels }));
  assert.equal(pack.length, 120);
  const board = importedBoard(pack[0], 1);
  assert.equal(board.pieces.filter(piece => piece.role === "target").length, 2);
  assert.ok(board.pieces.some(piece => piece.geometry === "brick" && piece.role === "blocker"));
  assert.ok(board.pieces.some(piece => typeof piece.geometry === "object" && piece.role === "target"));
  const rolls = Array.from({ length: 12 }, (_, seed) => importedBoard(pack[0], seed * 104729));
  assert.ok(rolls.some(roll => roll.pieces[0].role === "standard"));
  assert.ok(rolls.every(roll => roll.pieces.filter(piece => piece.role === "target").length === 2));
  assert.equal(pack[0].pieces[0].role, "target");
  let saved = pack;
  const game = new PegBounceGame(() => saved);
  game.start("Campaign", 1);
  assert.equal(game.campaignLength, 120);
  game.level = 15;
  game.phase = "clear";
  saved = [];
  game.click(false, 1);
  assert.equal(game.name, "Custom 16");
  assert.equal(game.balls, 21);
  game.start("Campaign", 1);
  assert.equal(game.campaignLength, 15);
  assert.throws(() => parseImportedCampaign(JSON.stringify({ version: 2, levels: [{ pieces: [] }] })), /Level 1/);
});

test("Campaign recalls cleared levels, locks future levels and preserves progress on retry", () => {
  let saved = 0;
  const makeGame = () => new PegBounceGame(() => [], () => saved, cleared => { saved = cleared; });
  const game = makeGame();
  game.selection = 1;
  game.click(false, 1);
  assert.equal(game.phase, "campaigns");
  game.click(false, 1);
  assert.equal(game.phase, "levels");
  assert.equal(game.unlockedLevel, 1);
  game.move(1);
  game.click(false, 1);
  assert.equal(game.phase, "levels", "locked level cannot launch");
  game.move(-1);
  game.click(false, 1);
  game.pieces = [{ role: "target", radius: 6, path: [{ x: 300, y: 120 }] }];
  game.click(false, 1);
  settle(game);
  assert.equal(saved, 1);
  const reopened = makeGame();
  reopened.selection = 1;
  reopened.click(false, 2);
  reopened.click(false, 2);
  assert.equal(reopened.levelSelection, 2);
  reopened.move(-1);
  reopened.click(false, 2);
  assert.equal(reopened.level, 1, "completed level can be replayed");
  reopened.phase = "lost";
  reopened.balls = 0;
  reopened.click(false, 2);
  assert.equal(reopened.phase, "aim");
  assert.equal(reopened.balls, 15);
  assert.equal(saved, 1);
});

test("the Campaign picker keeps built-in and imported packs selectable with independent progress", () => {
  const { campaignLibrary, progressKey } = require("../.test-build/app/apps/peg-bounce/imported-campaign");
  const legacy = '{"version":1,"pieces":[]}';
  assert.deepEqual(campaignLibrary("", legacy), [{ name: "Imported Campaign", text: legacy }]);
  assert.deepEqual(campaignLibrary("[]", legacy), [], "a reset must not reload the legacy pack");
  assert.notEqual(progressKey(legacy), progressKey(""));
  const board = name => ({ name, pieces: [], power: null });
  const packs = [[], [board("Warm-up"), board("Next")], [board("Other first")]];
  let selected = 0;
  const game = new PegBounceGame(index => { selected = index; return packs[index]; },
    () => [0, 1, 0][selected], () => {}, () => ["Workshop", "Arcade"]);
  game.selection = 1;
  game.click(false, 1);
  assert.deepEqual(game.campaignNames, ["Main Campaign", "Workshop", "Arcade"]);
  game.move(1);
  game.click(false, 1);
  assert.equal(game.levelSelection, 2);
  assert.equal(game.levelName(2), "Next");
  game.showCampaigns();
  game.move(1);
  game.click(false, 1);
  assert.equal(game.levelSelection, 1);
  assert.equal(game.levelName(1), "Other first");
});

test("9:8 projects keep their coordinates and legacy boards migrate into the taller field", () => {
  const { WIDTH, HEIGHT } = require("../.test-build/app/apps/peg-bounce/physics");
  const { parseImportedCampaign, importedCampaignName } = require("../.test-build/app/apps/peg-bounce/imported-campaign");
  assert.equal(WIDTH / HEIGHT, 9 / 8);
  const level = { pieces: [{ kind: "peg", role: "target", x: 300, y: 200, radius: 6 }] };
  const old = parseImportedCampaign(JSON.stringify({ version: 2, levels: [level] }));
  assert.equal(old[0].pieces[0].path[0].y, HEIGHT / 2);
  const named = JSON.stringify({ version: 2, boardHeight: HEIGHT, campaignName: "Workshop", levels: [level] });
  assert.equal(parseImportedCampaign(named)[0].pieces[0].path[0].y, 200);
  assert.equal(importedCampaignName(named), "Workshop");
});

test("combo scores use per-hit Blitz tiers and grant both shot ball awards at most once", () => {
  const game = new PegBounceGame();
  game.start("Campaign", 1);
  game.click(false, 1);
  game.balls = 2;
  const roles = ["target", ...Array(19).fill("standard")];
  game.pieces = roles.map(role => ({ role, path: [{ x: 300, y: 120 }], radius: 6 }));
  game.scoredTargets = 24;
  game.pieces.push({ role: "target", path: [{ x: 400, y: 125 }], radius: 6 });
  roles.forEach((_, index) => game.shot.hit.add(index));
  game.shot.outcome = "drained";
  settle(game);
  assert.equal(game.score, 400_000);
  assert.equal(game.balls, 4);
  game.step();
  assert.equal(game.balls, 4);
});

test("finale dividers guide each landing into a scoring bin", () => {
  const { FINALE_BIN_WIDTH, FINALE_BIN_LIP, FINALE_BIN_VALUES } = require("../.test-build/app/apps/peg-bounce/physics");
  function drop(x) {
    const shot = launch(0);
    shot.finale = true;
    shot.ball.position = { x, y: FINALE_BIN_LIP - 50 };
    shot.ball.velocity = { x: 0, y: 180 };
    for (let frame = 0; frame < 3600 && shot.outcome === "flying"; frame++) {
      advance(shot, [], frame * STEP, null);
    }
    assert.equal(shot.outcome, "binned");
    return shot.bin;
  }
  FINALE_BIN_VALUES.forEach((_, i) => assert.equal(drop((i + 0.5) * FINALE_BIN_WIDTH), i));
  for (let i = 1; i < FINALE_BIN_VALUES.length; i++) {
    assert.ok([i - 1, i].includes(drop(i * FINALE_BIN_WIDTH)));
  }
});
