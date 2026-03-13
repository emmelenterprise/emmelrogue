const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load pokemon data (shared with chat-feature)
const pokemonData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'pokemon-data.json'), 'utf-8')
);

// --- Constants ---
const STREAMER_ID = '647322993';

const DEFAULT_CONFIG = {
  bossBudget: 18,
  budgetByRole: {
    everyone: 10,
    follower: 11,
    sub1: 13,
    sub2: 15,
    sub3: 18,
    vip: 14,
    mod: 16,
  },
  // Uses pokemon-data.json cost field directly (1-10 scale from PokéRogue)
  maxPokemonByRole: {
    everyone: 3,
    follower: 3,
    sub1: 4,
    sub2: 5,
    sub3: 6,
    vip: 4,
    mod: 6,
  },
  maxQueueLength: 20,
  afkTimeout: 120,
  queuePermission: 'everyone',
  allowRejoinAfterSkip: true,
  wordFilterBlacklist: [],
  bossEggMoves: true,
  challengerEggMoves: 'none', // 'none' | 'all' | 'cost'
  eggMoveCost: 3,
};

// Role hierarchy for permission checks
const ROLE_HIERARCHY = ['everyone', 'follower', 'sub1', 'sub2', 'sub3', 'vip', 'mod'];

// --- State ---
let gymSession = null;
const badges = new Map(); // persists across sessions within process
const knownRoles = new Map(); // twitchId -> role (from chat commands)

// --- Helpers ---
function getPokemonCost(speciesId) {
  const data = pokemonData[String(speciesId)];
  if (!data) return 999;
  return data.cost || 5;
}

function calculateTeamCost(team) {
  let total = 0;
  for (const p of team) {
    total += getPokemonCost(p.speciesId);
  }
  return total;
}

function getRoleBudget(role, config) {
  return config.budgetByRole[role] || config.budgetByRole.everyone || 10;
}

function getRoleMaxPokemon(role, config) {
  if (!config.maxPokemonByRole) return 6;
  return config.maxPokemonByRole[role] || config.maxPokemonByRole.everyone || 3;
}

function checkRolePermission(userRole, requiredRole) {
  const userIdx = ROLE_HIERARCHY.indexOf(userRole);
  const reqIdx = ROLE_HIERARCHY.indexOf(requiredRole);
  if (userIdx === -1 || reqIdx === -1) return userRole === 'everyone' || reqIdx === 0;
  return userIdx >= reqIdx;
}

function filterText(text, blacklist) {
  if (!text || !blacklist || !blacklist.length) return text;
  let filtered = text;
  for (const word of blacklist) {
    if (!word) continue;
    const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    filtered = filtered.replace(regex, '***');
  }
  return filtered;
}

function filterTrainerLines(lines, blacklist) {
  if (!lines) return { intro: '', defeat: '', victory: '' };
  return {
    intro: filterText((lines.intro || '').slice(0, 100), blacklist),
    defeat: filterText((lines.defeat || '').slice(0, 100), blacklist),
    victory: filterText((lines.victory || '').slice(0, 100), blacklist),
  };
}

// --- Session Management ---
function createSession() {
  if (gymSession && gymSession.status === 'active') {
    return { success: false, error: 'Session laeuft bereits' };
  }

  const id = crypto.randomBytes(8).toString('hex');
  gymSession = {
    id,
    status: 'active',
    createdAt: Date.now(),
    bossTeam: [],
    bossBudget: 0,
    bossSprite: 'gym_leader_brock',
    activeBossPreset: 0, // which of the 3 presets is active
    bossTeamPresets: [
      { name: 'Team 1', team: [], spriteKey: 'gym_leader_brock' },
      { name: 'Team 2', team: [], spriteKey: 'gym_leader_brock' },
      { name: 'Team 3', team: [], spriteKey: 'gym_leader_brock' },
    ],
    queue: [],
    currentChallenger: null,
    currentChallengerSince: null,
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    matchHistory: [],
    kickedUsers: new Set(),
  };

  console.log(`[Gym] Session created: ${id}`);
  return { success: true, session: gymSession };
}

