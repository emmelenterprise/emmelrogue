/**
 * PvP Battle Manager (Server-side)
 *
 * Manages battle rooms for real-time PvP between two players.
 * Each battle has two sides: "boss" (streamer) and "challenger".
 * Server's job: relay moves between players, enforce turn sync.
 */

const PREFIX = '[PvP]';

// Active battles: battleId -> BattleRoom
const battles = new Map();

class BattleRoom {
  constructor(battleId, config) {
    this.battleId = battleId;
    this.seed = config.seed || this.generateSeed();
    this.battleSeed = this.generateSeed(); // Shared battle RNG seed — identical on both clients
    this.bossTeam = config.bossTeam || [];
    this.challengerTeam = config.challengerTeam || [];
    this.bossName = config.bossName || 'Gym Leader';
    this.bossSprite = config.bossSprite || 'youngster';
    this.challengerName = config.challengerName || 'Challenger';
    this.challengerSprite = config.challengerSprite || 'youngster';
    this.level = config.level || 50;
    this.bossEggMoves = config.bossEggMoves !== false;
    this.challengerEggMoves = config.challengerEggMoves || 'none';
    this.createdAt = Date.now();
    this.turn = 0;
    this.status = 'waiting'; // waiting, active, ended

    // Socket connections
    this.bossSid = null;
    this.challengerSid = null;

    // Move buffer per turn
    this.pendingMoves = { boss: null, challenger: null };

    // Result
    this.result = null; // { winner: 'boss'|'challenger', reason: string }

    // Track which boss pokemon slots have been revealed (sent into battle)
    this.revealedBossSlots = new Set();
  }

  generateSeed() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let seed = '';
    for (let i = 0; i < 16; i++) {
      seed += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return seed;
  }

  join(side, socketId) {
    if (side === 'boss') {
      this.bossSid = socketId;
    } else if (side === 'challenger') {
      this.challengerSid = socketId;
    }

    // Start when both are connected
    if (this.bossSid && this.challengerSid && this.status === 'waiting') {
      this.status = 'active';
      this.turn = 1;
      // Lead pokemon (slot 0) is always revealed
      this.revealedBossSlots.add(0);
      console.log(`${PREFIX} Battle ${this.battleId} started!`);
      return true; // battle started
    }
    return false;
  }

  leave(socketId) {
    if (socketId === this.bossSid) {
      this.bossSid = null;
      return 'boss';
    }
    if (socketId === this.challengerSid) {
      this.challengerSid = null;
      return 'challenger';
    }
    return null;
  }

  submitMove(side, turn, move) {
    if (this.status !== 'active') return null;
    if (turn !== this.turn) {
      console.warn(`${PREFIX} Turn mismatch: expected ${this.turn}, got ${turn}`);
      return null;
    }

    this.pendingMoves[side] = move;
    console.log(`${PREFIX} ${side} submitted move for turn ${turn}`);

    // Check if both moves are in
    if (this.pendingMoves.boss && this.pendingMoves.challenger) {
      const result = {
        bossMove: this.pendingMoves.boss,
        challengerMove: this.pendingMoves.challenger,
        turn: this.turn,
      };

      // Reset for next turn
      this.turn++;
      this.pendingMoves = { boss: null, challenger: null };

      return result;
    }

    return null; // waiting for other player
  }

  setResult(winner, reason) {
    this.status = 'ended';
    this.result = { winner, reason };
  }

  revealBossSlot(index) {
    if (typeof index !== 'number' || index < 0 || index > 5) return false;
    if (this.revealedBossSlots.has(index)) return false;
    this.revealedBossSlots.add(index);
    console.log(`${PREFIX} Boss slot ${index} revealed (total: ${this.revealedBossSlots.size})`);
    return true; // new reveal
  }

  getRevealedBossSlots() {
    return Array.from(this.revealedBossSlots).sort((a, b) => a - b);
  }

  getConfigForSide(side) {
    if (side === 'boss') {
      return {
        battleId: this.battleId,
        side: 'boss',
        seed: this.seed,
        battleSeed: this.battleSeed,
        playerTeam: this.bossTeam,
        opponentTeam: this.challengerTeam,
        opponentName: this.challengerName,
        opponentSprite: this.challengerSprite,
        playerLevel: this.level,
        bossEggMoves: this.bossEggMoves,
        challengerEggMoves: this.challengerEggMoves,
      };
    } else {
      return {
        battleId: this.battleId,
        side: 'challenger',
        seed: this.seed,
        battleSeed: this.battleSeed,
        playerTeam: this.challengerTeam,
        opponentTeam: this.bossTeam,
        opponentName: this.bossName,
        opponentSprite: this.bossSprite,
        playerLevel: this.level,
        bossEggMoves: this.bossEggMoves,
        challengerEggMoves: this.challengerEggMoves,
      };
    }
  }
}

