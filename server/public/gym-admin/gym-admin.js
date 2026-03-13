/* eslint-disable */
'use strict';

// --- Pokemon Icon Path Helper ---
function getIconPath(speciesId) {
  const pd = pokemonData[speciesId];
  const gen = pd ? pd.generation : 9;
  return `/images/pokemon/icons/${gen}/${speciesId}.png`;
}

// --- Twitch OAuth ---
const TWITCH_CLIENT_ID = 'aoqvg74maqoulqjqs64osjwdkh4xut';
const REDIRECT_URI = window.location.origin + '/lobby/';
const STREAMER_ID = '647322993';

let currentUser = null;
let pokemonData = {};
let trainerSprites = [];
let gymState = { active: false };

// Boss team editor state
let bossTeam = []; // [{ speciesId, name, cost }]
let activePresetTab = 0; // 0, 1, 2
// Local copy of presets for editing
let localPresets = [
  { name: 'Team 1', team: [], spriteKey: 'gym_leader_brock' },
  { name: 'Team 2', team: [], spriteKey: 'gym_leader_brock' },
  { name: 'Team 3', team: [], spriteKey: 'gym_leader_brock' },
];

// --- Socket.io ---
const socket = io({ transports: ['websocket', 'polling'] });

// --- Init ---
window.addEventListener('DOMContentLoaded', async () => {
  loadUser();

  try {
    const [pdRes, spRes] = await Promise.all([
      fetch('/api/pokemon-data'),
      fetch('/api/trainer-sprites'),
    ]);
    pokemonData = await pdRes.json();
    trainerSprites = await spRes.json();
    populateSpriteSelect();
  } catch (e) {
    console.error('Failed to load data:', e);
  }

  setupSocket();
  setupSearch();
});

// --- Auth ---
function loadUser() {
  let stored = localStorage.getItem('twitch_community_user');
  if (stored) {
    try {
      currentUser = JSON.parse(stored);
    } catch (e) {
      localStorage.removeItem('twitch_community_user');
    }
  }
  if (!stored) {
    stored = sessionStorage.getItem('twitch-user');
    if (stored) {
      try {
        currentUser = JSON.parse(stored);
        localStorage.setItem('twitch_community_user', stored);
      } catch (e) { /* ignore */ }
    }
  }
  updateAuthUI();
}

function updateAuthUI() {
  const loginBtn = document.getElementById('btn-login');
  const userInfo = document.getElementById('user-info');
  const notAuth = document.getElementById('not-authorized');
  const main = document.getElementById('main');

  if (currentUser && currentUser.id === STREAMER_ID) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'flex';
    document.getElementById('user-avatar').src = currentUser.profile_image_url;
    document.getElementById('user-name').textContent = currentUser.display_name;
    main.style.display = 'flex';
    notAuth.style.display = 'none';
  } else if (currentUser) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'flex';
    document.getElementById('user-avatar').src = currentUser.profile_image_url;
    document.getElementById('user-name').textContent = currentUser.display_name;
    main.style.display = 'none';
    notAuth.style.display = 'flex';
  } else {
    loginBtn.style.display = 'inline-flex';
    userInfo.style.display = 'none';
    main.style.display = 'none';
    notAuth.style.display = 'flex';
  }
}

