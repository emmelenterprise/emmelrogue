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
const TWITCH_SCOPES = 'user:read:subscriptions';

let currentUser = null;
let pokemonData = {};
let trainerSprites = [];
let gymState = { active: false };
let inQueue = false;

// Team builder state
let myTeam = []; // [{ speciesId, name, cost }]

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
  checkImportAvailable();
  fetchUserRole();
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
  if (currentUser) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'flex';
    document.getElementById('user-avatar').src = currentUser.profile_image_url;
    document.getElementById('user-name').textContent = currentUser.display_name;
  } else {
    loginBtn.style.display = 'inline-flex';
    userInfo.style.display = 'none';
  }
}

function loginTwitch() {
  localStorage.setItem('twitch_auth_return', window.location.href);
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=${encodeURIComponent(TWITCH_SCOPES)}`;
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
    updateInQueueState();
    renderAll();
  });

  socket.on('GYM_QUEUE_JOINED', ({ position, role, budget }) => {
    inQueue = true;
    if (role) userRole = role;
    if (budget) userBudget = budget;
    document.getElementById('join-error').style.display = 'none';
    const el = document.getElementById('join-success');
    const roleLabel = { everyone: 'Zuschauer', follower: 'Follower', sub1: 'Sub T1', sub2: 'Sub T2', sub3: 'Sub T3', vip: 'VIP', mod: 'Mod' }[userRole] || userRole;
    el.textContent = `Du bist in der Warteschlange! Position: ${position} (${roleLabel}, Budget: ${budget || userBudget})`;
    el.style.display = 'block';
    updateJoinButtons();
  });

  socket.on('GYM_ERROR', ({ message }) => {
    const el = document.getElementById('join-error');
    el.textContent = message;
    el.style.display = 'block';
    document.getElementById('join-success').style.display = 'none';
  });

  socket.on('GYM_BADGE_AWARDED', ({ twitchId, displayName, totalBadges }) => {
    if (currentUser && twitchId === currentUser.id) {
      alert(`Du hast einen Badge gewonnen! (Total: ${totalBadges})`);
    }
  });

  // PvP: When a battle is created and this user is the current challenger, auto-redirect
  socket.on('GYM_BATTLE_CREATED', ({ battleId }) => {
    if (currentUser && gymState.currentChallenger?.twitchId === currentUser.id) {
      const battleUrl = `${window.location.origin}/?pvp=${battleId}&side=challenger`;
      const el = document.getElementById('join-success');
      el.innerHTML = `<strong>Kampf startet!</strong> Du wirst weitergeleitet...`;
      el.style.display = 'block';
      setTimeout(() => { window.location.href = battleUrl; }, 500);
    }
  });
}

function updateInQueueState() {
  if (!currentUser) { inQueue = false; return; }
  const uid = currentUser.id;
  inQueue = (gymState.queue || []).some(c => c.twitchId === uid) ||
    (gymState.currentChallenger && gymState.currentChallenger.twitchId === uid);
  updateJoinButtons();
}

function updateJoinButtons() {
  const joinBtn = document.getElementById('btn-join');
  const leaveBtn = document.getElementById('btn-leave');
  if (inQueue) {
    joinBtn.style.display = 'none';
    leaveBtn.style.display = 'flex';
  } else {
    joinBtn.style.display = 'flex';
    leaveBtn.style.display = 'none';
    document.getElementById('join-success').style.display = 'none';
  }
}

// --- Sprite Select ---
let selectedMySprite = 'youngster';

function populateSpriteSelect() {
  renderSpriteGrid('my');
  updateSpriteDisplay('my', selectedMySprite);

  document.getElementById('my-sprite-filter').addEventListener('input', () => {
    renderSpriteGrid('my');
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
  const current = prefix === 'my' ? selectedMySprite : '';

  const filtered = filter
    ? trainerSprites.filter(s => s.label.toLowerCase().includes(filter) || s.key.toLowerCase().includes(filter))
    : trainerSprites;

  grid.innerHTML = '';
  for (const sprite of filtered) {
    const item = document.createElement('div');
    item.className = 'sprite-item' + (sprite.key === current ? ' selected' : '');
    item.innerHTML = `${getSpriteThumb(sprite, 48)}<span>${sprite.label}</span>`;
    item.addEventListener('click', () => {
      selectedMySprite = sprite.key;
      document.getElementById('my-sprite').value = sprite.key;
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

// --- Pokemon Search ---
function setupSearch() {
  const input = document.getElementById('pokemon-search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { results.classList.remove('show'); return; }
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
  if (matches.length === 0) { container.classList.remove('show'); return; }
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
    div.addEventListener('click', () => addToTeam(m));
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
      fDiv.addEventListener('click', () => addToTeam(m, form.formIndex, form.formName));
      container.appendChild(fDiv);
    }
  }
  container.classList.add('show');
}

// --- Team Builder ---
function addToTeam(pokemon, formIndex, formName) {
  const role = getUserRole();
  const maxPokemon = gymState.config?.maxPokemonByRole?.[role] || gymState.config?.maxPokemonByRole?.everyone || 3;
  if (myTeam.length >= maxPokemon) return;
  const entry = { speciesId: pokemon.speciesId, name: pokemon.name, cost: pokemon.cost, shiny: false, variant: 0 };
  if (formIndex !== undefined && formIndex > 0) {
    entry.formIndex = formIndex;
    entry.formName = formName || '';
  }
  myTeam.push(entry);
  renderMyTeam();
  document.getElementById('pokemon-search').value = '';
  document.getElementById('search-results').classList.remove('show');
}

function toggleShiny(index) {
  const p = myTeam[index];
  if (!p) return;
  if (!p.shiny) { p.shiny = true; p.variant = 0; }
  else if (p.variant === 0) { p.variant = 1; }
  else if (p.variant === 1) { p.variant = 2; }
  else { p.shiny = false; p.variant = 0; }
  renderMyTeam();
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
  if (dragIndex !== null && dragIndex !== index && index < myTeam.length) {
    document.querySelectorAll('.team-slot.drag-over').forEach(el => el.classList.remove('drag-over'));
    e.target.closest('.team-slot')?.classList.add('drag-over');
  }
}
function onDrop(e, index) {
  e.preventDefault();
  if (dragIndex === null || dragIndex === index || index >= myTeam.length) return;
  const [moved] = myTeam.splice(dragIndex, 1);
  myTeam.splice(index, 0, moved);
  dragIndex = null;
  renderMyTeam();
}

function removeFromTeam(index) {
  myTeam.splice(index, 1);
  renderMyTeam();
}

function renderMyTeam() {
  const container = document.getElementById('my-team');
  const costEl = document.getElementById('my-cost');
  const budgetEl = document.getElementById('my-budget');

  const role = getUserRole();
  const budget = gymState.config?.budgetByRole?.[role] || gymState.config?.budgetByRole?.everyone || 10;
  const maxPokemon = gymState.config?.maxPokemonByRole?.[role] || gymState.config?.maxPokemonByRole?.everyone || 3;
  const totalCost = myTeam.reduce((sum, p) => sum + p.cost, 0);

  budgetEl.textContent = budget;
  costEl.textContent = totalCost;
  costEl.style.color = totalCost > budget ? 'var(--red)' : 'var(--green)';

  // Pokemon count
  const pokeCountEl = document.getElementById('my-poke-count');
  const pokeMaxEl = document.getElementById('my-poke-max');
  if (pokeCountEl) {
    pokeCountEl.textContent = myTeam.length;
    pokeCountEl.style.color = myTeam.length > maxPokemon ? 'var(--red)' : 'var(--green)';
  }
  if (pokeMaxEl) pokeMaxEl.textContent = maxPokemon;

  // Role badge
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    const labels = { everyone: 'Zuschauer', follower: 'Follower', sub1: 'Sub T1', sub2: 'Sub T2', sub3: 'Sub T3', vip: 'VIP', mod: 'Mod' };
    roleBadge.textContent = labels[userRole] || userRole;
    roleBadge.className = `role-badge role-${userRole}`;
  }

  container.innerHTML = '';
  for (let i = 0; i < myTeam.length; i++) {
    const p = myTeam[i];
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
      <button class="remove" onclick="removeFromTeam(${i})">&times;</button>
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
  for (let i = myTeam.length; i < 6; i++) {
    const slot = document.createElement('div');
    slot.className = 'team-slot';
    slot.style.opacity = '0.3';
    slot.innerHTML = '<div class="name" style="font-size:1.5rem;color:var(--text-muted)">+</div>';
    container.appendChild(slot);
  }
}

let userRole = 'everyone';
let userBudget = 10;

function getUserRole() {
  return userRole;
}

async function fetchUserRole() {
  if (!currentUser) return;
  const token = localStorage.getItem('twitch_community_token');
  if (!token) return;
  try {
    const res = await fetch(`/api/gym/check-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twitchId: currentUser.id, token }),
    });
    const data = await res.json();
    if (data.role) userRole = data.role;
    if (data.budget) userBudget = data.budget;
    renderMyTeam();
  } catch (e) { /* ignore */ }
}

