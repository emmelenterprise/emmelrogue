import { getSocket } from "./multiplayer";
import { globalScene } from "#app/global-scene";

const PREFIX = "[Race]";

interface RaceState {
  code: string;
  playerNumber: number;
  twitchId: string | null;
  seed: string | null;
  starterMode: "random" | "free";
  startedAt: number | null;
  opponentProgress: { wave: number; status: string };
  starters: number[] | null;
  gameMode: string;
  winCondition: string;
  winWave: number;
  cameraEnabled: boolean;
  cameraDeviceId: string | null;
  nuzlockeDeath: boolean;
  nuzlockeCatch: boolean;
  starterCount: number;
  respawnOnWipe: boolean;
  shinyMode: string;
  luckLevel: number;
  /** Race-Override fuer Player-Level-Cap-Multiplier. null = Settings-Default greift. */
  levelCapMultiplier: number | null;
  caughtBiomes: Set<number>;
  wipeCount: number;
}

type SeedCallback = (seed: string, starterMode: string) => void;

let seedCallbacks: SeedCallback[] = [];
let socketListenersRegistered = false;
let raceEndedByServer = false;

interface UrlRaceParams {
  code: string | null;
  player: number;
  twitchId: string | null;
  seed: string | null;
  starterMode: "random" | "free";
  starters: number[] | null;
  gameMode: string;
  winCondition: string;
  winWave: number;
  cameraEnabled: boolean;
  cameraDeviceId: string | null;
  nuzlockeDeath: boolean;
  nuzlockeCatch: boolean;
  starterCount: number;
  respawnOnWipe: boolean;
  shinyMode: string;
  luckLevel: number;
  levelCapMultiplier: number | null;
}

function readUrlParams(): UrlRaceParams {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("race");
  const player = parseInt(params.get("player") || "0", 10);
  const twitchId = params.get("twitchId");

  // Parse starters array from URL (e.g. [1,4,7])
  let starters: number[] | null = null;
  const startersParam = params.get("starters");
  if (startersParam) {
    try {
      starters = JSON.parse(startersParam);
    } catch { /* ignore */ }
  }

  const seed = params.get("seed");
  const starterMode = (params.get("starterMode") === "free" ? "free" : "random") as "random" | "free";
  const gameMode = params.get("gameMode") || "classic";
  const winCondition = params.get("winCondition") || "wave";
  const winWave = parseInt(params.get("winWave") || "20", 10);
  const cameraEnabled = params.get("cam") === "1";
  const cameraDeviceId = params.get("camDev") || null;
  const nuzlockeDeath = params.get("nuzDeath") === "1";
  const nuzlockeCatch = params.get("nuzCatch") === "1";
  const starterCount = parseInt(params.get("starterCount") || "3", 10);
  const respawnOnWipe = params.get("respawn") === "1";
  const shinyMode = params.get("shiny") || "off";
  const luckLevel = parseInt(params.get("luck") || "-1", 10);
  const levelCapRaw = params.get("levelCap");
  const levelCapMultiplier = levelCapRaw && !Number.isNaN(parseFloat(levelCapRaw)) ? parseFloat(levelCapRaw) : null;

  return { code, player, twitchId, seed, starterMode, starters, gameMode, winCondition, winWave, cameraEnabled, cameraDeviceId, nuzlockeDeath, nuzlockeCatch, starterCount, respawnOnWipe, shinyMode, luckLevel, levelCapMultiplier };
}

// Eagerly initialize state from URL params so isRaceMode() works synchronously
// BEFORE socket connects. Socket listeners are set up later in init().
const urlParams = readUrlParams();
let state: RaceState | null =
  urlParams.code && urlParams.player
    ? {
        code: urlParams.code,
        playerNumber: urlParams.player,
        twitchId: urlParams.twitchId,
        seed: urlParams.seed || null,
        starterMode: urlParams.starterMode,
        startedAt: null,
        opponentProgress: { wave: 0, status: "waiting" },
        starters: urlParams.starters,
        gameMode: urlParams.gameMode,
        winCondition: urlParams.winCondition,
        winWave: urlParams.winWave,
        cameraEnabled: urlParams.cameraEnabled,
        cameraDeviceId: urlParams.cameraDeviceId,
        nuzlockeDeath: urlParams.nuzlockeDeath,
        nuzlockeCatch: urlParams.nuzlockeCatch,
        starterCount: urlParams.starterCount,
        respawnOnWipe: urlParams.respawnOnWipe,
        shinyMode: urlParams.shinyMode,
        luckLevel: urlParams.luckLevel,
        levelCapMultiplier: urlParams.levelCapMultiplier,
        caughtBiomes: new Set(),
        wipeCount: 0,
      }
    : null;