function endSession() {
  if (!gymSession) return;
  console.log(`[Gym] Session ended: ${gymSession.id}`);
  gymSession.status = 'ended';
  gymSession = null;
}

function getSession() {
  return gymSession;
}

function getState() {
  if (!gymSession) return { active: false };
  return {
    active: true,
    id: gymSession.id,
    status: gymSession.status,
    bossTeam: gymSession.bossTeam,
    bossBudget: gymSession.bossBudget,
    bossSprite: gymSession.bossSprite,
    activeBossPreset: gymSession.activeBossPreset || 0,
    bossTeamPresets: gymSession.bossTeamPresets || [],
    queue: gymSession.queue.map(serializeChallenger),
    currentChallenger: gymSession.currentChallenger ? serializeChallenger(gymSession.currentChallenger) : null,
    currentChallengerSince: gymSession.currentChallengerSince,
    config: gymSession.config,
    matchHistory: gymSession.matchHistory.slice(-20),
    leaderboard: getLeaderboard().slice(0, 10),
    activeBattleId: gymSession.activeBattleId || null,
  };
}

function serializeChallenger(c) {
  return {
    twitchId: c.twitchId,
    displayName: c.displayName,
    profileImage: c.profileImage,
    team: c.team,
    teamBudget: c.teamBudget,
    trainerLines: c.trainerLines,
    spriteKey: c.spriteKey,
    joinedAt: c.joinedAt,
    twitchRole: c.twitchRole,
  };
}

// --- Boss Team ---
function buildTeamArray(team) {
  return team.map(p => {
    const entry = {
      speciesId: p.speciesId,
      name: pokemonData[String(p.speciesId)]?.name_de || pokemonData[String(p.speciesId)]?.name || 'Unknown',
      cost: getPokemonCost(p.speciesId),
    };
    if (p.formIndex) {
      entry.formIndex = p.formIndex;
      const pd = pokemonData[String(p.speciesId)];
      if (pd && pd.forms) {
        const form = pd.forms.find(f => f.formIndex === p.formIndex);
        if (form) entry.formName = form.formName;
      }
    }
    if (p.shiny) {
      entry.shiny = true;
      entry.variant = typeof p.variant === 'number' ? p.variant : 0;
    }
    return entry;
  });
}

function setBossTeam(team, spriteKey) {
  if (!gymSession) return { success: false, error: 'Keine Session aktiv' };
  if (!team || !Array.isArray(team) || team.length < 1 || team.length > 6) {
    return { success: false, error: 'Team muss 1-6 Pokemon haben' };
  }

  // Validate all species exist
  for (const p of team) {
    if (!pokemonData[String(p.speciesId)]) {
      return { success: false, error: `Unbekanntes Pokemon: ID ${p.speciesId}` };
    }
  }

  const cost = calculateTeamCost(team);
  if (cost > gymSession.config.bossBudget) {
    return { success: false, error: `Budget ueberschritten: ${cost}/${gymSession.config.bossBudget}` };
  }

  gymSession.bossTeam = buildTeamArray(team);
  gymSession.bossBudget = cost;
  if (spriteKey) gymSession.bossSprite = spriteKey;

  // Also save to current preset
  const presetIdx = gymSession.activeBossPreset || 0;
  gymSession.bossTeamPresets[presetIdx] = {
    name: gymSession.bossTeamPresets[presetIdx]?.name || `Team ${presetIdx + 1}`,
    team: gymSession.bossTeam.map(p => ({ ...p })),
    spriteKey: gymSession.bossSprite,
  };

  console.log(`[Gym] Boss team set (preset ${presetIdx + 1}): ${gymSession.bossTeam.map(p => p.name).join(', ')} (${cost}/${gymSession.config.bossBudget})`);
  return { success: true, bossTeam: gymSession.bossTeam, bossBudget: cost };
}

