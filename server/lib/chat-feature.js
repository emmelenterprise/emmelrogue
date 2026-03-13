const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load pokemon data for budget validation
const pokemonData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'pokemon-data.json'), 'utf-8')
);

// Load default config
const defaultConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'chat-config.json'), 'utf-8')
);

// --- Constants ---
const RIVAL_WAVES = [8, 25, 55, 95, 145, 195];
const EVIL_WAVES = [35, 62, 64, 66, 112, 114, 115, 165];
const E4_WAVES = [182, 184, 186, 188];
const CHAMPION_WAVE = 190;
const GYM_WAVES = [30, 60, 90, 120, 150, 180];

// --- Session Storage ---
const gameSessions = new Map();

// --- Session Code ---
function generateSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while ([...gameSessions.values()].some(s => s.code === code));
  return code;
}

function findSessionByCode(code) {
  if (!code) return null;
  code = code.toUpperCase();
  for (const [, session] of gameSessions) {
    if ((session.code === code || session.raceCode === code) && session.status === 'active') return session;
  }
  return null;
}

// --- Trainer Categorization ---
function categorizeTrainer(waveIndex, isFixed, isBoss, isCustomInserted) {
  if (isCustomInserted) return 'custom';
  if (RIVAL_WAVES.includes(waveIndex)) return 'rival';
  if (E4_WAVES.includes(waveIndex)) return 'elite_four';
  if (waveIndex === CHAMPION_WAVE) return 'champion';
  if (EVIL_WAVES.includes(waveIndex)) return 'evil_team';
  if (GYM_WAVES.includes(waveIndex) && isBoss) return 'gym_leader';
  if (isBoss) return 'boss';
  return 'normal';
}

// --- Budget ---
function getCustomBudget(wave) {
  if (wave <= 20) return 6;
  if (wave <= 50) return 10;
  if (wave <= 100) return 15;
  if (wave <= 150) return 20;
  return 25;
}

function getCustomPartySize(budget) {
  return Math.min(6, Math.ceil(budget / 4));
}

function validateBudget(originalBudget, newParty) {
  if (!newParty || !newParty.length) return false;
  let totalCost = 0;
  for (const p of newParty) {
    const data = pokemonData[String(p.speciesId)];
    if (!data) return false;
    totalCost += data.cost;
  }
  return totalCost <= originalBudget;
}

function calculateTeamBudget(party) {
  let total = 0;
  for (const p of party) {
    const data = pokemonData[String(p.speciesId)];
    if (data) total += data.cost;
  }
  return total;
}

// Streamer IDs that bypass all trigger checks
const STREAMER_IDS = ['647322993']; // janemmel

// --- Trigger Validation ---
function canClaim(session, twitchUserId, category) {
  // Streamer bypasses all triggers
  if (STREAMER_IDS.includes(twitchUserId)) return { allowed: true };

  const config = session.config;
  const trigger = config.categoryTriggers[category];
  if (!trigger) return { allowed: false, reason: 'Unbekannte Kategorie' };

  if (trigger.type === 'free') return { allowed: true };

  const credits = session.triggerCredits.get(twitchUserId);
  if (!credits) return { allowed: false, reason: `Erfordert: ${formatTrigger(trigger)}` };

  switch (trigger.type) {
    case 'bits':
      if ((credits.bits || 0) >= trigger.amount) return { allowed: true };
      return { allowed: false, reason: `${trigger.amount} Bits benötigt (du hast: ${credits.bits || 0})` };
    case 'sub_t1':
      if ((credits.subTier || 0) >= 1) return { allowed: true };
      return { allowed: false, reason: 'Sub Tier 1 benötigt' };
    case 'sub_t2':
      if ((credits.subTier || 0) >= 2) return { allowed: true };
      return { allowed: false, reason: 'Sub Tier 2 benötigt' };
    case 'sub_t3':
      if ((credits.subTier || 0) >= 3) return { allowed: true };
      return { allowed: false, reason: 'Sub Tier 3 benötigt' };
    case 'channel_points':
      if ((credits.channelPoints || 0) >= trigger.amount) return { allowed: true };
      return { allowed: false, reason: `${trigger.amount} Kanalpunkte benötigt (du hast: ${credits.channelPoints || 0})` };
    case 'sub_bomb':
      if ((credits.giftedSubs || 0) >= trigger.amount) return { allowed: true };
      return { allowed: false, reason: `${trigger.amount} Gift-Subs benötigt` };
    default:
      return { allowed: false, reason: 'Unbekannter Trigger-Typ' };
  }
}