function loginTwitch() {
  localStorage.setItem('twitch_auth_return', window.location.href);
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=`;
  window.location.href = url;
}

function logoutTwitch() {
  currentUser = null;
  localStorage.removeItem('twitch_community_user');
  localStorage.removeItem('twitch_community_token');
  updateAuthUI();
}

// --- Socket ---
function setupSocket() {
  socket.emit('GYM_JOIN');

  socket.on('GYM_STATE', (state) => {
    gymState = state;
    renderAll();
  });

  socket.on('GYM_ERROR', ({ message }) => {
    alert(message);
  });

  socket.on('GYM_BADGE_AWARDED', ({ displayName, totalBadges }) => {
    console.log(`Badge awarded to ${displayName} (total: ${totalBadges})`);
  });

  socket.on('GYM_BATTLE_CREATED', ({ battleId }) => {
    gymState.activeBattleId = battleId;
    renderAll();
  });
}

// --- Session ---
function createSession() {
  const token = localStorage.getItem('twitch_community_token') || sessionStorage.getItem('twitch-token');
  socket.emit('GYM_CREATE_SESSION', { twitchId: currentUser.id, broadcasterToken: token });
}

function endSession() {
  if (!confirm('Session wirklich beenden?')) return;
  socket.emit('GYM_END_SESSION', { twitchId: currentUser.id });
}

// --- PvP Battle ---
function startBattle() {
  socket.emit('GYM_START_BATTLE', { twitchId: currentUser.id });
}

function copyUrl(side) {
  const el = document.getElementById(`battle-url-${side}`);
  if (el) {
    navigator.clipboard.writeText(el.textContent).then(() => {
      el.style.color = 'var(--green)';
      setTimeout(() => { el.style.color = ''; }, 1000);
    });
  }
}

// --- Boss Team ---
let selectedBossSprite = 'gym_leader_brock';

function populateSpriteSelect() {
  renderSpriteGrid('boss');
  updateSpriteDisplay('boss', selectedBossSprite);

  document.getElementById('boss-sprite-filter').addEventListener('input', () => {
    renderSpriteGrid('boss');
  });
}

function getSpriteThumb(sprite, size) {
  size = size || 64;
  if (sprite.frame) {
    const f = sprite.frame;
    const scale = Math.min(size / f.w, size / f.h);
    const sw = Math.round(f.sw * scale);
    const sh = Math.round(f.sh * scale);
    const ox = Math.round(-f.x * scale);
    const oy = Math.round(-f.y * scale);
    const dw = Math.round(f.w * scale);
    const dh = Math.round(f.h * scale);
    return `<div style="width:${dw}px;height:${dh}px;background:url('/images/trainer/${sprite.key}.png') ${ox}px ${oy}px / ${sw}px ${sh}px no-repeat;image-rendering:pixelated;"></div>`;
  }
  return `<img src="/images/trainer/${sprite.key}.png" alt="${sprite.label}" style="width:${size}px;height:${size}px;image-rendering:pixelated;object-fit:contain;" onerror="this.style.display='none'">`;
}

function toggleSpriteGrid(prefix) {
  const grid = document.getElementById(`${prefix}-sprite-grid`);
  const search = document.getElementById(`${prefix}-sprite-search`);
  const show = grid.style.display === 'none';
  grid.style.display = show ? 'grid' : 'none';
  search.style.display = show ? 'block' : 'none';
  if (show) {
    document.getElementById(`${prefix}-sprite-filter`).focus();
    renderSpriteGrid(prefix);
  }
}

function renderSpriteGrid(prefix) {
  const grid = document.getElementById(`${prefix}-sprite-grid`);
  const filter = document.getElementById(`${prefix}-sprite-filter`).value.trim().toLowerCase();
  const current = prefix === 'boss' ? selectedBossSprite : '';

  const filtered = filter
    ? trainerSprites.filter(s => s.label.toLowerCase().includes(filter) || s.key.toLowerCase().includes(filter))
    : trainerSprites;

  grid.innerHTML = '';
  for (const sprite of filtered) {
    const item = document.createElement('div');
    item.className = 'sprite-item' + (sprite.key === current ? ' selected' : '');
    item.innerHTML = `${getSpriteThumb(sprite, 48)}<span>${sprite.label}</span>`;
    item.addEventListener('click', () => {
      if (prefix === 'boss') {
        selectedBossSprite = sprite.key;
        document.getElementById('boss-sprite').value = sprite.key;
      }
      updateSpriteDisplay(prefix, sprite.key);
      toggleSpriteGrid(prefix);
    });
    grid.appendChild(item);
  }
}

function updateSpriteDisplay(prefix, key) {
  const sp = trainerSprites.find(s => s.key === key);
  if (!sp) return;
  const preview = document.getElementById(`${prefix}-sprite-preview`);
  const label = document.getElementById(`${prefix}-sprite-label`);
  preview.innerHTML = getSpriteThumb(sp, 64);
  if (label) label.textContent = sp.label;
}

function setupSearch() {
  const input = document.getElementById('boss-search');
  const results = document.getElementById('boss-search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) {
      results.classList.remove('show');
      return;
    }
    const matches = [];
    for (const [id, pd] of Object.entries(pokemonData)) {
      const name = (pd.name_de || pd.name || '').toLowerCase();
      if (name.includes(q) || id === q) {
        const cost = pd.cost || 5;
        matches.push({ speciesId: parseInt(id), name: pd.name_de || pd.name, cost, generation: pd.generation });
        if (matches.length >= 30) break;
      }
    }
    matches.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
    renderSearchResults(matches, results);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => results.classList.remove('show'), 200);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) input.dispatchEvent(new Event('input'));
  });
}

function renderSearchResults(matches, container) {
  container.innerHTML = '';
  if (matches.length === 0) {
    container.classList.remove('show');
    return;
  }
  for (const m of matches) {
    const pd = pokemonData[m.speciesId];
    const forms = pd && pd.forms ? pd.forms : [];

    // Base form entry
    const div = document.createElement('div');
    div.className = 'search-item';
    div.innerHTML = `
      <img src="${getIconPath(m.speciesId)}" alt="${m.name}" onerror="this.style.display='none'">
      <div class="info">
        <div class="name">${m.name}</div>
        <div class="bst">Kosten: ${m.cost}</div>
      </div>
      <span class="cost-badge">${m.cost}</span>
    `;
    div.addEventListener('click', () => addToBossTeam(m));
    container.appendChild(div);

    // Show each form as its own row directly below
    for (const form of forms) {
      const fDiv = document.createElement('div');
      fDiv.className = 'search-item form-option';
      fDiv.innerHTML = `
        <img src="${getIconPath(m.speciesId)}" alt="${form.formName}" onerror="this.style.display='none'">
        <div class="info">
          <div class="name">${m.name} <span style="color:var(--accent)">${form.formName}</span></div>
          <div class="bst">${form.type1 || ''}${form.type2 ? '/' + form.type2 : ''} | BST ${form.baseTotal}</div>
        </div>
        <span class="cost-badge">${m.cost}</span>
      `;
      fDiv.addEventListener('click', () => addToBossTeam(m, form.formIndex, form.formName));
      container.appendChild(fDiv);
    }
  }
  container.classList.add('show');
}

function addToBossTeam(pokemon, formIndex, formName) {
  if (bossTeam.length >= 6) return;
  const entry = { speciesId: pokemon.speciesId, name: pokemon.name, cost: pokemon.cost, shiny: false, variant: 0 };
  if (formIndex !== undefined && formIndex > 0) {
    entry.formIndex = formIndex;
    entry.formName = formName || '';
  }
  bossTeam.push(entry);
  renderBossTeam();
  document.getElementById('boss-search').value = '';
  document.getElementById('boss-search-results').classList.remove('show');
}

function toggleShiny(index) {
  const p = bossTeam[index];
  if (!p) return;
  if (!p.shiny) { p.shiny = true; p.variant = 0; }
  else if (p.variant === 0) { p.variant = 1; }
  else if (p.variant === 1) { p.variant = 2; }
  else { p.shiny = false; p.variant = 0; }
  renderBossTeam();
}

// --- Drag and Drop ---
let dragIndex = null;
function onDragStart(e, index) {
  dragIndex = index;
  e.dataTransfer.effectAllowed = 'move';
  e.target.closest('.team-slot').classList.add('dragging');
}
function onDragEnd(e) {
  dragIndex = null;
  document.querySelectorAll('.team-slot.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.team-slot.drag-over').forEach(el => el.classList.remove('drag-over'));
}
function onDragOver(e, index) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (dragIndex !== null && dragIndex !== index && index < bossTeam.length) {
    document.querySelectorAll('.team-slot.drag-over').forEach(el => el.classList.remove('drag-over'));
    e.target.closest('.team-slot')?.classList.add('drag-over');
  }
}
function onDrop(e, index) {
  e.preventDefault();
  if (dragIndex === null || dragIndex === index || index >= bossTeam.length) return;
  const [moved] = bossTeam.splice(dragIndex, 1);
  bossTeam.splice(index, 0, moved);
  dragIndex = null;
  renderBossTeam();
}

function removeBossSlot(index) {
  bossTeam.splice(index, 1);
  renderBossTeam();
}

function renderBossTeam() {
  const container = document.getElementById('boss-team');
  const costEl = document.getElementById('boss-cost');
  const budgetEl = document.getElementById('boss-budget');

  const budget = gymState.config?.bossBudget || 18;
  const totalCost = bossTeam.reduce((sum, p) => sum + p.cost, 0);

  budgetEl.textContent = budget;
  costEl.textContent = totalCost;
  costEl.style.color = totalCost > budget ? 'var(--red)' : 'var(--green)';

  container.innerHTML = '';
  for (let i = 0; i < bossTeam.length; i++) {
    const p = bossTeam[i];
    const formLabel = p.formName && p.formName !== 'Normal' ? `<div class="form-label">${p.formName}</div>` : '';
    const shinyLabels = ['', 'Shiny', 'Shiny+', 'Shiny++'];
    const shinyColors = ['var(--text-muted)', '#FFD700', '#00CED1', '#FF69B4'];
    const shinyState = p.shiny ? p.variant + 1 : 0;
    const slot = document.createElement('div');
    slot.className = 'team-slot';
    slot.draggable = true;
    slot.addEventListener('dragstart', (e) => onDragStart(e, i));
    slot.addEventListener('dragend', onDragEnd);
    slot.addEventListener('dragover', (e) => onDragOver(e, i));
    slot.addEventListener('drop', (e) => onDrop(e, i));
    slot.innerHTML = `
      <button class="remove" onclick="removeBossSlot(${i})">&times;</button>
      <img src="${getIconPath(p.speciesId)}" alt="${p.name}" onerror="this.style.display='none'">
      <div class="name">${p.name}</div>
      ${formLabel}
      <div class="cost">Kosten: ${p.cost}</div>
      <button class="shiny-toggle" onclick="toggleShiny(${i})" style="color:${shinyColors[shinyState]}" title="Shiny umschalten">
        &#10022; ${shinyLabels[shinyState] || 'Normal'}
      </button>
    `;
    container.appendChild(slot);
  }

  // Empty slots
  for (let i = bossTeam.length; i < 6; i++) {
    const slot = document.createElement('div');
    slot.className = 'team-slot';
    slot.style.opacity = '0.3';
    slot.innerHTML = '<div class="name" style="font-size:1.5rem;color:var(--text-muted)">+</div>';
    container.appendChild(slot);
  }
}

function switchPresetTab(index) {
  // Save current tab state to local presets
  localPresets[activePresetTab] = {
    name: localPresets[activePresetTab].name || `Team ${activePresetTab + 1}`,
    team: bossTeam.map(p => ({ ...p })),
    spriteKey: document.getElementById('boss-sprite').value || 'gym_leader_brock',
  };

  activePresetTab = index;

  // Load new tab
  const preset = localPresets[index];
  bossTeam = (preset.team || []).map(p => ({ ...p }));
  selectedBossSprite = preset.spriteKey || 'gym_leader_brock';
  document.getElementById('boss-sprite').value = selectedBossSprite;
  updateSpriteDisplay('boss', selectedBossSprite);
  renderBossTeam();

  // Update tab UI
  document.querySelectorAll('.preset-tab').forEach((tab, i) => {
    tab.classList.toggle('active', i === index);
    // Highlight active server preset
    const isServerActive = gymState.activeBossPreset === i;
    tab.classList.toggle('server-active', isServerActive);
  });
}

function buildTeamPayload(team) {
  return team.map(p => {
    const entry = { speciesId: p.speciesId };
    if (p.formIndex) entry.formIndex = p.formIndex;
    if (p.shiny) { entry.shiny = true; entry.variant = p.variant || 0; }
    return entry;
  });
}

function saveBossTeam() {
  if (bossTeam.length < 1) return alert('Mindestens 1 Pokemon');
  const spriteKey = document.getElementById('boss-sprite').value;
  const teamPayload = buildTeamPayload(bossTeam);

  socket.emit('GYM_SAVE_PRESET', {
    twitchId: currentUser.id,
    presetIndex: activePresetTab,
    team: teamPayload,
    spriteKey,
    presetName: `Team ${activePresetTab + 1}`,
  });

  socket.emit('GYM_SET_BOSS_TEAM', {
    twitchId: currentUser.id,
    team: teamPayload,
    spriteKey,
  });
}

function activatePreset() {
  const spriteKey = document.getElementById('boss-sprite').value;
  if (bossTeam.length < 1) return alert('Mindestens 1 Pokemon');
  const teamPayload = buildTeamPayload(bossTeam);

  socket.emit('GYM_SAVE_PRESET', {
    twitchId: currentUser.id,
    presetIndex: activePresetTab,
    team: teamPayload,
    spriteKey,
    presetName: `Team ${activePresetTab + 1}`,
  });

  socket.emit('GYM_SWITCH_PRESET', {
    twitchId: currentUser.id,
    presetIndex: activePresetTab,
  });
}

// --- Queue / Challenger ---
function renderQueue() {
  const currentDiv = document.getElementById('current-challenger');
  const listDiv = document.getElementById('queue-list');

  // Current challenger
  const cc = gymState.currentChallenger;
  if (cc) {
    const teamIcons = (cc.team || []).map(p => `<img src="${getIconPath(p.speciesId)}" alt="${p.name}" title="${p.name} (${p.cost})">`).join('');
    const lines = cc.trainerLines || {};
    const linesHtml = (lines.intro || lines.defeat || lines.victory) ?
      `<div class="trainer-lines">
        ${lines.intro ? `<span>Intro: "${lines.intro}"</span>` : ''}
        ${lines.defeat ? `<span>Defeat: "${lines.defeat}"</span>` : ''}
        ${lines.victory ? `<span>Victory: "${lines.victory}"</span>` : ''}
      </div>` : '';
    currentDiv.innerHTML = `
      <h3>Aktueller Herausforderer</h3>
      <div class="challenger-card">
        <img class="avatar-large" src="${cc.profileImage || ''}" alt="" onerror="this.style.display='none'">
        <div class="info">
          <div class="name">${cc.displayName}</div>
          <div class="role">${cc.twitchRole || 'everyone'}</div>
          <div class="team-preview">${teamIcons}</div>
          <div class="budget-tag">Budget: ${cc.teamBudget || '?'}</div>
          ${linesHtml}
        </div>
        <div class="actions">
          <button class="btn btn-green btn-small" onclick="awardBadge('${cc.twitchId}', '${cc.displayName.replace(/'/g, "\\'")}')">Badge</button>
          <button class="btn btn-danger btn-small" onclick="recordLoss('${cc.twitchId}', '${cc.displayName.replace(/'/g, "\\'")}')">Verloren</button>
          <button class="btn btn-small" onclick="skipChallenger()">Skip</button>
        </div>
      </div>
    `;
  } else {
    currentDiv.innerHTML = '<div class="queue-empty">Kein aktiver Herausforderer</div>';
  }

  // Queue list
  const queue = gymState.queue || [];
  if (queue.length === 0) {
    listDiv.innerHTML = '<div class="queue-empty">Warteschlange leer</div>';
  } else {
    listDiv.innerHTML = '';
    queue.forEach((c, i) => {
      const teamIcons = (c.team || []).map(p => `<img src="${getIconPath(p.speciesId)}" alt="${p.name}">`).join('');
      const div = document.createElement('div');
      div.className = 'queue-item';
      div.innerHTML = `
        <span class="pos">#${i + 1}</span>
        <img class="avatar-small" src="${c.profileImage || ''}" alt="" onerror="this.style.display='none'">
        <div class="info">
          <div class="name">${c.displayName}</div>
          <div class="budget-tag">Budget: ${c.teamBudget || '?'} | ${c.twitchRole || 'everyone'}</div>
        </div>
        <div class="team-icons">${teamIcons}</div>
        <div class="actions">
          <button class="btn btn-danger btn-small" onclick="kickUser('${c.twitchId}')">Kick</button>
        </div>
      `;
      listDiv.appendChild(div);
    });
  }
}

function awardBadge(challengerId, challengerName) {
  socket.emit('GYM_AWARD_BADGE', { twitchId: currentUser.id, challengerId, challengerName });
}

function recordLoss(challengerId, challengerName) {
  socket.emit('GYM_RECORD_LOSS', { twitchId: currentUser.id, challengerId, challengerName });
}

function skipChallenger() {
  socket.emit('GYM_SKIP_CHALLENGER', { twitchId: currentUser.id });
}

function kickUser(targetId) {
  socket.emit('GYM_KICK_FROM_QUEUE', { twitchId: currentUser.id, targetId });
}

// --- History & Leaderboard ---
function renderHistory() {
  const historyDiv = document.getElementById('match-history');
  const lbDiv = document.getElementById('leaderboard');
  const history = gymState.matchHistory || [];
  const lb = gymState.leaderboard || [];

  if (history.length === 0) {
    historyDiv.innerHTML = '<div class="queue-empty">Keine Matches</div>';
  } else {
    historyDiv.innerHTML = '';
    for (const m of [...history].reverse()) {
      const cls = m.result === 'win' ? 'result-win' : m.result === 'loss' ? 'result-loss' : 'result-skipped';
      const label = m.result === 'win' ? 'Sieg' : m.result === 'loss' ? 'Niederlage' : 'Skipped';
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <span>${m.challengerName}</span>
        <span class="result ${cls}">${label}</span>
      `;
      historyDiv.appendChild(div);
    }
  }

  if (lb.length === 0) {
    lbDiv.innerHTML = '<div class="queue-empty">Keine Badges</div>';
  } else {
    lbDiv.innerHTML = '';
    lb.forEach((entry, i) => {
      const div = document.createElement('div');
      div.className = 'lb-item';
      div.innerHTML = `
        <span class="rank">#${i + 1}</span>
        <span>${entry.displayName}</span>
        <span class="badges">${entry.count} Badge${entry.count !== 1 ? 's' : ''}</span>
      `;
      lbDiv.appendChild(div);
    });
  }
}