// --- Team Import from Community ---
async function importCommunityTeam() {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/gym/my-team/${currentUser.id}`);
    const data = await res.json();
    if (!data.found) {
      const el = document.getElementById('join-error');
      el.textContent = 'Kein Community-Team gefunden. Erstelle eins auf der Community-Seite!';
      el.style.display = 'block';
      return;
    }
    myTeam = data.team.map(p => ({
      speciesId: p.speciesId,
      name: p.name || pokemonData[String(p.speciesId)]?.name_de || 'Unknown',
      cost: p.cost || pokemonData[String(p.speciesId)]?.cost || 5,
    }));
    if (data.spriteKey) {
      const sel = document.getElementById('my-sprite');
      for (const opt of sel.options) {
        if (opt.value === data.spriteKey) { opt.selected = true; break; }
      }
      updateSpritePreview('my-sprite', 'my-sprite-preview');
    }
    renderMyTeam();
    document.getElementById('join-error').style.display = 'none';
    const el = document.getElementById('join-success');
    el.textContent = `Team importiert! (${myTeam.length} Pokemon)`;
    el.style.display = 'block';
  } catch (e) {
    console.error('Import failed:', e);
  }
}

async function checkImportAvailable() {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/gym/my-team/${currentUser.id}`);
    const data = await res.json();
    document.getElementById('btn-import').style.display = data.found ? 'flex' : 'none';
  } catch (e) {
    document.getElementById('btn-import').style.display = 'none';
  }
}

