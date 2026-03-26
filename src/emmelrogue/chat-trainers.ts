import { getSocket } from "./multiplayer";

const PREFIX = "[ChatTrainers]";

interface WaveCustomization {
  waveIndex: number;
  trainerName: string | null;
  spriteKey: string | null;
  trainerClass: string | null;
  customParty: { speciesId: number; name: string; cost: number; shiny: boolean; nickname: string | null }[] | null;
  pokemonNicknames: Record<number, string>;
  isCustomInserted: boolean;
}

interface ActiveGimmick {
  id: string;
  label: string;
  remainingWaves: number;
}

interface ChatTrainerState {
  sessionId: string | null;
  enabled: boolean;
  customizations: Map<number, WaveCustomization>;
  gimmicks: ActiveGimmick[];
  pendingRequests: Map<number, ((custom: WaveCustomization | null) => void)[]>;
  pendingParty: { speciesId: number; iconId?: string; name: string; level: number; shiny: boolean; shinyVariant?: number; hp: number; maxHp: number }[] | null;
  pendingWaveUpdate: { wave: number; biome: string } | null;
}

let state: ChatTrainerState = {
  sessionId: null,
  enabled: false,
  customizations: new Map(),
  gimmicks: [],
  pendingRequests: new Map(),
  pendingParty: null,
  pendingWaveUpdate: null,
};

let socketListenersRegistered = false;

function setupSocketListeners(): void {
  const socket = getSocket();
  if (!socket || socketListenersRegistered) return;
  socketListenersRegistered = true;

  socket.on("CHAT_SESSION_STARTED", (data: { sessionId: string; code?: string; fixedTrainerOverrides?: Record<string, { trainerClass: string; isBoss: boolean }> }) => {
    state.sessionId = data.sessionId;
    state.enabled = true;
    console.log(`${PREFIX} Session started: ${data.sessionId} (code: ${data.code || "?"})`);
    // Apply config overrides for fixed trainer waves
    if (data.fixedTrainerOverrides) {
      applyFixedTrainerOverrides(data.fixedTrainerOverrides);
    }
    // Pre-register known fixed trainer waves so community can claim them early
    prescanFixedTrainers();
    // Flush any pending data that was queued before session was ready
    if (state.pendingWaveUpdate) {
      chatTrainers.reportWaveUpdate(state.pendingWaveUpdate.wave, state.pendingWaveUpdate.biome);
      state.pendingWaveUpdate = null;
    }
    if (state.pendingParty) {
      chatTrainers.reportStreamerParty(state.pendingParty);
      state.pendingParty = null;
    }
  });

  socket.on("CHAT_SESSION_ENDED", () => {
    console.log(`${PREFIX} Session ended`);
    state.sessionId = null;
    state.enabled = false;
    state.customizations.clear();
    state.gimmicks = [];
  });

  socket.on("CHAT_CUSTOMIZATION", (data: WaveCustomization | null) => {
    if (!data) return;
    const wave = data.waveIndex;
    state.customizations.set(wave, data);

    // Resolve pending requests
    const pending = state.pendingRequests.get(wave);
    if (pending) {
      for (const resolve of pending) {
        resolve(data);
      }
      state.pendingRequests.delete(wave);
    }
  });

  socket.on("CHAT_GIMMICK_STATE", (data: { activeGimmicks: ActiveGimmick[] }) => {
    state.gimmicks = data.activeGimmicks || [];
    console.log(`${PREFIX} Gimmicks updated: ${state.gimmicks.map(g => g.id).join(", ") || "none"}`);
  });

  socket.on("CHAT_GIMMICK_ACTIVATED", (data: { gimmickId: string; label: string; duration: number }) => {
    // Update local gimmick list
    state.gimmicks = state.gimmicks.filter(g => g.id !== data.gimmickId);
    state.gimmicks.push({
      id: data.gimmickId,
      label: data.label,
      remainingWaves: data.duration,
    });
    console.log(`${PREFIX} Gimmick activated: ${data.label} (${data.duration} waves)`);
  });
}

