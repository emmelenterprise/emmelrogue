/* eslint-disable */
'use strict';

// --- Pokemon Icon Path Helper ---
function getIconPath(speciesId) {
  const pd = pokemonData[speciesId];
  const gen = pd ? pd.generation : 9;
  return `/images/pokemon/icons/${gen}/${speciesId}.png`;
}

let pokemonData = {};
let trainerSprites = [];
let gymState = { active: false };
let prevChallengerId = null;

const socket = io({ transports: ['websocket', 'polling'] });

// --- Init ---
window.addEventListener('DOMContentLoaded', async () => {
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

  setupSocket();
});

function setupSocket() {
  socket.emit('GYM_JOIN');

  socket.on('GYM_STATE', (state) => {
    const oldState = gymState;
    gymState = state;

    // Detect new challenger → trigger entrance sequence
    const newChallenger = state.currentChallenger;
    if (newChallenger && newChallenger.twitchId !== prevChallengerId) {
      triggerEntranceSequence(newChallenger);
    }
    prevChallengerId = newChallenger?.twitchId || null;

    renderOverlay();
  });

  socket.on('GYM_BADGE_AWARDED', ({ twitchId, displayName, totalBadges }) => {
    showBadgeAlert(displayName, totalBadges);
  });
}

// ===== ARENA ENTRANCE SEQUENCE =====
function triggerEntranceSequence(challenger) {
  const seq = document.getElementById('arena-sequence');
  const gate = document.getElementById('arena-gate');
  const entrance = document.getElementById('challenger-entrance');
  const teamsReveal = document.getElementById('teams-reveal');
  const lineBox = document.getElementById('trainer-line-box');
  const fightText = document.getElementById('fight-text');

  // Reset all
  seq.classList.remove('hidden');
  gate.classList.remove('open');
  entrance.classList.remove('walk-in');
  teamsReveal.classList.remove('show');
  lineBox.classList.remove('show');
  fightText.classList.remove('show');

  // Set challenger data
  document.getElementById('seq-challenger-name').textContent = challenger.displayName;
  document.getElementById('seq-challenger-label').textContent = challenger.displayName;

  // Challenger sprite
  renderTrainerSprite('seq-challenger-sprite', challenger.spriteKey, 128);

  // Boss team icons
  const bossTeamEl = document.getElementById('seq-boss-team');
  bossTeamEl.innerHTML = (gymState.bossTeam || []).map(p =>
    `<img src="${getIconPath(p.speciesId)}" alt="${p.name}" onerror="this.style.display='none'">`
  ).join('');

  // Challenger team icons
  const challengerTeamEl = document.getElementById('seq-challenger-team');
  challengerTeamEl.innerHTML = (challenger.team || []).map(p =>
    `<img src="${getIconPath(p.speciesId)}" alt="${p.name}" onerror="this.style.display='none'">`
  ).join('');

  // Trainer line
  const introLine = challenger.trainerLines?.intro;
  if (introLine) {
    document.getElementById('seq-trainer-line').textContent = `"${introLine}"`;
  }

  // Step 1: Gate opens (0ms)
  setTimeout(() => gate.classList.add('open'), 300);

  // Step 2: Challenger walks in (1.5s)
  setTimeout(() => entrance.classList.add('walk-in'), 1500);

  // Step 3: Teams revealed (3.5s)
  setTimeout(() => {
    entrance.style.opacity = '0';
    teamsReveal.classList.add('show');
  }, 3500);

  // Step 4: Trainer line (5s)
  if (introLine) {
    setTimeout(() => lineBox.classList.add('show'), 5000);
  }

  // Step 5: FIGHT! (6.5s)
  setTimeout(() => {
    teamsReveal.classList.remove('show');
    lineBox.classList.remove('show');
    fightText.classList.add('show');
  }, introLine ? 7000 : 5500);

  // Step 6: Hide sequence (8.5s)
  setTimeout(() => {
    seq.classList.add('hidden');
    // Reset entrance opacity
    entrance.style.opacity = '';
  }, introLine ? 9000 : 7500);
}