// --- Config ---
function renderConfig() {
  if (!gymState.config) return;
  const cfg = gymState.config;
  document.getElementById('cfg-boss-budget').value = cfg.bossBudget;
  document.getElementById('cfg-max-queue').value = cfg.maxQueueLength;
  document.getElementById('cfg-afk-timeout').value = cfg.afkTimeout;
  document.getElementById('cfg-queue-perm').value = cfg.queuePermission;
  if (cfg.budgetByRole) {
    for (const [role, val] of Object.entries(cfg.budgetByRole)) {
      const el = document.getElementById(`cfg-budget-${role}`);
      if (el) el.value = val;
    }
  }
  if (cfg.maxPokemonByRole) {
    for (const [role, val] of Object.entries(cfg.maxPokemonByRole)) {
      const el = document.getElementById(`cfg-maxpoke-${role}`);
      if (el) el.value = val;
    }
  }
  const bossEggEl = document.getElementById('cfg-boss-eggmoves');
  if (bossEggEl) bossEggEl.checked = cfg.bossEggMoves !== false;
  const challEggEl = document.getElementById('cfg-challenger-eggmoves');
  if (challEggEl) challEggEl.value = cfg.challengerEggMoves || 'none';
  const eggCostEl = document.getElementById('cfg-eggmove-cost');
  if (eggCostEl) eggCostEl.value = cfg.eggMoveCost || 3;
}

