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
// Use lobby redirect (already registered in Twitch app)
const REDIRECT_URI = window.location.origin + '/lobby/';
const STREAMER_IDS = ['647322993']; // janemmel

let currentUser = null; // { id, login, display_name, profile_image_url }
let sessionId = null;
let sessionCode = null;
let sessionConfig = null;
let trainers = [];
let pokemonData = {};
let trainerSprites = [];
let activeVote = null;
let activeGimmicks = [];
let streamerParty = [];
let currentWave = 0;
let winWave = 200;
let nuzlockeCatch = false;

// --- Trainer Profile (localStorage) ---
function loadProfile() {
  try { return JSON.parse(localStorage.getItem('emmelrogue_profile') || '{}'); } catch { return {}; }
}
function saveProfile() {
  const profile = {
    spriteKey: document.getElementById('profile-sprite-preview').dataset.spriteKey || null,
    intro: document.getElementById('profile-intro').value.trim(),
    victory: document.getElementById('profile-victory').value.trim(),
    defeat: document.getElementById('profile-defeat').value.trim(),
    anonymous: document.getElementById('profile-anon').checked,
  };
  localStorage.setItem('emmelrogue_profile', JSON.stringify(profile));
}
// --- Team Presets (localStorage) ---
let presetEditIndex = -1; // -1 = not editing preset, 0-2 = editing preset slot

