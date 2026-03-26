import { getSocket } from "./multiplayer";
import { startPvpCam, stopPvpCam } from "./webrtc";

const PREFIX = "[PvP]";

/**
 * PvP Battle Manager
 *
 * Manages real-time PvP battles between two players.
 * Both players run PokéRogue independently — the only synced data is move selections.
 * Same battleSeed ensures identical RNG outcomes on both sides.
 *
 * Flow per turn:
 * 1. Player picks move (CommandPhase) → sent to server
 * 2. Server waits for both players' moves
 * 3. Server broadcasts opponent's move to each player
 * 4. EnemyCommandPhase receives opponent's move → turn executes
 */

export interface PvpMoveCommand {
  command: number;        // Command enum (FIGHT=0, POKEMON=2)
  cursor?: number;        // Move index or pokemon index
  move?: {
    move: number;         // MoveId
    targets: number[];    // BattlerIndex[]
    useMode: number;      // MoveUseMode
  };
  args?: any[];
  skip?: boolean;
}

export interface PvpBattleConfig {
  battleId: string;
  side: "boss" | "challenger";
  seed: string;
  battleSeed: string;     // Shared RNG seed for battle — identical on both clients
  playerTeam: { speciesId: number; formIndex?: number; shiny?: boolean; variant?: number; name: string; cost: number; moves?: (number | null)[] }[];
  opponentTeam: { speciesId: number; formIndex?: number; shiny?: boolean; variant?: number; name: string; cost: number; moves?: (number | null)[] }[];
  opponentName: string;
  opponentSprite: string;
  playerLevel: number;    // Base level for all pokemon
  bossEggMoves?: boolean;
  challengerEggMoves?: string; // 'none' | 'all' | 'cost'
}

interface PvpState {
  active: boolean;
  battleId: string | null;
  side: "boss" | "challenger" | null;
  config: PvpBattleConfig | null;
  turn: number;
  waitingForOpponent: boolean;
  playerMoveSubmitted: boolean;
  pendingOpponentMove: PvpMoveCommand | null;
  opponentMoveResolve: ((move: PvpMoveCommand) => void) | null;
  battleResult: "win" | "loss" | null;
  pendingFaintSwitch: number | null;
  faintSwitchResolve: ((index: number) => void) | null;
}

let state: PvpState = {
  active: false,
  battleId: null,
  side: null,
  config: null,
  turn: 0,
  waitingForOpponent: false,
  playerMoveSubmitted: false,
  pendingOpponentMove: null,
  opponentMoveResolve: null,
  battleResult: null,
  pendingFaintSwitch: null,
  faintSwitchResolve: null,
};

// --- URL param detection (like race-manager) ---
function readPvpUrlParams(): { battleId: string | null; side: "boss" | "challenger" | null } {
  const params = new URLSearchParams(window.location.search);
  const battleId = params.get("pvp");
  const side = params.get("side") as "boss" | "challenger" | null;
  return { battleId, side };
}

const urlParams = readPvpUrlParams();
if (urlParams.battleId && urlParams.side) {
  // Pre-set state so isPvpActive() returns true synchronously
  state.active = true;
  state.battleId = urlParams.battleId;
  state.side = urlParams.side;
  console.log(`${PREFIX} PvP mode detected from URL — battle=${urlParams.battleId} side=${urlParams.side}`);
}

// Ready promise — resolves when config is loaded (or immediately if not PvP)
let configReadyResolve: (() => void) | null = null;
const configReadyPromise: Promise<void> = new Promise((resolve) => {
  if (!urlParams.battleId || !urlParams.side) {
    resolve(); // Not PvP, resolve immediately
  } else {
    configReadyResolve = resolve;
  }
});

let socketListenersRegistered = false;

function setupSocketListeners(): void {
  const socket = getSocket();
  if (!socket || socketListenersRegistered) return;
  socketListenersRegistered = true;

  // Server sends opponent's move after both players submitted
  socket.on("PVP_OPPONENT_MOVE", (data: { battleId: string; turn: number; move: PvpMoveCommand }) => {
    if (!state.active || data.battleId !== state.battleId) return;
    console.log(`${PREFIX} Received opponent move for turn ${data.turn}:`, data.move);

    if (state.opponentMoveResolve) {
      // Someone is already waiting — resolve immediately
      state.opponentMoveResolve(data.move);
      state.opponentMoveResolve = null;
      state.waitingForOpponent = false;
    } else {
      // Store for when EnemyCommandPhase asks
      state.pendingOpponentMove = data.move;
    }
  });

  // Battle started confirmation
  socket.on("PVP_BATTLE_STARTED", (data: { battleId: string; seed: string }) => {
    console.log(`${PREFIX} Battle started: ${data.battleId} (seed: ${data.seed})`);
  });

  // Battle ended (opponent disconnected, timeout, etc.)
  socket.on("PVP_BATTLE_ENDED", (data: { battleId: string; reason: string; winner?: string }) => {
    if (data.battleId !== state.battleId) return;
    console.log(`${PREFIX} Battle ended: ${data.reason} (winner: ${data.winner || "none"})`);
    if (data.winner) {
      state.battleResult = data.winner === state.side ? "win" : "loss";
    }
  });

  // Turn sync confirmation
  socket.on("PVP_TURN_SYNC", (data: { battleId: string; turn: number }) => {
    if (data.battleId !== state.battleId) return;
    console.log(`${PREFIX} Turn synced: ${data.turn}`);
  });

  // Opponent's pokemon fainted / switched — for state tracking
  socket.on("PVP_BATTLE_EVENT", (data: { battleId: string; event: string; payload: any }) => {
    if (data.battleId !== state.battleId) return;
    console.log(`${PREFIX} Battle event: ${data.event}`, data.payload);

    // Handle faint switch relay from opponent
    if (data.event === "faint_switch" && data.payload?.slotIndex !== undefined) {
      const idx = data.payload.slotIndex as number;
      if (state.faintSwitchResolve) {
        state.faintSwitchResolve(idx);
        state.faintSwitchResolve = null;
      } else {
        state.pendingFaintSwitch = idx;
      }
    }
  });
}

