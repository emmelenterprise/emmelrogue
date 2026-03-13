import { globalScene } from "#app/global-scene";
import { pvpBattle } from "#app/emmelrogue/pvp-battle";
import { AbilityId } from "#enums/ability-id";
import { BattlerIndex } from "#enums/battler-index";
import { BattlerTagType } from "#enums/battler-tag-type";
import { Command } from "#enums/command";
import type { EnemyPokemon } from "#field/pokemon";
import { FieldPhase } from "#phases/field-phase";

/**
 * Phase for determining an enemy's action for the next turn.
 *
 * In normal mode: Enemy AI picks the move.
 * In PvP mode: Waits for the opponent's move selection via network.
 *
 * For more information on how the Enemy AI works, see docs/enemy-ai.md
 * @see {@linkcode Pokemon.getMatchupScore}
 * @see {@linkcode EnemyPokemon.getNextMove}
 */
export class EnemyCommandPhase extends FieldPhase {
  public readonly phaseName = "EnemyCommandPhase";
  protected fieldIndex: number;
  protected skipTurn = false;

  constructor(fieldIndex: number) {
    super();

    this.fieldIndex = fieldIndex;
    if (globalScene.currentBattle.mysteryEncounter?.skipEnemyBattleTurns) {
      this.skipTurn = true;
    }
  }

  start() {
    super.start();

    const enemyPokemon = globalScene.getEnemyField()[this.fieldIndex];

    const battle = globalScene.currentBattle;

    const trainer = battle.trainer;

    if (
      battle.double
      && enemyPokemon.hasAbility(AbilityId.COMMANDER)
      && enemyPokemon.getAlly()?.getTag(BattlerTagType.COMMANDED)
    ) {
      this.skipTurn = true;
    }

    // --- PvP Mode: Wait for opponent's move from network ---
    if (pvpBattle.isPvpActive()) {
      this.handlePvpMove(enemyPokemon);
      return;
    }

    // --- Normal AI Mode ---
    this.handleAiMove(enemyPokemon, battle, trainer);
  }

  /**
   * PvP mode: Wait for the opponent's move selection from the server.
   */
  private handlePvpMove(enemyPokemon: EnemyPokemon): void {
    if (this.skipTurn) {
      globalScene.currentBattle.turnCommands[this.fieldIndex + BattlerIndex.ENEMY] = {
        command: Command.FIGHT,
        move: { move: 0, targets: [], useMode: 0 },
        skip: true,
      };
      this.end();
      return;
    }

    pvpBattle.waitForOpponentMove().then((opponentMove) => {
      const battle = globalScene.currentBattle;

      if (opponentMove.command === Command.POKEMON) {
        // Opponent is switching pokemon
        battle.turnCommands[this.fieldIndex + BattlerIndex.ENEMY] = {
          command: Command.POKEMON,
          cursor: opponentMove.cursor,
          args: opponentMove.args || [false],
          skip: this.skipTurn,
        };
      } else {
        // Opponent is using a move (Command.FIGHT)
        // Flip targets between perspectives: opponent's PLAYER(0) ↔ our ENEMY(2), etc.
        const flippedTargets = opponentMove.move?.targets.map(t => (t + 2) % 4) ?? [];
        battle.turnCommands[this.fieldIndex + BattlerIndex.ENEMY] = {
          command: Command.FIGHT,
          move: opponentMove.move ? {
            move: opponentMove.move.move,
            targets: flippedTargets,
            useMode: opponentMove.move.useMode,
          } : enemyPokemon.getNextMove(), // fallback to AI if no move data
          skip: this.skipTurn,
        };
      }

      this.end();
    });
  }

  /**
   * Normal AI mode: Enemy AI decides whether to switch or attack.
   */
  private handleAiMove(enemyPokemon: EnemyPokemon, battle: any, trainer: any): void {
    /**
     * If the enemy has a trainer, decide whether or not the enemy should switch
     * to another member in its party.
     */
    if (trainer && enemyPokemon.getMoveQueue().length === 0) {
      const opponents = enemyPokemon.getOpponents();

      if (!enemyPokemon.isTrapped()) {
        const partyMemberScores = trainer.getPartyMemberMatchupScores(enemyPokemon.trainerSlot, true);

        if (partyMemberScores.length > 0) {
          const matchupScores = opponents.map((opp: any) => enemyPokemon.getMatchupScore(opp));
          const matchupScore = matchupScores.reduce((total: number, score: number) => (total += score), 0) / matchupScores.length;

          const sortedPartyMemberScores = trainer.getSortedPartyMemberMatchupScores(partyMemberScores);

          const switchMultiplier = 1 - (battle.enemySwitchCounter ? Math.pow(0.1, 1 / battle.enemySwitchCounter) : 0);

          if (sortedPartyMemberScores[0][1] * switchMultiplier >= matchupScore * (trainer.config.isBoss ? 2 : 3)) {
            const index = trainer.getNextSummonIndex(enemyPokemon.trainerSlot, partyMemberScores);

            battle.turnCommands[this.fieldIndex + BattlerIndex.ENEMY] = {
              command: Command.POKEMON,
              cursor: index,
              args: [false],
              skip: this.skipTurn,
            };

            battle.enemySwitchCounter++;

            return this.end();
          }
        }
      }
    }

    /** Select a move to use (and a target to use it against, if applicable) */
    const nextMove = enemyPokemon.getNextMove();

    if (this.shouldTera(enemyPokemon)) {
      globalScene.currentBattle.preTurnCommands[this.fieldIndex + BattlerIndex.ENEMY] = { command: Command.TERA };
    }

    globalScene.currentBattle.turnCommands[this.fieldIndex + BattlerIndex.ENEMY] = {
      command: Command.FIGHT,
      move: nextMove,
      skip: this.skipTurn,
    };

    globalScene.currentBattle.enemySwitchCounter = Math.max(globalScene.currentBattle.enemySwitchCounter - 1, 0);

    this.end();
  }

  private shouldTera(pokemon: EnemyPokemon): boolean {
    return !!globalScene.currentBattle.trainer?.shouldTera(pokemon);
  }

  getFieldIndex(): number {
    return this.fieldIndex;
  }
}