// ===== SPRITE RENDERING =====
function renderTrainerSprite(containerId, spriteKey, targetWidth) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const sp = trainerSprites.find(s => s.key === spriteKey);
  if (!sp) return;
  const img = document.createElement('img');
  img.src = `/images/trainer/${spriteKey}.png`;
  img.style.imageRendering = 'pixelated';
  if (sp.frame) {
    const scale = targetWidth / sp.frame.w;
    img.style.width = (sp.frame.sw * scale) + 'px';
    img.style.height = (sp.frame.sh * scale) + 'px';
    img.style.marginLeft = (-sp.frame.x * scale) + 'px';
    img.style.marginTop = (-sp.frame.y * scale) + 'px';
  } else {
    img.style.width = targetWidth + 'px';
    img.style.height = 'auto';
  }
  container.appendChild(img);
}

// ===== PERSISTENT OVERLAY =====
function renderOverlay() {
  renderBattleBar();
  renderQueueBar();
  renderLeaderboard();
}

function renderBattleBar() {
  const bar = document.getElementById('current-battle');
  const cc = gymState.currentChallenger;
  if (!cc) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  // Boss sprite
  renderTrainerSprite('ov-boss-sprite', gymState.bossSprite || 'gym_leader_brock', 48);

  // Challenger
  renderTrainerSprite('ov-challenger-sprite', cc.spriteKey || 'youngster', 48);
  document.getElementById('ov-challenger-name').textContent = cc.displayName;
}

function renderQueueBar() {
  const container = document.getElementById('queue-items');
  const queue = gymState.queue || [];

  if (queue.length === 0) {
    container.innerHTML = '<div class="q-empty">Leer</div>';
    return;
  }

  container.innerHTML = '';
  const shown = queue.slice(0, 8);
  shown.forEach((c, i) => {
    const teamIcons = (c.team || []).map(p =>
      `<img src="${getIconPath(p.speciesId)}" alt="${p.name}" onerror="this.style.display='none'">`
    ).join('');
    const div = document.createElement('div');
    div.className = 'q-item';
    div.innerHTML = `
      <span class="q-pos">${i + 1}</span>
      <img class="q-avatar" src="${c.profileImage || ''}" alt="" onerror="this.style.display='none'">
      <span class="q-name">${c.displayName}</span>
      <div class="q-team">${teamIcons}</div>
    `;
    container.appendChild(div);
  });
  if (queue.length > 8) {
    const more = document.createElement('div');
    more.className = 'q-empty';
    more.textContent = `+${queue.length - 8} weitere`;
    container.appendChild(more);
  }
}

function renderLeaderboard() {
  const container = document.getElementById('lb-items');
  const lb = gymState.leaderboard || [];

  if (lb.length === 0) {
    container.innerHTML = '<div class="lb-empty">—</div>';
    return;
  }

  container.innerHTML = '';
  lb.slice(0, 5).forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = 'lb-row';
    div.innerHTML = `
      <span class="lb-rank r${i + 1}">#${i + 1}</span>
      <span class="lb-name">${entry.displayName}</span>
      <span class="lb-count">${entry.count}</span>
    `;
    container.appendChild(div);
  });
}

// ===== BADGE ALERT =====
function showBadgeAlert(displayName, totalBadges) {
  const alert = document.getElementById('badge-alert');
  document.getElementById('badge-winner-name').textContent = displayName;

  alert.classList.remove('hidden', 'hide');
  alert.classList.add('show');

  setTimeout(() => {
    alert.classList.remove('show');
    alert.classList.add('hide');
  }, 5000);

  setTimeout(() => {
    alert.classList.add('hidden');
    alert.classList.remove('hide');
  }, 5500);
}