if (state) {
  console.log(`${PREFIX} Race mode detected from URL — code=${state.code} player=${state.playerNumber} seed=${state.seed ? 'YES' : 'NO'} starters=${state.starters?.length ?? 0}`);
}

export const raceManager = {
  /** Set up socket listeners for race events. Call once from multiplayer.ts on connect. */
  init(): void {
    if (socketListenersRegistered) return;
    if (!state) return;

    console.log(`${PREFIX} Setting up socket listeners for race ${state.code}`);
    this.setupSocketListeners();
  },

  setupSocketListeners(): void {
    const socket = getSocket();
    if (!socket) {
      console.warn(`${PREFIX} No socket — will retry on connect`);
      return;
    }

    socketListenersRegistered = true;

    socket.on("RACE_STARTING", (data: { seed: string; starterMode: string; startedAt: number; gameMode?: string; winCondition?: string; winWave?: number; nuzlockeDeath?: boolean; nuzlockeCatch?: boolean; starterCount?: number; respawnOnWipe?: boolean; shinyMode?: string; luckLevel?: number; startersP1?: number[]; startersP2?: number[]; cameraSettings?: Record<number, { enabled: boolean; deviceId: string | null }> }) => {
      if (!state) return;
      state.seed = data.seed;
      state.starterMode = data.starterMode === "free" ? "free" : "random";
      state.startedAt = data.startedAt;
      if (data.gameMode) state.gameMode = data.gameMode;
      if (data.winCondition) state.winCondition = data.winCondition;
      if (data.winWave) state.winWave = data.winWave;
      if (data.nuzlockeDeath !== undefined) state.nuzlockeDeath = data.nuzlockeDeath;
      if (data.nuzlockeCatch !== undefined) state.nuzlockeCatch = data.nuzlockeCatch;
      if (data.starterCount !== undefined) state.starterCount = data.starterCount;
      if (data.respawnOnWipe !== undefined) state.respawnOnWipe = data.respawnOnWipe;
      if (data.shinyMode) state.shinyMode = data.shinyMode;
      if (data.luckLevel !== undefined) state.luckLevel = data.luckLevel;
      // Use this player's starters from server
      const myStarters = state.playerNumber === 1 ? data.startersP1 : data.startersP2;
      if (myStarters && myStarters.length) state.starters = myStarters;
      console.log(`${PREFIX} Received seed: ${data.seed} starterMode: ${data.starterMode} starters: ${state.starters}`);

      for (const cb of seedCallbacks) {
        cb(data.seed, data.starterMode);
      }
      seedCallbacks = [];
    });

    socket.on("RACE_UPDATE", (data: { progress: Record<number, { wave: number; status: string }>; status: string }) => {
      if (!state) return;
      const opponentNum = state.playerNumber === 1 ? 2 : 1;
      if (data.progress[opponentNum]) {
        state.opponentProgress = data.progress[opponentNum];
      }

      // Server set our status (e.g. wave win condition) — trigger game over
      const myProgress = data.progress[state.playerNumber];
      if (myProgress && (myProgress.status === "victory" || myProgress.status === "defeated") && !raceEndedByServer) {
        raceEndedByServer = true;
        const isVictory = myProgress.status === "victory";
        console.log(`${PREFIX} Server ended race — ${myProgress.status}. Triggering game over.`);
        try {
          globalScene.phaseManager.unshiftNew("GameOverPhase", isVictory);
        } catch (err) {
          console.warn(`${PREFIX} Could not push GameOverPhase:`, err);
        }
      }
    });

    socket.on("RACE_ERROR", () => {
      if (!state) return;
      console.warn(`${PREFIX} Race not found on server — clearing race mode`);
      state = null;
      // Reload without race params to show normal title menu
      const url = new URL(window.location.href);
      url.searchParams.delete("race");
      url.searchParams.delete("player");
      url.searchParams.delete("twitchId");
      window.location.href = url.toString();
    });

    // Tell server we're in the race room (include playerNumber for game-client identification)
    console.log(`${PREFIX} Emitting RACE_READY code=${state!.code} player=${state!.playerNumber}`);
    socket.emit("RACE_READY", { code: state!.code, playerNumber: state!.playerNumber });
  },

  isRaceMode(): boolean {
    return state !== null;
  },

  getRaceCode(): string | null {
    return state?.code ?? null;
  },

  getPlayerNumber(): number {
    return state?.playerNumber ?? 0;
  },

  getSeed(): string | null {
    return state?.seed ?? null;
  },

  getStarterMode(): string {
    return state?.starterMode ?? "random";
  },

  getStartedAt(): number | null {
    return state?.startedAt ?? null;
  },

  getOpponentProgress(): { wave: number; status: string } {
    return state?.opponentProgress ?? { wave: 0, status: "waiting" };
  },

  /** Get server-assigned starter species IDs (from Race-Menu) */
  getStarters(): number[] | null {
    return state?.starters ?? null;
  },

  getGameMode(): string {
    return state?.gameMode ?? "classic";
  },

  getWinCondition(): string {
    return state?.winCondition ?? "wave";
  },

  getWinWave(): number {
    return state?.winWave ?? 20;
  },

  getCameraEnabled(): boolean {
    return state?.cameraEnabled ?? true;
  },

  getCameraDeviceId(): string | null {
    return state?.cameraDeviceId ?? null;
  },

  /** Register callback for when seed is received. If seed already exists, calls immediately. */
  onSeedReceived(cb: SeedCallback): void {
    if (state?.seed) {
      cb(state.seed, state.starterMode);
    } else {
      seedCallbacks.push(cb);
    }
  },

  /** Report wave progress to server */
  reportProgress(wave: number, status: string): void {
    if (!state) return;
    const socket = getSocket();
    if (!socket?.connected) return;
    socket.emit("RACE_PROGRESS", { code: state.code, wave, status });
  },

  getNuzlockeDeath(): boolean {
    return state?.nuzlockeDeath ?? false;
  },

  getNuzlockeCatch(): boolean {
    return state?.nuzlockeCatch ?? false;
  },

  getStarterCount(): number {
    return state?.starterCount ?? 3;
  },

  getRespawnOnWipe(): boolean {
    return state?.respawnOnWipe ?? false;
  },

  getShinyMode(): string {
    return state?.shinyMode ?? "off";
  },

  getLuckLevel(): number {
    return state?.luckLevel ?? -1;
  },

  /** Race-Override fuer Player-Level-Cap-Multiplier; null falls keine Race-Auswahl. */
  getLevelCapMultiplier(): number | null {
    return state?.levelCapMultiplier ?? null;
  },

  hasCaughtInBiome(biomeId: number): boolean {
    return state?.caughtBiomes.has(biomeId) ?? false;
  },

  markCaughtInBiome(biomeId: number): void {
    state?.caughtBiomes.add(biomeId);
  },

  getWipeCount(): number {
    return state?.wipeCount ?? 0;
  },

  incrementWipeCount(): number {
    if (state) {
      state.wipeCount++;
      // Reset caught biomes on wipe (new run through biomes)
      state.caughtBiomes.clear();
    }
    return state?.wipeCount ?? 0;
  },

  /** Mark race as ended locally (prevents duplicate GameOverPhase from RACE_UPDATE) */
  markEnded(): void {
    raceEndedByServer = true;
  },

  /** Handle socket reconnect — rejoin the race room */
  handleReconnect(): void {
    if (!state) return;
    const socket = getSocket();
    if (!socket?.connected) return;

    console.log(`${PREFIX} Reconnecting to race ${state.code} as P${state.playerNumber}...`);
    socket.emit("RACE_REJOIN", {
      code: state.code,
      twitchId: state.twitchId,
      playerNumber: state.playerNumber,
    });

    // Re-setup listeners (new socket instance after reconnect)
    socketListenersRegistered = false;
    this.setupSocketListeners();
  },
};