function saveBossPreset(presetIndex, team, spriteKey, presetName) {
  if (!gymSession) return { success: false, error: 'Keine Session aktiv' };
  if (presetIndex < 0 || presetIndex > 2) return { success: false, error: 'Preset Index 0-2' };
  if (!team || !Array.isArray(team) || team.length > 6) {
    return { success: false, error: 'Team muss 0-6 Pokemon haben' };
  }

  for (const p of team) {
    if (!pokemonData[String(p.speciesId)]) {
      return { success: false, error: `Unbekanntes Pokemon: ID ${p.speciesId}` };
    }
  }

  const builtTeam = team.length > 0 ? buildTeamArray(team) : [];
  gymSession.bossTeamPresets[presetIndex] = {
    name: presetName || `Team ${presetIndex + 1}`,
    team: builtTeam,
    spriteKey: spriteKey || 'gym_leader_brock',
  };

  console.log(`[Gym] Preset ${presetIndex + 1} saved: ${builtTeam.map(p => p.name).join(', ') || '(leer)'}`);
  return { success: true };
}

function switchBossPreset(presetIndex) {
  if (!gymSession) return { success: false, error: 'Keine Session aktiv' };
  if (presetIndex < 0 || presetIndex > 2) return { success: false, error: 'Preset Index 0-2' };

  const preset = gymSession.bossTeamPresets[presetIndex];
  if (!preset || !preset.team || preset.team.length === 0) {
    return { success: false, error: `Preset ${presetIndex + 1} ist leer` };
  }

  gymSession.activeBossPreset = presetIndex;
  gymSession.bossTeam = preset.team.map(p => ({ ...p }));
  gymSession.bossBudget = calculateTeamCost(preset.team);
  gymSession.bossSprite = preset.spriteKey || 'gym_leader_brock';

  console.log(`[Gym] Switched to preset ${presetIndex + 1}: ${gymSession.bossTeam.map(p => p.name).join(', ')}`);
  return { success: true, bossTeam: gymSession.bossTeam, bossBudget: gymSession.bossBudget };
}

// --- Queue ---
function joinQueue(twitchId, displayName, profileImage, team, trainerLines, spriteKey, twitchRole) {
  if (!gymSession) return { success: false, error: 'Keine Session aktiv' };
  if (gymSession.status !== 'active') return { success: false, error: 'Session nicht aktiv' };

  // Permission check
  const role = twitchRole || 'everyone';
  if (!checkRolePermission(role, gymSession.config.queuePermission)) {
    return { success: false, error: `Berechtigung fehlt: mindestens ${gymSession.config.queuePermission} erforderlich` };
  }

  // Check if kicked
  if (gymSession.kickedUsers.has(twitchId)) {
    return { success: false, error: 'Du wurdest aus der Queue entfernt' };
  }

  // Check if already in queue or fighting
  if (gymSession.queue.some(c => c.twitchId === twitchId)) {
    return { success: false, error: 'Du bist bereits in der Warteschlange' };
  }
  if (gymSession.currentChallenger?.twitchId === twitchId) {
    return { success: false, error: 'Du kaempfst gerade' };
  }

  // Queue full?
  if (gymSession.queue.length >= gymSession.config.maxQueueLength) {
    return { success: false, error: `Warteschlange voll (${gymSession.config.maxQueueLength})` };
  }

  // Max pokemon check
  const maxPokemon = getRoleMaxPokemon(role, gymSession.config);
  if (!team || !Array.isArray(team) || team.length < 1 || team.length > maxPokemon) {
    return { success: false, error: `Team muss 1-${maxPokemon} Pokemon haben (deine Rolle: ${role})` };
  }
  for (const p of team) {
    if (!pokemonData[String(p.speciesId)]) {
      return { success: false, error: `Unbekanntes Pokemon: ID ${p.speciesId}` };
    }
  }

  // Budget check
  const budget = getRoleBudget(role, gymSession.config);
  const cost = calculateTeamCost(team);
  // Streamer bypasses budget
  if (twitchId !== STREAMER_ID && cost > budget) {
    return { success: false, error: `Budget ueberschritten: ${cost}/${budget}` };
  }

  // Filter trainer lines
  const filtered = filterTrainerLines(trainerLines, gymSession.config.wordFilterBlacklist);

  const entry = {
    twitchId,
    displayName,
    profileImage: profileImage || '',
    team: buildTeamArray(team),
    teamBudget: cost,
    trainerLines: filtered,
    spriteKey: spriteKey || 'youngster',
    joinedAt: Date.now(),
    twitchRole: role,
  };

  // Remember role for web page budget display
  knownRoles.set(twitchId, role);

  gymSession.queue.push(entry);
  const position = gymSession.queue.length;

  console.log(`[Gym] ${displayName} joined queue (pos ${position}, team cost: ${cost}/${budget})`);

  // If no current challenger, promote immediately
  if (!gymSession.currentChallenger) {
    promoteNext();
  }

  return { success: true, position };
}