// Known fixed trainer waves (Classic mode) for pre-registration
const DEFAULT_FIXED_TRAINER_WAVES = [
  { waveIndex: 5, trainerClass: "Youngster/Göre", isFixed: true, isBoss: false },
  { waveIndex: 8, trainerClass: "Rivale", isFixed: true, isBoss: false },
  { waveIndex: 25, trainerClass: "Rivale", isFixed: true, isBoss: false },
  { waveIndex: 35, trainerClass: "Team Grunt", isFixed: true, isBoss: false },
  { waveIndex: 55, trainerClass: "Rivale", isFixed: true, isBoss: false },
  { waveIndex: 62, trainerClass: "Team Grunt", isFixed: true, isBoss: false },
  { waveIndex: 64, trainerClass: "Team Grunt", isFixed: true, isBoss: false },
  { waveIndex: 66, trainerClass: "Team Admin", isFixed: true, isBoss: false },
  { waveIndex: 95, trainerClass: "Rivale", isFixed: true, isBoss: false },
  { waveIndex: 112, trainerClass: "Team Grunt", isFixed: true, isBoss: false },
  { waveIndex: 114, trainerClass: "Team Admin", isFixed: true, isBoss: false },
  { waveIndex: 115, trainerClass: "Team Boss", isFixed: true, isBoss: true },
  { waveIndex: 145, trainerClass: "Rivale", isFixed: true, isBoss: false },
  { waveIndex: 164, trainerClass: "Team Admin", isFixed: true, isBoss: false },
  { waveIndex: 165, trainerClass: "Team Boss", isFixed: true, isBoss: true },
  { waveIndex: 182, trainerClass: "Top Vier", isFixed: true, isBoss: true },
  { waveIndex: 184, trainerClass: "Top Vier", isFixed: true, isBoss: true },
  { waveIndex: 186, trainerClass: "Top Vier", isFixed: true, isBoss: true },
  { waveIndex: 188, trainerClass: "Top Vier", isFixed: true, isBoss: true },
  { waveIndex: 190, trainerClass: "Champion", isFixed: true, isBoss: true },
  { waveIndex: 195, trainerClass: "Rivale", isFixed: true, isBoss: false },
];

// Apply server-side overrides from config (fixedTrainerOverrides in chat-config.json)
let FIXED_TRAINER_WAVES = [...DEFAULT_FIXED_TRAINER_WAVES];

function applyFixedTrainerOverrides(overrides: Record<string, { trainerClass: string; isBoss: boolean }>) {
  if (!overrides || typeof overrides !== "object") return;
  FIXED_TRAINER_WAVES = DEFAULT_FIXED_TRAINER_WAVES.map(t => {
    const override = overrides[String(t.waveIndex)];
    if (override) {
      return { ...t, trainerClass: override.trainerClass || t.trainerClass, isBoss: override.isBoss ?? t.isBoss };
    }
    return t;
  });
  // Add new waves from overrides that aren't in defaults
  for (const [wave, data] of Object.entries(overrides)) {
    const waveNum = parseInt(wave);
    if (isNaN(waveNum) || wave.startsWith("_")) continue;
    if (!FIXED_TRAINER_WAVES.some(t => t.waveIndex === waveNum)) {
      FIXED_TRAINER_WAVES.push({ waveIndex: waveNum, trainerClass: data.trainerClass, isFixed: true, isBoss: data.isBoss ?? false });
    }
  }
  FIXED_TRAINER_WAVES.sort((a, b) => a.waveIndex - b.waveIndex);
  console.log(`${PREFIX} Fixed trainer overrides applied: ${FIXED_TRAINER_WAVES.length} waves`);
}

function prescanFixedTrainers(): void {
  const socket = getSocket();
  if (!socket?.connected || !state.sessionId) return;
  console.log(`${PREFIX} Pre-scanning ${FIXED_TRAINER_WAVES.length} fixed trainer waves`);
  socket.emit("CHAT_BIOME_PRESCAN", {
    sessionId: state.sessionId,
    trainers: FIXED_TRAINER_WAVES,
  });
}