// Deduct credits after a successful claim
function deductCredits(session, twitchUserId, category) {
  if (STREAMER_IDS.includes(twitchUserId)) return; // Streamer doesn't pay
  const trigger = session.config.categoryTriggers[category];
  if (!trigger || trigger.type === 'free') return;
  const credits = session.triggerCredits.get(twitchUserId);
  if (!credits) return;
  switch (trigger.type) {
    case 'bits':
      credits.bits = Math.max(0, (credits.bits || 0) - trigger.amount);
      break;
    case 'channel_points':
      credits.channelPoints = Math.max(0, (credits.channelPoints || 0) - trigger.amount);
      break;
    case 'sub_bomb':
      credits.giftedSubs = Math.max(0, (credits.giftedSubs || 0) - trigger.amount);
      break;
    // sub_t1/t2/t3: don't deduct (sub status persists)
  }
}

function formatTrigger(trigger) {
  switch (trigger.type) {
    case 'free': return 'Kostenlos';
    case 'bits': return `${trigger.amount} Bits`;
    case 'sub_t1': return 'Sub Tier 1';
    case 'sub_t2': return 'Sub Tier 2';
    case 'sub_t3': return 'Sub Tier 3';
    case 'channel_points': return `${trigger.amount} Kanalpunkte`;
    case 'sub_bomb': return `${trigger.amount} Gift-Subs`;
    default: return trigger.type;
  }
}

// --- Session Management ---
function createSession(seed, raceCode) {
  const sessionId = crypto.randomBytes(8).toString('hex');
  const code = generateSessionCode();
  const session = {
    sessionId,
    code,
    seed,
    raceCode: raceCode || null,
    status: 'active',
    currentWave: 0,
    currentBiome: '',
    hostSocketId: null,

    trainers: new Map(),
    trainerClaims: new Map(),
    pokemonClaims: new Map(),
    triggerCredits: new Map(),

    // Streamer's current party (reported by game client)
    streamerParty: [],

    activeVote: null,
    activeGimmicks: [],

    nuzlockeCatch: false,

    config: JSON.parse(JSON.stringify(defaultConfig)),
    createdAt: Date.now(),
  };

  gameSessions.set(sessionId, session);
  console.log(`[Chat] Session created: ${sessionId} code=${code} (seed: ${seed}, race: ${raceCode || 'solo'})`);
  return sessionId;
}

function destroySession(sessionId) {
  const session = gameSessions.get(sessionId);
  if (session) {
    // Clear any vote timer
    if (session.activeVote?.timer) {
      clearTimeout(session.activeVote.timer);
    }
    gameSessions.delete(sessionId);
    console.log(`[Chat] Session destroyed: ${sessionId}`);
  }
}

function getSession(sessionId) {
  return gameSessions.get(sessionId) || null;
}

function getActiveSession() {
  for (const [, session] of gameSessions) {
    if (session.status === 'active') return session;
  }
  return null;
}