function leaveQueue(twitchId) {
  if (!gymSession) return { success: false };
  gymSession.queue = gymSession.queue.filter(c => c.twitchId !== twitchId);
  return { success: true };
}

function skipChallenger() {
  if (!gymSession || !gymSession.currentChallenger) return { success: false, error: 'Kein aktiver Herausforderer' };

  const skipped = gymSession.currentChallenger;
  gymSession.currentChallenger = null;
  gymSession.currentChallengerSince = null;

  // Record as loss
  gymSession.matchHistory.push({
    challengerId: skipped.twitchId,
    challengerName: skipped.displayName,
    result: 'skipped',
    timestamp: Date.now(),
  });

  // Allow rejoin if configured
  if (!gymSession.config.allowRejoinAfterSkip) {
    gymSession.kickedUsers.add(skipped.twitchId);
  }

  console.log(`[Gym] Skipped challenger: ${skipped.displayName}`);

  // Promote next
  promoteNext();

  return { success: true, skipped: serializeChallenger(skipped) };
}

function kickFromQueue(twitchId) {
  if (!gymSession) return { success: false };

  // Remove from queue
  const before = gymSession.queue.length;
  gymSession.queue = gymSession.queue.filter(c => c.twitchId !== twitchId);

  // Also remove if current challenger
  if (gymSession.currentChallenger?.twitchId === twitchId) {
    gymSession.currentChallenger = null;
    gymSession.currentChallengerSince = null;
    promoteNext();
  }

  gymSession.kickedUsers.add(twitchId);

  console.log(`[Gym] Kicked ${twitchId} from queue`);
  return { success: true, removed: gymSession.queue.length < before };
}

function promoteNext() {
  if (!gymSession || gymSession.currentChallenger) return null;
  if (gymSession.queue.length === 0) return null;

  gymSession.currentChallenger = gymSession.queue.shift();
  gymSession.currentChallengerSince = Date.now();

  console.log(`[Gym] Next challenger: ${gymSession.currentChallenger.displayName}`);
  return gymSession.currentChallenger;
}

// --- Badges ---
function awardBadge(twitchId, displayName) {
  const existing = badges.get(twitchId) || { displayName, count: 0, lastEarned: 0 };
  existing.displayName = displayName;
  existing.count++;
  existing.lastEarned = Date.now();
  badges.set(twitchId, existing);

  // Record match
  if (gymSession) {
    gymSession.matchHistory.push({
      challengerId: twitchId,
      challengerName: displayName,
      result: 'win',
      timestamp: Date.now(),
    });

    // Clear current challenger
    gymSession.currentChallenger = null;
    gymSession.currentChallengerSince = null;
    promoteNext();
  }

  console.log(`[Gym] Badge awarded to ${displayName} (total: ${existing.count})`);
  return { totalBadges: existing.count };
}

function recordLoss(twitchId, displayName) {
  if (gymSession) {
    gymSession.matchHistory.push({
      challengerId: twitchId,
      challengerName: displayName,
      result: 'loss',
      timestamp: Date.now(),
    });

    gymSession.currentChallenger = null;
    gymSession.currentChallengerSince = null;
    promoteNext();
  }
}

function getLeaderboard() {
  const list = [];
  for (const [twitchId, data] of badges) {
    list.push({ twitchId, ...data });
  }
  list.sort((a, b) => b.count - a.count || a.lastEarned - b.lastEarned);
  return list;
}

