import { importedBoard } from "./imported-campaign";
import { campaignBoard, campaignName, campaignShots, CAMPAIGN_LENGTH, endlessCandidate, endlessFallback, hasClearingRoute, markBonus, SHOTS_PER_BOARD, STANDARD_TARGET_COUNT, tutorialBoard, type Board } from "./boards";
import { advance, BALL_RADIUS, FINALE_BIN_VALUES, HEIGHT, launch, MAX_ANGLE, removeHitPieces, STEP, TRAY_Y, type Piece, type Power, type Shot } from "./physics";

export const PAUSE_OPTIONS = ["Resume", "Retry", "Exit Level"] as const;
export const MODES = ["Tutorial", "Campaign", "Endless"] as const;
export type Mode = typeof MODES[number];
export const COIN_SPIN_SECONDS = 0.85;
const COIN_RESULT_SECONDS = 1.05;

const SHOT_BALL_THRESHOLDS = [25_000, 75_000] as const;
export const BLITZ_TIERS = [1, 2, 3, 5, 10] as const;

function blitzMultiplier(cleared: number, total: number): number {
  if (total === 0) return 1;
  if (cleared >= total) return 100;
  return BLITZ_TIERS[Math.floor(cleared * BLITZ_TIERS.length / total)]!;
}

export type Cue = "peg" | "target" | "power" | "catch" | "clear";
type Phase = "menu" | "campaigns" | "levels" | "loading" | "aim" | "flight" | "coin" | "sweep" | "clear" | "lost" | "paused";

export class PegBounceGame {
  private campaign: readonly Board[] = [];
  constructor(
    private readonly readCampaign: (index: number) => readonly Board[] = () => [],
    private readonly readCleared: () => number = () => 0,
    private readonly saveCleared: (cleared: number) => void = () => {},
    private readonly readNames: () => string[] = () => [],
  ) {}

  campaignNames = ["Main Campaign"];
  campaignSelection = 0;
  cleared = 0;
  levelSelection = 1;

  get unlockedLevel(): number {
    return Math.min(this.cleared + 1, this.campaignLength);
  }

  levelName(level: number): string {
    return this.campaign[level - 1]?.name ?? campaignName(level);
  }

  private loadCampaign(): void {
    this.campaign = this.readCampaign(this.campaignSelection);
    const saved = this.readCleared();
    this.cleared = Number.isSafeInteger(saved) ? Math.max(0, Math.min(saved, this.campaignLength)) : 0;
  }

  showCampaigns(refresh = false): void {
    if (refresh) {
      this.campaignNames = ["Main Campaign", ...this.readNames()];
      this.campaignSelection = 0;
    }
    this.phase = "campaigns";
    this.menuScanning = false;
  }

  showLevels(): void {
    this.mode = "Campaign";
    this.phase = "levels";
    this.levelSelection = this.unlockedLevel;
    this.menuScanning = false;
  }

  get campaignLength(): number {
    return this.campaign.length || CAMPAIGN_LENGTH;
  }

  phase: Phase = "menu";
  mode: Mode = "Tutorial";
  selection = 0;
  level = 1;
  name = "";
  pieces: Piece[] = [];
  score = 0;
  unusedBallBonus = 0;
  binBonus = 0;
  landedBin: number | null = null;
  private startingTargets = 0;
  private scoredTargets = 0;
  balls = 0;
  angle = 0;
  boardTime = 0;
  shot: Shot | null = null;
  queued: Power | null = null;
  active: Power | null = null;
  sweeping = false;
  sweepDirection = 1;
  menuScanning = false;
  tutorialStep = 0;
  caught = false;
  coin: { won: boolean; time: number } | null = null;
  private whiffs = 0;
  celebration = 0;
  private scanTime = 0;
  private boardPower: Power | null = null;
  private turn = 0;
  pauseSelection = 0;
  private pausedFrom: "aim" | "flight" | "sweep" = "aim";
  private seed = 0;
  private entryScore = 0;
  private sweepSteps = 0;
  private pendingHits: number[] = [];
  private shotSubtotal = 0;
  private entryPower: Power | null = null;

  get targets(): number {
    return this.pieces.reduce((count, piece, i) => count + Number(piece.role === "target" && !this.shot?.hit.has(i)), 0);
  }