function getAllSessions() {
  const result = [];
  for (const [, session] of gameSessions) {
    result.push({
      sessionId: session.sessionId,
      code: session.code,
      seed: session.seed,
      raceCode: session.raceCode,
      status: session.status,
      currentWave: session.currentWave,
      currentBiome: session.currentBiome,
      trainerCount: session.trainers.size,
      claimCount: [...session.trainerClaims.values()].reduce((sum, arr) => sum + arr.length, 0),
      streamerParty: session.streamerParty || [],
      nuzlockeCatch: session.nuzlockeCatch || false,
      createdAt: session.createdAt,
    });
  }
  // Sort by createdAt descending so the most recent session is first
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

// --- Streamer Party ---
function updateStreamerParty(sessionId, party) {
  const session = gameSessions.get(sessionId);
  if (!session) return;
  session.streamerParty = party;
}

// --- Trainer Registration ---
function registerTrainer(sessionId, trainerData) {
  const session = gameSessions.get(sessionId);
  if (!session) return null;

  const { waveIndex, trainerType, trainerClass, spriteKey, variant, isFixed, isBoss, biome, originalParty } = trainerData;

  const category = categorizeTrainer(waveIndex, isFixed, isBoss, false);
  const calcBudget = calculateTeamBudget(originalParty || []);
  // Use wave-based budget as fallback when originalParty is empty (pre-registered trainers)
  const budget = calcBudget > 0 ? calcBudget : getCustomBudget(waveIndex);
  const trigger = session.config.categoryTriggers[category] || { type: 'free', amount: 0 };

  // Preserve claim data if trainer already exists (from prescan)
  const existing = session.trainers.get(waveIndex);

  const entry = {
    waveIndex,
    trainerType: trainerType ?? -1,
    trainerClass: trainerClass || (existing ? existing.trainerClass : ''),
    spriteKey: spriteKey || '',
    variant: variant ?? 0,
    isFixed: !!isFixed,
    isBoss: !!isBoss,
    isCustomInserted: false,
    biome: biome || '',
    category,
    originalParty: originalParty || [],
    budget,
    claimedBy: existing ? existing.claimedBy : null,
    claimedByName: existing ? existing.claimedByName : null,
    customSprite: existing ? existing.customSprite : null,
    customParty: existing ? existing.customParty : null,
    pokemonNicknames: existing ? existing.pokemonNicknames : {},
    anonymous: existing ? existing.anonymous : false,
    triggerType: trigger.type,
    triggerAmount: trigger.amount,
  };

  session.trainers.set(waveIndex, entry);
  console.log(`[Chat] Trainer registered: wave ${waveIndex} (${category}, ${trainerClass}, budget: ${budget})`);
  return entry;
}

function registerTrainerBatch(sessionId, trainers) {
  const results = [];
  for (const t of trainers) {
    const entry = registerTrainer(sessionId, t);
    if (entry) results.push(entry);
  }
  return results;
}

// --- Claiming ---

// Find next available unclaimed trainer wave after startWave
function findNextAvailableWave(session, startWave) {
  const buffer = session.config.waveBuffer || 2;
  const minWave = session.currentWave + buffer + 1;
  const candidates = [];
  for (const [wave, trainer] of session.trainers) {
    if (wave > startWave && wave >= minWave && !trainer.claimedBy && !trainer.isCustomInserted) {
      candidates.push(wave);
    }
  }
  candidates.sort((a, b) => a - b);
  return candidates.length > 0 ? candidates[0] : null;
}

function claimTrainer(sessionId, waveIndex, twitchUserId, displayName, anonymous, spriteKey) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };
  if (session.status !== 'active') return { success: false, error: 'Session nicht aktiv' };

  // Nuzlocke catch protection: X1 waves (first encounter per biome) must stay wild
  if (session.nuzlockeCatch && waveIndex % 10 === 1) {
    return { success: false, error: 'Nuzlocke: Welle X1 ist für den ersten Fang reserviert!' };
  }

  let trainer = session.trainers.get(waveIndex);
  if (!trainer) return { success: false, error: 'Kein Trainer bei dieser Welle' };

  // Wave buffer check — if too close/passed, try to find next available slot
  if (waveIndex <= session.currentWave + session.config.waveBuffer || trainer.claimedBy) {
    const fallbackWave = findNextAvailableWave(session, waveIndex);
    if (!fallbackWave) {
      return { success: false, error: 'Keine freien Trainer-Slots mehr verfügbar' };
    }
    waveIndex = fallbackWave;
    trainer = session.trainers.get(waveIndex);
    if (!trainer) return { success: false, error: 'Interner Fehler' };
  }

  // Double-check: already claimed (after fallback)
  if (trainer.claimedBy) {
    return { success: false, error: `Bereits geclaimed von ${trainer.claimedByName}` };
  }

  // Claim limit check
  if (session.config.claimMode !== 'free_for_all') {
    const userClaims = session.trainerClaims.get(twitchUserId) || [];
    const maxClaims = session.config.claimMode === 'one_per_person' ? 1 : (session.config.maxClaimsPerPerson || 1);
    if (userClaims.length >= maxClaims) {
      const waves = userClaims.map(c => c.waveIndex).join(', ');
      return { success: false, error: maxClaims === 1
        ? `Du hast bereits Welle ${waves} geclaimed`
        : `Limit erreicht (${userClaims.length}/${maxClaims}) — Wellen: ${waves}` };
    }
  }

  // Trigger check
  const triggerResult = canClaim(session, twitchUserId, trainer.category);
  if (!triggerResult.allowed) {
    return { success: false, error: triggerResult.reason };
  }

  // Claim it — deduct credits
  deductCredits(session, twitchUserId, trainer.category);

  trainer.claimedBy = twitchUserId;
  trainer.claimedByName = displayName;
  trainer.anonymous = !!anonymous;
  trainer.customSprite = spriteKey || 'youngster'; // Default to youngster if no sprite selected

  // Set original party as default custom party (user can modify later)
  if (trainer.originalParty && trainer.originalParty.length > 0 && !trainer.customParty) {
    trainer.customParty = trainer.originalParty.map(p => ({
      speciesId: p.speciesId,
      name: pokemonData[String(p.speciesId)]?.name_de || pokemonData[String(p.speciesId)]?.name || p.name || 'Unknown',
      cost: pokemonData[String(p.speciesId)]?.cost || p.cost || 0,
      shiny: false,
      nickname: null,
      nicknameBy: null,
    }));
  }

  const userClaims = session.trainerClaims.get(twitchUserId) || [];
  userClaims.push({ waveIndex, displayName, claimedAt: Date.now() });
  session.trainerClaims.set(twitchUserId, userClaims);

  console.log(`[Chat] Trainer wave ${waveIndex} claimed by ${displayName} (${twitchUserId})`);
  return { success: true, trainer, waveIndex };
}