// --- Config ---
function updateConfig(patch) {
  if (!gymSession) return null;

  const cfg = gymSession.config;
  if (patch.bossBudget !== undefined) cfg.bossBudget = Math.max(1, Math.min(50, parseInt(patch.bossBudget) || 18));
  if (patch.budgetByRole && typeof patch.budgetByRole === 'object') {
    for (const [role, val] of Object.entries(patch.budgetByRole)) {
      if (cfg.budgetByRole[role] !== undefined) {
        cfg.budgetByRole[role] = Math.max(1, Math.min(50, parseInt(val) || 10));
      }
    }
  }
  if (patch.maxPokemonByRole && typeof patch.maxPokemonByRole === 'object') {
    if (!cfg.maxPokemonByRole) cfg.maxPokemonByRole = {};
    for (const [role, val] of Object.entries(patch.maxPokemonByRole)) {
      if (ROLE_HIERARCHY.includes(role)) {
        cfg.maxPokemonByRole[role] = Math.max(1, Math.min(6, parseInt(val) || 3));
      }
    }
  }
  if (patch.maxQueueLength !== undefined) cfg.maxQueueLength = Math.max(1, Math.min(100, parseInt(patch.maxQueueLength) || 20));
  if (patch.afkTimeout !== undefined) cfg.afkTimeout = Math.max(0, Math.min(600, parseInt(patch.afkTimeout) || 120));
  if (patch.queuePermission !== undefined && ROLE_HIERARCHY.includes(patch.queuePermission)) cfg.queuePermission = patch.queuePermission;
  if (patch.allowRejoinAfterSkip !== undefined) cfg.allowRejoinAfterSkip = !!patch.allowRejoinAfterSkip;
  if (patch.wordFilterBlacklist !== undefined && Array.isArray(patch.wordFilterBlacklist)) {
    cfg.wordFilterBlacklist = patch.wordFilterBlacklist.filter(w => typeof w === 'string' && w.trim()).map(w => w.trim());
  }
  if (patch.bossEggMoves !== undefined) cfg.bossEggMoves = !!patch.bossEggMoves;
  if (patch.challengerEggMoves !== undefined && ['none', 'all', 'cost'].includes(patch.challengerEggMoves)) {
    cfg.challengerEggMoves = patch.challengerEggMoves;
  }
  if (patch.eggMoveCost !== undefined) cfg.eggMoveCost = Math.max(0, Math.min(20, parseInt(patch.eggMoveCost) || 3));

  console.log(`[Gym] Config updated: ${Object.keys(patch).join(', ')}`);
  return cfg;
}

// --- AFK Check ---
function checkAfkTimeout() {
  if (!gymSession || !gymSession.currentChallenger || !gymSession.currentChallengerSince) return null;
  if (gymSession.config.afkTimeout <= 0) return null;

  const elapsed = (Date.now() - gymSession.currentChallengerSince) / 1000;
  if (elapsed >= gymSession.config.afkTimeout) {
    return { expired: true, challenger: gymSession.currentChallenger, elapsed: Math.floor(elapsed) };
  }
  return { expired: false, elapsed: Math.floor(elapsed), remaining: Math.ceil(gymSession.config.afkTimeout - elapsed) };
}

function getKnownRole(twitchId) {
  return knownRoles.get(twitchId) || 'everyone';
}

function setKnownRole(twitchId, role) {
  knownRoles.set(twitchId, role);
}

module.exports = {
  createSession,
  endSession,
  getSession,
  getState,
  setBossTeam,
  saveBossPreset,
  switchBossPreset,
  joinQueue,
  leaveQueue,
  skipChallenger,
  kickFromQueue,
  promoteNext,
  awardBadge,
  recordLoss,
  getLeaderboard,
  updateConfig,
  checkAfkTimeout,
  calculateTeamCost,
  getRoleBudget,
  getRoleMaxPokemon,
  getPokemonCost,
  getKnownRole,
  setKnownRole,
  filterTrainerLines,
  pokemonData,
};
