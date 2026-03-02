import { getSocket } from "./multiplayer";

const PREFIX = "[Race]";

interface RaceState {
  code: string;
  playerNumber: number;
  twitchId: string | null;
  seed: string | null;
  starterMode: "random" | "free";
  startedAt: number | null;
  opponentProgress: { wave: number; status: string };
}

type SeedCallback = (seed: string, starterMode: string) => void;

let state: RaceState | null = null;
let seedCallbacks: SeedCallback[] = [];
let initialized = false;

function readUrlParams(): { code: string | null; player: number; twitchId: string | null } {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("race");
  const player = parseInt(params.get("player") || "0", 10);
  const twitchId = params.get("twitchId");
  return { code, player, twitchId };
}

export const raceManager = {
  /** Initialize race mode from URL params + socket events. Call once from multiplayer.ts connect. */
  init(): void {
    if (initialized) return;
    initialized = true;

    const { code, player, twitchId } = readUrlParams();
    if (!code || !player) return;

    state = {
      code,
      playerNumber: player,
      twitchId,
      seed: null,
      starterMode: "random",
      startedAt: null,
      opponentProgress: { wave: 0, status: "waiting" },
    };

    console.log(`${PREFIX} Race mode active — code=${code} player=${player}`);
    this.setupSocketListeners();
  },

  setupSocketListeners(): void {
    const socket = getSocket();
    if (!socket) {
      console.warn(`${PREFIX} No socket — will retry on connect`);
      return;
    }

    socket.on("RACE_STARTING", (data: { seed: string; starterMode: string; startedAt: number }) => {
      if (!state) return;
      state.seed = data.seed;
      state.starterMode = data.starterMode as "random" | "free";
      state.startedAt = data.startedAt;
      console.log(`${PREFIX} Received seed: ${data.seed} starterMode: ${data.starterMode}`);

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
    });

    // Tell server we're in the race room
    socket.emit("RACE_READY", { code: state!.code });
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
    return state?.starterMode ?? "free";
  },

  getStartedAt(): number | null {
    return state?.startedAt ?? null;
  },

  getOpponentProgress(): { wave: number; status: string } {
    return state?.opponentProgress ?? { wave: 0, status: "waiting" };
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
    this.setupSocketListeners();
  },
};