function unclaimTrainer(sessionId, waveIndex) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };

  const trainer = session.trainers.get(waveIndex);
  if (!trainer) return { success: false, error: 'Kein Trainer bei dieser Welle' };

  const oldClaimer = trainer.claimedBy;
  trainer.claimedBy = null;
  trainer.claimedByName = null;
  trainer.customSprite = null;
  trainer.customParty = null;
  trainer.pokemonNicknames = {};

  // Remove from claims array
  if (oldClaimer) {
    const userClaims = session.trainerClaims.get(oldClaimer) || [];
    const filtered = userClaims.filter(c => c.waveIndex !== waveIndex);
    if (filtered.length > 0) {
      session.trainerClaims.set(oldClaimer, filtered);
    } else {
      session.trainerClaims.delete(oldClaimer);
    }
  }

  // Remove pokemon claims for this wave
  for (const [key, claim] of session.pokemonClaims.entries()) {
    if (claim.waveIndex === waveIndex) {
      session.pokemonClaims.delete(key);
    }
  }

  console.log(`[Chat] Trainer wave ${waveIndex} unclaimed (admin)`);
  return { success: true, trainer };
}

function editTeam(sessionId, waveIndex, twitchUserId, newParty) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };

  const trainer = session.trainers.get(waveIndex);
  if (!trainer) return { success: false, error: 'Kein Trainer bei dieser Welle' };

  if (trainer.claimedBy !== twitchUserId) {
    return { success: false, error: 'Nicht dein Trainer' };
  }

  if (waveIndex <= session.currentWave + session.config.waveBuffer) {
    return { success: false, error: 'Zu nah! Kann nicht mehr bearbeitet werden' };
  }

  // Validate party size
  const expectedSize = trainer.originalParty?.length || getCustomPartySize(trainer.budget || getCustomBudget(waveIndex));
  if (newParty.length < 1 || newParty.length > expectedSize) {
    return { success: false, error: `Team muss 1-${expectedSize} Pokemon haben` };
  }

  // Validate all species exist
  for (const p of newParty) {
    if (!pokemonData[String(p.speciesId)]) {
      return { success: false, error: `Unbekanntes Pokemon: ID ${p.speciesId}` };
    }
  }

  // Validate budget
  if (!validateBudget(trainer.budget, newParty)) {
    const totalCost = newParty.reduce((sum, p) => sum + (pokemonData[String(p.speciesId)]?.cost || 0), 0);
    return { success: false, error: `Budget überschritten: ${totalCost}/${trainer.budget}` };
  }

  // Validate shiny
  if (!session.config.allowShiny) {
    const hasShiny = newParty.some(p => p.shiny);
    if (hasShiny) {
      return { success: false, error: 'Shiny Pokemon sind nicht erlaubt' };
    }
  }

  trainer.customParty = newParty.map(p => ({
    speciesId: p.speciesId,
    name: pokemonData[String(p.speciesId)]?.name_de || pokemonData[String(p.speciesId)]?.name || 'Unknown',
    cost: pokemonData[String(p.speciesId)]?.cost || 0,
    shiny: !!p.shiny,
    nickname: p.nickname || null,
    nicknameBy: p.nickname ? twitchUserId : null,
  }));

  console.log(`[Chat] Team edited for wave ${waveIndex} by ${twitchUserId}`);
  return { success: true, customParty: trainer.customParty };
}

