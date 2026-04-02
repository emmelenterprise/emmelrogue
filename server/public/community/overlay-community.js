/* eslint-disable */
'use strict';

// --- URL Params ---
const params = new URLSearchParams(window.location.search);
const sessionParam = params.get('session') || '';
let surpriseMode = params.get('surprise') === '1';

// --- State ---
let sessionId = null;
let sessionCode = null;
let trainers = [];
let streamerParty = [];
let activeVote = null;
let activeGimmicks = [];
let currentWave = 0;
let voteTimerInterval = null;

// --- DOM ---
const codeEl = document.getElementById('co-code');
const waveEl = document.getElementById('co-wave');
const biomeEl = document.getElementById('co-biome');
const partyEl = document.getElementById('co-party');
const trainersEl = document.getElementById('co-trainers');
const gimmicksEl = document.getElementById('co-gimmicks');
const gimmickSection = document.getElementById('section-gimmicks');
const voteEl = document.getElementById('co-vote');
const voteSection = document.getElementById('section-vote');

// --- Socket.io ---
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  console.log('[CommunityOverlay] Connected');

  if (sessionParam) {
    // Join by session ID directly
    socket.emit('COMMUNITY_JOIN', { sessionId: sessionParam });
  } else {
    // Auto-find active session
    findActiveSession();
  }
});

socket.on('disconnect', () => {
  console.log('[CommunityOverlay] Disconnected');
});

async function findActiveSession() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    const active = sessions.find(s => s.status === 'active');
    if (active) {
      socket.emit('COMMUNITY_JOIN', { sessionId: active.sessionId });
    } else {
      // Retry in 3 seconds
      setTimeout(findActiveSession, 3000);
    }
  } catch (e) {
    setTimeout(findActiveSession, 5000);
  }
}

// --- Socket Events ---
socket.on('CHAT_SESSION_STATE', (data) => {
  sessionId = data.sessionId;
  sessionCode = data.code || '';
  currentWave = data.currentWave || 0;
  activeVote = data.activeVote || null;
  activeGimmicks = data.activeGimmicks || [];
  streamerParty = data.streamerParty || [];

  // Update surprise mode from session config (URL param overrides)
  if (!params.get('surprise') && data.config?.surpriseMode !== undefined) {
    surpriseMode = data.config.surpriseMode;
  }

  codeEl.textContent = sessionCode || '----';
  waveEl.textContent = `Wave ${currentWave}`;
  biomeEl.textContent = data.currentBiome || '';

  renderParty();
  renderVote();
  renderGimmicks();
});

socket.on('CHAT_TRAINER_LIST', (data) => {
  trainers = data.trainers || [];
  renderTrainers();
});

socket.on('CHAT_WAVE_PROGRESS', (data) => {
  currentWave = data.wave;
  waveEl.textContent = `Wave ${data.wave}`;
  if (data.biome) biomeEl.textContent = data.biome;
});

socket.on('CHAT_STREAMER_PARTY', (data) => {
  streamerParty = data.party || [];
  renderParty();
});