function loadPresets() {
  try { return JSON.parse(localStorage.getItem('emmelrogue_presets') || '[]'); } catch { return []; }
}
function savePreset(index, team) {
  const presets = loadPresets();
  presets[index] = team;
  localStorage.setItem('emmelrogue_presets', JSON.stringify(presets));
  updatePresetButtons();
}
function updatePresetButtons() {
  const presets = loadPresets();
  for (let i = 0; i < 3; i++) {
    const card = document.getElementById(`preset-${i}`);
    const iconsEl = document.getElementById(`preset-icons-${i}`);
    if (!card || !iconsEl) continue;
    const team = presets[i];
    if (team && team.length > 0) {
      card.classList.add('has-team');
      card.title = team.map(p => p.name).join(', ');
      iconsEl.innerHTML = team.map(p => {
        const src = p.speciesId ? getIconPath(p.speciesId) : '';
        return src ? `<img src="${src}" alt="${p.name}" title="${p.name} (${p.cost})" onerror="this.style.display='none'">` : '';
      }).join('');
    } else {
      card.classList.remove('has-team');
      card.title = 'Klicken um Team zu bauen';
      iconsEl.innerHTML = '<span class="preset-card-empty">leer</span>';
    }
  }
}
function openPresetEditor(index) {
  presetEditIndex = index;
  editingWave = null;
  editingTrainer = null;
  // Use max budget (48) for presets — actual budget check happens at claim time
  editBudget = 48;
  const presets = loadPresets();
  const team = presets[index] || [];
  editParty = team.map(p => ({
    speciesId: p.speciesId,
    name: p.name || pokemonData[String(p.speciesId)]?.name_de || 'Unknown',
    cost: p.cost || pokemonData[String(p.speciesId)]?.cost || 0,
    shiny: p.shiny || false,
    nickname: null,
  }));
  document.getElementById('modal-wave').textContent = `Preset ${index + 1}`;
  document.getElementById('budget-max').textContent = '∞';
  renderPartySlots();
  renderPokemonGrid();
  document.getElementById('team-modal').style.display = 'flex';
  document.getElementById('pokemon-search').value = '';
}
// Get the best fitting preset for a given budget
function getPresetForBudget(budget) {
  const presets = loadPresets();
  // Try presets 0, 1, 2 — return first that fits budget
  for (const team of presets) {
    if (!team || team.length === 0) continue;
    const totalCost = team.reduce((sum, p) => sum + (p.cost || 0), 0);
    if (totalCost <= budget) return team;
  }
  // No preset fits — try trimming the first preset with a team
  for (const team of presets) {
    if (!team || team.length === 0) continue;
    // Take as many pokemon as budget allows (from front)
    const trimmed = [];
    let remaining = budget;
    for (const p of team) {
      if ((p.cost || 0) <= remaining) {
        trimmed.push(p);
        remaining -= (p.cost || 0);
      }
    }
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function loadPresetIntoEditor(index) {
  const presets = loadPresets();
  const team = presets[index];
  if (!team || team.length === 0) {
    showToast(`Team ${index + 1} ist leer`, true);
    return;
  }
  const maxSlots = getEditMaxSlots();
  // Trim to budget if not in preset edit mode
  if (presetEditIndex >= 0) {
    editParty = team.slice(0, 6).map(p => ({
      speciesId: p.speciesId,
      name: p.name || pokemonData[String(p.speciesId)]?.name_de || 'Unknown',
      cost: p.cost || pokemonData[String(p.speciesId)]?.cost || 0,
      shiny: p.shiny || false, nickname: null,
    }));
  } else {
    editParty = [];
    let remaining = editBudget;
    for (const p of team) {
      if (editParty.length >= maxSlots) break;
      const cost = pokemonData[String(p.speciesId)]?.cost || p.cost || 0;
      if (cost <= remaining) {
        editParty.push({
          speciesId: p.speciesId,
          name: p.name || pokemonData[String(p.speciesId)]?.name_de || 'Unknown',
          cost, shiny: p.shiny || false, nickname: null,
        });
        remaining -= cost;
      }
    }
    if (editParty.length === 0) {
      showToast(`Team ${index + 1} passt nicht ins Budget (${editBudget})`, true);
      return;
    }
    if (editParty.length < team.length) {
      showToast(`${editParty.length}/${team.length} Pokemon passen ins Budget`);
    }
  }
  renderPartySlots();
}

function initProfile() {
  const p = loadProfile();
  if (p.intro) document.getElementById('profile-intro').value = p.intro;
  if (p.victory) document.getElementById('profile-victory').value = p.victory;
  if (p.defeat) document.getElementById('profile-defeat').value = p.defeat;
  if (p.anonymous !== undefined) document.getElementById('profile-anon').checked = p.anonymous;
  if (p.spriteKey) renderProfileSprite(p.spriteKey);
  // Auto-Save bei jeder Änderung
  ['profile-intro', 'profile-victory', 'profile-defeat'].forEach(id => {
    document.getElementById(id).addEventListener('input', saveProfile);
  });
  document.getElementById('profile-anon').addEventListener('change', saveProfile);
  updatePresetButtons();
}
function renderProfileSprite(spriteKey) {
  const el = document.getElementById('profile-sprite-preview');
  el.dataset.spriteKey = spriteKey;
  const spriteData = trainerSprites.find(s => s.key === spriteKey);
  if (spriteData?.frame) {
    const f = spriteData.frame;
    const scale = Math.min(60 / f.w, 60 / f.h);
    const sw = Math.round(f.sw * scale);
    const sh = Math.round(f.sh * scale);
    const ox = Math.round(-f.x * scale);
    const oy = Math.round(-f.y * scale);
    const dw = Math.round(f.w * scale);
    const dh = Math.round(f.h * scale);
    el.innerHTML = `<div style="width:${dw}px;height:${dh}px;margin:auto;background:url('/images/trainer/${spriteKey}.png') ${ox}px ${oy}px / ${sw}px ${sh}px no-repeat;image-rendering:pixelated;"></div>`;
  } else {
    el.innerHTML = `<img src="/images/trainer/${spriteKey}.png" alt="${spriteKey}" style="width:60px;height:60px;object-fit:contain;image-rendering:pixelated;" onerror="this.parentElement.innerHTML='<span class=profile-sprite-label>Sprite</span>'">`;
  }
}
function openProfileSpriteModal() {
  spriteModalWave = null;
  spriteModalClaimMode = false;
  document.getElementById('sprite-search').value = '';
  const anonRow = document.getElementById('sprite-modal-anon-row');
  if (anonRow) anonRow.style.display = 'none';
  const skipBtn = document.getElementById('sprite-modal-skip');
  if (skipBtn) skipBtn.style.display = 'none';
  const titleEl = document.getElementById('sprite-modal-title');
  if (titleEl) titleEl.textContent = 'Profil-Sprite wählen';
  renderSpriteGrid('', loadProfile().spriteKey);
  document.getElementById('sprite-modal').style.display = 'flex';
  // Override select behavior for profile
  document.getElementById('sprite-modal').dataset.profileMode = 'true';
}

// --- Pending Claims (optimistic UI lock) ---
let pendingClaimWaves = new Set(); // waves currently being claimed (disabled in UI)

// --- Team Editor State ---
let editingWave = null;
let editingTrainer = null;
let editParty = [];
let editBudget = 0;

// --- Socket.io ---
const socket = io({ transports: ['websocket', 'polling'] });

// --- Init ---
window.addEventListener('DOMContentLoaded', async () => {
  // Check for OAuth callback (redirected from lobby)
  handleOAuthCallback();

  // Load stored user (from localStorage, shared between lobby and community)
  loadUser();

  // Load pokemon data
  try {
    const [pdRes, spRes] = await Promise.all([
      fetch('/api/pokemon-data'),
      fetch('/api/trainer-sprites'),
    ]);
    pokemonData = await pdRes.json();
    trainerSprites = await spRes.json();
  } catch (e) {
    console.error('Failed to load data:', e);
  }

  // Check URL params for code
  const urlParams = new URLSearchParams(window.location.search);
  const codeParam = urlParams.get('code');

  if (codeParam) {
    joinByCode(codeParam);
  } else {
    // Auto-search for active sessions
    pollForSession();
  }

  // Setup UI handlers
  setupUI();
  setupSocket();
});

// --- Twitch OAuth ---
// OAuth flow: community → Twitch → /lobby/ (registered redirect) → community
// The lobby.js handles the token, stores in localStorage, then redirects back here.
// So we just load from localStorage on init. No hash parsing needed on this page.
function handleOAuthCallback() {
  // Nothing to do here — lobby handles the OAuth redirect and stores user in localStorage.
  // The loadUser() function below picks it up from localStorage.
}

function loadUser() {
  // Try community-specific localStorage
  let stored = localStorage.getItem('twitch_community_user');
  if (stored) {
    try {
      currentUser = JSON.parse(stored);
      updateUserUI();
      return;
    } catch (e) {
      localStorage.removeItem('twitch_community_user');
    }
  }
  // Fallback: try lobby sessionStorage (if user logged in there)
  stored = sessionStorage.getItem('twitch-user');
  if (stored) {
    try {
      currentUser = JSON.parse(stored);
      localStorage.setItem('twitch_community_user', stored);
      updateUserUI();
    } catch (e) { /* ignore */ }
  }
}

function updateUserUI() {
  const loginBtn = document.getElementById('btn-login');
  const userInfo = document.getElementById('user-info');
  const configBtn = document.getElementById('btn-config');
  const streamerCreate = document.getElementById('streamer-create');

  if (currentUser) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'flex';
    document.getElementById('user-avatar').src = currentUser.profile_image_url;
    document.getElementById('user-name').textContent = currentUser.display_name;

    // Show config button + create button for streamer
    if (STREAMER_IDS.includes(currentUser.id)) {
      configBtn.style.display = 'flex';
      if (!sessionId) streamerCreate.style.display = 'block';
    }
  } else {
    loginBtn.style.display = 'inline-flex';
    userInfo.style.display = 'none';
    configBtn.style.display = 'none';
    streamerCreate.style.display = 'none';
  }
}

function loginTwitch() {
  // Store current URL so we can redirect back after OAuth
  localStorage.setItem('twitch_auth_return', window.location.href);
  // Redirect to Twitch OAuth via lobby redirect (which is registered)
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=`;
  window.location.href = url;
}

function logoutTwitch() {
  currentUser = null;
  localStorage.removeItem('twitch_community_user');
  localStorage.removeItem('twitch_community_token');
  updateUserUI();
}

// --- Session Management ---
async function pollForSession() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    const active = sessions.find(s => s.status === 'active');

    if (active) {
      joinSession(active.sessionId, active.code);
    } else {
      document.getElementById('auto-search').innerHTML = '<p class="muted">Kein aktiver Run gefunden. Gib einen Code ein oder warte...</p>';
      // Show create button for streamer
      if (currentUser && STREAMER_IDS.includes(currentUser.id)) {
        document.getElementById('streamer-create').style.display = 'block';
      }
      // Retry in 5 seconds
      setTimeout(pollForSession, 5000);
    }
  } catch (e) {
    console.error('Session poll error:', e);
    setTimeout(pollForSession, 5000);
  }
}

async function joinByCode(code) {
  code = code.toUpperCase().trim();
  if (code.length !== 4) {
    showJoinError('Code muss 4 Zeichen haben');
    return;
  }

  try {
    const res = await fetch(`/api/session/by-code/${code}`);
    if (!res.ok) {
      showJoinError('Session nicht gefunden');
      return;
    }
    const data = await res.json();
    joinSession(data.sessionId, code);
    // Update URL without reload
    history.replaceState(null, '', `?code=${code}`);
  } catch (e) {
    showJoinError('Verbindungsfehler');
  }
}

function showJoinError(msg) {
  const el = document.getElementById('join-error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

async function createSession() {
  try {
    const res = await fetch('/api/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.success) {
      joinSession(data.sessionId, data.code);
      showToast(`Session erstellt! Code: ${data.code}`);
    } else {
      showToast(data.error || 'Fehler', true);
    }
  } catch (e) {
    showToast('Verbindungsfehler', true);
  }
}

function joinSession(id, code) {
  sessionId = id;
  sessionCode = code;
  socket.emit('COMMUNITY_JOIN', { sessionId: id });

  // Update URL
  if (code) {
    history.replaceState(null, '', `?code=${code}`);
  }
}

// --- Socket Events ---
function setupSocket() {
  socket.on('CHAT_SESSION_STATE', (data) => {
    sessionId = data.sessionId;
    sessionCode = data.code || sessionCode;
    sessionConfig = data.config;
    activeVote = data.activeVote;
    activeGimmicks = data.activeGimmicks || [];
    streamerParty = data.streamerParty || [];
    nuzlockeCatch = data.nuzlockeCatch || false;

    document.getElementById('no-session').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';
    document.getElementById('session-info').style.display = 'flex';

    currentWave = data.currentWave || 0;
    winWave = data.winWave || 200;
    document.getElementById('current-wave').textContent = currentWave;
    document.getElementById('current-biome').textContent = data.currentBiome || '—';
    document.getElementById('session-code').textContent = sessionCode || '—';

    // Show share bar
    if (sessionCode) {
      const shareUrl = `${window.location.origin}/community/?code=${sessionCode}`;
      document.getElementById('share-url').value = shareUrl;
      document.getElementById('share-bar').style.display = 'flex';
    }

    // Show profile if user is logged in
    if (currentUser) {
      document.getElementById('profile-section').style.display = '';
      initProfile();
    }

    renderStreamerParty();
    renderTrainers();
    renderVote();
    renderGimmicks();
    updateConfigPanel();
  });

  socket.on('CHAT_TRAINER_LIST', (data) => {
    trainers = data.trainers || [];
    renderTrainers();
  });

  socket.on('CHAT_WAVE_PROGRESS', (data) => {
    currentWave = data.wave;
    document.getElementById('current-wave').textContent = data.wave;
    if (data.biome) document.getElementById('current-biome').textContent = data.biome;
  });

  socket.on('CHAT_STREAMER_PARTY', (data) => {
    streamerParty = data.party || [];
    renderStreamerParty();
  });

  socket.on('CHAT_TRAINER_CLAIMED', (data) => {
    pendingClaimWaves.delete(data.wave);
    const t = trainers.find(t => t.waveIndex === data.wave);
    if (t) {
      t.claimedBy = data.claimedBy;
      t.claimedByName = data.claimedByName;
      t.anonymous = !!data.anonymous;
      if (data.spriteKey) t.spriteKey = data.spriteKey;
      if (data.trainerLines) t.trainerLines = data.trainerLines;
    } else {
      // Neuer Custom Trainer (war freie Welle) — in lokale Liste aufnehmen
      trainers.push({
        waveIndex: data.wave, claimedBy: data.claimedBy, claimedByName: data.claimedByName,
        anonymous: !!data.anonymous, spriteKey: data.spriteKey || null,
        trainerLines: data.trainerLines || null, category: 'custom',
        trainerClass: 'Custom', isCustomInserted: true,
        customParty: [], originalParty: [], pokemonNicknames: {},
      });
    }
    renderTrainers();
  });

  socket.on('CHAT_TRAINER_UNCLAIMED', (data) => {
    const t = trainers.find(t => t.waveIndex === data.wave);
    if (t) {
      t.claimedBy = null;
      t.claimedByName = null;
      t.customSprite = null;
      t.customParty = null;
      t.pokemonNicknames = {};
      renderTrainers();
    }
  });

  socket.on('CHAT_TEAM_EDITED', (data) => {
    const t = trainers.find(t => t.waveIndex === data.wave);
    if (t) {
      t.customParty = data.customParty;
      renderTrainers();
    }
  });

  socket.on('CHAT_SPRITE_CHANGED', (data) => {
    const t = trainers.find(t => t.waveIndex === data.wave);
    if (t) {
      t.spriteKey = data.spriteKey;
      renderTrainers();
    }
  });

  socket.on('CHAT_POKEMON_CLAIMED', (data) => {
    const t = trainers.find(t => t.waveIndex === data.wave);
    if (t) {
      if (!t.pokemonNicknames) t.pokemonNicknames = {};
      t.pokemonNicknames[data.slot] = data.nickname;
      renderTrainers();
    }
  });

  socket.on('CHAT_LINES_UPDATED', (data) => {
    const t = trainers.find(t => t.waveIndex === data.wave);
    if (t) {
      t.trainerLines = data.trainerLines;
      renderTrainers();
    }
  });

  socket.on('COMMUNITY_LINES_RESULT', (data) => {
    if (data.success) {
      showToast('Sprüche gespeichert!');
      document.getElementById('lines-modal').style.display = 'none';
    } else {
      showToast(data.error || 'Fehler beim Speichern', 'error');
    }
  });

  socket.on('CHAT_VOTE_UPDATE', (data) => {
    activeVote = data;
    renderVote();
  });

  socket.on('CHAT_VOTE_RESULT', (data) => {
    activeVote = null;
    renderVote();
    if (data.winner) {
      showToast(`Abstimmung beendet: ${data.winner.label} gewinnt!`);
    }
  });

  socket.on('CHAT_GIMMICK_ACTIVATED', (data) => {
    activeGimmicks = activeGimmicks.filter(g => g.id !== data.gimmickId);
    activeGimmicks.push({ id: data.gimmickId, label: data.label, remainingWaves: data.duration });
    renderGimmicks();
    showToast(`Gimmick aktiviert: ${data.label}`);
  });

  socket.on('CHAT_GIMMICK_STATE', (data) => {
    activeGimmicks = data.activeGimmicks || [];
    renderGimmicks();
  });

  socket.on('CHAT_CONFIG_CHANGED', (data) => {
    sessionConfig = data.config;
    updateConfigPanel();
  });

  socket.on('CHAT_NUZLOCKE_CHANGED', (data) => {
    nuzlockeCatch = data.nuzlockeCatch || false;
    renderTrainers();
  });

  socket.on('CHAT_WIN_WAVE_CHANGED', (data) => {
    winWave = data.winWave || 200;
  });

  socket.on('CHAT_SESSION_ENDED', () => {
    sessionId = null;
    sessionCode = null;
    trainers = [];
    streamerParty = [];
    document.getElementById('no-session').style.display = 'flex';
    document.getElementById('main-content').style.display = 'none';
    document.getElementById('session-info').style.display = 'none';
    document.getElementById('share-bar').style.display = 'none';
    showToast('Session beendet');
    history.replaceState(null, '', window.location.pathname);
    setTimeout(pollForSession, 3000);
  });

  // New session became available while we're on the "no session" screen
  socket.on('CHAT_SESSION_AVAILABLE', (data) => {
    if (!sessionId && data.sessionId) {
      joinSession(data.sessionId, data.code);
    }
  });

  socket.on('CHAT_ERROR', (data) => {
    showToast(data.message || 'Fehler', true);
  });

  // Claim results
  socket.on('COMMUNITY_CLAIM_RESULT', (data) => {
    // Clear all pending claims on result (success or error)
    pendingClaimWaves.clear();
    if (!data.success) {
      showToast(data.error, true);
      renderTrainers(); // re-render to re-enable buttons
    } else {
      const wave = data.waveIndex || null;
      const requested = data.requestedWave || null;
      if (wave && requested && wave !== requested) {
        showToast(`Welle ${requested} war vergeben — du hast Welle ${wave} bekommen!`);
      } else {
        showToast(wave ? `Trainer Welle ${wave} geclaimed!` : 'Trainer geclaimed!');
      }
      // If claimed via "Anpassen" flow, auto-open team editor
      if (pendingClaimCustomize && wave) {
        pendingClaimCustomize = false;
        // Wait for CHAT_TRAINER_CLAIMED to update trainers array, then open editor
        setTimeout(() => {
          const t = trainers.find(t => t.waveIndex === wave);
          if (t && t.claimedBy === currentUser?.id) {
            openTeamEditor(t);
          }
        }, 300);
      }
    }
  });

  socket.on('COMMUNITY_EDIT_RESULT', (data) => {
    if (!data.success) {
      showToast(data.error, true);
    } else {
      showToast('Team gespeichert!');
      closeTeamModal();
    }
  });

  socket.on('COMMUNITY_POKEMON_RESULT', (data) => {
    if (!data.success) {
      showToast(data.error, true);
    } else {
      showToast('Pokemon geclaimed!');
    }
  });

  socket.on('COMMUNITY_INSERT_RESULT', (data) => {
    // Remove from pending
    if (data.trainer?.waveIndex) pendingClaimWaves.delete(data.trainer.waveIndex);
    if (!data.success) {
      showToast(data.error, true);
    } else {
      showToast('Trainer erstellt!');
    }
    renderTrainers();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
  });

  socket.on('reconnect', () => {
    if (sessionId) {
      socket.emit('COMMUNITY_JOIN', { sessionId });
    }
  });
}

// --- UI Setup ---
function setupUI() {
  document.getElementById('btn-login').addEventListener('click', loginTwitch);
  document.getElementById('btn-logout').addEventListener('click', logoutTwitch);

  // Join by code
  document.getElementById('btn-join-code').addEventListener('click', () => {
    const code = document.getElementById('join-code').value;
    joinByCode(code);
  });
  document.getElementById('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      joinByCode(e.target.value);
    }
  });

  // Create session (streamer)
  document.getElementById('btn-create-session').addEventListener('click', createSession);

  // Copy share URL
  document.getElementById('btn-copy-url').addEventListener('click', () => {
    const url = document.getElementById('share-url').value;
    navigator.clipboard.writeText(url).then(() => showToast('URL kopiert!'));
  });

  // Session code badge click to copy
  document.getElementById('session-code-badge').addEventListener('click', () => {
    if (sessionCode) {
      navigator.clipboard.writeText(sessionCode).then(() => showToast('Code kopiert!'));
    }
  });

  // Config panel
  document.getElementById('btn-config').addEventListener('click', () => {
    const panel = document.getElementById('config-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btn-close-config').addEventListener('click', () => {
    document.getElementById('config-panel').style.display = 'none';
  });

  // Config changes
  document.getElementById('cfg-enabled').addEventListener('change', sendConfigUpdate);
  document.getElementById('cfg-custom-trainers').addEventListener('change', sendConfigUpdate);
  document.getElementById('cfg-shiny').addEventListener('change', sendConfigUpdate);
  document.getElementById('cfg-claim-mode').addEventListener('change', () => {
    const mode = document.getElementById('cfg-claim-mode').value;
    document.getElementById('cfg-max-claims-row').style.display = mode === 'limit_per_person' ? '' : 'none';
    sendConfigUpdate();
  });
  document.getElementById('cfg-max-claims').addEventListener('change', sendConfigUpdate);
  document.getElementById('cfg-wave-buffer').addEventListener('change', sendConfigUpdate);
  document.getElementById('cfg-max-text-length').addEventListener('input', () => applyTextLimit(document.getElementById('cfg-max-text-length').value));
  document.getElementById('cfg-max-text-length').addEventListener('change', sendConfigUpdate);
  document.getElementById('cfg-surprise').addEventListener('change', sendConfigUpdate);

  // Vote start
  document.getElementById('btn-start-vote').addEventListener('click', startVote);

  // Gimmick activate
  document.getElementById('btn-activate-gimmick').addEventListener('click', activateGimmick);

  // Team modal
  document.getElementById('btn-close-modal').addEventListener('click', closeTeamModal);
  document.getElementById('btn-cancel-team').addEventListener('click', closeTeamModal);
  document.getElementById('btn-save-team').addEventListener('click', saveTeam);
  document.getElementById('btn-random-team').addEventListener('click', generateRandomTeam);
  document.getElementById('btn-load-last-team').addEventListener('click', loadLastTeam);

  // Pokemon search (team editor) — also filters grid
  const searchInput = document.getElementById('pokemon-search');
  searchInput.addEventListener('input', () => { handlePokemonSearch(); filterPokemonGrid(searchInput.value); });
  searchInput.addEventListener('focus', handlePokemonSearch);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.pokemon-search')) {
      document.getElementById('pokemon-suggestions').style.display = 'none';
      document.getElementById('insert-pokemon-suggestions').style.display = 'none';
    }
  });

  // Sprite modal
  document.getElementById('btn-close-sprite').addEventListener('click', closeSpriteModal);
  document.getElementById('sprite-modal').addEventListener('click', (e) => {
    if (e.target.id === 'sprite-modal') closeSpriteModal();
  });
  document.getElementById('sprite-search').addEventListener('input', (e) => {
    const trainer = trainers.find(t => t.waveIndex === spriteModalWave);
    renderSpriteGrid(e.target.value, trainer?.spriteKey);
  });

  // Lines (Sprüche) modal
  document.getElementById('btn-close-lines').addEventListener('click', () => {
    document.getElementById('lines-modal').style.display = 'none';
  });
  document.getElementById('lines-modal').addEventListener('click', (e) => {
    if (e.target.id === 'lines-modal') document.getElementById('lines-modal').style.display = 'none';
  });
  document.getElementById('btn-save-lines').addEventListener('click', saveLinesModal);

  // Insert trainer modal
  // btn-insert-trainer entfernt — alle Wellen sind direkt im Grid claimbar
  document.getElementById('btn-close-insert').addEventListener('click', closeInsertModal);
  document.getElementById('btn-cancel-insert').addEventListener('click', closeInsertModal);
  document.getElementById('btn-save-insert').addEventListener('click', saveInsertTrainer);
  document.getElementById('insert-wave').addEventListener('input', onInsertWaveChange);
  document.getElementById('btn-insert-random-team').addEventListener('click', generateInsertRandomTeam);
  document.getElementById('btn-insert-load-last').addEventListener('click', loadInsertLastTeam);
  const insertSearch = document.getElementById('insert-pokemon-search');
  insertSearch.addEventListener('input', () => { handleInsertPokemonSearch(); renderInsertPokemonGrid(insertSearch.value); });
  insertSearch.addEventListener('focus', handleInsertPokemonSearch);
}

// --- Render Streamer Party ---
function renderStreamerParty() {
  const container = document.getElementById('streamer-party');
  const section = document.getElementById('team-section');

  if (!streamerParty || streamerParty.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = '';

  for (const p of streamerParty) {
    const card = document.createElement('div');
    card.className = 'party-member';
    if (p.hp <= 0) card.classList.add('fainted');
    if (p.shiny) card.classList.add('shiny');

    const hpPct = p.maxHp > 0 ? (p.hp / p.maxHp * 100) : 0;
    const hpColor = hpPct > 50 ? 'var(--green)' : hpPct > 25 ? 'var(--yellow)' : 'var(--red)';

    const iconId = p.iconId || p.speciesId;
    const iconSrc = iconId ? getIconPath(String(iconId).replace('s', '').replace(/-.*/, '')) : '';

    card.innerHTML = `
      ${iconSrc ? `<img src="${iconSrc}" class="pm-icon" style="width:32px;height:32px;image-rendering:pixelated;" onerror="this.style.display='none'">` : ''}
      <div class="pm-name">${p.shiny ? '&#10024; ' : ''}${p.name}</div>
      <div class="pm-level">Lv.${p.level}</div>
      <div class="pm-hp-bar">
        <div class="pm-hp-fill" style="width:${hpPct}%; background:${hpColor}"></div>
      </div>
      <div class="pm-hp-text">${p.hp}/${p.maxHp}</div>
    `;

    container.appendChild(card);
  }
}

// --- Render All Waves as Grid ---
function renderTrainers() {
  const grid = document.getElementById('trainer-grid');
  const noTrainers = document.getElementById('no-trainers');
  grid.innerHTML = '';

  if (!sessionId) { noTrainers.style.display = 'block'; return; }
  noTrainers.style.display = 'none';

  const buffer = sessionConfig?.waveBuffer || 2;
  // Build lookup from registered trainers
  const trainerMap = {};
  for (const t of trainers) trainerMap[t.waveIndex] = t;

  for (let w = 1; w <= winWave; w++) {
    const t = trainerMap[w]; // registered trainer or undefined (free wave)
    const isPassed = w <= currentWave;
    const isLocked = !isPassed && w <= currentWave + buffer;
    const isNuzlockeBlocked = nuzlockeCatch && w % 10 === 1 && !isPassed && !isLocked;
    const isClaimed = t?.claimedBy;
    const isFixed = t?.isFixed;

    const card = document.createElement('div');
    card.className = 'trainer-card';
    if (isPassed) card.classList.add('passed');
    if (isLocked || isNuzlockeBlocked) card.classList.add('locked');
    if (isClaimed) card.classList.add('claimed');
    if (!t && !isPassed && !isLocked) card.classList.add('free-wave');

    // Status
    let statusText, statusClass;
    if (isPassed) { statusText = 'Vorbei'; statusClass = 'status-locked'; }
    else if (isNuzlockeBlocked) { statusText = 'Nuzlocke-Fang'; statusClass = 'status-locked'; }
    else if (isLocked) { statusText = 'Gesperrt'; statusClass = 'status-locked'; }
    else if (isClaimed) { statusText = `@${t.claimedByName}`; statusClass = 'status-claimed'; }
    else if (isFixed) { statusText = 'Fester Trainer'; statusClass = 'status-locked'; }
    else { statusText = 'Frei'; statusClass = 'status-available'; }

    // Sprite
    let spriteHtml = '';
    const spriteKey = t?.spriteKey;
    if (spriteKey) {
      const spriteData = trainerSprites.find(s => s.key === spriteKey);
      if (spriteData?.frame) {
        const f = spriteData.frame;
        const scale = Math.min(64 / f.w, 64 / f.h);
        const sw = Math.round(f.sw * scale), sh = Math.round(f.sh * scale);
        const ox = Math.round(-f.x * scale), oy = Math.round(-f.y * scale);
        const dw = Math.round(f.w * scale), dh = Math.round(f.h * scale);
        spriteHtml = `<div style="width:${dw}px;height:${dh}px;margin:auto;background:url('/images/trainer/${spriteKey}.png') ${ox}px ${oy}px / ${sw}px ${sh}px no-repeat;image-rendering:pixelated;"></div>`;
      } else {
        spriteHtml = `<img src="/images/trainer/${spriteKey}.png" style="width:64px;height:64px;object-fit:contain;image-rendering:pixelated;" onerror="this.style.display='none'">`;
      }
    }

    // Party dots (compact)
    const party = t ? (t.customParty || t.originalParty || []) : [];
    const partyHtml = party.length > 0
      ? `<div class="card-party">${party.map((p, i) => {
          const sid = p.speciesId || 0;
          const src = sid ? getIconPath(sid) : '';
          return src ? `<div class="party-dot" data-wave="${w}" data-slot="${i}"><img src="${src}" class="party-icon" onerror="this.style.display='none'"></div>` : '';
        }).join('')}</div>`
      : '';

    // Sprüche
    const lines = t?.trainerLines;
    const linesHtml = lines && (lines.intro || lines.victory || lines.defeat)
      ? `<div class="card-lines">${lines.intro ? `<span>"${lines.intro}"</span>` : ''}</div>` : '';

    // Category label
    const catLabel = t ? formatCategory(t.category) : '';
    const catClass = t ? `cat-${t.category}` : '';

    card.innerHTML = `
      <span class="card-wave">W${w}</span>
      ${catLabel ? `<span class="card-category ${catClass}">${catLabel}</span>` : ''}
      ${spriteHtml ? `<div class="card-sprite">${spriteHtml}</div>` : ''}
      ${t ? `<div class="card-class">${t.trainerClass || ''}</div>` : ''}
      ${linesHtml}
      ${partyHtml}
      <div class="card-status ${statusClass}">${statusText}</div>
      <div class="card-actions" data-wave="${w}"></div>
    `;

    // Actions
    const actions = card.querySelector('.card-actions');
    if (!isPassed && !isLocked && !isNuzlockeBlocked && !isFixed && currentUser) {
      if (pendingClaimWaves.has(w)) {
        actions.innerHTML = '<span class="claiming-indicator">Claiming...</span>';
      } else if (!isClaimed) {
        // Free wave or unclaimed trainer — claim button
        const claimBtn = document.createElement('button');
        claimBtn.className = 'btn btn-small btn-accent';
        claimBtn.textContent = 'Claim';
        claimBtn.addEventListener('click', () => claimTrainerWithProfile(w));
        actions.appendChild(claimBtn);
      } else if (t.claimedBy === currentUser.id) {
        // Own claim — edit buttons
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-small';
        editBtn.textContent = 'Team';
        editBtn.addEventListener('click', () => openTeamEditor(t));
        actions.appendChild(editBtn);

        const spriteBtn = document.createElement('button');
        spriteBtn.className = 'btn btn-small';
        spriteBtn.textContent = 'Sprite';
        spriteBtn.addEventListener('click', () => openSpriteModal(t.waveIndex, t.spriteKey));
        actions.appendChild(spriteBtn);

        const linesBtn = document.createElement('button');
        linesBtn.className = 'btn btn-small';
        linesBtn.textContent = 'Sprüche';
        linesBtn.addEventListener('click', () => openLinesModal(t));
        actions.appendChild(linesBtn);
      }
      // Admin unclaim
      if (isClaimed && isStreamer()) {
        const unclaimBtn = document.createElement('button');
        unclaimBtn.className = 'btn btn-small btn-danger';
        unclaimBtn.textContent = 'X';
        unclaimBtn.title = 'Unclaim';
        unclaimBtn.addEventListener('click', () => unclaimTrainer(w));
        actions.appendChild(unclaimBtn);
      }
    }

    grid.appendChild(card);
  }
}

// (claimWaveWithProfile + insertTrainerWithProfile entfernt — alles über claimTrainerWithProfile)

function isStreamer() {
  return currentUser && STREAMER_IDS.includes(currentUser.id);
}

// --- Actions ---
function claimTrainerWithProfile(wave) {
  const p = loadProfile();
  const lines = { intro: p.intro || '', victory: p.victory || '', defeat: p.defeat || '' };
  // Find trainer data to get budget for this wave
  const t = trainers.find(t => t.waveIndex === wave);
  const budget = t?.budget || getInsertBudget(wave);
  const presetTeam = getPresetForBudget(budget);
  claimTrainer(wave, p.anonymous !== undefined ? p.anonymous : true, p.spriteKey || null, lines, presetTeam);
}

function claimTrainer(wave, anonymous, spriteKey, trainerLines, presetParty) {
  if (!currentUser || !sessionId) return;
  if (pendingClaimWaves.has(wave)) return; // already claiming
  pendingClaimWaves.add(wave);
  renderTrainers(); // re-render to show "Claiming..." state
  socket.emit('COMMUNITY_CLAIM_TRAINER', {
    sessionId,
    wave,
    twitchUserId: currentUser.id,
    displayName: currentUser.display_name,
    anonymous: !!anonymous,
    spriteKey: spriteKey || null,
    trainerLines: trainerLines || null,
    presetParty: presetParty || null,
  });
}

function unclaimTrainer(wave) {
  if (!sessionId) return;
  if (!confirm(`Trainer Welle ${wave} wirklich unclaimen?`)) return;
  socket.emit('COMMUNITY_UNCLAIM_TRAINER', { sessionId, wave });
}

function claimPokemon(wave, slot) {
  if (!currentUser || !sessionId) return;
  socket.emit('COMMUNITY_CLAIM_POKEMON', {
    sessionId,
    wave,
    slot,
    twitchUserId: currentUser.id,
    displayName: currentUser.display_name,
  });
}

function toggleAnonymous(wave, anonymous) {
  if (!currentUser || !sessionId) return;
  socket.emit('COMMUNITY_TOGGLE_ANONYMOUS', {
    sessionId,
    wave,
    twitchUserId: currentUser.id,
    anonymous,
  });
}

// --- Team Editor ---
function getEditMaxSlots() {
  // Preset-Modus: immer 6 Slots
  if (presetEditIndex >= 0) return 6;
  // Use originalParty length if available, otherwise budget-based slots
  if (editingTrainer?.originalParty?.length) return editingTrainer.originalParty.length;
  return getInsertMaxSlots(editBudget || getInsertBudget(editingWave));
}

function openTeamEditor(trainer) {
  editingWave = trainer.waveIndex;
  editingTrainer = trainer;
  editBudget = trainer.budget || getInsertBudget(trainer.waveIndex);

  const party = trainer.customParty || trainer.originalParty || [];
  editParty = party.map(p => ({
    speciesId: p.speciesId,
    name: p.name || pokemonData[String(p.speciesId)]?.name_de || pokemonData[String(p.speciesId)]?.name || 'Unknown',
    cost: p.cost || pokemonData[String(p.speciesId)]?.cost || 0,
    shiny: p.shiny || false,
    nickname: p.nickname || null,
  }));

  document.getElementById('modal-wave').textContent = editingWave;
  document.getElementById('budget-max').textContent = editBudget;
  renderPartySlots();
  renderPokemonGrid();
  document.getElementById('team-modal').style.display = 'flex';
  document.getElementById('pokemon-search').value = '';
}

function closeTeamModal() {
  document.getElementById('team-modal').style.display = 'none';
  editingWave = null;
  editingTrainer = null;
  editParty = [];
}

function renderPartySlots() {
  const container = document.getElementById('party-slots');
  container.innerHTML = '';

  let totalCost = 0;
  const maxSlots = getEditMaxSlots();

  for (let i = 0; i < maxSlots; i++) {
    const p = editParty[i];
    const slot = document.createElement('div');
    slot.className = 'party-slot';

    if (p) {
      totalCost += p.cost;
      const iconSrc = p.speciesId ? getIconPath(p.speciesId) : '';
      const iconImg = iconSrc ? `<img src="${iconSrc}" alt="" style="width:32px;height:32px;image-rendering:pixelated;object-fit:contain;">` : '';
      slot.innerHTML = `
        <span class="slot-num">#${i + 1}</span>
        ${iconImg}
        <span class="slot-name">${p.name}</span>
        <span class="slot-cost">Kosten: ${p.cost}</span>
        <span class="btn-remove" data-index="${i}">X</span>
      `;
      slot.querySelector('.btn-remove').addEventListener('click', () => {
        editParty[i] = null;
        renderPartySlots();
      });
    } else {
      slot.innerHTML = `
        <span class="slot-num">#${i + 1}</span>
        <span class="slot-name" style="color: var(--text-muted)">Leer — Pokemon suchen</span>
      `;
    }

    container.appendChild(slot);
  }

  document.getElementById('budget-current').textContent = totalCost;
  const fill = document.getElementById('budget-fill');
  const pct = editBudget > 0 ? Math.min(100, (totalCost / editBudget) * 100) : 0;
  fill.style.width = pct + '%';
  fill.className = 'budget-fill' + (totalCost > editBudget ? ' over' : '');
}

function handlePokemonSearch() {
  const input = document.getElementById('pokemon-search');
  const suggestions = document.getElementById('pokemon-suggestions');
  const query = input.value.toLowerCase().trim();

  if (query.length < 2) {
    suggestions.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, data] of Object.entries(pokemonData)) {
    const deName = data.name_de || data.name;
    if (deName.toLowerCase().includes(query) || data.name.toLowerCase().includes(query)) {
      results.push({ id: parseInt(id), name: deName, nameEn: data.name, cost: data.cost });
    }
    if (results.length >= 20) break;
  }

  if (results.length === 0) {
    suggestions.style.display = 'none';
    return;
  }

  suggestions.innerHTML = '';
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    const iconSrc = getIconPath(r.id);
    const iconImg = `<img src="${iconSrc}" alt="" style="width:24px;height:24px;image-rendering:pixelated;vertical-align:middle;margin-right:4px;" onerror="this.style.display='none'">`;
    const formHint = r.nameEn.toLowerCase() !== r.name.toLowerCase() ? ` <small style="opacity:0.5">(${r.nameEn})</small>` : '';
    item.innerHTML = `<span>${iconImg}${r.name}${formHint}</span><span class="suggestion-cost">Kosten: ${r.cost}</span>`;
    item.addEventListener('click', () => {
      addPokemonToParty(r);
      suggestions.style.display = 'none';
      input.value = '';
    });
    suggestions.appendChild(item);
  }
  suggestions.style.display = 'block';
}

function addPokemonToParty(pokemon) {
  const maxSlots = getEditMaxSlots();
  let emptyIdx = -1;
  for (let i = 0; i < maxSlots; i++) {
    if (!editParty[i]) { emptyIdx = i; break; }
  }
  if (emptyIdx === -1) {
    showToast('Team ist voll!', true);
    return;
  }

  editParty[emptyIdx] = {
    speciesId: pokemon.id,
    name: pokemon.name,
    cost: pokemon.cost,
    shiny: false,
    nickname: null,
  };
  renderPartySlots();
}

function saveTeam() {
  // Preset-Modus: in localStorage speichern
  if (presetEditIndex >= 0) {
    const party = editParty.filter(p => p);
    savePreset(presetEditIndex, party);
    showToast(`Preset ${presetEditIndex + 1} gespeichert! (${party.length} Pokemon)`);
    presetEditIndex = -1;
    closeTeamModal();
    return;
  }

  if (!currentUser || !sessionId || !editingWave) return;

  const maxSlots = getEditMaxSlots();
  const party = [];
  for (let i = 0; i < maxSlots; i++) {
    if (editParty[i]) {
      party.push(editParty[i]);
    }
  }
  if (party.length === 0) {
    showToast('Mindestens ein Pokémon nötig!', true);
    return;
  }

  // Save to localStorage for "Load Last Team"
  saveLastTeam(party);

  socket.emit('COMMUNITY_EDIT_TEAM', {
    sessionId,
    wave: editingWave,
    twitchUserId: currentUser.id,
    newParty: party,
  });
}

// --- Insert Custom Trainer ---
// Check if a wave is blocked (fixed trainer or boss wave)
function isBlockedWave(wave) {
  // Every 10th wave is a boss battle (10, 20, 30, 40, ...)
  if (wave % 10 === 0) return true;
  // Fixed trainer waves from the game
  const fixed = [5,8,25,35,55,62,64,66,95,112,114,115,145,164,165,182,184,186,188,190,195];
  return fixed.includes(wave);
}

let insertWave = null;
let insertBudget = 0;
let insertMaxSlots = 0;
let insertParty = [];

function getInsertBudget(wave) {
  // Use budgetTiers from session config if available
  const tiers = sessionConfig?.budgetTiers;
  if (tiers && tiers.length > 0) {
    for (const tier of tiers) {
      if (wave <= tier.maxWave) return tier.budget;
    }
    return tiers[tiers.length - 1].budget;
  }
  // Fallback
  if (wave <= 10) return 6;
  if (wave <= 30) return 10;
  if (wave <= 50) return 16;
  if (wave <= 80) return 22;
  if (wave <= 120) return 30;
  if (wave <= 160) return 38;
  return 48;
}

function getInsertMaxSlots(budget) {
  return Math.min(6, Math.ceil(budget / 4));
}

function openInsertModal() {
  if (!currentUser || !sessionId) {
    showToast('Bitte einloggen', true);
    return;
  }
  insertWave = null;
  insertBudget = 0;
  insertMaxSlots = 0;
  insertParty = [];

  // Find first available wave (after buffer, not blocked, not already claimed)
  const buffer = sessionConfig?.waveBuffer || 2;
  const minWave = currentWave + buffer + 1;
  let firstAvailable = null;
  for (let w = minWave; w <= winWave; w++) {
    if (!isBlockedWave(w) && !trainers.find(t => t.waveIndex === w)) {
      firstAvailable = w;
      break;
    }
  }

  const waveInput = document.getElementById('insert-wave');
  if (firstAvailable) {
    waveInput.value = firstAvailable;
  } else {
    waveInput.value = '';
  }
  document.getElementById('insert-wave-info').textContent = '';
  document.getElementById('insert-budget-max').textContent = '0';
  document.getElementById('insert-budget-current').textContent = '0';
  document.getElementById('insert-budget-fill').style.width = '0%';
  document.getElementById('insert-party-slots').innerHTML = '<p class="muted" style="text-align:center">Welle eingeben um Team zu bauen</p>';
  document.getElementById('insert-modal').style.display = 'flex';
  document.getElementById('insert-pokemon-search').value = '';

  // Trigger wave change to validate and show budget
  if (firstAvailable) {
    onInsertWaveChange();
  }
}

function closeInsertModal() {
  document.getElementById('insert-modal').style.display = 'none';
  insertWave = null;
  insertParty = [];
}

function onInsertWaveChange() {
  const wave = parseInt(document.getElementById('insert-wave').value);
  const info = document.getElementById('insert-wave-info');

  if (!wave || wave < 1 || wave > winWave) {
    info.textContent = '';
    insertWave = null;
    document.getElementById('insert-party-slots').innerHTML = `<p class="muted" style="text-align:center">Gültige Welle eingeben (1-${winWave})</p>`;
    return;
  }

  // Check if wave has a fixed trainer
  if (isBlockedWave(wave)) {
    info.textContent = 'Fester Trainer — nicht verfügbar';
    info.style.color = 'var(--red, #ef4444)';
    insertWave = null;
    document.getElementById('insert-party-slots').innerHTML = '';
    return;
  }

  // Nuzlocke catch: X1 waves reserved for first encounter
  if (nuzlockeCatch && wave % 10 === 1) {
    info.textContent = 'Nuzlocke: Erster Fang — nicht verfügbar';
    info.style.color = 'var(--red, #ef4444)';
    insertWave = null;
    document.getElementById('insert-party-slots').innerHTML = '';
    return;
  }

  // Check if wave already has a trainer claim
  const existing = trainers.find(t => t.waveIndex === wave);
  if (existing) {
    info.textContent = existing.claimedBy ? `Bereits geclaimed von @${existing.claimedByName}` : 'Bereits registriert';
    info.style.color = 'var(--red, #ef4444)';
    insertWave = null;
    document.getElementById('insert-party-slots').innerHTML = '';
    return;
  }

  // Check wave buffer
  const buffer = sessionConfig?.waveBuffer || 2;
  if (wave <= currentWave + buffer) {
    info.textContent = `Zu nah! Mind. ${buffer} Wellen voraus`;
    info.style.color = 'var(--red, #ef4444)';
    insertWave = null;
    document.getElementById('insert-party-slots').innerHTML = '';
    return;
  }

  // Valid wave
  insertWave = wave;
  insertBudget = getInsertBudget(wave);
  insertMaxSlots = getInsertMaxSlots(insertBudget);
  insertParty = new Array(insertMaxSlots).fill(null);

  info.textContent = `Verfügbar! Budget: ${insertBudget}, max ${insertMaxSlots} Pokémon`;
  info.style.color = 'var(--green, #4ade80)';
  document.getElementById('insert-budget-max').textContent = insertBudget;

  renderInsertPartySlots();
  renderInsertPokemonGrid();
}

function renderInsertPartySlots() {
  const container = document.getElementById('insert-party-slots');
  container.innerHTML = '';

  let totalCost = 0;
  for (let i = 0; i < insertMaxSlots; i++) {
    const p = insertParty[i];
    const slot = document.createElement('div');
    slot.className = 'party-slot';

    if (p) {
      totalCost += p.cost;
      const iconSrc = p.speciesId ? getIconPath(p.speciesId) : '';
      const iconImg = iconSrc ? `<img src="${iconSrc}" alt="" style="width:32px;height:32px;image-rendering:pixelated;object-fit:contain;">` : '';
      slot.innerHTML = `
        <span class="slot-num">#${i + 1}</span>
        ${iconImg}
        <span class="slot-name">${p.name}</span>
        <span class="slot-cost">Kosten: ${p.cost}</span>
        <span class="btn-remove" data-index="${i}">X</span>
      `;
      slot.querySelector('.btn-remove').addEventListener('click', () => {
        insertParty[i] = null;
        renderInsertPartySlots();
      });
    } else {
      slot.innerHTML = `
        <span class="slot-num">#${i + 1}</span>
        <span class="slot-name" style="color: var(--text-muted)">Leer — Pokemon suchen</span>
      `;
    }

    container.appendChild(slot);
  }

  document.getElementById('insert-budget-current').textContent = totalCost;
  const fill = document.getElementById('insert-budget-fill');
  const pct = insertBudget > 0 ? Math.min(100, (totalCost / insertBudget) * 100) : 0;
  fill.style.width = pct + '%';
  fill.className = 'budget-fill' + (totalCost > insertBudget ? ' over' : '');
}

function handleInsertPokemonSearch() {
  const input = document.getElementById('insert-pokemon-search');
  const suggestions = document.getElementById('insert-pokemon-suggestions');
  const query = input.value.toLowerCase().trim();

  if (query.length < 2) {
    suggestions.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, data] of Object.entries(pokemonData)) {
    const deName = data.name_de || data.name;
    if (deName.toLowerCase().includes(query) || data.name.toLowerCase().includes(query)) {
      results.push({ id: parseInt(id), name: deName, nameEn: data.name, cost: data.cost });
    }
    if (results.length >= 20) break;
  }

  if (results.length === 0) {
    suggestions.style.display = 'none';
    return;
  }

  suggestions.innerHTML = '';
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    const iconSrc = getIconPath(r.id);
    const iconImg = `<img src="${iconSrc}" alt="" style="width:24px;height:24px;image-rendering:pixelated;vertical-align:middle;margin-right:4px;" onerror="this.style.display='none'">`;
    const formHint = r.nameEn.toLowerCase() !== r.name.toLowerCase() ? ` <small style="opacity:0.5">(${r.nameEn})</small>` : '';
    item.innerHTML = `<span>${iconImg}${r.name}${formHint}</span><span class="suggestion-cost">Kosten: ${r.cost}</span>`;
    item.addEventListener('click', () => {
      addInsertPokemon(r);
      suggestions.style.display = 'none';
      input.value = '';
    });
    suggestions.appendChild(item);
  }
  suggestions.style.display = 'block';
}

function addInsertPokemon(pokemon) {
  let emptyIdx = -1;
  for (let i = 0; i < insertMaxSlots; i++) {
    if (!insertParty[i]) { emptyIdx = i; break; }
  }
  if (emptyIdx === -1) {
    showToast('Team ist voll!', true);
    return;
  }

  insertParty[emptyIdx] = {
    speciesId: pokemon.id,
    name: pokemon.name,
    cost: pokemon.cost,
    shiny: false,
    nickname: null,
  };
  renderInsertPartySlots();
}

function saveInsertTrainer() {
  if (!currentUser || !sessionId || !insertWave) return;

  const party = insertParty.filter(p => p !== null);
  if (party.length === 0) {
    showToast('Mindestens 1 Pokémon auswählen!', true);
    return;
  }

  const totalCost = party.reduce((sum, p) => sum + p.cost, 0);
  if (totalCost > insertBudget) {
    showToast(`Budget überschritten: ${totalCost}/${insertBudget}`, true);
    return;
  }

  const insertAnon = document.getElementById('insert-anon')?.checked ?? true;
  socket.emit('COMMUNITY_INSERT_TRAINER', {
    sessionId,
    wave: insertWave,
    twitchUserId: currentUser.id,
    displayName: currentUser.display_name,
    anonymous: insertAnon,
    spriteKey: null,
    party,
  });

  closeInsertModal();
}

// --- Voting ---
function renderVote() {
  const section = document.getElementById('vote-section');
  const container = document.getElementById('vote-container');

  if (!activeVote) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  const totalVotes = Object.values(activeVote.tallies).reduce((s, v) => s + v, 0);

  let html = '';
  for (const opt of activeVote.options) {
    const count = activeVote.tallies[opt.id] || 0;
    const pct = totalVotes > 0 ? (count / totalVotes * 100) : 0;
    html += `
      <div class="vote-option">
        <div class="vote-bar-bg">
          <div class="vote-bar-fill" style="width:${pct}%"></div>
          <span class="vote-bar-label">${opt.label}</span>
          <span class="vote-bar-count">${count} (${Math.round(pct)}%)</span>
        </div>
        <button class="btn btn-small btn-accent vote-btn" data-option="${opt.id}">Vote</button>
      </div>
    `;
  }

  html += `<div class="vote-timer">${activeVote.timeLeft}s</div>`;
  container.innerHTML = html;

  container.querySelectorAll('.vote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentUser || !sessionId) {
        showToast('Bitte einloggen um abzustimmen', true);
        return;
      }
      socket.emit('COMMUNITY_CAST_VOTE', {
        sessionId,
        twitchUserId: currentUser.id,
        option: btn.dataset.option,
      });
    });
  });

  if (activeVote.timeLeft > 0) {
    setTimeout(() => {
      if (activeVote) {
        activeVote.timeLeft = Math.max(0, activeVote.timeLeft - 1);
        renderVote();
      }
    }, 1000);
  }
}

// --- Gimmicks ---
function renderGimmicks() {
  const section = document.getElementById('gimmick-section');
  const bar = document.getElementById('gimmick-bar');

  if (!activeGimmicks || activeGimmicks.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  bar.innerHTML = '';

  for (const g of activeGimmicks) {
    const tag = document.createElement('div');
    tag.className = 'gimmick-tag';
    tag.innerHTML = `
      <span>${g.label}</span>
      <span class="gimmick-duration">(noch ${g.remainingWaves} Wellen)</span>
    `;
    bar.appendChild(tag);
  }
}

// --- Config Panel ---
const TRIGGER_TYPES = [
  { value: 'free', label: 'Kostenlos' },
  { value: 'bits', label: 'Bits' },
  { value: 'sub_t1', label: 'Sub Tier 1' },
  { value: 'sub_t2', label: 'Sub Tier 2' },
  { value: 'sub_t3', label: 'Sub Tier 3' },
  { value: 'channel_points', label: 'Kanalpunkte' },
  { value: 'sub_bomb', label: 'Gift-Subs' },
];

const CATEGORY_LABELS = {
  normal: 'Normal',
  boss: 'Boss',
  rival: 'Rivale',
  evil_team: 'Team Rocket',
  gym_leader: 'Arenaleiter',
  elite_four: 'Top Vier',
  champion: 'Champion',
  custom: 'Custom Trainer',
};

function updateConfigPanel() {
  if (!sessionConfig) return;
  document.getElementById('cfg-enabled').checked = sessionConfig.enabled;
  document.getElementById('cfg-custom-trainers').checked = sessionConfig.allowCustomTrainers;
  document.getElementById('cfg-shiny').checked = sessionConfig.allowShiny;
  document.getElementById('cfg-surprise').checked = sessionConfig.surpriseMode || false;
  document.getElementById('cfg-claim-mode').value = sessionConfig.claimMode;
  document.getElementById('cfg-max-claims').value = sessionConfig.maxClaimsPerPerson || 3;
  document.getElementById('cfg-max-claims-row').style.display = sessionConfig.claimMode === 'limit_per_person' ? '' : 'none';
  document.getElementById('cfg-wave-buffer').value = sessionConfig.waveBuffer;
  document.getElementById('cfg-max-text-length').value = sessionConfig.maxTextLength || 400;
  applyTextLimit(sessionConfig.maxTextLength || 400);

  // Trigger editor
  const triggerContainer = document.getElementById('trigger-editor');
  triggerContainer.innerHTML = '';
  const triggers = sessionConfig.categoryTriggers || {};
  for (const [cat, trigger] of Object.entries(triggers)) {
    const label = CATEGORY_LABELS[cat] || cat;
    const row = document.createElement('div');
    row.className = 'config-row';
    row.style.cssText = 'display:flex; gap:0.5rem; align-items:center; margin-bottom:0.4rem;';

    const catLabel = document.createElement('span');
    catLabel.style.cssText = 'flex:1; font-size:0.85rem;';
    catLabel.textContent = label;

    const typeSelect = document.createElement('select');
    typeSelect.style.cssText = 'flex:1;';
    typeSelect.dataset.cat = cat;
    typeSelect.className = 'trigger-type-select';
    for (const t of TRIGGER_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.value;
      opt.textContent = t.label;
      if (trigger.type === t.value) opt.selected = true;
      typeSelect.appendChild(opt);
    }

    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0';
    amountInput.style.cssText = 'width:70px;';
    amountInput.dataset.cat = cat;
    amountInput.className = 'trigger-amount-input';
    amountInput.value = trigger.amount || 0;
    // Hide amount for non-amount types
    const needsAmount = ['bits', 'channel_points', 'sub_bomb'].includes(trigger.type);
    amountInput.style.display = needsAmount ? '' : 'none';

    typeSelect.addEventListener('change', () => {
      const needs = ['bits', 'channel_points', 'sub_bomb'].includes(typeSelect.value);
      amountInput.style.display = needs ? '' : 'none';
      sendConfigUpdate();
    });
    amountInput.addEventListener('change', sendConfigUpdate);

    row.appendChild(catLabel);
    row.appendChild(typeSelect);
    row.appendChild(amountInput);
    triggerContainer.appendChild(row);
  }

  // Vote options
  const voteContainer = document.getElementById('vote-options-config');
  voteContainer.innerHTML = '';
  if (sessionConfig.voteOptions) {
    for (const opt of sessionConfig.voteOptions) {
      const label = document.createElement('label');
      label.className = 'toggle-row';
      label.innerHTML = `<span>${opt.label}</span><input type="checkbox" class="vote-opt-check" data-id="${opt.id}" checked>`;
      voteContainer.appendChild(label);
    }
  }
}

// Max. Zeichen auf alle Sprüche-Eingabefelder (Claim + Profil) anwenden.
function applyTextLimit(n) {
  const lim = Math.max(50, Math.min(2000, parseInt(n) || 400));
  ['profile-intro', 'profile-victory', 'profile-defeat', 'lines-intro', 'lines-victory', 'lines-defeat'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.maxLength = lim;
  });
}

function sendConfigUpdate() {
  if (!sessionId) return;

  // Build trigger config from editor
  const categoryTriggers = {};
  document.querySelectorAll('.trigger-type-select').forEach(sel => {
    const cat = sel.dataset.cat;
    const amountInput = document.querySelector(`.trigger-amount-input[data-cat="${cat}"]`);
    categoryTriggers[cat] = {
      type: sel.value,
      amount: parseInt(amountInput?.value) || 0,
    };
  });

  socket.emit('COMMUNITY_CONFIG_UPDATE', {
    sessionId,
    config: {
      enabled: document.getElementById('cfg-enabled').checked,
      allowCustomTrainers: document.getElementById('cfg-custom-trainers').checked,
      allowShiny: document.getElementById('cfg-shiny').checked,
      surpriseMode: document.getElementById('cfg-surprise').checked,
      claimMode: document.getElementById('cfg-claim-mode').value,
      maxClaimsPerPerson: parseInt(document.getElementById('cfg-max-claims').value) || 3,
      waveBuffer: parseInt(document.getElementById('cfg-wave-buffer').value) || 2,
      maxTextLength: parseInt(document.getElementById('cfg-max-text-length').value) || 400,
      categoryTriggers: Object.keys(categoryTriggers).length > 0 ? categoryTriggers : undefined,
    },
  });
}

function startVote() {
  if (!sessionId) return;
  const checks = document.querySelectorAll('.vote-opt-check:checked');
  const options = [];
  checks.forEach(c => {
    const opt = sessionConfig?.voteOptions?.find(o => o.id === c.dataset.id);
    if (opt) options.push(opt);
  });

  if (options.length < 2) {
    showToast('Mindestens 2 Optionen auswählen', true);
    return;
  }

  const duration = parseInt(document.getElementById('cfg-vote-duration').value) || 60;
  socket.emit('COMMUNITY_START_VOTE', { sessionId, options, duration });
}

function activateGimmick() {
  if (!sessionId) return;
  const select = document.getElementById('cfg-gimmick-select');
  const gimmickId = select.value;
  const label = select.options[select.selectedIndex].textContent;
  socket.emit('COMMUNITY_ACTIVATE_GIMMICK', { sessionId, gimmickId, label });
}

// --- Sprite Modal ---
let spriteModalWave = null;
let spriteModalClaimMode = false; // true = claiming, false = just changing sprite
let pendingClaimCustomize = false; // true = open team editor after claim

// --- Lines (Sprüche) Modal ---
let linesModalWave = null;

function openLinesModal(trainer) {
  linesModalWave = trainer.waveIndex;
  const lines = trainer.trainerLines || {};
  // Vorausfüllen: claim-spezifische Sprüche, Fallback auf Profil-Sprüche
  const p = loadProfile();
  document.getElementById('lines-modal-wave').textContent = trainer.waveIndex;
  document.getElementById('lines-intro').value = lines.intro || p.intro || '';
  document.getElementById('lines-victory').value = lines.victory || p.victory || '';
  document.getElementById('lines-defeat').value = lines.defeat || p.defeat || '';
  document.getElementById('lines-modal').style.display = 'flex';
}

function saveLinesModal() {
  if (!linesModalWave || !currentUser || !sessionId) return;
  const trainerLines = {
    intro: document.getElementById('lines-intro').value.trim(),
    victory: document.getElementById('lines-victory').value.trim(),
    defeat: document.getElementById('lines-defeat').value.trim(),
  };
  socket.emit('COMMUNITY_UPDATE_LINES', {
    sessionId,
    wave: linesModalWave,
    twitchUserId: currentUser.id,
    trainerLines,
  });
}

function openSpriteModal(waveIndex, currentSpriteKey) {
  spriteModalWave = waveIndex;
  spriteModalClaimMode = false;
  document.getElementById('sprite-modal-wave').textContent = waveIndex;
  document.getElementById('sprite-search').value = '';
  const anonRow = document.getElementById('sprite-modal-anon-row');
  if (anonRow) anonRow.style.display = 'none';
  const skipBtn = document.getElementById('sprite-modal-skip');
  if (skipBtn) skipBtn.style.display = 'none';
  const titleEl = document.getElementById('sprite-modal-title');
  if (titleEl) titleEl.textContent = 'Sprite wählen';
  renderSpriteGrid('', currentSpriteKey);
  document.getElementById('sprite-modal').style.display = 'flex';
}

function openClaimModal(waveIndex) {
  spriteModalWave = waveIndex;
  spriteModalClaimMode = true;
  pendingClaimCustomize = true; // auto-open team editor after claim
  document.getElementById('sprite-modal-wave').textContent = waveIndex;
  document.getElementById('sprite-search').value = '';
  const anonRow = document.getElementById('sprite-modal-anon-row');
  if (anonRow) { anonRow.style.display = 'flex'; }
  const anonCb = document.getElementById('sprite-modal-anon');
  if (anonCb) anonCb.checked = true;
  const skipBtn = document.getElementById('sprite-modal-skip');
  if (skipBtn) skipBtn.style.display = '';
  const titleEl = document.getElementById('sprite-modal-title');
  if (titleEl) titleEl.textContent = 'Anpassen — Sprite wählen';
  renderSpriteGrid('', null);
  document.getElementById('sprite-modal').style.display = 'flex';
}

function closeSpriteModal() {
  document.getElementById('sprite-modal').style.display = 'none';
  spriteModalWave = null;
  spriteModalClaimMode = false;
  pendingClaimCustomize = false;
}

function renderSpriteGrid(filter, currentSpriteKey) {
  const grid = document.getElementById('sprite-grid');
  const query = (filter || '').toLowerCase();
  const filtered = query
    ? trainerSprites.filter(s => s.label.toLowerCase().includes(query) || s.key.toLowerCase().includes(query))
    : trainerSprites;

  grid.innerHTML = '';
  for (const sprite of filtered) {
    const item = document.createElement('div');
    item.className = 'sprite-item' + (sprite.key === currentSpriteKey ? ' selected' : '');

    // Use atlas frame data to show only the first frame (not the full sprite sheet)
    let thumbHtml;
    if (sprite.frame) {
      const f = sprite.frame;
      // Scale factor to fit frame into 64px box
      const scale = Math.min(64 / f.w, 64 / f.h);
      const sw = Math.round(f.sw * scale);
      const sh = Math.round(f.sh * scale);
      const ox = Math.round(-f.x * scale);
      const oy = Math.round(-f.y * scale);
      const dw = Math.round(f.w * scale);
      const dh = Math.round(f.h * scale);
      thumbHtml = `<div style="width:${dw}px;height:${dh}px;background:url('/images/trainer/${sprite.key}.png') ${ox}px ${oy}px / ${sw}px ${sh}px no-repeat;image-rendering:pixelated;"></div>`;
    } else {
      thumbHtml = `<img src="/images/trainer/${sprite.key}.png" alt="${sprite.label}" style="width:64px;height:64px;image-rendering:pixelated;object-fit:contain;" onerror="this.style.display='none'">`;
    }
    item.innerHTML = `${thumbHtml}<span>${sprite.label}</span>`;
    item.addEventListener('click', () => selectSprite(sprite.key));
    grid.appendChild(item);
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="muted" style="text-align:center; grid-column:1/-1; padding:2rem;">Kein Sprite gefunden</p>';
  }
}

function selectSprite(spriteKey) {
  // Profile mode: save sprite to profile, no claim
  const modal = document.getElementById('sprite-modal');
  if (modal.dataset.profileMode === 'true') {
    renderProfileSprite(spriteKey);
    modal.dataset.profileMode = '';
    closeSpriteModal();
    saveProfile(); // Auto-Save
    return;
  }
  if (!currentUser || !sessionId || !spriteModalWave) return;
  if (spriteModalClaimMode) {
    // Claim with sprite + profile lines
    const anonymous = document.getElementById('sprite-modal-anon')?.checked || false;
    const p = loadProfile();
    const lines = { intro: p.intro || '', victory: p.victory || '', defeat: p.defeat || '' };
    claimTrainer(spriteModalWave, anonymous, spriteKey, lines);
  } else {
    // Just change sprite
    socket.emit('COMMUNITY_CHANGE_SPRITE', {
      sessionId,
      wave: spriteModalWave,
      twitchUserId: currentUser.id,
      spriteKey,
    });
  }
  closeSpriteModal();
}

function claimSkipSprite() {
  if (!currentUser || !sessionId || !spriteModalWave) return;
  const anonymous = document.getElementById('sprite-modal-anon')?.checked || false;
  claimTrainer(spriteModalWave, anonymous, null);
  closeSpriteModal();
}

// --- Helpers ---
function formatCategory(cat) {
  const labels = {
    normal: 'Normal',
    boss: 'Boss',
    rival: 'Rivale',
    evil_team: 'Team',
    gym_leader: 'Arena',
    elite_four: 'Top 4',
    champion: 'Champ',
    custom: 'Custom',
  };
  return labels[cat] || cat;
}

function getTriggerLabel(type, amount) {
  switch (type) {
    case 'free': return 'KOSTENLOS';
    case 'bits': return `${amount} Bits`;
    case 'sub_t1': return 'Sub T1';
    case 'sub_t2': return 'Sub T2';
    case 'sub_t3': return 'Sub T3';
    case 'channel_points': return `${amount} Punkte`;
    case 'sub_bomb': return `${amount} Gift-Subs`;
    default: return type;
  }
}

function getSpriteEmoji(category) {
  const emojis = {
    normal: '&#9876;',
    boss: '&#9733;',
    rival: '&#9829;',
    evil_team: '&#9760;',
    gym_leader: '&#127942;',
    elite_four: '&#9830;',
    champion: '&#128081;',
    custom: '&#10024;',
  };
  return emojis[category] || '&#9876;';
}

// --- Toast ---
let toastTimeout = null;
function showToast(message, isError = false) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      padding: 10px 20px; border-radius: 8px; font-size: 0.9rem; z-index: 999;
      transition: opacity 0.3s;
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.background = isError ? 'var(--red)' : 'var(--green)';
  toast.style.color = 'white';
  toast.style.opacity = '1';

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
  }, 3000);
}

// --- Pokemon Grid (browsable) ---
let pokemonGridCache = null;

function renderPokemonGrid(filter) {
  const grid = document.getElementById('pokemon-grid');
  if (!grid) return;

  // Build cache once
  if (!pokemonGridCache) {
    pokemonGridCache = [];
    for (const [id, data] of Object.entries(pokemonData)) {
      pokemonGridCache.push({
        id: parseInt(id),
        name: data.name_de || data.name,
        nameEn: data.name,
        cost: data.cost,
        gen: data.generation || 1,
      });
    }
    pokemonGridCache.sort((a, b) => a.id - b.id);
  }

  const query = (filter || '').toLowerCase().trim();
  const filtered = query.length >= 2
    ? pokemonGridCache.filter(p => p.name.toLowerCase().includes(query) || p.nameEn.toLowerCase().includes(query))
    : pokemonGridCache;

  // Calculate remaining budget
  let usedBudget = 0;
  for (const ep of editParty) { if (ep) usedBudget += ep.cost; }
  const remainingBudget = editBudget - usedBudget;
  const teamFull = editParty.filter(Boolean).length >= getEditMaxSlots();

  grid.innerHTML = '';
  for (const p of filtered) {
    const cell = document.createElement('div');
    const isInParty = editParty.some(ep => ep && ep.speciesId === p.id);
    const tooExpensive = !isInParty && (p.cost > remainingBudget || teamFull);
    cell.style.cssText = `
      display:flex;flex-direction:column;align-items:center;padding:4px;
      border-radius:6px;cursor:${tooExpensive ? 'not-allowed' : 'pointer'};
      border:1px solid ${isInParty ? 'var(--accent,#7c3aed)' : 'transparent'};
      background:${isInParty ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.03)'};
      opacity:${tooExpensive ? '0.3' : '1'};
      transition:all 0.15s;font-size:0.65rem;text-align:center;
    `;
    cell.innerHTML = `
      <img src="${getIconPath(p.id)}" alt="" style="width:32px;height:32px;image-rendering:pixelated;" onerror="this.style.display='none'" loading="lazy">
      <span style="color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65px;">${p.name}</span>
      <span style="color:${p.cost >= 8 ? '#ef4444' : p.cost >= 5 ? '#eab308' : '#22c55e'};font-weight:bold;">${p.cost}</span>
    `;
    if (!tooExpensive) {
      cell.addEventListener('mouseenter', () => { if (!isInParty) cell.style.background = 'rgba(255,255,255,0.08)'; });
      cell.addEventListener('mouseleave', () => { if (!isInParty) cell.style.background = 'rgba(255,255,255,0.03)'; });
      cell.addEventListener('click', () => {
        if (isInParty) {
          const idx = editParty.findIndex(ep => ep && ep.speciesId === p.id);
          if (idx >= 0) { editParty[idx] = null; renderPartySlots(); renderPokemonGrid(query); }
        } else {
          addPokemonToParty(p);
          renderPokemonGrid(query);
        }
      });
    }
    grid.appendChild(cell);
  }
}

function filterPokemonGrid(query) {
  renderPokemonGrid(query);
}

// --- Random Team Generator ---
function generateRandomTeam() {
  if (!pokemonGridCache) renderPokemonGrid(); // init cache
  const budget = editBudget;
  const maxSlots = getEditMaxSlots();

  // Clear current team
  editParty = new Array(maxSlots).fill(null);

  let remainingBudget = budget;
  let filled = 0;

  // Shuffle pokemon list
  const shuffled = [...pokemonGridCache].sort(() => Math.random() - 0.5);

  for (const p of shuffled) {
    if (filled >= maxSlots) break;
    if (p.cost > remainingBudget) continue;

    editParty[filled] = {
      speciesId: p.id,
      name: p.name,
      cost: p.cost,
      shiny: false,
      nickname: null,
    };
    remainingBudget -= p.cost;
    filled++;
  }

  renderPartySlots();
  renderPokemonGrid(document.getElementById('pokemon-search')?.value);
  showToast(`Random Team: ${filled} Pokemon, ${budget - remainingBudget}/${budget} Budget`);
}

// --- Last Team (LocalStorage) ---
const LAST_TEAM_KEY = 'emmelrogue_last_team';

function saveLastTeam(party) {
  try {
    localStorage.setItem(LAST_TEAM_KEY, JSON.stringify(party));
  } catch {}
}

function loadLastTeam() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_TEAM_KEY));
    if (!Array.isArray(saved) || saved.length === 0) {
      showToast('Kein gespeichertes Team gefunden', true);
      return;
    }

    const maxSlots = getEditMaxSlots();
    editParty = new Array(maxSlots).fill(null);

    let totalCost = 0;
    for (let i = 0; i < Math.min(saved.length, maxSlots); i++) {
      const p = saved[i];
      if (!p || !p.speciesId) continue;
      const data = pokemonData[String(p.speciesId)];
      if (!data) continue;
      const cost = data.cost || 0;
      if (totalCost + cost > editBudget) continue;
      editParty[i] = {
        speciesId: p.speciesId,
        name: data.name_de || data.name || p.name,
        cost: cost,
        shiny: p.shiny || false,
        nickname: p.nickname || null,
      };
      totalCost += cost;
    }

    renderPartySlots();
    renderPokemonGrid(document.getElementById('pokemon-search')?.value);
    showToast('Letztes Team geladen');
  } catch {
    showToast('Kein gespeichertes Team gefunden', true);
  }
}

// --- Insert Modal: Pokemon Grid, Random, Last Team ---

function renderInsertPokemonGrid(filter) {
  const grid = document.getElementById('insert-pokemon-grid');
  if (!grid) return;
  if (!pokemonGridCache) renderPokemonGrid(); // init cache

  const query = (filter || '').toLowerCase().trim();
  const filtered = query.length >= 2
    ? pokemonGridCache.filter(p => p.name.toLowerCase().includes(query) || p.nameEn.toLowerCase().includes(query))
    : pokemonGridCache;

  let usedBudget = 0;
  for (const ep of insertParty) { if (ep) usedBudget += ep.cost; }
  const remainingBudget = insertBudget - usedBudget;
  const teamFull = insertParty.filter(Boolean).length >= insertMaxSlots;

  grid.innerHTML = '';
  for (const p of filtered) {
    const cell = document.createElement('div');
    const isInParty = insertParty.some(ep => ep && ep.speciesId === p.id);
    const tooExpensive = !isInParty && (p.cost > remainingBudget || teamFull);
    cell.style.cssText = `
      display:flex;flex-direction:column;align-items:center;padding:4px;
      border-radius:6px;cursor:${tooExpensive ? 'not-allowed' : 'pointer'};
      border:1px solid ${isInParty ? 'var(--accent,#7c3aed)' : 'transparent'};
      background:${isInParty ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.03)'};
      opacity:${tooExpensive ? '0.3' : '1'};
      transition:all 0.15s;font-size:0.65rem;text-align:center;
    `;
    cell.innerHTML = `
      <img src="${getIconPath(p.id)}" alt="" style="width:32px;height:32px;image-rendering:pixelated;" onerror="this.style.display='none'" loading="lazy">
      <span style="color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65px;">${p.name}</span>
      <span style="color:${p.cost >= 8 ? '#ef4444' : p.cost >= 5 ? '#eab308' : '#22c55e'};font-weight:bold;">${p.cost}</span>
    `;
    if (!tooExpensive) {
      cell.addEventListener('mouseenter', () => { if (!isInParty) cell.style.background = 'rgba(255,255,255,0.08)'; });
      cell.addEventListener('mouseleave', () => { if (!isInParty) cell.style.background = 'rgba(255,255,255,0.03)'; });
      cell.addEventListener('click', () => {
        if (isInParty) {
          const idx = insertParty.findIndex(ep => ep && ep.speciesId === p.id);
          if (idx >= 0) { insertParty[idx] = null; renderInsertPartySlots(); renderInsertPokemonGrid(query); }
        } else {
          addInsertPokemonToParty(p);
          renderInsertPokemonGrid(query);
        }
      });
    }
    grid.appendChild(cell);
  }
}

function addInsertPokemonToParty(pokemon) {
  let emptyIdx = -1;
  for (let i = 0; i < insertMaxSlots; i++) {
    if (!insertParty[i]) { emptyIdx = i; break; }
  }
  if (emptyIdx === -1) { showToast('Team ist voll!', true); return; }
  insertParty[emptyIdx] = {
    speciesId: pokemon.id,
    name: pokemon.name,
    cost: pokemon.cost,
    shiny: false,
    nickname: null,
  };
  renderInsertPartySlots();
}

function generateInsertRandomTeam() {
  if (!insertWave || !insertBudget) { showToast('Erst eine Welle eingeben', true); return; }
  if (!pokemonGridCache) renderPokemonGrid();
  insertParty = new Array(insertMaxSlots).fill(null);
  let remaining = insertBudget;
  let filled = 0;
  const shuffled = [...pokemonGridCache].sort(() => Math.random() - 0.5);
  for (const p of shuffled) {
    if (filled >= insertMaxSlots) break;
    if (p.cost > remaining) continue;
    insertParty[filled] = { speciesId: p.id, name: p.name, cost: p.cost, shiny: false, nickname: null };
    remaining -= p.cost;
    filled++;
  }
  renderInsertPartySlots();
  renderInsertPokemonGrid(document.getElementById('insert-pokemon-search')?.value);
  showToast(`Random Team: ${filled} Pokemon, ${insertBudget - remaining}/${insertBudget} Budget`);
}

function loadInsertLastTeam() {
  if (!insertWave || !insertBudget) { showToast('Erst eine Welle eingeben', true); return; }
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_TEAM_KEY));
    if (!Array.isArray(saved) || saved.length === 0) { showToast('Kein gespeichertes Team', true); return; }
    insertParty = new Array(insertMaxSlots).fill(null);
    let totalCost = 0;
    for (let i = 0; i < Math.min(saved.length, insertMaxSlots); i++) {
      const p = saved[i];
      if (!p || !p.speciesId) continue;
      const data = pokemonData[String(p.speciesId)];
      if (!data) continue;
      if (totalCost + data.cost > insertBudget) continue;
      insertParty[i] = { speciesId: p.speciesId, name: data.name_de || data.name, cost: data.cost, shiny: false, nickname: null };
      totalCost += data.cost;
    }
    renderInsertPartySlots();
    renderInsertPokemonGrid(document.getElementById('insert-pokemon-search')?.value);
    showToast('Letztes Team geladen');
  } catch { showToast('Kein gespeichertes Team', true); }
}