function changeSprite(sessionId, waveIndex, twitchUserId, spriteKey) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };

  const trainer = session.trainers.get(waveIndex);
  if (!trainer) return { success: false, error: 'Kein Trainer bei dieser Welle' };

  if (trainer.claimedBy !== twitchUserId) {
    return { success: false, error: 'Nicht dein Trainer' };
  }

  if (waveIndex <= session.currentWave + session.config.waveBuffer) {
    return { success: false, error: 'Zu nah! Kann nicht mehr bearbeitet werden' };
  }

  trainer.customSprite = spriteKey;
  console.log(`[Chat] Sprite changed for wave ${waveIndex}: ${spriteKey}`);
  return { success: true, spriteKey };
}

function toggleAnonymous(sessionId, waveIndex, twitchUserId, anonymous) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };

  const trainer = session.trainers.get(waveIndex);
  if (!trainer) return { success: false, error: 'Kein Trainer bei dieser Welle' };

  if (trainer.claimedBy !== twitchUserId) {
    return { success: false, error: 'Nicht dein Trainer' };
  }

  trainer.anonymous = !!anonymous;
  console.log(`[Chat] Anonymous toggled for wave ${waveIndex}: ${trainer.anonymous}`);
  return { success: true, anonymous: trainer.anonymous };
}

function claimPokemon(sessionId, waveIndex, slot, twitchUserId, displayName) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };

  const trainer = session.trainers.get(waveIndex);
  if (!trainer) return { success: false, error: 'Kein Trainer bei dieser Welle' };

  if (waveIndex <= session.currentWave + session.config.waveBuffer) {
    return { success: false, error: 'Zu nah!' };
  }

  const party = trainer.customParty || trainer.originalParty;
  if (slot < 0 || slot >= party.length) {
    return { success: false, error: 'Ungültiger Slot' };
  }

  // Check if already claimed
  const key = `${waveIndex}:${slot}`;
  if (session.pokemonClaims.has(key)) {
    const existing = session.pokemonClaims.get(key);
    return { success: false, error: `Bereits geclaimed von ${existing.displayName}` };
  }

  // Set nickname
  trainer.pokemonNicknames[slot] = displayName;
  session.pokemonClaims.set(key, {
    waveIndex,
    partySlot: slot,
    displayName,
    twitchUserId,
    claimedAt: Date.now(),
  });

  console.log(`[Chat] Pokemon claimed: wave ${waveIndex} slot ${slot} by ${displayName}`);
  return { success: true, nickname: displayName, slot };
}