socket.on('CHAT_TRAINER_CLAIMED', (data) => {
  const t = trainers.find(t => t.waveIndex === data.wave);
  if (t) {
    t.claimedBy = data.claimedBy;
    t.claimedByName = data.claimedByName;
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

socket.on('CHAT_VOTE_UPDATE', (data) => {
  activeVote = data;
  renderVote();
});

socket.on('CHAT_VOTE_RESULT', () => {
  activeVote = null;
  renderVote();
});

socket.on('CHAT_GIMMICK_ACTIVATED', (data) => {
  // Add or update gimmick
  const idx = activeGimmicks.findIndex(g => g.id === data.gimmickId);
  if (idx >= 0) {
    activeGimmicks[idx] = { id: data.gimmickId, label: data.label, wavesLeft: data.duration };
  } else {
    activeGimmicks.push({ id: data.gimmickId, label: data.label, wavesLeft: data.duration });
  }
  renderGimmicks();
});

socket.on('CHAT_GIMMICK_STATE', (data) => {
  activeGimmicks = data.activeGimmicks || [];
  renderGimmicks();
});

socket.on('CHAT_CONFIG_CHANGED', (data) => {
  if (!params.get('surprise') && data.config?.surpriseMode !== undefined) {
    const prev = surpriseMode;
    surpriseMode = data.config.surpriseMode;
    if (prev !== surpriseMode) {
      renderParty();
      renderTrainers();
    }
  }
});

// Session ended — clear everything
socket.on('CHAT_SESSION_ENDED', () => {
  console.log('[CommunityOverlay] Session ended, clearing state');
  sessionId = null;
  sessionCode = null;
  trainers = [];
  streamerParty = [];
  activeVote = null;
  activeGimmicks = [];
  currentWave = 0;
  codeEl.textContent = '----';
  waveEl.textContent = 'Wave 0';
  biomeEl.textContent = '';
  renderParty();
  renderTrainers();
  renderVote();
  renderGimmicks();
  // Start polling for next session
  if (!sessionParam) findActiveSession();
});

// New session available — auto-join
socket.on('CHAT_SESSION_AVAILABLE', (data) => {
  if (sessionId) return; // Already in a session
  console.log('[CommunityOverlay] New session available:', data.sessionId);
  socket.emit('COMMUNITY_JOIN', { sessionId: data.sessionId });
});

// --- Party layout (from URL param, default: 3 columns) ---
const partyCols = parseInt(params.get('partyCols') || '3');

// --- Embedded widgets (Chat + Pokemon) ---
(function initEmbeds() {
  // Chat: ?chat=1&chatChannel=janemmel&chatTheme=neon&chatFs=14&chatMax=25
  const chatEnabled = params.get('chat') === '1';
  const chatSection = document.getElementById('section-chat');
  if (chatEnabled && chatSection) {
    const chatIframe = document.getElementById('chat-iframe');
    const channel = params.get('chatChannel') || 'janemmel';
    const theme = params.get('chatTheme') || 'neon';
    const fs = params.get('chatFs') || '13';
    const max = params.get('chatMax') || '20';
    const chatW = params.get('chatW');
    const chatH = params.get('chatH');
    const chatUrl = params.get('chatUrl');
    if (chatUrl) {
      chatIframe.src = chatUrl;
    } else {
      chatIframe.src = `https://emmel.tv/widgets/chatoverlay?channel=${encodeURIComponent(channel)}&theme=${encodeURIComponent(theme)}&fs=${fs}&max=${max}&badges=1`;
    }
    chatSection.style.display = '';
    if (chatW) { chatSection.style.width = chatW + 'px'; chatSection.style.margin = '0 auto'; }
    if (chatH) {
      chatSection.classList.remove('co-embed-grow');
      chatSection.style.height = chatH + 'px';
    }
  }

  // Pokemon: ?pokemon=1&pokemonStyle=classic&pokemonW=300&pokemonH=250
  const pokemonEnabled = params.get('pokemon') === '1';
  const pokemonSection = document.getElementById('section-pokemon');
  if (pokemonEnabled && pokemonSection) {
    const pokemonIframe = document.getElementById('pokemon-iframe');
    const style = params.get('pokemonStyle') || 'classic';
    const pokemonW = params.get('pokemonW');
    const pokemonH = params.get('pokemonH') || '250';
    const pokemonVol = params.get('pokemonVol') || '50';
    const pokemonUrl = params.get('pokemonUrl');
    if (pokemonUrl) {
      pokemonIframe.src = pokemonUrl;
    } else {
      pokemonIframe.src = `https://emmel.tv/widgets/pokemon?style=${encodeURIComponent(style)}&position=center&vol=${pokemonVol}`;
    }
    pokemonSection.style.display = '';
    pokemonSection.style.height = pokemonH + 'px';
    if (pokemonW) { pokemonSection.style.width = pokemonW + 'px'; pokemonSection.style.margin = '0 auto'; }
  }
})();

// --- Pokemon Icon Path Helper ---
function getIconPath(idOrIconId, iconGen) {
  // If generation is provided (from game client), use it directly
  if (iconGen) {
    return `/images/pokemon/icons/${iconGen}/${idOrIconId}.png`;
  }
  // Fallback: map species ID to generation bucket
  const id = parseInt(String(idOrIconId).split('-')[0]) || 0;
  let gen;
  if (id <= 151) gen = 1;
  else if (id <= 251) gen = 2;
  else if (id <= 386) gen = 3;
  else if (id <= 493) gen = 4;
  else if (id <= 649) gen = 5;
  else if (id <= 721) gen = 6;
  else if (id <= 809) gen = 7;
  else if (id <= 905) gen = 8;
  else gen = 9;
  return `/images/pokemon/icons/${gen}/${idOrIconId}.png`;
}

// --- Render: Streamer Party ---
function renderParty() {
  if (!streamerParty.length) {
    partyEl.innerHTML = '<div class="co-empty">Kein Team geladen</div>';
    partyEl.className = 'co-party';
    return;
  }

  partyEl.className = 'co-party' + (partyCols === 2 ? ' cols-2' : '');

  // Pad to 6 slots
  const slots = [...streamerParty];
  while (slots.length < 6) slots.push(null);

  partyEl.innerHTML = slots.map(p => {
    if (!p) {
      return `<div class="co-pokemon empty">
        <div class="co-pokemon-ball"><div class="co-pokeball-bg"></div></div>
        <div class="co-pokemon-info">
          <span class="co-pokemon-name" style="color:var(--text-muted)">---</span>
        </div>
      </div>`;
    }
    const hpPct = p.maxHp > 0 ? Math.round((p.hp / p.maxHp) * 100) : 100;
    const hpClass = hpPct > 50 ? 'hp-high' : hpPct > 20 ? 'hp-mid' : 'hp-low';
    const name = surpriseMode ? '???' : (p.nickname || p.name || '???');
    const fainted = p.hp <= 0 ? ' fainted' : '';

    let spriteDiv = '';
    if (!surpriseMode) {
      if (p.iconId) {
        spriteDiv = `<img class="co-pokemon-sprite" src="${getIconPath(p.iconId, p.iconGen)}" onerror="this.style.display='none'">`;
      } else if (p.speciesId) {
        let suffix = '';
        if (p.shiny) {
          const v = p.shinyVariant || 1;
          suffix = v === 1 ? 's' : `_${v}`;
        }
        spriteDiv = `<img class="co-pokemon-sprite" src="${getIconPath(p.speciesId + suffix, p.iconGen)}" onerror="this.style.display='none'">`;
      }
    }

    return `<div class="co-pokemon${fainted}">
      <div class="co-pokemon-ball">
        <div class="co-pokeball-bg"></div>
        ${spriteDiv}
      </div>
      <div class="co-pokemon-info">
        <span class="co-pokemon-name">${esc(name)}</span>
        <span class="co-pokemon-level">Lv${p.level || '?'}</span>
        <div class="co-hp-bar"><div class="co-hp-fill ${hpClass}" style="width:${hpPct}%"></div></div>
      </div>
    </div>`;
  }).join('');
}

// --- Render: Trainers ---
function renderTrainers() {
  if (!trainers.length) {
    trainersEl.innerHTML = '<div class="co-empty">Keine Trainer</div>';
    return;
  }

  // Sort by wave, show active + next 3 upcoming trainers
  const sorted = [...trainers].sort((a, b) => a.waveIndex - b.waveIndex);
  const upcoming = sorted.filter(t => t.waveIndex >= currentWave);
  const visible = upcoming.slice(0, 4);

  if (!visible.length) {
    trainersEl.innerHTML = '<div class="co-empty">Keine Trainer in Sicht</div>';
    return;
  }

  trainersEl.innerHTML = visible.map(t => {
    const catClass = t.category || 'normal';
    const partySize = t.customParty ? t.customParty.length : (t.originalParty ? t.originalParty.length : 0);
    const claimed = !!t.claimedBy;
    const isActive = t.waveIndex === currentWave;
    const locked = t.waveIndex <= currentWave + 2 && !claimed && !isActive;

    let statusText, statusClass;
    if (isActive) {
      // Aktive Welle: Name immer revealen (auch bei anonym/surprise)
      const realName = t.claimedBy ? (t.realName || t.claimedByName || '???') : null;
      statusText = realName ? '@' + realName : 'JETZT';
      statusClass = 'active';
    } else if (claimed) {
      statusText = surpriseMode ? '???' : '@' + (t.claimedByName || '???');
      statusClass = 'claimed';
    } else if (locked) {
      statusText = 'Gesperrt';
      statusClass = 'locked';
    } else {
      statusText = 'Frei';
      statusClass = 'free';
    }

    const dots = [];
    for (let i = 0; i < partySize; i++) {
      const hasClaim = t.pokemonNicknames && t.pokemonNicknames[i];
      const isCustom = t.customParty && t.customParty[i];
      dots.push(`<div class="co-party-dot${hasClaim ? ' claimed' : ''}${isCustom ? ' custom' : ''}"></div>`);
    }

    const className = t.trainerClass || t.category || '?';

    return `<div class="co-trainer">
      <span class="co-trainer-wave ${catClass}">${t.waveIndex}</span>
      <div class="co-trainer-info">
        <div class="co-trainer-class">${esc(className)}</div>
        <div class="co-trainer-party">${dots.join('')}</div>
      </div>
      <span class="co-trainer-status ${statusClass}">${esc(statusText)}</span>
    </div>`;
  }).join('');
}

// --- Render: Vote ---
function renderVote() {
  if (voteTimerInterval) {
    clearInterval(voteTimerInterval);
    voteTimerInterval = null;
  }

  if (!activeVote || !activeVote.options || !activeVote.options.length) {
    voteSection.style.display = 'none';
    return;
  }

  voteSection.style.display = '';

  const totalVotes = Object.values(activeVote.tallies || {}).reduce((a, b) => a + b, 0);

  let html = activeVote.options.map(opt => {
    const count = (activeVote.tallies || {})[opt.id] || 0;
    const pct = totalVotes > 0 ? Math.round(count / totalVotes * 100) : 0;
    return `<div class="co-vote-option">
      <div class="co-vote-bar" style="width:${pct}%"></div>
      <div class="co-vote-label">
        <span>${esc(opt.label)}</span>
        <span class="co-vote-pct">${pct}%</span>
      </div>
    </div>`;
  }).join('');

  if (activeVote.expiresAt) {
    html += `<div class="co-vote-timer" id="co-vote-countdown"></div>`;
  }

  voteEl.innerHTML = html;

  // Start countdown
  if (activeVote.expiresAt) {
    updateVoteCountdown();
    voteTimerInterval = setInterval(updateVoteCountdown, 1000);
  }
}

function updateVoteCountdown() {
  const el = document.getElementById('co-vote-countdown');
  if (!el || !activeVote || !activeVote.expiresAt) return;
  const left = Math.max(0, Math.floor((activeVote.expiresAt - Date.now()) / 1000));
  const min = Math.floor(left / 60);
  const sec = String(left % 60).padStart(2, '0');
  el.textContent = left > 0 ? `${min}:${sec}` : 'Beendet';
  if (left <= 0 && voteTimerInterval) {
    clearInterval(voteTimerInterval);
    voteTimerInterval = null;
  }
}

// --- Render: Gimmicks ---
function renderGimmicks() {
  if (!activeGimmicks.length) {
    gimmickSection.style.display = 'none';
    return;
  }

  gimmickSection.style.display = '';
  gimmicksEl.innerHTML = activeGimmicks.map(g => {
    const durText = g.wavesLeft ? ` (${g.wavesLeft}W)` : '';
    return `<span class="co-gimmick">${esc(g.label)}<span class="co-gimmick-duration">${durText}</span></span>`;
  }).join('');
}

// --- Helpers ---
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Live Style Updates (from parent overlay via postMessage) ---
window.addEventListener('message', (event) => {
  if (event.data?.type === 'COMMUNITY_STYLE') {
    const vars = event.data.vars;
    if (!vars || typeof vars !== 'object') return;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
  }
  if (event.data?.type === 'COMMUNITY_HEADER') {
    const header = document.querySelector('.co-header');
    if (header) header.style.display = event.data.visible ? '' : 'none';
  }
});