export const pvpBattle = {
  /** Check if PvP mode is active */
  isPvpActive(): boolean {
    return state.active;
  },

  /** Wait for PvP config to be loaded (resolves immediately if not PvP) */
  waitForConfig(): Promise<void> {
    return configReadyPromise;
  },

  /** Get current battle config */
  getConfig(): PvpBattleConfig | null {
    return state.config;
  },

  /** Get current side */
  getSide(): "boss" | "challenger" | null {
    return state.side;
  },

  /** Get shared battle RNG seed (identical on both clients) */
  getBattleSeed(): string | null {
    return state.config?.battleSeed || null;
  },

  /** Initialize PvP battle from URL params or gym system */
  init(): void {
    setupSocketListeners();

    // If PvP was detected from URL, fetch config from server
    if (state.active && state.battleId && state.side && !state.config) {
      this.fetchConfig(state.battleId, state.side);
    }
  },

  /** Fetch battle config from server */
  async fetchConfig(battleId: string, side: "boss" | "challenger"): Promise<void> {
    try {
      const res = await fetch(`/api/pvp/battle/${battleId}?side=${side}`);
      if (!res.ok) {
        console.error(`${PREFIX} Failed to fetch battle config: ${res.status}`);
        if (configReadyResolve) {
          configReadyResolve();
          configReadyResolve = null;
        }
        return;
      }
      const config = await res.json() as PvpBattleConfig;
      state.config = config;
      state.battleId = config.battleId;
      state.side = config.side;
      console.log(`${PREFIX} Config loaded: ${config.playerTeam.length} player pokemon, ${config.opponentTeam.length} opponent pokemon`);

      // Start webcam streaming for challenger
      if (config.side === "challenger") {
        startPvpCam(config.battleId);
      }

      // Signal that config is ready
      if (configReadyResolve) {
        configReadyResolve();
        configReadyResolve = null;
      }

      // Join the battle room via socket
      const socket = getSocket();
      if (socket?.connected) {
        socket.emit("PVP_JOIN_BATTLE", {
          battleId: config.battleId,
          side: config.side,
        });
      }
    } catch (err) {
      console.error(`${PREFIX} Error fetching config:`, err);
      if (configReadyResolve) {
        configReadyResolve();
        configReadyResolve = null;
      }
    }
  },

  /** Start a PvP battle */
  startBattle(config: PvpBattleConfig): void {
    setupSocketListeners();
    state.active = true;
    state.battleId = config.battleId;
    state.side = config.side;
    state.config = config;
    state.turn = 0;
    state.battleResult = null;
    state.pendingOpponentMove = null;
    state.opponentMoveResolve = null;
    state.playerMoveSubmitted = false;
    state.waitingForOpponent = false;

    const socket = getSocket();
    if (socket?.connected) {
      socket.emit("PVP_JOIN_BATTLE", {
        battleId: config.battleId,
        side: config.side,
      });
    }

    console.log(`${PREFIX} Battle started: ${config.battleId} as ${config.side}`);
    console.log(`${PREFIX} Player team: ${config.playerTeam.map(p => p.name).join(", ")}`);
    console.log(`${PREFIX} Opponent team: ${config.opponentTeam.map(p => p.name).join(", ")}`);

    // Start webcam streaming for challenger
    if (config.side === "challenger") {
      startPvpCam(config.battleId);
    }
  },

  /** Called when a new turn begins */
  newTurn(): void {
    state.turn++;
    state.playerMoveSubmitted = false;
    state.waitingForOpponent = false;
    state.pendingOpponentMove = null;
    state.opponentMoveResolve = null;
    state.pendingFaintSwitch = null;
    state.faintSwitchResolve = null;
    console.log(`${PREFIX} Turn ${state.turn} started`);
  },

  /**
   * Send player's move to server.
   * Called from CommandPhase when the player selects a move.
   */
  sendPlayerMove(move: PvpMoveCommand): void {
    if (!state.active || state.playerMoveSubmitted) return;
    state.playerMoveSubmitted = true;

    const socket = getSocket();
    if (!socket?.connected) {
      console.error(`${PREFIX} Cannot send move — socket not connected`);
      return;
    }

    socket.emit("PVP_SUBMIT_MOVE", {
      battleId: state.battleId,
      side: state.side,
      turn: state.turn,
      move,
    });

    console.log(`${PREFIX} Submitted player move for turn ${state.turn}:`, move);
  },

  /**
   * Wait for opponent's move.
   * Called from EnemyCommandPhase instead of AI.
   * Returns a Promise that resolves with the opponent's TurnCommand.
   */
  waitForOpponentMove(): Promise<PvpMoveCommand> {
    if (!state.active) {
      return Promise.reject(new Error("PvP not active"));
    }

    // Check if we already received the opponent's move
    if (state.pendingOpponentMove) {
      const move = state.pendingOpponentMove;
      state.pendingOpponentMove = null;
      state.waitingForOpponent = false;
      console.log(`${PREFIX} Opponent move already available`);
      return Promise.resolve(move);
    }

    // Wait for it
    state.waitingForOpponent = true;
    console.log(`${PREFIX} Waiting for opponent move...`);

    return new Promise((resolve) => {
      state.opponentMoveResolve = resolve;

      // Timeout after 120 seconds (AFK)
      setTimeout(() => {
        if (state.opponentMoveResolve === resolve) {
          console.warn(`${PREFIX} Opponent move timeout!`);
          state.opponentMoveResolve = null;
          state.waitingForOpponent = false;
          // Return a "struggle" move as fallback
          resolve({
            command: 0, // Command.FIGHT
            move: { move: 165, targets: [0], useMode: 0 }, // Struggle
            skip: false,
          });
        }
      }, 120_000);
    });
  },

  /** Send faint switch choice to opponent */
  sendFaintSwitch(slotIndex: number): void {
    const socket = getSocket();
    if (socket?.connected && state.battleId) {
      socket.emit("PVP_BATTLE_EVENT", {
        battleId: state.battleId,
        side: state.side,
        event: "faint_switch",
        payload: { slotIndex },
      });
      console.log(`${PREFIX} Sent faint switch: slot ${slotIndex}`);
    }
  },

  /** Wait for opponent's faint switch choice */
  waitForFaintSwitch(): Promise<number> {
    if (state.pendingFaintSwitch !== null) {
      const idx = state.pendingFaintSwitch;
      state.pendingFaintSwitch = null;
      console.log(`${PREFIX} Faint switch already available: slot ${idx}`);
      return Promise.resolve(idx);
    }

    console.log(`${PREFIX} Waiting for opponent faint switch...`);
    return new Promise((resolve) => {
      state.faintSwitchResolve = resolve;
      // Timeout after 30s — use first available as fallback
      setTimeout(() => {
        if (state.faintSwitchResolve === resolve) {
          console.warn(`${PREFIX} Faint switch timeout — using fallback`);
          state.faintSwitchResolve = null;
          resolve(-1);
        }
      }, 30_000);
    });
  },

  /** Report battle result to server */
  reportResult(result: "win" | "loss"): void {
    state.battleResult = result;
    const socket = getSocket();
    if (socket?.connected && state.battleId) {
      socket.emit("PVP_BATTLE_RESULT", {
        battleId: state.battleId,
        side: state.side,
        result,
      });
    }
    console.log(`${PREFIX} Battle result: ${result}`);
  },

  /** Report a faint event (so opponent can track which pokemon are alive) */
  reportFaint(battlerIndex: number): void {
    const socket = getSocket();
    if (socket?.connected && state.battleId) {
      socket.emit("PVP_BATTLE_EVENT", {
        battleId: state.battleId,
        side: state.side,
        event: "faint",
        payload: { battlerIndex },
      });
    }
  },

  /** End PvP battle */
  endBattle(): void {
    console.log(`${PREFIX} Battle ended`);
    stopPvpCam();
    state.active = false;
    state.battleId = null;
    state.side = null;
    state.config = null;
    state.turn = 0;
    state.waitingForOpponent = false;
    state.playerMoveSubmitted = false;
    state.pendingOpponentMove = null;
    state.opponentMoveResolve = null;
  },

  /** Is the player waiting for the opponent? */
  isWaitingForOpponent(): boolean {
    return state.waitingForOpponent;
  },

  /** Get battle result */
  getBattleResult(): "win" | "loss" | null {
    return state.battleResult;
  },

  /** Handle reconnect */
  handleReconnect(): void {
    socketListenersRegistered = false;
    setupSocketListeners();
    // Re-join battle if active
    if (state.active && state.battleId) {
      const socket = getSocket();
      if (socket?.connected) {
        socket.emit("PVP_JOIN_BATTLE", {
          battleId: state.battleId,
          side: state.side,
        });
      }
    }
  },
};