// --- Custom Trainer (Wild → Trainer) ---
function insertCustomTrainer(sessionId, waveIndex, twitchUserId, displayName, spriteKey, party, anonymous) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };

  if (!session.config.allowCustomTrainers) {
    return { success: false, error: 'Custom Trainer sind deaktiviert' };
  }

  // Nuzlocke catch protection: X1 waves must stay wild
  if (session.nuzlockeCatch && waveIndex % 10 === 1) {
    return { success: false, error: 'Nuzlocke: Welle X1 ist für den ersten Fang reserviert!' };
  }

  if (waveIndex <= session.currentWave + session.config.waveBuffer) {
    return { success: false, error: 'Zu nah!' };
  }

  // Check if wave already has a trainer
  if (session.trainers.has(waveIndex)) {
    return { success: false, error: 'Diese Welle hat bereits einen Trainer' };
  }

  // Trigger check for custom category
  const triggerResult = canClaim(session, twitchUserId, 'custom');
  if (!triggerResult.allowed) {
    return { success: false, error: triggerResult.reason };
  }

  // Claim limit check
  if (session.config.claimMode !== 'free_for_all') {
    const userClaims = session.trainerClaims.get(twitchUserId) || [];
    const maxClaims = session.config.claimMode === 'one_per_person' ? 1 : (session.config.maxClaimsPerPerson || 1);
    if (userClaims.length >= maxClaims) {
      const waves = userClaims.map(c => c.waveIndex).join(', ');
      return { success: false, error: maxClaims === 1
        ? `Du hast bereits Welle ${waves} geclaimed`
        : `Limit erreicht (${userClaims.length}/${maxClaims}) — Wellen: ${waves}` };
    }
  }

  const budget = getCustomBudget(waveIndex);
  const maxPartySize = getCustomPartySize(budget);

  if (party.length > maxPartySize) {
    return { success: false, error: `Maximal ${maxPartySize} Pokemon für diese Welle` };
  }

  if (!validateBudget(budget, party)) {
    const totalCost = party.reduce((sum, p) => sum + (pokemonData[String(p.speciesId)]?.cost || 0), 0);
    return { success: false, error: `Budget überschritten: ${totalCost}/${budget}` };
  }

  const trigger = session.config.categoryTriggers['custom'] || { type: 'free', amount: 0 };

  const entry = {
    waveIndex,
    trainerType: -1,
    trainerClass: 'Custom',
    spriteKey: spriteKey || '',
    variant: 0,
    isFixed: false,
    isBoss: false,
    isCustomInserted: true,
    biome: session.currentBiome,
    category: 'custom',
    originalParty: party.map(p => ({
      speciesId: p.speciesId,
      name: pokemonData[String(p.speciesId)]?.name_de || pokemonData[String(p.speciesId)]?.name || 'Unknown',
      level: 0,
      cost: pokemonData[String(p.speciesId)]?.cost || 0,
    })),
    budget,
    claimedBy: twitchUserId,
    claimedByName: displayName,
    customSprite: spriteKey || null,
    customParty: party.map(p => ({
      speciesId: p.speciesId,
      name: pokemonData[String(p.speciesId)]?.name_de || pokemonData[String(p.speciesId)]?.name || 'Unknown',
      cost: pokemonData[String(p.speciesId)]?.cost || 0,
      shiny: !!p.shiny && session.config.allowShiny,
      nickname: p.nickname || null,
      nicknameBy: p.nickname ? twitchUserId : null,
    })),
    pokemonNicknames: {},
    anonymous: !!anonymous,
    triggerType: trigger.type,
    triggerAmount: trigger.amount,
  };

  session.trainers.set(waveIndex, entry);
  const userClaims = session.trainerClaims.get(twitchUserId) || [];
  userClaims.push({ waveIndex, displayName, claimedAt: Date.now() });
  session.trainerClaims.set(twitchUserId, userClaims);

  console.log(`[Chat] Custom trainer inserted at wave ${waveIndex} by ${displayName}`);
  return { success: true, trainer: entry };
}

// --- Visible Trainers (filtered by waveBuffer) ---
function getVisibleTrainers(sessionId) {
  const session = gameSessions.get(sessionId);
  if (!session) return [];

  const result = [];
  for (const [wave, trainer] of session.trainers) {
    result.push({
      waveIndex: wave,
      trainerClass: trainer.trainerClass,
      spriteKey: trainer.customSprite || trainer.spriteKey,
      category: trainer.category,
      isCustomInserted: trainer.isCustomInserted,
      isBoss: trainer.isBoss,
      biome: trainer.biome,
      budget: trainer.budget,
      originalParty: trainer.originalParty,
      customParty: trainer.customParty,
      pokemonNicknames: trainer.pokemonNicknames,
      claimedBy: trainer.claimedBy,
      claimedByName: trainer.anonymous ? '???' : trainer.claimedByName,
      anonymous: trainer.anonymous,
      triggerType: trainer.triggerType,
      triggerAmount: trainer.triggerAmount,
      locked: wave <= session.currentWave + session.config.waveBuffer,
      passed: wave <= session.currentWave,
    });
  }

  // Sort by wave
  result.sort((a, b) => a.waveIndex - b.waveIndex);
  return result;
}

// --- Customization for Game Client ---
function getAllCustomizations(sessionId) {
  const session = gameSessions.get(sessionId);
  if (!session) return [];
  const results = [];
  for (const [wave, trainer] of session.trainers) {
    if (trainer.claimedBy || trainer.isCustomInserted) {
      results.push({
        waveIndex: wave,
        trainerName: trainer.claimedByName,
        spriteKey: trainer.customSprite,
        trainerClass: trainer.trainerClass,
        customParty: trainer.customParty,
        pokemonNicknames: trainer.pokemonNicknames,
        isCustomInserted: trainer.isCustomInserted,
      });
    }
  }
  return results;
}