function saveConfig() {
  const config = {
    bossBudget: parseInt(document.getElementById('cfg-boss-budget').value),
    maxQueueLength: parseInt(document.getElementById('cfg-max-queue').value),
    afkTimeout: parseInt(document.getElementById('cfg-afk-timeout').value),
    queuePermission: document.getElementById('cfg-queue-perm').value,
    budgetByRole: {},
    maxPokemonByRole: {},
  };
  for (const role of ['everyone', 'follower', 'sub1', 'sub2', 'sub3', 'vip', 'mod']) {
    const budgetEl = document.getElementById(`cfg-budget-${role}`);
    if (budgetEl) config.budgetByRole[role] = parseInt(budgetEl.value);
    const maxPokeEl = document.getElementById(`cfg-maxpoke-${role}`);
    if (maxPokeEl) config.maxPokemonByRole[role] = parseInt(maxPokeEl.value);
  }
  const bossEggEl = document.getElementById('cfg-boss-eggmoves');
  if (bossEggEl) config.bossEggMoves = bossEggEl.checked;
  const challEggEl = document.getElementById('cfg-challenger-eggmoves');
  if (challEggEl) config.challengerEggMoves = challEggEl.value;
  const eggCostEl = document.getElementById('cfg-eggmove-cost');
  if (eggCostEl) config.eggMoveCost = parseInt(eggCostEl.value) || 3;

  socket.emit('GYM_UPDATE_CONFIG', { twitchId: currentUser.id, config });
}