  get blitzProgress(): number {
    return this.startingTargets > 0 ? (this.startingTargets - this.targets) / this.startingTargets : 0;
  }

  get blitzTier(): number {
    return blitzMultiplier(this.startingTargets - this.targets, this.startingTargets);
  }

  get animated(): boolean {
    return (this.phase === "clear" && this.celebration < 1.3) || this.phase === "aim" || this.phase === "flight" || this.phase === "coin" || this.phase === "sweep" || ((this.phase === "menu" || this.phase === "campaigns" || this.phase === "levels" || this.phase === "paused") && this.menuScanning);
  }

  start(mode: Mode, seed: number): void {
    if (mode === "Campaign") this.loadCampaign();
    this.startRun(mode, seed, 1);
  }

  private startRun(mode: Mode, seed: number, level: number): void {
    this.mode = mode;
    this.seed = seed;
    this.level = level;
    this.score = 0;
    this.queued = null;
    this.tutorialStep = 0;
    this.openBoard();
  }

  openBoard(): void {
    this.whiffs = 0;
    this.coin = null;
    this.entryScore = this.score;
    this.entryPower = this.queued;
    this.shot = null;
    this.active = null;
    this.celebration = 0;
    this.phase = this.mode === "Endless" ? "loading" : "aim";
    if (this.phase !== "loading") this.loadBoard();
  }