function getCustomization(sessionId, waveIndex) {
  const session = gameSessions.get(sessionId);
  if (!session) return null;

  const trainer = session.trainers.get(waveIndex);
  if (!trainer) return null;

  // Only return customizations if the trainer is claimed
  if (!trainer.claimedBy && !trainer.isCustomInserted) return null;

  return {
    waveIndex,
    trainerName: trainer.claimedByName,
    spriteKey: trainer.customSprite,
    trainerClass: trainer.trainerClass,
    customParty: trainer.customParty,
    pokemonNicknames: trainer.pokemonNicknames,
    isCustomInserted: trainer.isCustomInserted,
  };
}

// --- Nuzlocke ---
function setNuzlockeCatch(sessionId, enabled) {
  const session = gameSessions.get(sessionId);
  if (!session) return;
  session.nuzlockeCatch = !!enabled;
  console.log(`[Chat] Nuzlocke catch set to ${session.nuzlockeCatch} for session ${sessionId}`);
}

// --- Wave/Biome Updates ---
function updateWave(sessionId, wave, biome) {
  const session = gameSessions.get(sessionId);
  if (!session) return;
  session.currentWave = wave;
  if (biome) session.currentBiome = biome;

  // Decrement gimmick durations
  session.activeGimmicks = session.activeGimmicks.filter(g => {
    g.remainingWaves--;
    return g.remainingWaves > 0;
  });
}

// --- Trigger Credits ---
function addTriggerCredits(sessionId, twitchUserId, displayName, type, amount) {
  const session = gameSessions.get(sessionId);
  if (!session) return;

  if (!session.triggerCredits.has(twitchUserId)) {
    session.triggerCredits.set(twitchUserId, {
      displayName,
      bits: 0,
      subTier: 0,
      channelPoints: 0,
      giftedSubs: 0,
    });
  }

  const credits = session.triggerCredits.get(twitchUserId);
  credits.displayName = displayName;

  switch (type) {
    case 'bits':
      credits.bits = (credits.bits || 0) + amount;
      break;
    case 'sub':
      credits.subTier = Math.max(credits.subTier || 0, amount);
      break;
    case 'channel_points':
      credits.channelPoints = (credits.channelPoints || 0) + amount;
      break;
    case 'gift_sub':
      credits.giftedSubs = (credits.giftedSubs || 0) + amount;
      break;
  }

  console.log(`[Chat] Trigger credit: ${displayName} +${amount} ${type}`);
}

// --- Voting ---
function startVote(sessionId, options, durationSec, io) {
  const session = gameSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session nicht gefunden' };
  if (session.activeVote) return { success: false, error: 'Abstimmung läuft bereits' };

  const tallies = {};
  for (const opt of options) {
    tallies[opt.id] = 0;
  }

  session.activeVote = {
    options,
    tallies,
    voters: new Set(),
    startedAt: Date.now(),
    expiresAt: Date.now() + durationSec * 1000,
    timer: setTimeout(() => {
      endVote(sessionId, io);
    }, durationSec * 1000),
  };

  console.log(`[Chat] Vote started: ${options.map(o => o.label).join(' vs ')}`);
  return { success: true, vote: getVoteState(session) };
}

function castVote(sessionId, twitchUserId, optionId) {
  const session = gameSessions.get(sessionId);
  if (!session || !session.activeVote) return { success: false, error: 'Keine Abstimmung aktiv' };

  if (session.activeVote.voters.has(twitchUserId)) {
    return { success: false, error: 'Du hast bereits abgestimmt' };
  }

  if (!(optionId in session.activeVote.tallies)) {
    return { success: false, error: 'Unbekannte Option' };
  }

  session.activeVote.tallies[optionId]++;
  session.activeVote.voters.add(twitchUserId);

  return { success: true, tallies: { ...session.activeVote.tallies } };
}

function endVote(sessionId, io) {
  const session = gameSessions.get(sessionId);
  if (!session || !session.activeVote) return null;

  if (session.activeVote.timer) {
    clearTimeout(session.activeVote.timer);
  }

  const vote = session.activeVote;
  session.activeVote = null;

  // Find winner
  let maxVotes = 0;
  let winnerId = null;
  for (const [id, count] of Object.entries(vote.tallies)) {
    if (count > maxVotes) {
      maxVotes = count;
      winnerId = id;
    }
  }

  const winner = vote.options.find(o => o.id === winnerId);
  const result = {
    winner: winner || null,
    tallies: vote.tallies,
    totalVoters: vote.voters.size,
  };

  // Activate gimmick if vote has a winner
  if (winner && maxVotes > 0) {
    const duration = session.config.gimmickDurations?.[winner.id] || 10;
    activateGimmick(sessionId, winner.id, winner.label, duration);
  }

  // Broadcast result
  if (io) {
    io.to(`chat:${sessionId}`).emit('CHAT_VOTE_RESULT', result);
  }

  console.log(`[Chat] Vote ended: winner=${winner?.label || 'none'} (${maxVotes} votes)`);
  return result;
}