// --- Render All ---
function renderAll() {
  const active = gymState.active;

  // Session panel
  const statusBadge = document.getElementById('session-status');
  const createBtn = document.getElementById('btn-create-session');
  const endBtn = document.getElementById('btn-end-session');
  const challengerLink = document.getElementById('challenger-link');

  if (active) {
    statusBadge.textContent = 'Session aktiv';
    statusBadge.className = 'status-badge status-active';
    createBtn.style.display = 'none';
    endBtn.style.display = 'inline-flex';
    challengerLink.style.display = 'block';
    const url = window.location.origin + '/gym/';
    document.getElementById('challenger-url').href = url;
    document.getElementById('challenger-url').textContent = url;
  } else {
    statusBadge.textContent = 'Keine Session aktiv';
    statusBadge.className = 'status-badge status-inactive';
    createBtn.style.display = 'inline-flex';
    endBtn.style.display = 'none';
    challengerLink.style.display = 'none';
  }

  // Show/hide panels
  document.getElementById('boss-panel').style.display = active ? 'block' : 'none';
  document.getElementById('battle-panel').style.display = active ? 'block' : 'none';
  document.getElementById('queue-panel').style.display = active ? 'block' : 'none';
  document.getElementById('history-panel').style.display = active ? 'block' : 'none';
  document.getElementById('config-panel').style.display = active ? 'block' : 'none';

  // Battle panel
  if (active) {
    const hasChallenger = gymState.currentChallenger != null;
    const startBtn = document.getElementById('btn-start-battle');
    const battleInfo = document.getElementById('battle-info');
    const battleUrls = document.getElementById('battle-urls');

    if (gymState.activeBattleId) {
      // Battle is active
      const baseUrl = window.location.origin;
      const bossUrl = `${baseUrl}/?pvp=${gymState.activeBattleId}&side=boss`;
      const challUrl = `${baseUrl}/?pvp=${gymState.activeBattleId}&side=challenger`;
      document.getElementById('battle-url-boss').href = bossUrl;
      document.getElementById('battle-url-boss').textContent = bossUrl;
      document.getElementById('battle-url-challenger').href = challUrl;
      document.getElementById('battle-url-challenger').textContent = challUrl;
      battleUrls.style.display = 'block';
      battleInfo.textContent = `Kampf aktiv: ${gymState.currentChallenger?.displayName || '?'}`;
      startBtn.style.display = 'none';
    } else if (hasChallenger) {
      battleInfo.textContent = `Bereit: ${gymState.currentChallenger.displayName}`;
      startBtn.style.display = 'block';
      battleUrls.style.display = 'none';
    } else {
      battleInfo.textContent = 'Kein Challenger bereit';
      startBtn.style.display = 'none';
      battleUrls.style.display = 'none';
    }
  }

  if (active) {
    // Sync presets from server
    if (gymState.bossTeamPresets && gymState.bossTeamPresets.length) {
      for (let i = 0; i < 3; i++) {
        const sp = gymState.bossTeamPresets[i];
        if (sp && sp.team && sp.team.length > 0) {
          localPresets[i] = {
            name: sp.name || `Team ${i + 1}`,
            team: sp.team.map(p => ({ speciesId: p.speciesId, name: p.name, cost: p.cost, formIndex: p.formIndex, formName: p.formName, shiny: !!p.shiny, variant: p.variant || 0 })),
            spriteKey: sp.spriteKey || 'gym_leader_brock',
          };
        }
      }
    }

    // Load active preset tab
    const preset = localPresets[activePresetTab];
    if (bossTeam.length === 0 && preset.team.length > 0) {
      bossTeam = preset.team.map(p => ({ ...p }));
      selectedBossSprite = preset.spriteKey || 'gym_leader_brock';
      document.getElementById('boss-sprite').value = selectedBossSprite;
      updateSpriteDisplay('boss', selectedBossSprite);
    } else if (bossTeam.length === 0 && gymState.bossTeam && gymState.bossTeam.length > 0) {
      bossTeam = gymState.bossTeam.map(p => ({ speciesId: p.speciesId, name: p.name, cost: p.cost }));
    }

    // Update tab UI
    document.querySelectorAll('.preset-tab').forEach((tab, i) => {
      tab.classList.toggle('active', i === activePresetTab);
      tab.classList.toggle('server-active', gymState.activeBossPreset === i);
      const p = localPresets[i];
      tab.textContent = p.team.length > 0 ? `Team ${i + 1} (${p.team.length})` : `Team ${i + 1}`;
    });

    renderBossTeam();
    renderQueue();
    renderHistory();
    renderConfig();
  }
}
