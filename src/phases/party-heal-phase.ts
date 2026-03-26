import { globalScene } from "#app/global-scene";
import { raceManager } from "#app/emmelrogue/race-manager";
import { ChallengeType } from "#enums/challenge-type";
import { BattlePhase } from "#phases/battle-phase";
import { applyChallenges } from "#utils/challenge-utils";
import { BooleanHolder, fixedInt } from "#utils/common";

export class PartyHealPhase extends BattlePhase {
  public readonly phaseName = "PartyHealPhase";
  private resumeBgm: boolean;

  constructor(resumeBgm: boolean) {
    super();

    this.resumeBgm = resumeBgm;
  }

  start() {
    super.start();

    const bgmPlaying = globalScene.isBgmPlaying();
    if (bgmPlaying) {
      globalScene.fadeOutBgm(1000, false);
    }
    globalScene.ui.fadeOut(1000).then(() => {
      const preventRevive = new BooleanHolder(false);
      applyChallenges(ChallengeType.PREVENT_REVIVE, preventRevive);

      // EmmelRogue Nuzlocke: Tote Pokemon ZUERST entfernen, DANN heilen
      const isNuzlocke = raceManager.isRaceMode() && raceManager.getNuzlockeDeath();
      if (isNuzlocke) {
        const party = globalScene.getPlayerParty();
        for (let i = party.length - 1; i >= 0; i--) {
          if (party[i].isFainted()) {
            console.log(`[Nuzlocke] Removing fainted ${party[i].name} before heal (wave ${globalScene.currentBattle?.waveIndex})`);
            party.splice(i, 1);
          }
        }
      }

      for (const pokemon of globalScene.getPlayerParty()) {
        // Prevent reviving fainted pokemon during certain challenges
        if (pokemon.isFainted() && preventRevive.value) {
          continue;
        }

        pokemon.hp = pokemon.getMaxHp();
        pokemon.resetStatus(true, false, false, true);
        for (const move of pokemon.moveset) {
          move.ppUsed = 0;
        }
        pokemon.updateInfo(true);
      }
      const healSong = globalScene.playSoundWithoutBgm("heal");
      if (healSong) {
        globalScene.time.delayedCall(fixedInt(healSong.totalDuration * 1000), () => {
          healSong.destroy();
          if (this.resumeBgm && bgmPlaying) {
            globalScene.playBgm();
          }
          globalScene.ui.fadeIn(500).then(() => this.end());
        });
      }
    });
    globalScene.arena.playerTerasUsed = 0;
  }
}