function getVoteState(session) {
  if (!session.activeVote) return null;
  return {
    options: session.activeVote.options,
    tallies: session.activeVote.tallies,
    timeLeft: Math.max(0, Math.ceil((session.activeVote.expiresAt - Date.now()) / 1000)),
    totalVoters: session.activeVote.voters.size,
  };
}

// --- Gimmicks ---
function activateGimmick(sessionId, gimmickId, label, durationWaves) {
  const session = gameSessions.get(sessionId);
  if (!session) return;

  // Remove existing gimmick of same type
  session.activeGimmicks = session.activeGimmicks.filter(g => g.id !== gimmickId);

  session.activeGimmicks.push({
    id: gimmickId,
    label,
    remainingWaves: durationWaves,
    activatedAt: Date.now(),
  });

  console.log(`[Chat] Gimmick activated: ${label} (${durationWaves} waves)`);
}

function getActiveGimmicks(sessionId) {
  const session = gameSessions.get(sessionId);
  if (!session) return [];
  return session.activeGimmicks.map(g => ({
    id: g.id,
    label: g.label,
    remainingWaves: g.remainingWaves,
  }));
}

// --- Config ---
const configFilePath = path.join(__dirname, '..', 'data', 'chat-config.json');

function persistDefaultConfig(config) {
  try {
    const toSave = JSON.parse(JSON.stringify(config));
    fs.writeFileSync(configFilePath, JSON.stringify(toSave, null, 2), 'utf-8');
    // Reload defaultConfig so new sessions pick up the changes
    Object.assign(defaultConfig, toSave);
    console.log('[Chat] Default config persisted to disk');
  } catch (err) {
    console.error('[Chat] Failed to persist config:', err.message);
  }
}

function updateConfig(sessionId, patch) {
  const session = gameSessions.get(sessionId);
  if (!session) return null;

  // Merge patch into config
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'categoryTriggers' && typeof value === 'object') {
      Object.assign(session.config.categoryTriggers, value);
    } else if (key === 'gimmickTriggers' && typeof value === 'object') {
      Object.assign(session.config.gimmickTriggers, value);
    } else if (key === 'gimmickDurations' && typeof value === 'object') {
      Object.assign(session.config.gimmickDurations, value);
    } else if (key in session.config) {
      session.config[key] = value;
    }
  }

  // Persist to disk so future sessions use these settings
  persistDefaultConfig(session.config);

  console.log(`[Chat] Config updated & persisted: ${Object.keys(patch).join(', ')}`);
  return session.config;
}

// --- Cleanup ---
function cleanupStaleSessions() {
  const now = Date.now();
  for (const [id, session] of gameSessions) {
    // Remove sessions older than 6 hours
    if (now - session.createdAt > 6 * 60 * 60 * 1000) {
      gameSessions.delete(id);
      console.log(`[Chat] Session ${id} cleaned up (stale)`);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleSessions, 5 * 60 * 1000);

module.exports = {
  // Session
  createSession,
  destroySession,
  getSession,
  getActiveSession,
  getAllSessions,

  // Trainers
  registerTrainer,
  registerTrainerBatch,
  insertCustomTrainer,

  // Claims
  claimTrainer,
  unclaimTrainer,
  editTeam,
  changeSprite,
  claimPokemon,

  // Data
  getVisibleTrainers,
  getCustomization,
  toggleAnonymous,
  getAllCustomizations,
  updateWave,
  addTriggerCredits,

  // Voting
  startVote,
  castVote,
  endVote,

  // Gimmicks
  activateGimmick,
  getActiveGimmicks,

  // Config
  updateConfig,
  getVoteState,

  // Streamer Party
  updateStreamerParty,

  // Nuzlocke
  setNuzlockeCatch,

  // Session Code
  findSessionByCode,

  // Helpers
  categorizeTrainer,
  validateBudget,
  getCustomBudget,
  getCustomPartySize,
  formatTrigger,
  pokemonData,
};