const pvpBattleManager = {
  /**
   * Create a new PvP battle room
   */
  createBattle(config) {
    const battleId = 'pvp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const room = new BattleRoom(battleId, config);
    battles.set(battleId, room);
    console.log(`${PREFIX} Created battle ${battleId}`);

    // Auto-cleanup after 30 minutes
    setTimeout(() => {
      if (battles.has(battleId)) {
        battles.delete(battleId);
        console.log(`${PREFIX} Cleaned up stale battle ${battleId}`);
      }
    }, 30 * 60 * 1000);

    return room;
  },

  /**
   * Get battle room by ID
   */
  getBattle(battleId) {
    return battles.get(battleId) || null;
  },

  /**
   * Delete a battle room
   */
  deleteBattle(battleId) {
    battles.delete(battleId);
  },

  /**
   * Find battle by socket ID
   */
  findBattleBySocket(socketId) {
    for (const [id, room] of battles) {
      if (room.bossSid === socketId || room.challengerSid === socketId) {
        return room;
      }
    }
    return null;
  },

  /**
   * Get all active battles
   */
  getActiveBattles() {
    const result = [];
    for (const [id, room] of battles) {
      result.push({
        battleId: id,
        status: room.status,
        bossName: room.bossName,
        challengerName: room.challengerName,
        turn: room.turn,
        createdAt: room.createdAt,
      });
    }
    return result;
  },

  /**
   * Setup Socket.io event handlers for PvP
   */
  setupSocketHandlers(io, socket, onBossReveal, onBattleEnd) {
    // Player joins a battle room
    socket.on('PVP_JOIN_BATTLE', (data) => {
      const { battleId, side } = data;
      const room = battles.get(battleId);
      if (!room) {
        socket.emit('PVP_ERROR', { error: 'Battle not found' });
        return;
      }

      const started = room.join(side, socket.id);
      socket.join(`pvp:${battleId}`);

      // Send battle config to this player
      socket.emit('PVP_BATTLE_CONFIG', room.getConfigForSide(side));

      if (started) {
        // Notify both players
        io.to(`pvp:${battleId}`).emit('PVP_BATTLE_STARTED', {
          battleId,
          seed: room.seed,
          turn: 1,
        });
      }
    });

    // Player submits a move
    socket.on('PVP_SUBMIT_MOVE', (data) => {
      const { battleId, side, turn, move } = data;
      const room = battles.get(battleId);
      if (!room) return;

      // Track boss pokemon switches (command=2 is POKEMON switch)
      if (side === 'boss' && move && move.command === 2 && typeof move.cursor === 'number') {
        if (room.revealBossSlot(move.cursor)) {
          const slots = room.getRevealedBossSlots();
          io.to('gym').emit('GYM_BOSS_REVEAL', { battleId, revealedSlots: slots });
          if (onBossReveal) onBossReveal(battleId, slots);
        }
      }

      const result = room.submitMove(side, turn, move);
      if (result) {
        // Both moves are in — send opponent's move to each player
        // Boss gets challenger's move, challenger gets boss's move
        if (room.bossSid) {
          io.to(room.bossSid).emit('PVP_OPPONENT_MOVE', {
            battleId,
            turn: result.turn,
            move: result.challengerMove,
          });
        }
        if (room.challengerSid) {
          io.to(room.challengerSid).emit('PVP_OPPONENT_MOVE', {
            battleId,
            turn: result.turn,
            move: result.bossMove,
          });
        }

        // Confirm turn sync
        io.to(`pvp:${battleId}`).emit('PVP_TURN_SYNC', {
          battleId,
          turn: room.turn,
        });
      }
    });

    // Player reports battle result
    socket.on('PVP_BATTLE_RESULT', (data) => {
      const { battleId, side, result } = data;
      const room = battles.get(battleId);
      if (!room) return;

      // The winner reports "win", loser reports "loss"
      // Trust the first result report
      if (!room.result) {
        const winner = result === 'win' ? side : (side === 'boss' ? 'challenger' : 'boss');
        room.setResult(winner, 'battle_complete');

        io.to(`pvp:${battleId}`).emit('PVP_BATTLE_ENDED', {
          battleId,
          reason: 'battle_complete',
          winner,
        });

        console.log(`${PREFIX} Battle ${battleId} ended — winner: ${winner}`);
        if (onBattleEnd) onBattleEnd(battleId, winner, 'battle_complete');
      }
    });

    // Battle event relay (faint, switch, etc.)
    socket.on('PVP_BATTLE_EVENT', (data) => {
      const { battleId, side, event, payload } = data;
      const room = battles.get(battleId);
      if (!room) return;

      // Track boss faint switches — reveals new pokemon slot
      if (side === 'boss' && event === 'faint_switch' && payload?.slotIndex !== undefined) {
        if (room.revealBossSlot(payload.slotIndex)) {
          const slots = room.getRevealedBossSlots();
          io.to('gym').emit('GYM_BOSS_REVEAL', { battleId, revealedSlots: slots });
          if (onBossReveal) onBossReveal(battleId, slots);
        }
      }

      // Relay to opponent
      const targetSid = side === 'boss' ? room.challengerSid : room.bossSid;
      if (targetSid) {
        io.to(targetSid).emit('PVP_BATTLE_EVENT', {
          battleId,
          event,
          payload,
        });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      const room = pvpBattleManager.findBattleBySocket(socket.id);
      if (room) {
        const side = room.leave(socket.id);
        if (side && room.status === 'active') {
          const winner = side === 'boss' ? 'challenger' : 'boss';
          room.setResult(winner, 'disconnect');
          io.to(`pvp:${room.battleId}`).emit('PVP_BATTLE_ENDED', {
            battleId: room.battleId,
            reason: 'opponent_disconnected',
            winner,
          });
          console.log(`${PREFIX} ${side} disconnected from battle ${room.battleId}`);
          if (onBattleEnd) onBattleEnd(room.battleId, winner, 'opponent_disconnected');
        }
      }
    });
  },
};

module.exports = pvpBattleManager;