export const chatTrainers = {
  /** Initialize: start a chat session on the server */
  startSession(seed: string, raceCode?: string): void {
    setupSocketListeners();
    const socket = getSocket();

    const doStart = () => {
      const s = getSocket();
      if (!s?.connected) {
        console.warn(`${PREFIX} doStart called but socket not connected!`);
        return;
      }
      s.emit("CHAT_SESSION_START", { seed, raceCode: raceCode || null });
      console.log(`${PREFIX} Starting session (seed: ${seed})`);
    };

    if (socket?.connected) {
      console.log(`${PREFIX} Socket already connected, starting immediately`);
      doStart();
    } else if (socket) {
      console.warn(`${PREFIX} Socket not connected yet (id=${socket.id}, state=${(socket as any).io?._readyState}), queuing session start`);
      socket.once("connect", () => {
        console.log(`${PREFIX} Socket connected (queued), starting session now`);
        doStart();
      });
    } else {
      console.warn(`${PREFIX} No socket available — connect() not called yet?`);
    }
  },

  /** Join an existing race session (for P2 in race mode) */
  joinRaceSession(raceCode: string): void {
    setupSocketListeners();
    const socket = getSocket();

    const doJoin = () => {
      const s = getSocket();
      if (!s?.connected) return;
      s.emit("CHAT_SESSION_JOIN", { raceCode });
      console.log(`${PREFIX} Joining race session (race: ${raceCode})`);
    };

    if (socket?.connected) {
      doJoin();
    } else if (socket) {
      console.warn(`${PREFIX} Socket not connected yet, queuing session join`);
      socket.once("connect", doJoin);
    } else {
      console.warn(`${PREFIX} No socket available`);
    }
  },

  /** Initialize socket listeners (call from multiplayer.ts on connect) */
  init(): void {
    setupSocketListeners();
  },

  /** Is the chat trainer feature active? */
  isActive(): boolean {
    return state.enabled && state.sessionId !== null;
  },

  /** Get current session ID */
  getSessionId(): string | null {
    return state.sessionId;
  },

  // --- Reporting (Game → Server) ---

  /** Report a trainer encounter to the server */
  reportTrainer(wave: number, trainerData: {
    trainerType?: number;
    trainerClass?: string;
    spriteKey?: string;
    variant?: number;
    isFixed?: boolean;
    isBoss?: boolean;
    biome?: string;
    originalParty?: { speciesId: number; name: string; level: number; cost: number }[];
  }): void {
    if (!state.sessionId) return;
    const socket = getSocket();
    if (!socket?.connected) return;

    socket.emit("CHAT_TRAINER_REPORT", {
      sessionId: state.sessionId,
      trainers: [{
        waveIndex: wave,
        ...trainerData,
      }],
    });
  },

  /** Report streamer's current party */
  reportStreamerParty(party: { speciesId: number; iconId?: string; name: string; level: number; shiny: boolean; shinyVariant?: number; hp: number; maxHp: number }[]): void {
    if (!state.sessionId) {
      // Queue for when session starts
      state.pendingParty = party;
      return;
    }
    const socket = getSocket();
    if (!socket?.connected) return;

    socket.emit("CHAT_PARTY_UPDATE", {
      sessionId: state.sessionId,
      party,
    });
  },

  /** Report wave/biome progress */
  reportWaveUpdate(wave: number, biome: string): void {
    if (!state.sessionId) {
      // Queue for when session starts
      state.pendingWaveUpdate = { wave, biome };
      return;
    }
    const socket = getSocket();
    if (!socket?.connected) return;

    socket.emit("CHAT_WAVE_UPDATE", {
      sessionId: state.sessionId,
      wave,
      biome,
    });
  },

  /** Report biome prescan (upcoming trainers) */
  reportBiomePrescan(trainers: {
    waveIndex: number;
    trainerType?: number;
    trainerClass?: string;
    spriteKey?: string;
    variant?: number;
    isFixed?: boolean;
    isBoss?: boolean;
    biome?: string;
    originalParty?: { speciesId: number; name: string; level: number; cost: number }[];
  }[]): void {
    if (!state.sessionId) return;
    const socket = getSocket();
    if (!socket?.connected) return;

    socket.emit("CHAT_BIOME_PRESCAN", {
      sessionId: state.sessionId,
      trainers,
    });
  },

  // --- Customizations (Server → Game) ---

  /** Get cached customization for a wave */
  getCustomization(wave: number): WaveCustomization | null {
    return state.customizations.get(wave) || null;
  },

  /** Request customization from server (async, returns via socket) */
  requestCustomization(wave: number): Promise<WaveCustomization | null> {
    // Check cache first
    const cached = state.customizations.get(wave);
    if (cached) return Promise.resolve(cached);

    if (!state.sessionId) return Promise.resolve(null);
    const socket = getSocket();
    if (!socket?.connected) return Promise.resolve(null);

    return new Promise((resolve) => {
      // Register pending callback
      if (!state.pendingRequests.has(wave)) {
        state.pendingRequests.set(wave, []);
      }
      state.pendingRequests.get(wave)!.push(resolve);

      // Request from server
      socket.emit("CHAT_REQUEST_CUSTOMIZATION", {
        sessionId: state.sessionId,
        wave,
      });

      // Timeout after 3 seconds
      setTimeout(() => {
        const pending = state.pendingRequests.get(wave);
        if (pending) {
          const idx = pending.indexOf(resolve);
          if (idx !== -1) {
            pending.splice(idx, 1);
            resolve(null);
          }
          if (pending.length === 0) {
            state.pendingRequests.delete(wave);
          }
        }
      }, 3000);
    });
  },

  /** Check if a wave has a custom trainer insert (Wild → Trainer) */
  hasCustomTrainerInsert(wave: number): boolean {
    const custom = state.customizations.get(wave);
    return custom?.isCustomInserted ?? false;
  },

  // --- Gimmicks ---

  /** Get all active gimmicks */
  getActiveGimmicks(): ActiveGimmick[] {
    return state.gimmicks;
  },

  /** Check if double battles are forced */
  isDoubleForced(): boolean {
    return state.gimmicks.some(g => g.id === "double_10");
  },

  /** Check if trainer-only mode is active */
  isTrainerOnly(): boolean {
    return state.gimmicks.some(g => g.id === "trainer_only");
  },

  /** Check if shiny wave is active */
  isShinyWave(): boolean {
    return state.gimmicks.some(g => g.id === "shiny_wave");
  },

  /** Check if level boost is active */
  isLevelBoost(): boolean {
    return state.gimmicks.some(g => g.id === "level_boost");
  },

  /** Check if item rain is active */
  isItemRain(): boolean {
    return state.gimmicks.some(g => g.id === "item_rain");
  },

  /** Check if luck boost (max luck) is active */
  isLuckMax(): boolean {
    return state.gimmicks.some(g => g.id === "luck_boost");
  },

  /** End session (notifies server to destroy it) */
  endSession(): void {
    if (!state.sessionId) return;
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit("CHAT_SESSION_END", { sessionId: state.sessionId });
    }
    state.sessionId = null;
    state.enabled = false;
    state.customizations.clear();
    state.gimmicks = [];
    state.pendingRequests.clear();
    state.pendingParty = null;
    state.pendingWaveUpdate = null;
  },

  /** Clear local state without destroying server session (for P2 in race mode) */
  clearLocalState(): void {
    state.sessionId = null;
    state.enabled = false;
    state.customizations.clear();
    state.gimmicks = [];
    state.pendingRequests.clear();
    state.pendingParty = null;
    state.pendingWaveUpdate = null;
  },

  /** Handle reconnect */
  handleReconnect(): void {
    socketListenersRegistered = false;
    setupSocketListeners();
  },
};