  loadBoard(): void {
    const custom = this.mode === "Campaign" ? this.campaign[this.level - 1] : undefined;
    let board = custom ? importedBoard(custom, this.seed ^ this.level) : this.mode === "Tutorial" ? tutorialBoard()
      : this.mode === "Campaign" ? campaignBoard(this.level, this.seed, this.queued)
        : endlessFallback(this.seed, this.level);
    if (this.mode === "Endless") {
      for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = endlessCandidate(this.seed, this.level, attempt);
        const targetCount = candidate.pieces.filter(piece => piece.role === "target").length;
        if (targetCount === STANDARD_TARGET_COUNT && hasClearingRoute(candidate, this.queued)) {
          board = candidate;
          break;
        }
      }
      board.name = `Endless ${this.level}`;
    }
    if (this.mode === "Tutorial" && this.tutorialStep === 1) board.pieces = [];
    this.name = board.name;
    this.pieces = board.pieces;
    this.startingTargets = this.targets;
    this.scoredTargets = 0;
    this.unusedBallBonus = 0;
    this.binBonus = 0;
    this.landedBin = null;
    this.boardPower = board.power;
    this.balls = this.mode === "Tutorial" ? 3 : this.mode === "Campaign" ? custom?.balls ?? campaignShots(this.level) : SHOTS_PER_BOARD;
    this.angle = 0;
    this.boardTime = 0;
    this.turn = 0;
    this.caught = false;
    this.sweeping = false;
    this.menuScanning = false;
    this.phase = "aim";
    if (this.mode !== "Tutorial") markBonus(this.pieces, 0);
  }

  menu(): void {
    this.phase = "menu";
    this.menuScanning = false;
    this.sweeping = false;
  }

  move(delta: number, vertical = false): void {
    if (this.phase === "paused") {
      this.menuScanning = false;
      this.pauseSelection = (this.pauseSelection + Math.sign(delta) + PAUSE_OPTIONS.length) % PAUSE_OPTIONS.length;
      return;
    }
    if (this.phase === "campaigns") {
      this.menuScanning = false;
      this.campaignSelection = Math.max(0, Math.min(this.campaignNames.length - 1, this.campaignSelection + Math.sign(delta)));
      return;
    }
    if (this.phase === "levels") {
      this.menuScanning = false;
      this.levelSelection = Math.max(1, Math.min(this.campaignLength, this.levelSelection + Math.sign(delta) * (vertical ? 2 : 1)));
      return;
    }
    if (this.phase === "menu") {
      this.menuScanning = false;
      this.selection = (this.selection + Math.sign(delta) + MODES.length) % MODES.length;
    } else if (this.phase === "aim") {
      this.sweeping = false;
      if (this.mode !== "Tutorial" || this.tutorialStep !== 1) {
        this.angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, Math.round(this.angle) + delta));
      }
    }
  }

  click(arm: boolean, seed: number): void {
    switch (this.phase) {
      case "menu":
        if (arm && !this.menuScanning) {
          this.menuScanning = true;
          this.scanTime = 0;
        } else if (MODES[this.selection] === "Campaign") {
          this.showCampaigns(true);
        } else this.start(MODES[this.selection]!, seed);
        break;
      case "campaigns":
        if (arm && !this.menuScanning) {
          this.menuScanning = true;
          this.scanTime = 0;
        } else {
          this.loadCampaign();
          this.showLevels();
        }
        break;
      case "levels":
        if (arm && !this.menuScanning) {
          this.menuScanning = true;
          this.scanTime = 0;
        } else if (this.levelSelection <= this.unlockedLevel) {
          this.startRun("Campaign", seed, this.levelSelection);
        }
        break;
      case "aim":
        if (this.mode === "Tutorial" && this.tutorialStep === 1) {
          // Start the demonstration at the catcher phase that meets a center shot.
          const demo = launch(0);
          let flight = 0;
          while (demo.ball.position.y < TRAY_Y && demo.outcome === "flying") {
            advance(demo, [], flight, null);
            flight += STEP;
          }
          this.boardTime = Math.PI / 1.18 - flight;
          this.fire();
        } else if (arm && !this.sweeping) {
          this.sweeping = true;
        } else this.fire();
        break;
      case "paused":
        if (arm && !this.menuScanning) {
          this.menuScanning = true;
          this.scanTime = 0;
          break;
        }
        this.menuScanning = false;
        if (this.pauseSelection === 0) this.phase = this.pausedFrom;
        else if (this.pauseSelection === 1) this.retryLevel();
        else if (this.mode === "Campaign") this.showLevels();
        else this.menu();
        break;
      case "clear":
        if (this.mode === "Tutorial") {
          if (this.tutorialStep === 0) {
            this.tutorialStep = 1;
            this.openBoard();
          } else {
            this.selection = 1;
            this.menu();
          }
        } else if (this.mode === "Campaign" && this.level === this.campaignLength) this.showLevels();
        else {
          this.level++;
          this.openBoard();
        }
        break;
      case "lost":
        if (this.mode === "Endless") {
          this.start("Endless", this.seed);
          break;
        }
        this.retryLevel();
        break;
    }
  }

  private retryLevel(): void {
    this.score = this.entryScore;
    this.queued = this.entryPower;
    this.openBoard();
  }

  pause(): void {
    if (this.shot?.finale) return;
    if (this.phase === "aim" || this.phase === "flight" || this.phase === "sweep") {
      this.pausedFrom = this.phase;
      this.pauseSelection = 0;
      this.menuScanning = false;
      this.phase = "paused";
    }
  }

  private fire(): void {
    this.shotSubtotal = 0;
    this.active = this.queued;
    this.queued = null;
    this.sweeping = false;
    this.caught = false;
    this.balls--;
    this.shot = launch(Math.round(this.angle));
    this.phase = "flight";
  }

  step(): Cue | undefined {
    if (this.phase === "coin" && this.coin) {
      const previous = this.coin.time;
      this.coin.time += STEP;
      if (previous < COIN_SPIN_SECONDS && this.coin.time >= COIN_SPIN_SECONDS && this.coin.won) {
        this.balls++;
        return "catch";
      }
      if (this.coin.time >= COIN_SPIN_SECONDS + COIN_RESULT_SECONDS) {
        this.coin = null;
        return this.finishShot();
      }
      return;
    }
    if (this.phase === "sweep") {
      this.boardTime += STEP;
      return this.sweep();
    }
    if (this.phase === "clear") {
      this.celebration = Math.min(1.3, this.celebration + STEP);
      return;
    }
    if ((this.phase === "menu" || this.phase === "campaigns" || this.phase === "levels" || this.phase === "paused") && this.menuScanning) {
      this.scanTime += STEP;
      if (this.scanTime >= 1.6) {
        if (this.phase === "paused") this.pauseSelection = (this.pauseSelection + 1) % PAUSE_OPTIONS.length;
        else if (this.phase === "levels") this.levelSelection = this.levelSelection % this.unlockedLevel + 1;
        else if (this.phase === "campaigns") this.campaignSelection = (this.campaignSelection + 1) % this.campaignNames.length;
        else this.selection = (this.selection + 1) % MODES.length;
        this.scanTime = 0;
      }
    }
    if (this.phase === "aim" && this.sweeping) {
      this.angle += STEP * 16 * this.sweepDirection;
      if (Math.abs(this.angle) >= MAX_ANGLE) {
        this.angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, this.angle));
        this.sweepDirection *= -1;
      }
    }
    if (this.phase !== "aim" && this.phase !== "flight") return;
    this.boardTime += STEP;
    const shot = this.shot;
    if (!shot || this.phase !== "flight") return;
    const hitCount = shot.hit.size;
    advance(shot, this.pieces, this.boardTime - STEP, this.active, () => {
      if (!shot.finale && shot.hit.size > hitCount && this.mode !== "Tutorial" &&
          this.startingTargets > 0 && this.targets === 0) shot.finale = true;
      return false;
    });
    let cue: Cue | undefined;
    if (shot.hit.size > hitCount) {
      for (const index of [...shot.hit].slice(hitCount)) {
        const role = this.pieces[index]!.role;
        if (role === "target") this.whiffs = 0;
        if (role === "power") cue = "power";
        else if (role === "target" && cue !== "power") cue = "target";
        else cue ??= "peg";
      }
    }
    shot.trail.push(shot.ball.position);
    if (shot.trail.length > 10) shot.trail.shift();
    if (shot.outcome === "flying") return cue;

    this.caught = shot.outcome === "caught";
    if (this.caught) this.balls++;
    if (shot.outcome === "drained" && shot.ball.position.y > HEIGHT + BALL_RADIUS && !shot.touchedPiece) {
      const chance = Math.max(0, (5 - this.whiffs) / 10);
      this.whiffs++;
      this.coin = { won: Math.random() < chance, time: 0 };
      this.phase = "coin";
      return;
    }
    this.pendingHits = [...shot.hit];
    this.sweepSteps = 0;
    this.phase = "sweep";
    if (!this.pendingHits.length) return this.finishShot();
    return this.caught ? "catch" : cue;
  }

  private sweep(): Cue | undefined {
    if (++this.sweepSteps < 6) return;
    this.sweepSteps = 0;
    const index = this.pendingHits.shift();
    if (index !== undefined) {
      const role = this.pieces[index]!.role;
      const points = role === "target" ? 100 : role === "bonus" ? 250 : 10;
      this.shotSubtotal += points * blitzMultiplier(this.scoredTargets, this.startingTargets);
      if (role === "target") this.scoredTargets++;
      if (role === "power") this.queued = this.boardPower;
      const removed = this.shot!.escaped;
      removed.add(index);
    }
    return this.pendingHits.length ? undefined : this.finishShot();
  }

  private finishShot(): Cue | undefined {
    const { hit, bin } = this.shot!;
    const shotScore = this.shotSubtotal * hit.size;
    this.score += shotScore;
    for (const threshold of SHOT_BALL_THRESHOLDS) {
      if (shotScore >= threshold) this.balls++;
    }
    this.pieces = removeHitPieces(this.pieces, hit);
    this.shot = null;
    this.active = null;
    if (this.targets === 0) {
      this.phase = "clear";
      if (this.mode !== "Tutorial" && this.startingTargets > 0) {
        this.landedBin = bin;
        this.binBonus = bin === null ? 0 : FINALE_BIN_VALUES[bin]!;
        this.score += this.binBonus;
        this.unusedBallBonus = this.balls * 10_000;
        this.score += this.unusedBallBonus;
      }
      if (this.mode === "Campaign" && this.level > this.cleared) {
        this.cleared = this.level;
        this.saveCleared(this.cleared);
      }
    }
    else if (this.balls === 0) this.phase = "lost";
    else {
      if (this.mode !== "Tutorial") markBonus(this.pieces, ++this.turn);
      this.phase = "aim";
    }
    if (this.phase === "clear" && this.mode !== "Tutorial") return "clear";
    return this.caught && hit.size === 0 ? "catch" : undefined;
  }
}