// --- Queue Actions ---
function joinQueue() {
  if (!currentUser) return loginTwitch();
  if (myTeam.length < 1) {
    const el = document.getElementById('join-error');
    el.textContent = 'Du brauchst mindestens 1 Pokemon!';
    el.style.display = 'block';
    return;
  }

  const trainerLines = {
    intro: document.getElementById('line-intro').value.trim(),
    victory: document.getElementById('line-victory').value.trim(),
    defeat: document.getElementById('line-defeat').value.trim(),
  };
  const spriteKey = document.getElementById('my-sprite').value;

  const token = localStorage.getItem('twitch_community_token');
  socket.emit('GYM_JOIN_QUEUE', {
    twitchId: currentUser.id,
    displayName: currentUser.display_name,
    profileImage: currentUser.profile_image_url,
    team: myTeam.map(p => {
      const entry = { speciesId: p.speciesId };
      if (p.formIndex) entry.formIndex = p.formIndex;
      if (p.shiny) { entry.shiny = true; entry.variant = p.variant || 0; }
      return entry;
    }),
    trainerLines,
    spriteKey,
    twitchRole: userRole,
    token,
  });
}

function leaveQueue() {
  if (!currentUser) return;
  socket.emit('GYM_LEAVE_QUEUE', { twitchId: currentUser.id });
  inQueue = false;
  updateJoinButtons();
}

// --- Render ---
function renderAll() {
  const noSession = document.getElementById('no-session');
  const main = document.getElementById('main');

  if (!gymState.active) {
    noSession.style.display = 'flex';
    main.style.display = 'none';
    return;
  }
  noSession.style.display = 'none';
  main.style.display = 'flex';

  renderBossInfo();
  renderMyTeam();
  renderQueue();
  renderLeaderboard();
}

function renderBossInfo() {
  const container = document.getElementById('boss-info');
  const team = gymState.bossTeam || [];
  if (team.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted)">Gym Leader stellt Team zusammen...</div>';
    return;
  }
  const slots = team.map(p => `
    <div class="pokemon-slot">
      <img src="${getIconPath(p.speciesId)}" alt="${p.name}" onerror="this.style.display='none'">
      <div class="name">${p.name}</div>
      <div class="cost">${p.cost}</div>
    </div>
  `).join('');
  container.innerHTML = `
    <div class="boss-team-display">${slots}</div>
    <div class="boss-budget-tag">Budget: ${gymState.bossBudget || 0}/${gymState.config?.bossBudget || 18}</div>
  `;
}

function renderQueue() {
  const currentDiv = document.getElementById('current-challenger');
  const listDiv = document.getElementById('queue-list');
  const uid = currentUser?.id;

  const cc = gymState.currentChallenger;
  if (cc) {
    const teamIcons = (cc.team || []).map(p => `<img src="${getIconPath(p.speciesId)}" alt="${p.name}" title="${p.name}">`).join('');
    const isYou = uid && cc.twitchId === uid;
    currentDiv.innerHTML = `
      <div class="active-challenger${isYou ? ' is-you' : ''}">
        <div class="label">Aktueller Kampf${isYou ? ' — DU!' : ''}</div>
        <div class="name">${cc.displayName}</div>
        <div class="team-preview">${teamIcons}</div>
      </div>
    `;
  } else {
    currentDiv.innerHTML = '<div class="queue-empty">Kein aktiver Kampf</div>';
  }

  const queue = gymState.queue || [];
  if (queue.length === 0) {
    listDiv.innerHTML = '<div class="queue-empty">Warteschlange leer</div>';
  } else {
    listDiv.innerHTML = '';
    queue.forEach((c, i) => {
      const isYou = uid && c.twitchId === uid;
      const teamIcons = (c.team || []).map(p => `<img src="${getIconPath(p.speciesId)}" alt="${p.name}">`).join('');
      const div = document.createElement('div');
      div.className = `queue-item${isYou ? ' is-you' : ''}`;
      div.innerHTML = `
        <span class="pos">#${i + 1}</span>
        <img class="avatar-small" src="${c.profileImage || ''}" alt="" onerror="this.style.display='none'">
        <div class="info">
          <div class="name">${c.displayName}${isYou ? ' (Du)' : ''}</div>
        </div>
        <div class="team-icons">${teamIcons}</div>
      `;
      listDiv.appendChild(div);
    });
  }
}

function renderLeaderboard() {
  const lbDiv = document.getElementById('leaderboard');
  const lb = gymState.leaderboard || [];
  if (lb.length === 0) {
    lbDiv.innerHTML = '<div class="queue-empty">Noch keine Badges vergeben</div>';
    return;
  }
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
