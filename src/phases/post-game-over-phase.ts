import { raceManager } from "#app/emmelrogue/race-manager";
import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import type { EndCardPhase } from "#phases/end-card-phase";

export class PostGameOverPhase extends Phase {
  public readonly phaseName = "PostGameOverPhase";
  private endCardPhase?: EndCardPhase | undefined;
  private slotId: number;

  constructor(slotId: number, endCardPhase?: EndCardPhase) {
    super();
    this.slotId = slotId;
    this.endCardPhase = endCardPhase;
  }

  start() {
    super.start();

    // Race mode: notify parent overlay that the game is over (don't save/reset)
    if (raceManager.isRaceMode()) {
      try {
        window.parent.postMessage({ type: "RACE_GAME_OVER" }, "*");
      } catch { /* ignore if no parent */ }
      this.end();
      return;
    }

    const saveAndReset = () => {
      globalScene.gameData.saveAll(true, true, true).then(success => {
        if (!success) {
          return globalScene.reset(true);
        }
        globalScene.gameData.tryClearSession(this.slotId).then(([success]) => {
          if (!success) {
            return globalScene.reset(true);
          }
          globalScene.reset();
          globalScene.phaseManager.unshiftNew("TitlePhase");
          this.end();
        });
      });
    };

    if (this.endCardPhase) {
      globalScene.ui.fadeOut(500).then(() => {
        globalScene.ui.getMessageHandler().bg.setVisible(true);

        this.endCardPhase?.endCard.destroy();
        this.endCardPhase?.text.destroy();
        saveAndReset();
      });
    } else {
      saveAndReset();
    }
  }
}
