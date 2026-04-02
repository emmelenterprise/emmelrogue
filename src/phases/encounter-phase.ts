import { applyAbAttrs } from "#abilities/apply-ab-attrs";
import { PLAYER_PARTY_MAX_SIZE, WEIGHT_INCREMENT_ON_SPAWN_MISS } from "#app/constants";
import { raceManager } from "#app/emmelrogue/race-manager";
import { chatTrainers } from "#app/emmelrogue/chat-trainers";
import { pvpBattle } from "#app/emmelrogue/pvp-battle";
import { PokemonMove } from "#moves/pokemon-move";
import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import Overrides from "#app/overrides";
import { handleTutorial, Tutorial } from "#app/tutorial";
import { initEncounterAnims, loadEncounterAnimAssets } from "#data/battle-anims";
import { getCharVariantFromDialogue } from "#data/dialogue";
import { getNatureName } from "#data/nature";
import { BattleSpec } from "#enums/battle-spec";
import { BattleType } from "#enums/battle-type";
import { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { FieldPosition } from "#enums/field-position";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import { MysteryEncounterMode } from "#enums/mystery-encounter-mode";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import { TrainerSlot } from "#enums/trainer-slot";
import { TrainerType } from "#enums/trainer-type";
import { TrainerVariant } from "#enums/trainer-variant";
import { Trainer } from "#field/trainer";
import { UiMode } from "#enums/ui-mode";
import { EncounterPhaseEvent } from "#events/battle-scene";
import type { Pokemon } from "#field/pokemon";
import {
  BoostBugSpawnModifier,
  IvScannerModifier,
  overrideHeldItems,
  overrideModifiers,
  TurnHeldItemTransferModifier,
} from "#modifiers/modifier";
import { regenerateModifierPoolThresholds } from "#modifiers/modifier-type";
import { getEncounterText } from "#mystery-encounters/encounter-dialogue-utils";
import { doTrainerExclamation } from "#mystery-encounters/encounter-phase-utils";
import { getGoldenBugNetSpecies } from "#mystery-encounters/encounter-pokemon-utils";
import { BattlePhase } from "#phases/battle-phase";
import { achvs } from "#system/achv";
import { randSeedInt, randSeedItem } from "#utils/common";
import { getPokemonSpecies } from "#utils/pokemon-utils";
import i18next from "i18next";

export class EncounterPhase extends BattlePhase {
  // Union type is necessary as this is subclassed, and typescript will otherwise complain
  public readonly phaseName: "EncounterPhase" | "NextEncounterPhase" | "NewBiomeEncounterPhase" = "EncounterPhase";
  private loaded: boolean;

  constructor(loaded = false) {
    super();

    this.loaded = loaded;
  }

  async start() {
    super.start();

    globalScene.updateGameInfo();

    globalScene.initSession();

    globalScene.eventTarget.dispatchEvent(new EncounterPhaseEvent());

    // Wait for PvP config if PvP mode is active (fixes race condition with async fetch)
    if (pvpBattle.isPvpActive()) {
      await pvpBattle.waitForConfig();
    }

    // Nuzlocke: remove all fainted Pokemon from party at the start of each encounter
    // Done here (not during faint) to avoid breaking the SwitchPhase party-index logic
    if (raceManager.isRaceMode() && raceManager.getNuzlockeDeath()) {
      const party = globalScene.getPlayerParty();
      for (let i = party.length - 1; i >= 0; i--) {
        if (party[i].isFainted()) {
          console.log(`[Race] Nuzlocke: removing fainted ${party[i].name} from party`);
          party.splice(i, 1);
        }
      }
    }

    // Report wave progress for race mode
    if (raceManager.isRaceMode()) {
      raceManager.reportProgress(globalScene.currentBattle.waveIndex, "playing");
    }

    // Failsafe if players somehow skip floor 200 in classic mode
    if (globalScene.gameMode.isClassic && globalScene.currentBattle.waveIndex > 200) {
      globalScene.phaseManager.unshiftNew("GameOverPhase");
    }

    const loadEnemyAssets: Promise<void>[] = [];

    const battle = globalScene.currentBattle;

    // DEBUG: Log encounter state for trainer battles (always, regardless of chatTrainers)
    if (battle.battleType === BattleType.TRAINER && !this.loaded) {
      console.log(`[Encounter DEBUG] Wave ${battle.waveIndex}: TRAINER battle, chatTrainers.isActive=${chatTrainers.isActive()}, double=${battle.double}, enemyLevels=${battle.enemyLevels?.length}`);
    }

    // Generate and Init Mystery Encounter
    if (battle.isBattleMysteryEncounter() && !battle.mysteryEncounter) {
      globalScene.executeWithSeedOffset(() => {
        const currentSessionEncounterType = battle.mysteryEncounterType;
        battle.mysteryEncounter = globalScene.getMysteryEncounter(currentSessionEncounterType);
      }, battle.waveIndex * 16);
    }
    const mysteryEncounter = battle.mysteryEncounter;
    if (mysteryEncounter) {
      // If ME has an onInit() function, call it
      // Usually used for calculating rand data before initializing anything visual
      // Also prepopulates any dialogue tokens from encounter/option requirements
      globalScene.executeWithSeedOffset(() => {
        if (mysteryEncounter.onInit) {
          mysteryEncounter.onInit();
        }
        mysteryEncounter.populateDialogueTokensFromRequirements();
      }, battle.waveIndex);

      // Add any special encounter animations to load
      if (mysteryEncounter.encounterAnimations && mysteryEncounter.encounterAnimations.length > 0) {
        loadEnemyAssets.push(
          initEncounterAnims(mysteryEncounter.encounterAnimations).then(() => loadEncounterAnimAssets(true)),
        );
      }

      // Add intro visuals for mystery encounter
      mysteryEncounter.initIntroVisuals();
      globalScene.field.add(mysteryEncounter.introVisuals!);
    }

    // --- PvP Mode: Set up trainer battle with opponent's team ---
    let pvpCustomPartyUsed = false;
    if (pvpBattle.isPvpActive() && !this.loaded && battle.waveIndex === 1) {
      const config = pvpBattle.getConfig();
      if (config && config.opponentTeam.length > 0) {
        battle.battleType = BattleType.TRAINER;
        battle.double = false;
        battle.battleSeed = config.seed; // Shared seed for deterministic results

        const trainer = new Trainer(TrainerType.ACE_TRAINER, TrainerVariant.DEFAULT, 0);
        trainer.overrideName = config.opponentName;
        trainer.overrideSpriteKey = config.opponentSprite;
        battle.trainer = trainer;
        globalScene.field.add(trainer);

        const level = config.playerLevel || 50;
        battle.enemyLevels = config.opponentTeam.map(() => level);
        battle.enemyParty = [];

        // Seed RNG deterministically per side so both clients create identical Pokemon
        const opponentSide = config.side === "boss" ? "challenger" : "boss";
        Phaser.Math.RND.sow([config.seed + "_" + opponentSide]);

        for (let ci = 0; ci < config.opponentTeam.length; ci++) {
          const cp = config.opponentTeam[ci];
          const species = getPokemonSpecies(cp.speciesId);
          const newPokemon = globalScene.addEnemyPokemon(species, level, TrainerSlot.TRAINER);
          // Apply form if specified (Mega, Gigantamax, etc.)
          if (cp.formIndex !== undefined && cp.formIndex > 0) {
            newPokemon.formIndex = cp.formIndex;
            newPokemon.generateName();
          }
          // Apply shiny variant
          if (cp.shiny) {
            newPokemon.shiny = true;
            if (cp.variant !== undefined) {
              newPokemon.variant = cp.variant;
            }
          }
          // Apply custom moves if specified
          if (cp.moves && Array.isArray(cp.moves)) {
            const customMoves = cp.moves.filter((m: number | null) => m !== null && m > 0);
            if (customMoves.length > 0) {
              newPokemon.moveset = customMoves.map((moveId: number) => new PokemonMove(moveId));
            }
          }
          battle.enemyParty[ci] = newPokemon;
        }
        pvpCustomPartyUsed = true;
        console.log(`[PvP] Set up battle: ${config.opponentTeam.length} opponent Pokemon (seed: ${config.seed})`);
      }
    }

    // --- Chat Feature: Wild → Trainer conversion ---
    if (chatTrainers.isActive() && !this.loaded && !battle.isBattleMysteryEncounter()
        && battle.battleType !== BattleType.TRAINER && chatTrainers.hasCustomTrainerInsert(battle.waveIndex)) {
      const custom = chatTrainers.getCustomization(battle.waveIndex);
      if (custom?.customParty && custom.customParty.length > 0) {
        battle.battleType = BattleType.TRAINER;
        battle.double = false; // Inserted trainers are always single battles

        const trainer = new Trainer(TrainerType.ACE_TRAINER, TrainerVariant.DEFAULT, 0);
        if (custom.trainerName) trainer.overrideName = custom.trainerName;
        trainer.overrideSpriteKey = custom.spriteKey || 'youngster';
        if (custom.trainerLines) {
          if (custom.trainerLines.intro) trainer.overrideEncounterMessages = [custom.trainerLines.intro];
          if (custom.trainerLines.victory) trainer.overrideDefeatMessages = [custom.trainerLines.victory];
          if (custom.trainerLines.defeat) trainer.overrideVictoryMessages = [custom.trainerLines.defeat];
        }
        battle.trainer = trainer;
        globalScene.field.add(trainer);

        // Build custom party directly (skip main loop to avoid double-creation bugs)
        battle.enemyLevels = [];
        battle.enemyParty = [];
        for (let ci = 0; ci < custom.customParty.length; ci++) {
          const cp = custom.customParty[ci];
          const species = getPokemonSpecies(cp.speciesId);
          const level = battle.getLevelForWave();
          // Double battles: alternate TrainerSlot between TRAINER and TRAINER_PARTNER
          const slot = !battle.double || !(ci % 2) ? TrainerSlot.TRAINER : TrainerSlot.TRAINER_PARTNER;
          const newPokemon = globalScene.addEnemyPokemon(species, level, slot);
          if (cp.shiny) {
            newPokemon.shiny = true;
          }
          if (cp.nickname) {
            newPokemon.nickname = btoa(unescape(encodeURIComponent(cp.nickname)));
          }
          battle.enemyParty.push(newPokemon);
          if (ci < (battle.double ? 2 : 1)) {
            newPokemon.setX(-66 + newPokemon.getFieldPositionOffset()[0]);
          }
          loadEnemyAssets.push(newPokemon.loadAssets());
        }
        console.log(`[ChatTrainers] Wild→Trainer conversion at wave ${battle.waveIndex} (${custom.customParty.length} Pokemon, double=${!!battle.double})`);
      }
    }

    // --- Chat Feature: Trainer-Only gimmick (convert remaining wild encounters) ---
    if (chatTrainers.isActive() && !this.loaded && !battle.isBattleMysteryEncounter()
        && battle.battleType !== BattleType.TRAINER && chatTrainers.isTrainerOnly()) {
      battle.battleType = BattleType.TRAINER;

      const trainer = new Trainer(TrainerType.ACE_TRAINER, TrainerVariant.DEFAULT, 0);
      battle.trainer = trainer;
      globalScene.field.add(trainer);

      // Use current enemy levels count for party size
      battle.enemyLevels = (battle.enemyLevels || [battle.getLevelForWave()]);
      console.log(`[ChatTrainers] Trainer-Only gimmick: converted wild to trainer at wave ${battle.waveIndex}`);
    }

    let totalBst = 0;

    // --- Chat Feature: Pre-create custom party for claimed trainers ---
    // This ensures custom pokemon go through the normal fieldSetup(true) path,
    // preventing HP display glitches caused by post-loop destroy/recreate.
    let chatCustomPartyUsed = false;
    if (chatTrainers.isActive() && !this.loaded && !battle.isBattleMysteryEncounter()
        && battle.battleType === BattleType.TRAINER && battle.trainer) {
      const customCheck = chatTrainers.getCustomization(battle.waveIndex);
      if (customCheck && !customCheck.isCustomInserted && customCheck.customParty && customCheck.customParty.length > 0) {
        // Apply name/sprite overrides early
        if (customCheck.trainerName) {
          battle.trainer.overrideName = customCheck.trainerName;
        }
        battle.trainer.overrideSpriteKey = customCheck.spriteKey || 'youngster';

        // Force single battle if custom party has only 1 pokemon
        if (customCheck.customParty.length === 1 && battle.double) {
          battle.double = false;
        }

        // Override enemy levels to match custom party size
        battle.enemyLevels = customCheck.customParty.map(() => battle.getLevelForWave());

        // Pre-create custom pokemon
        for (let ci = 0; ci < customCheck.customParty.length; ci++) {
          const cp = customCheck.customParty[ci];
          const species = getPokemonSpecies(cp.speciesId);
          const level = battle.getLevelForWave();
          // Double battles: alternate TrainerSlot between TRAINER and TRAINER_PARTNER
          const slot = !battle.double || !(ci % 2) ? TrainerSlot.TRAINER : TrainerSlot.TRAINER_PARTNER;
          const newPokemon = globalScene.addEnemyPokemon(species, level, slot);
          if (cp.shiny) {
            newPokemon.shiny = true;
          }
          if (cp.nickname) {
            newPokemon.nickname = btoa(unescape(encodeURIComponent(cp.nickname)));
          }
          battle.enemyParty[ci] = newPokemon;
        }
        chatCustomPartyUsed = true;
        console.log(`[ChatTrainers] Pre-created custom party at wave ${battle.waveIndex} (${customCheck.customParty.length} Pokemon, double=${!!battle.double})`);

        // DEBUG: Log fieldUI state after pre-creation
        const fieldUIAll = globalScene.fieldUI.getAll();
        console.log(`[ChatTrainers DEBUG] fieldUI has ${fieldUIAll.length} children after pre-creation:`);
        fieldUIAll.slice(0, 8).forEach((child, i) => {
          const bi = child as any;
          const isPlayerBI = bi.player === true;
          const isEnemyBI = bi.player === false;
          if (isPlayerBI || isEnemyBI) {
            console.log(`  [${i}] ${isPlayerBI ? 'PlayerBI' : 'EnemyBI'}: visible=${child.visible}, x=${Math.round(child.x)}, y=${Math.round(child.y)}`);
          } else {
            console.log(`  [${i}] Other: type=${child.type}, visible=${child.visible}`);
          }
        });

        // DEBUG: Log player BattleInfo state
        const playerParty = globalScene.getPlayerParty();
        for (let pi = 0; pi < Math.min(playerParty.length, 2); pi++) {
          const pp = playerParty[pi];
          if (pp?.battleInfo) {
            const pbi = pp.battleInfo as any;
            console.log(`[ChatTrainers DEBUG] Player[${pi}] battleInfo: visible=${pbi.visible}, x=${Math.round(pbi.x)}, y=${Math.round(pbi.y)}, hpBar.scaleX=${pp.battleInfo.hpBar?.scaleX?.toFixed(3)}`);
            if (pbi.expMaskRect) {
              console.log(`  expMaskRect: x=${Math.round(pbi.expMaskRect.x)}, y=${Math.round(pbi.expMaskRect.y)}, visible=${pbi.expMaskRect.visible}`);
            }
          }
        }
      }
    }

    battle.enemyLevels?.every((level, e) => {
      if (battle.isBattleMysteryEncounter()) {
        // Skip enemy loading for MEs, those are loaded elsewhere
        return false;
      }
      if (!this.loaded) {
        if (chatCustomPartyUsed || pvpCustomPartyUsed) {
          // Pokemon already created above, skip genPartyMember
        } else if (battle.battleType === BattleType.TRAINER) {
          battle.enemyParty[e] = battle.trainer?.genPartyMember(e)!; // TODO:: is the bang correct here?
        } else {
          let enemySpecies = globalScene.randomSpecies(battle.waveIndex, level, true);
          // If player has golden bug net, rolls 10% chance to replace non-boss wave wild species from the golden bug net bug pool
          if (
            globalScene.findModifier(m => m instanceof BoostBugSpawnModifier)
            && !globalScene.gameMode.isBoss(battle.waveIndex)
            && globalScene.arena.biomeId !== BiomeId.END
            && randSeedInt(10) === 0
          ) {
            enemySpecies = getGoldenBugNetSpecies(level);
          }
          battle.enemyParty[e] = globalScene.addEnemyPokemon(
            enemySpecies,
            level,
            TrainerSlot.NONE,
            !!globalScene.getEncounterBossSegments(battle.waveIndex, level, enemySpecies),
          );
          if (globalScene.currentBattle.battleSpec === BattleSpec.FINAL_BOSS) {
            battle.enemyParty[e].ivs.fill(31);
          }
          globalScene
            .getPlayerParty()
            .slice(0, battle.double ? 2 : 1)
            .reverse()
            .forEach(playerPokemon => {
              applyAbAttrs("SyncEncounterNatureAbAttr", { pokemon: playerPokemon, target: battle.enemyParty[e] });
            });
        }
      }
      const enemyPokemon = globalScene.getEnemyParty()[e];
      if (e < (battle.double ? 2 : 1)) {
        enemyPokemon.setX(-66 + enemyPokemon.getFieldPositionOffset()[0]);
        enemyPokemon.fieldSetup(true);
      }

      if (!this.loaded) {
        globalScene.gameData.setPokemonSeen(
          enemyPokemon,
          true,
          battle.battleType === BattleType.TRAINER
            || battle?.mysteryEncounter?.encounterMode === MysteryEncounterMode.TRAINER_BATTLE,
        );
      }

      if (enemyPokemon.species.speciesId === SpeciesId.ETERNATUS) {
        if (
          globalScene.gameMode.isClassic
          && (battle.battleSpec === BattleSpec.FINAL_BOSS || globalScene.gameMode.isWaveFinal(battle.waveIndex))
        ) {
          if (battle.battleSpec !== BattleSpec.FINAL_BOSS) {
            enemyPokemon.formIndex = 1;
            enemyPokemon.updateScale();
          }
          enemyPokemon.setBoss();
        } else if (!(battle.waveIndex % 1000)) {
          enemyPokemon.formIndex = 1;
          enemyPokemon.updateScale();
        }
      }

      totalBst += enemyPokemon.getSpeciesForm().baseTotal;

      loadEnemyAssets.push(enemyPokemon.loadAssets());

      const stats: string[] = [
        `HP: ${enemyPokemon.stats[0]} (${enemyPokemon.ivs[0]})`,
        ` Atk: ${enemyPokemon.stats[1]} (${enemyPokemon.ivs[1]})`,
        ` Def: ${enemyPokemon.stats[2]} (${enemyPokemon.ivs[2]})`,
        ` Spatk: ${enemyPokemon.stats[3]} (${enemyPokemon.ivs[3]})`,
        ` Spdef: ${enemyPokemon.stats[4]} (${enemyPokemon.ivs[4]})`,
        ` Spd: ${enemyPokemon.stats[5]} (${enemyPokemon.ivs[5]})`,
      ];
      const moveset: string[] = [];
      for (const move of enemyPokemon.getMoveset()) {
        moveset.push(move.getName());
      }

      console.log(
        `Pokemon: ${getPokemonNameWithAffix(enemyPokemon)}`,
        `| Species ID: ${enemyPokemon.species.speciesId}`,
        `| Level: ${enemyPokemon.level}`,
        `| Nature: ${getNatureName(enemyPokemon.nature, true, true, true)}`,
      );
      console.log(`Stats (IVs): ${stats}`);
      console.log(
        `Ability: ${enemyPokemon.getAbility().name}`,
        `| Passive Ability${enemyPokemon.hasPassive() ? "" : " (inactive)"}: ${enemyPokemon.getPassiveAbility().name}`,
        `${enemyPokemon.isBoss() ? `| Boss Bars: ${enemyPokemon.bossSegments}` : ""}`,
      );
      console.log("Moveset:", moveset);
      return true;
    });

    // DEBUG: Log fieldUI state after main loop (only for custom trainer battles)
    if (chatCustomPartyUsed) {
      const fieldUIAll2 = globalScene.fieldUI.getAll();
      console.log(`[ChatTrainers DEBUG] fieldUI after main loop: ${fieldUIAll2.length} children`);
      fieldUIAll2.slice(0, 8).forEach((child, i) => {
        const bi = child as any;
        const isPlayerBI = bi.player === true;
        const isEnemyBI = bi.player === false;
        if (isPlayerBI || isEnemyBI) {
          console.log(`  [${i}] ${isPlayerBI ? 'PlayerBI' : 'EnemyBI'}: visible=${child.visible}, x=${Math.round(child.x)}, y=${Math.round(child.y)}`);
        }
      });
    }

    // --- Chat Trainer Feature Hooks ---
    if (chatTrainers.isActive() && !this.loaded && !battle.isBattleMysteryEncounter()) {
      // Only P1 / solo reports to server (P2 just receives customizations)
      const isReporter = !raceManager.isRaceMode() || raceManager.getPlayerNumber() === 1;

      // Report wave progress + streamer party
      if (isReporter) {
        chatTrainers.reportWaveUpdate(battle.waveIndex, globalScene.arena?.biomeId?.toString() || "");

        // Report streamer's current party
        const playerParty = globalScene.getPlayerParty().map(p => ({
          speciesId: p.species.speciesId,
          iconId: p.getIconId(),
          name: p.getNameToRender(),
          level: p.level,
          shiny: p.shiny,
          shinyVariant: p.shiny ? (p.variant ?? 0) + 1 : 0,
          hp: p.hp,
          maxHp: p.getMaxHp(),
        }));
        chatTrainers.reportStreamerParty(playerParty);
      }

      if (battle.battleType === BattleType.TRAINER && battle.trainer) {
        // Report trainer to server (P1 only)
        if (isReporter) {
          const partyData = battle.enemyParty.map(p => ({
            speciesId: p.species.speciesId,
            name: p.species.getName(),
            level: p.level,
            cost: 3, // Default cost, server will look up actual cost
          }));
          chatTrainers.reportTrainer(battle.waveIndex, {
            trainerType: battle.trainer.config?.trainerType,
            trainerClass: battle.trainer.config?.getTitle(TrainerSlot.NONE, battle.trainer.variant) || "",
            spriteKey: battle.trainer.getKey(),
            variant: battle.trainer.variant,
            isFixed: battle.trainer.config?.hasStaticParty || false,
            isBoss: globalScene.gameMode.isBoss(battle.waveIndex),
            biome: globalScene.arena?.biomeId?.toString() || "",
            originalParty: partyData,
          });
        }

        // Apply customizations from chat (skip for inserted trainers and pre-created custom parties)
        const custom = chatTrainers.getCustomization(battle.waveIndex);
        if (custom) {
          // Name override
          if (custom.trainerName) {
            battle.trainer.overrideName = custom.trainerName;
          }
          // Sprite override
          if (custom.spriteKey) {
            battle.trainer.overrideSpriteKey = custom.spriteKey;
          }
          // Trainer lines override (intro, victory, defeat)
          // PokéRogue Konvention: victoryMessages = Spieler gewinnt (Trainer verliert)
          //                       defeatMessages = Spieler verliert (Trainer gewinnt)
          if (custom.trainerLines) {
            if (custom.trainerLines.intro) battle.trainer.overrideEncounterMessages = [custom.trainerLines.intro];
            if (custom.trainerLines.victory) battle.trainer.overrideDefeatMessages = [custom.trainerLines.victory];
            if (custom.trainerLines.defeat) battle.trainer.overrideVictoryMessages = [custom.trainerLines.defeat];
          }
          // Pokemon nicknames
          if (custom.pokemonNicknames) {
            for (const [slotStr, nickname] of Object.entries(custom.pokemonNicknames)) {
              const slot = parseInt(slotStr);
              if (slot >= 0 && slot < battle.enemyParty.length && nickname) {
                battle.enemyParty[slot].nickname = btoa(unescape(encodeURIComponent(nickname as string)));
              }
            }
          }
        }
        // Apply nicknames for pre-created custom party
        if (chatCustomPartyUsed) {
          const customNick = chatTrainers.getCustomization(battle.waveIndex);
          if (customNick?.pokemonNicknames) {
            for (const [slotStr, nickname] of Object.entries(customNick.pokemonNicknames)) {
              const slot = parseInt(slotStr);
              if (slot >= 0 && slot < battle.enemyParty.length && nickname) {
                battle.enemyParty[slot].nickname = btoa(unescape(encodeURIComponent(nickname as string)));
              }
            }
          }
        }
      }

      // Gimmick: force double battles (only if enough enemies)
      if (chatTrainers.isDoubleForced() && !battle.double && battle.enemyParty.length >= 2) {
        battle.double = true;
      }

      // Gimmick: shiny wave — make all enemies shiny
      if (chatTrainers.isShinyWave()) {
        for (const enemy of battle.enemyParty) {
          enemy.shiny = true;
        }
      }

      // Gimmick: level boost — +10 levels to all enemies
      if (chatTrainers.isLevelBoost()) {
        for (const enemy of battle.enemyParty) {
          enemy.level = Math.min(enemy.level + 10, 100);
          enemy.calculateStats();
        }
      }
    }

    if (globalScene.getPlayerParty().filter(p => p.isShiny()).length === PLAYER_PARTY_MAX_SIZE) {
      globalScene.validateAchv(achvs.SHINY_PARTY);
    }

    if (battle.battleType === BattleType.TRAINER) {
      loadEnemyAssets.push(battle.trainer?.loadAssets().then(() => battle.trainer?.initSprite())!); // TODO: is this bang correct?
    } else if (battle.isBattleMysteryEncounter()) {
      if (battle.mysteryEncounter?.introVisuals) {
        loadEnemyAssets.push(
          battle.mysteryEncounter.introVisuals
            .loadAssets()
            .then(() => battle.mysteryEncounter!.introVisuals!.initSprite()),
        );
      }
      if (battle.mysteryEncounter?.loadAssets && battle.mysteryEncounter.loadAssets.length > 0) {
        loadEnemyAssets.push(...battle.mysteryEncounter.loadAssets);
      }
      // Load Mystery Encounter Exclamation bubble and sfx
      loadEnemyAssets.push(
        new Promise<void>(resolve => {
          globalScene
            .loadSe("GEN8- Exclaim", "battle_anims", "GEN8- Exclaim.wav")
            .loadImage("encounter_exclaim", "mystery-encounters");
          globalScene.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
          if (!globalScene.load.isLoading()) {
            globalScene.load.start();
          }
        }),
      );
    } else {
      const overridedBossSegments = Overrides.ENEMY_HEALTH_SEGMENTS_OVERRIDE > 1;
      // for double battles, reduce the health segments for boss Pokemon unless there is an override
      if (!overridedBossSegments && battle.enemyParty.filter(p => p.isBoss()).length > 1) {
        for (const enemyPokemon of battle.enemyParty) {
          // If the enemy pokemon is a boss and wasn't populated from data source, then update the number of segments
          if (enemyPokemon.isBoss() && !enemyPokemon.isPopulatedFromDataSource) {
            enemyPokemon.setBoss(
              true,
              Math.ceil(enemyPokemon.bossSegments * (enemyPokemon.getSpeciesForm().baseTotal / totalBst)),
            );
            enemyPokemon.initBattleInfo();
          }
        }
      }
    }

    Promise.all(loadEnemyAssets).then(() => {
      battle.enemyParty.every((enemyPokemon, e) => {
        if (battle.isBattleMysteryEncounter()) {
          return false;
        }
        if (e < (battle.double ? 2 : 1)) {
          if (battle.battleType === BattleType.WILD) {
            for (const pokemon of globalScene.getField()) {
              applyAbAttrs("PreSummonAbAttr", { pokemon });
            }
            globalScene.field.add(enemyPokemon);
            battle.seenEnemyPartyMemberIds.add(enemyPokemon.id);
            const playerPokemon = globalScene.getPlayerPokemon();
            if (playerPokemon?.isOnField()) {
              globalScene.field.moveBelow(enemyPokemon as Pokemon, playerPokemon);
            }
            enemyPokemon.tint(0, 0.5);
          } else if (battle.battleType === BattleType.TRAINER) {
            enemyPokemon.setVisible(false);
            globalScene.currentBattle.trainer?.tint(0, 0.5);
          }
          if (battle.double) {
            enemyPokemon.setFieldPosition(e ? FieldPosition.RIGHT : FieldPosition.LEFT);
          }
        }
        return true;
      });

      if (!this.loaded && battle.battleType !== BattleType.MYSTERY_ENCOUNTER) {
        // generate modifiers for MEs, overriding prior ones as applicable
        regenerateModifierPoolThresholds(
          globalScene.getEnemyField(),
          battle.battleType === BattleType.TRAINER ? ModifierPoolType.TRAINER : ModifierPoolType.WILD,
        );
        globalScene.generateEnemyModifiers();
        overrideModifiers(false);

        for (const enemy of globalScene.getEnemyField()) {
          overrideHeldItems(enemy, false);
        }
      }

      if (battle.battleType === BattleType.TRAINER && globalScene.currentBattle.trainer) {
        globalScene.currentBattle.trainer.genAI(globalScene.getEnemyParty());
      }

      globalScene.ui.setMode(UiMode.MESSAGE).then(() => {
        if (this.loaded) {
          this.doEncounter();
          globalScene.resetSeed();
        } else {
          // Set weather and terrain before session gets saved
          this.trySetWeatherIfNewBiome();
          this.trySetTerrainIfNewBiome();
          // Game syncs to server on waves X1 and X6 (As of 1.2.0)
          globalScene.gameData
            .saveAll(true, battle.waveIndex % 5 === 1 || (globalScene.lastSavePlayTime ?? 0) >= 300)
            .then(success => {
              globalScene.disableMenu = false;
              if (!success) {
                return globalScene.reset(true);
              }
              this.doEncounter();
              globalScene.resetSeed();
            });
        }
      });
    });
  }

  private incrementMysteryEncounterChance(): void {
    const { battleType, waveIndex } = globalScene.currentBattle;
    if (
      globalScene.isMysteryEncounterValidForWave(battleType, waveIndex)
      && !globalScene.currentBattle.isBattleMysteryEncounter()
    ) {
      // Increment ME spawn chance if an ME could have spawned but did not
      // Only do this AFTER session has been saved to avoid duplicating increments
      globalScene.mysteryEncounterSaveData.encounterSpawnChance += WEIGHT_INCREMENT_ON_SPAWN_MISS;
    }
  }

  doEncounter() {
    globalScene.playBgm(undefined, true);
    globalScene.updateModifiers(false);
    globalScene.setFieldScale(1);

    for (const pokemon of globalScene.getPlayerParty()) {
      // Currently, a new wave is not considered a new battle if there is no arena reset
      // Therefore, we only reset wave data here
      if (pokemon) {
        pokemon.resetWaveData();
      }
    }

    const enemyField = globalScene.getEnemyField();
    globalScene.tweens.add({
      targets: [
        globalScene.arenaEnemy,
        globalScene.currentBattle.trainer,
        enemyField,
        globalScene.arenaPlayer,
        globalScene.trainer,
      ].flat(),
      x: (_target, _key, value, fieldIndex: number) => (fieldIndex < 2 + enemyField.length ? value + 300 : value - 300),
      duration: 2000,
      onComplete: () => {
        if (!this.tryOverrideForBattleSpec()) {
          this.doEncounterCommon();
        }
      },
    });

    const encounterIntroVisuals = globalScene.currentBattle?.mysteryEncounter?.introVisuals;
    if (encounterIntroVisuals) {
      const enterFromRight = encounterIntroVisuals.enterFromRight;
      if (enterFromRight) {
        encounterIntroVisuals.x += 500;
      }
      globalScene.tweens.add({
        targets: encounterIntroVisuals,
        x: enterFromRight ? "-=200" : "+=300",
        duration: 2000,
      });
    }
  }

  getEncounterMessage(): string {
    const enemyField = globalScene.getEnemyField();

    if (globalScene.currentBattle.battleSpec === BattleSpec.FINAL_BOSS) {
      return i18next.t("battle:bossAppeared", {
        bossName: getPokemonNameWithAffix(enemyField[0]),
      });
    }

    if (globalScene.currentBattle.battleType === BattleType.TRAINER) {
      if (globalScene.currentBattle.double) {
        return i18next.t("battle:trainerAppearedDouble", {
          trainerName: globalScene.currentBattle.trainer?.getName(TrainerSlot.NONE, true),
        });
      }
      return i18next.t("battle:trainerAppeared", {
        trainerName: globalScene.currentBattle.trainer?.getName(TrainerSlot.NONE, true),
      });
    }

    return enemyField.length === 1
      ? i18next.t("battle:singleWildAppeared", {
          pokemonName: enemyField[0].getNameToRender(),
        })
      : i18next.t("battle:multiWildAppeared", {
          pokemonName1: enemyField[0].getNameToRender(),
          pokemonName2: enemyField[1].getNameToRender(),
        });
  }

  doEncounterCommon(showEncounterMessage = true) {
    this.incrementMysteryEncounterChance();

    const enemyField = globalScene.getEnemyField();

    if (globalScene.currentBattle.battleType === BattleType.WILD) {
      for (const enemyPokemon of enemyField) {
        enemyPokemon.untint(100, "Sine.easeOut");
        enemyPokemon.cry();
        enemyPokemon.showInfo();
        if (enemyPokemon.isShiny()) {
          globalScene.validateAchv(achvs.SEE_SHINY);
        }
      }
      globalScene.updateFieldScale();
      if (showEncounterMessage) {
        globalScene.ui.showText(this.getEncounterMessage(), null, () => this.end(), 1500);
      } else {
        this.end();
      }
    } else if (globalScene.currentBattle.battleType === BattleType.TRAINER) {
      const trainer = globalScene.currentBattle.trainer;
      trainer?.untint(100, "Sine.easeOut");
      trainer?.playAnim();

      const doSummon = () => {
        globalScene.currentBattle.started = true;
        globalScene.playBgm(undefined);
        // Skip pokeball tray for custom trainer battles (overlaps with player BattleInfo at y=-72)
        const isCustomTrainer = chatTrainers.isActive() && !!chatTrainers.getCustomization(globalScene.currentBattle.waveIndex);
        if (!isCustomTrainer) {
          globalScene.pbTray.showPbTray(globalScene.getPlayerParty());
          globalScene.pbTrayEnemy.showPbTray(globalScene.getEnemyParty());
        }
        const doTrainerSummon = () => {
          this.hideEnemyTrainer();
          const availablePartyMembers = globalScene.getEnemyParty().filter(p => !p.isFainted()).length;
          globalScene.phaseManager.unshiftNew("SummonPhase", 0, false);
          if (globalScene.currentBattle.double && availablePartyMembers > 1) {
            globalScene.phaseManager.unshiftNew("SummonPhase", 1, false);
          }
          this.end();
        };
        if (showEncounterMessage) {
          globalScene.ui.showText(this.getEncounterMessage(), null, doTrainerSummon, 1500, true);
        } else {
          doTrainerSummon();
        }
      };

      const encounterMessages = trainer?.getEncounterMessages() ?? [];

      if (encounterMessages.length === 0) {
        doSummon();
      } else {
        let message = "";
        globalScene.executeWithSeedOffset(
          () => (message = randSeedItem(encounterMessages)),
          globalScene.currentBattle.waveIndex,
        );
        const showDialogueAndSummon = () => {
          globalScene.ui.showDialogue(message, trainer?.getName(TrainerSlot.NONE, true), null, () => {
            globalScene.charSprite.hide().then(() => globalScene.hideFieldOverlay(250).then(() => doSummon()));
          });
        };
        if (trainer?.config.hasCharSprite && !globalScene.ui.shouldSkipDialogue(message)) {
          globalScene
            .showFieldOverlay(500)
            .then(() =>
              globalScene.charSprite
                .showCharacter(trainer.getKey()!, getCharVariantFromDialogue(encounterMessages[0]))
                .then(() => showDialogueAndSummon()),
            ); // TODO: is this bang correct?
        } else {
          showDialogueAndSummon();
        }
      }
    } else if (globalScene.currentBattle.isBattleMysteryEncounter() && globalScene.currentBattle.mysteryEncounter) {
      const encounter = globalScene.currentBattle.mysteryEncounter;
      const introVisuals = encounter.introVisuals;
      introVisuals?.playAnim();

      if (encounter.onVisualsStart) {
        encounter.onVisualsStart();
      } else if (encounter.spriteConfigs && introVisuals) {
        // If the encounter doesn't have any special visual intro, show sparkle for shiny Pokemon
        introVisuals.playShinySparkles();
      }

      const doEncounter = () => {
        const doShowEncounterOptions = () => {
          globalScene.ui.clearText();
          globalScene.ui.getMessageHandler().hideNameText();

          globalScene.phaseManager.unshiftNew("MysteryEncounterPhase");
          this.end();
        };

        const introDialogue = encounter.dialogue.intro;
        if (showEncounterMessage && introDialogue) {
          const FIRST_DIALOGUE_PROMPT_DELAY = 750;
          let i = 0;
          const showNextDialogue = () => {
            const nextAction = i === introDialogue.length - 1 ? doShowEncounterOptions : showNextDialogue;
            const dialogue = introDialogue[i];
            const title = getEncounterText(dialogue?.speaker);
            const text = getEncounterText(dialogue.text)!;
            i++;
            if (title) {
              globalScene.ui.showDialogue(text, title, null, nextAction, 0, i === 1 ? FIRST_DIALOGUE_PROMPT_DELAY : 0);
            } else {
              globalScene.ui.showText(text, null, nextAction, i === 1 ? FIRST_DIALOGUE_PROMPT_DELAY : 0, true);
            }
          };

          if (introDialogue.length > 0) {
            showNextDialogue();
          }
        } else {
          doShowEncounterOptions();
        }
      };

      const encounterMessage = i18next.t("battle:mysteryEncounterAppeared");

      if (encounterMessage) {
        doTrainerExclamation();
        globalScene.ui.showDialogue(encounterMessage, "???", null, () => {
          globalScene.charSprite.hide().then(() => globalScene.hideFieldOverlay(250).then(() => doEncounter()));
        });
      } else {
        doEncounter();
      }
    }
  }

  end() {
    const enemyField = globalScene.getEnemyField();

    enemyField.forEach((enemyPokemon, e) => {
      if (enemyPokemon.isShiny(true)) {
        globalScene.phaseManager.unshiftNew("ShinySparklePhase", BattlerIndex.ENEMY + e);
      }
      /** This sets Eternatus' held item to be untransferrable, preventing it from being stolen */
      if (
        enemyPokemon.species.speciesId === SpeciesId.ETERNATUS
        && (globalScene.gameMode.isBattleClassicFinalBoss(globalScene.currentBattle.waveIndex)
          || globalScene.gameMode.isEndlessMajorBoss(globalScene.currentBattle.waveIndex))
      ) {
        const enemyMBH = globalScene.findModifier(
          m => m instanceof TurnHeldItemTransferModifier,
          false,
        ) as TurnHeldItemTransferModifier;
        if (enemyMBH) {
          globalScene.removeModifier(enemyMBH, true);
          enemyMBH.setTransferrableFalse();
          globalScene.addEnemyModifier(enemyMBH);
        }
      }
    });

    if (![BattleType.TRAINER, BattleType.MYSTERY_ENCOUNTER].includes(globalScene.currentBattle.battleType)) {
      const ivScannerModifier = globalScene.findModifier(m => m instanceof IvScannerModifier);
      if (ivScannerModifier) {
        enemyField.map(p => globalScene.phaseManager.pushNew("ScanIvsPhase", p.getBattlerIndex()));
      }
    }

    if (!this.loaded) {
      const availablePartyMembers = globalScene.getPokemonAllowedInBattle();

      // DEBUG: Log player BattleInfo state before summon setup (chat trainer battles only)
      if (chatTrainers.isActive() && globalScene.currentBattle.battleType === BattleType.TRAINER) {
        const fieldUIEnd = globalScene.fieldUI.getAll();
        console.log(`[ChatTrainers DEBUG] end(): fieldUI has ${fieldUIEnd.length} children, battle.double=${globalScene.currentBattle.double}`);
        fieldUIEnd.slice(0, 8).forEach((child, i) => {
          const bi = child as any;
          if (bi.player === true || bi.player === false) {
            console.log(`  [${i}] ${bi.player ? 'PlayerBI' : 'EnemyBI'}: visible=${child.visible}, x=${Math.round(child.x)}, y=${Math.round(child.y)}`);
          }
        });
        for (let pi = 0; pi < Math.min(availablePartyMembers.length, 2); pi++) {
          const pp = availablePartyMembers[pi];
          console.log(`  Player[${pi}]: onField=${pp.isOnField()}, hp=${pp.hp}/${pp.getMaxHp()}, battleInfo.visible=${pp.battleInfo?.visible}, battleInfo.x=${Math.round(pp.battleInfo?.x ?? 0)}`);
        }
      }

      if (!availablePartyMembers[0].isOnField()) {
        globalScene.phaseManager.pushNew("SummonPhase", 0);
      }

      if (globalScene.currentBattle.double) {
        if (availablePartyMembers.length > 1) {
          globalScene.phaseManager.pushNew("ToggleDoublePositionPhase", true);
          if (!availablePartyMembers[1].isOnField()) {
            globalScene.phaseManager.pushNew("SummonPhase", 1);
          }
        }
      } else {
        if (availablePartyMembers.length > 1 && availablePartyMembers[1].isOnField()) {
          globalScene.phaseManager.pushNew("ReturnPhase", 1);
        }
        globalScene.phaseManager.pushNew("ToggleDoublePositionPhase", false);
      }

      if (
        globalScene.currentBattle.battleType !== BattleType.TRAINER
        && (globalScene.currentBattle.waveIndex > 1 || !globalScene.gameMode.isDaily)
      ) {
        const minPartySize = globalScene.currentBattle.double ? 2 : 1;
        if (availablePartyMembers.length > minPartySize) {
          globalScene.phaseManager.pushNew("CheckSwitchPhase", 0, globalScene.currentBattle.double);
          if (globalScene.currentBattle.double) {
            globalScene.phaseManager.pushNew("CheckSwitchPhase", 1, globalScene.currentBattle.double);
          }
        }
      }
    }
    handleTutorial(Tutorial.ACCESS_MENU).then(() => super.end());

    globalScene.phaseManager.pushNew("InitEncounterPhase");
  }

  tryOverrideForBattleSpec(): boolean {
    switch (globalScene.currentBattle.battleSpec) {
      case BattleSpec.FINAL_BOSS: {
        const enemy = globalScene.getEnemyPokemon();
        globalScene.ui.showText(
          this.getEncounterMessage(),
          null,
          () => {
            const localizationKey = "battleSpecDialogue:encounter";
            if (globalScene.ui.shouldSkipDialogue(localizationKey)) {
              // Logging mirrors logging found in dialogue-ui-handler
              console.log(`Dialogue ${localizationKey} skipped`);
              this.doEncounterCommon(false);
            } else {
              const count = 5643853 + globalScene.gameData.gameStats.classicSessionsPlayed;
              // The line below checks if an English ordinal is necessary or not based on whether an entry for encounterLocalizationKey exists in the language or not.
              const ordinalUsed =
                !i18next.exists(localizationKey, { fallbackLng: [] }) || i18next.resolvedLanguage === "en"
                  ? i18next.t("battleSpecDialogue:key", {
                      count,
                      ordinal: true,
                    })
                  : "";
              const cycleCount = count.toLocaleString() + ordinalUsed;
              const genderIndex = globalScene.gameData.gender ?? PlayerGender.UNSET;
              const genderStr = PlayerGender[genderIndex].toLowerCase();
              const encounterDialogue = i18next.t(localizationKey, {
                context: genderStr,
                cycleCount,
              });
              if (!globalScene.gameData.getSeenDialogues()[localizationKey]) {
                globalScene.gameData.saveSeenDialogue(localizationKey);
              }
              globalScene.ui.showDialogue(encounterDialogue, enemy?.species.name, null, () => {
                this.doEncounterCommon(false);
              });
            }
          },
          1500,
          true,
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Set biome weather if and only if this encounter is the start of a new biome.
   * @remarks
   * By using function overrides, this should happen if and only if this phase
   * is exactly a `NewBiomeEncounterPhase` or an `EncounterPhase` (to account for
   * Wave 1 of a Daily Run), but NOT `NextEncounterPhase` (which starts the next
   * wave in the same biome).
   */
  protected trySetWeatherIfNewBiome(): void {
    globalScene.arena.setBiomeWeather();
  }

  /**
   * Set biome terrain if and only if this encounter is the start of a new biome.
   * @remarks
   * By using function overrides, this should happen if and only if this phase
   * is exactly a `NewBiomeEncounterPhase` or an `EncounterPhase` (to account for
   * Wave 1 of a Daily Run), but NOT `NextEncounterPhase` (which starts the next
   * wave in the same biome).
   */
  protected trySetTerrainIfNewBiome(): void {
    globalScene.arena.setBiomeTerrain();
  }
}
