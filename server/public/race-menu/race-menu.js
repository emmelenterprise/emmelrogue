/* eslint-disable no-undef */

// --- DOM Elements ---
const raceCodeEl = document.getElementById('race-code');
const btnCopy = document.getElementById('btn-copy');
const p1Avatar = document.getElementById('p1-avatar');
const p1Name = document.getElementById('p1-name');
const p1Host = document.getElementById('p1-host');
const p2Avatar = document.getElementById('p2-avatar');
const p2Name = document.getElementById('p2-name');
const p2Host = document.getElementById('p2-host');

// Rules
const starterModeSelect = document.getElementById('starter-mode-select');
const starterCountSelect = document.getElementById('starter-count-select');
const starterCountField = document.getElementById('starter-count-field');
const gameModeSelect = document.getElementById('game-mode-select');
const winConditionSelect = document.getElementById('win-condition-select');
const winWaveInput = document.getElementById('win-wave-input');
const waveField = document.getElementById('wave-field');
const nuzlockeDeathCb = document.getElementById('nuzlocke-death');
const nuzlockeCatchCb = document.getElementById('nuzlocke-catch');
const respawnWipeCb = document.getElementById('respawn-wipe');
const respawnLabel = document.getElementById('respawn-label');
const shinyModeSelect = document.getElementById('shiny-mode-select');
const luckLevelSelect = document.getElementById('luck-level-select');

// Performance
const perfQuality = document.getElementById('perf-quality');

// Camera
const cameraEnabled = document.getElementById('camera-enabled');
const cameraDevice = document.getElementById('camera-device');
const cameraPreview = document.getElementById('camera-preview');
const cameraPreviewWrapper = document.getElementById('camera-preview-wrapper');

// Ready
const p1Ready = document.getElementById('p1-ready');
const p1ReadyText = document.getElementById('p1-ready-text');
const p2Ready = document.getElementById('p2-ready');
const p2ReadyText = document.getElementById('p2-ready-text');
const btnReady = document.getElementById('btn-ready');
const btnLeave = document.getElementById('btn-leave');

// Status
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const connectionEl = document.getElementById('connection');
const connectionText = document.getElementById('connection-text');

// --- Socket.io (must be before init) ---
const socket = io({ transports: ['websocket', 'polling'] });

// --- State ---
let raceCode = null;
let myPlayerNumber = null;
let twitchId = null;
let twitchUser = null;
let isHost = false;
let isReady = false;
let isSolo = false;
let camStream = null;
let chatSessionFromUrl = '';

// --- Init: Read URL params + restore session ---
(function init() {
  const params = new URLSearchParams(window.location.search);
  raceCode = params.get('code');
  myPlayerNumber = parseInt(params.get('player') || '0');
  twitchId = params.get('twitchId');
  isSolo = params.get('solo') === '1';
  isHost = myPlayerNumber === 1;
  chatSessionFromUrl = params.get('chatSession') || '';

  // Restore Twitch user from session
  const saved = sessionStorage.getItem('twitch-user');
  if (saved) {
    try { twitchUser = JSON.parse(saved); } catch { /* ignore */ }
  }

  if (!raceCode || !myPlayerNumber) {
    showStatus('Fehlende Race-Daten. Zurueck zur Lobby.', false);
    setTimeout(() => { window.location.href = '/lobby/'; }, 2000);
    return;
  }

  raceCodeEl.textContent = raceCode;

  // Show host controls
  if (isHost) {
    starterModeSelect.disabled = false;
    starterCountSelect.disabled = false;
    gameModeSelect.disabled = false;
    winConditionSelect.disabled = false;
    winWaveInput.disabled = false;
    nuzlockeDeathCb.disabled = false;
    nuzlockeCatchCb.disabled = false;
    respawnWipeCb.disabled = false;
    shinyModeSelect.disabled = false;
    luckLevelSelect.disabled = false;
  }

  // Restore last settings from localStorage (host only)
  // Only restore UI values here — config update is sent after socket joins the race
  if (isHost) {
    try {
      const saved = JSON.parse(localStorage.getItem('emmelrogue_race_settings') || '{}');
      if (saved.starterMode) starterModeSelect.value = saved.starterMode;
      if (saved.starterCount) starterCountSelect.value = saved.starterCount;
      if (saved.gameMode) gameModeSelect.value = saved.gameMode;
      if (saved.winCondition) winConditionSelect.value = saved.winCondition;
      if (saved.winWave) winWaveInput.value = saved.winWave;
      if (saved.nuzlockeDeath !== undefined) nuzlockeDeathCb.checked = saved.nuzlockeDeath;
      if (saved.nuzlockeCatch !== undefined) nuzlockeCatchCb.checked = saved.nuzlockeCatch;
      if (saved.respawnOnWipe !== undefined) respawnWipeCb.checked = saved.respawnOnWipe;
      if (saved.shinyMode) shinyModeSelect.value = saved.shinyMode;
      if (saved.luckLevel !== undefined) luckLevelSelect.value = saved.luckLevel;
      updateStarterCountVisibility();
      updateWaveFieldVisibility();
      // Send config after socket has joined the race (1s delay for safety)
      setTimeout(() => {
        const wc = winConditionSelect.value;
        socket.emit('RACE_CONFIG_UPDATE', {
          code: raceCode,
          starterMode: starterModeSelect.value,
          gameMode: gameModeSelect.value,
          winCondition: wc === 'wave100' ? 'wave' : wc === 'wave200' ? 'wave' : 'wave',
          winWave: parseInt(winWaveInput.value) || 20,
          nuzlockeDeath: nuzlockeDeathCb.checked,
          nuzlockeCatch: nuzlockeCatchCb.checked,
          starterCount: parseInt(starterCountSelect.value) || 3,
          respawnOnWipe: respawnWipeCb.checked,
          shinyMode: shinyModeSelect.value,
          luckLevel: parseInt(luckLevelSelect.value),
        });
      }, 1000);
    } catch {}
  }

  // Solo mode: hide P2 slot + VS
  if (isSolo) {
    // Hide P2 info in players bar
    const playersBar = document.querySelector('.players-bar');
    if (playersBar) {
      const vsEl = playersBar.querySelector('.vs');
      const p2Info = playersBar.children[2]; // 3rd child = P2 info
      if (vsEl) vsEl.style.display = 'none';
      if (p2Info) p2Info.style.display = 'none';
    }
    // Hide P2 ready indicator
    if (p2Ready) p2Ready.style.display = 'none';
    // Update starter mode labels for solo
    const starterOpts = starterModeSelect?.options;
    if (starterOpts) {
      for (const opt of starterOpts) {
        opt.textContent = opt.textContent.replace(' (gleich fuer beide)', '');
      }
    }
  }

  // Init camera
  initCamera();

  // Connect socket
  connectSocket();
})();

function connectSocket() {
  socket.on('connect', () => {
    connectionEl.classList.add('connected');
    connectionEl.classList.remove('disconnected');
    connectionText.textContent = 'Verbunden';

    // Join the race menu
    socket.emit('RACE_MENU_JOIN', {
      code: raceCode,
      playerNumber: myPlayerNumber,
      twitchId: twitchId,
    });
  });

  socket.on('disconnect', () => {
    connectionEl.classList.remove('connected');
    connectionEl.classList.add('disconnected');
    connectionText.textContent = 'Getrennt';
  });

  // Full state on join
  socket.on('RACE_MENU_STATE', (state) => {
    if (state.solo) isSolo = true;
    updatePlayers(state);
    updateRulesUI(state);
    updateReadyUI(state.menuReady || { 1: false, 2: false });
  });

  // Race state updates (players joining/leaving)
  socket.on('RACE_STATE', (state) => {
    updatePlayers(state);
    if (state.menuReady) updateReadyUI(state.menuReady);
  });

  // Config changed by host
  socket.on('RACE_CONFIG_CHANGED', (data) => {
    updateRulesFromData(data);

    // Reset ready state when config changes
    if (isReady) {
      isReady = false;
      updateReadyButton();
    }
    updateReadyUI(data.menuReady || { 1: false, 2: false });
  });

  // Ready state
  socket.on('RACE_READY_STATE', ({ menuReady }) => {
    updateReadyUI(menuReady);
  });

  // Race starting! Redirect to game
  socket.on('RACE_STARTING', (data) => {
    showStatus('Race startet! Lade Spiel...', true);
    btnReady.disabled = true;
    btnLeave.classList.add('hidden');

    // Stop camera
    if (camStream) {
      camStream.getTracks().forEach(t => t.stop());
    }

    // Save game settings to localStorage before game loads
    saveSettingsToLocalStorage();

    // Build URL params — redirect to overlay page (which embeds the game)
    setTimeout(() => {
      const params = new URLSearchParams({
        race: raceCode,
        player: String(myPlayerNumber),
      });
      if (isSolo) params.set('solo', '1');
      if (twitchId) params.set('twitchId', twitchId);

      // Pass seed directly via URL (avoids socket timing issues)
      if (data.seed) params.set('seed', data.seed);

      // Pass starters for this player (only in random mode)
      const myStarters = myPlayerNumber === 1 ? data.startersP1 : data.startersP2;
      if (myStarters && myStarters.length) {
        params.set('starters', JSON.stringify(myStarters));
      }

      // Pass game config
      if (data.starterMode) params.set('starterMode', data.starterMode);
      if (data.gameMode) params.set('gameMode', data.gameMode);
      if (data.winCondition) params.set('winCondition', data.winCondition);
      if (data.winWave) params.set('winWave', String(data.winWave));

      // Pass extended rules
      if (data.nuzlockeDeath) params.set('nuzDeath', '1');
      if (data.nuzlockeCatch) params.set('nuzCatch', '1');
      if (data.starterCount && data.starterCount !== 3) params.set('starterCount', String(data.starterCount));
      if (data.respawnOnWipe) params.set('respawn', '1');
      if (data.shinyMode && data.shinyMode !== 'off') params.set('shiny', data.shinyMode);
      if (data.luckLevel !== undefined && data.luckLevel !== -1) params.set('luck', String(data.luckLevel));

      // Pass camera settings
      const camEnabled = cameraEnabled.checked;
      params.set('cam', camEnabled ? '1' : '0');
      if (camEnabled && cameraDevice.value) {
        params.set('camDev', cameraDevice.value);
      }

      // Pass performance quality (per-player setting)
      if (perfQuality.value !== 'medium') {
        params.set('perf', perfQuality.value);
      }

      // Pass layout from server (synced for both players) or fallback to session
      if (data.overlayLayout) {
        params.set('layout', data.overlayLayout);
      } else {
        const savedLayout = sessionStorage.getItem('overlay-layout');
        if (savedLayout) params.set('layout', savedLayout);
      }

      // Pass cam width from server (synced for both players) or fallback to session
      if (data.overlayCamWidth !== undefined) {
        params.set('camW', String(data.overlayCamWidth));
      } else {
        const savedCamWidth = sessionStorage.getItem('cam-width');
        if (savedCamWidth) params.set('camW', savedCamWidth);
      }

      // Pass community width from server or fallback to session
      const layoutStr = (data.overlayLayout || sessionStorage.getItem('overlay-layout') || '').toUpperCase();
      if (layoutStr.includes('T')) {
        if (data.overlayCommunityWidth !== undefined && data.overlayCommunityWidth > 0) {
          params.set('comW', String(data.overlayCommunityWidth));
        } else {
          const savedComW = sessionStorage.getItem('com-width');
          if (savedComW && savedComW !== '0') params.set('comW', savedComW);
        }
      }

      // Pass cam zoom from server or fallback to session
      if (data.overlayCamZoom !== undefined && data.overlayCamZoom !== 100) {
        params.set('camZoom', String(data.overlayCamZoom));
      } else {
        const savedCamZoom = sessionStorage.getItem('cam-zoom');
        if (savedCamZoom && savedCamZoom !== '100') params.set('camZoom', savedCamZoom);
      }

      // Pass per-game + per-community offsets from server or fallback to session
      for (const key of ['g1x', 'g1y', 'g2x', 'g2y', 't1x', 't1y', 't2x', 't2y']) {
        const serverKey = 'overlay' + key.charAt(0).toUpperCase() + key.slice(1).toUpperCase();
        const serverVal = data[serverKey];
        if (serverVal !== undefined && serverVal !== 0) {
          params.set(key, String(serverVal));
        } else {
          const saved = sessionStorage.getItem(key);
          if (saved && saved !== '0') params.set(key, saved);
        }
      }

      // Pass HUD visibility from server or fallback to session
      if (data.overlayHud === false) {
        params.set('hud', '0');
      } else {
        const savedHud = sessionStorage.getItem('hud-enabled');
        if (savedHud === '0') params.set('hud', '0');
      }

      // Pass Timer visibility from server or fallback to session
      if (data.overlayTimer === false) {
        params.set('timer', '0');
      } else {
        const savedTimer = sessionStorage.getItem('timer-enabled');
        if (savedTimer === '0') params.set('timer', '0');
      }

      // Pass community session ID for overlay widget
      if (chatSessionFromUrl) {
        params.set('comSession', chatSessionFromUrl);
      }

      window.location.href = '/overlay/?' + params.toString();
    }, 1000);
  });

  socket.on('RACE_ERROR', ({ message }) => {
    showStatus(message, false);
  });

  socket.on('RACE_ENDED', ({ reason }) => {
    showStatus(reason || 'Race beendet', false);
    setTimeout(() => { window.location.href = '/lobby/'; }, 2000);
  });
}

// --- UI Updates ---

function updatePlayers(state) {
  if (state.host) {
    p1Name.textContent = state.host.name;
    if (state.host.avatar) p1Avatar.src = state.host.avatar;
  }
  if (state.guest) {
    p2Name.textContent = state.guest.name;
    if (state.guest.avatar) p2Avatar.src = state.guest.avatar;
  } else {
    p2Name.textContent = 'Warte...';
    p2Avatar.src = '';
  }
}

function updateRulesUI(state) {
  starterModeSelect.value = state.starterMode || 'random';
  updateStarterCountVisibility();
  if (!isHost) {
    gameModeSelect.value = state.gameMode || 'classic';
    starterCountSelect.value = String(state.starterCount || 3);
    nuzlockeDeathCb.checked = !!state.nuzlockeDeath;
    nuzlockeCatchCb.checked = !!state.nuzlockeCatch;
    respawnWipeCb.checked = !!state.respawnOnWipe;
    shinyModeSelect.value = state.shinyMode || 'off';
    luckLevelSelect.value = String(state.luckLevel !== undefined ? state.luckLevel : -1);
    // Map server winCondition+winWave to select preset
    setWinConditionUI(state.winCondition || 'wave', state.winWave || 20);
  }
  updateWaveFieldVisibility();
  updateMutualExclusion();
}

function updateRulesFromData(data) {
  if (data.starterMode) starterModeSelect.value = data.starterMode;
  updateStarterCountVisibility();
  if (!isHost) {
    if (data.gameMode) gameModeSelect.value = data.gameMode;
    if (data.starterCount !== undefined) starterCountSelect.value = String(data.starterCount);
    if (data.nuzlockeDeath !== undefined) nuzlockeDeathCb.checked = !!data.nuzlockeDeath;
    if (data.nuzlockeCatch !== undefined) nuzlockeCatchCb.checked = !!data.nuzlockeCatch;
    if (data.respawnOnWipe !== undefined) respawnWipeCb.checked = !!data.respawnOnWipe;
    if (data.shinyMode !== undefined) shinyModeSelect.value = data.shinyMode;
    if (data.luckLevel !== undefined) luckLevelSelect.value = String(data.luckLevel);
    if (data.winCondition) setWinConditionUI(data.winCondition, data.winWave || 20);
  }
  updateWaveFieldVisibility();
  updateMutualExclusion();
}

/** Map server winCondition+winWave to the preset select (for guest sync) */
function setWinConditionUI(condition, wave) {
  if (condition === 'wave' && wave === 100) {
    winConditionSelect.value = 'wave100';
  } else if (condition === 'wave' && wave === 200) {
    winConditionSelect.value = 'wave200';
  } else {
    winConditionSelect.value = condition;
  }
  winWaveInput.value = wave;
}

/** Show starter count only when random mode */
function updateStarterCountVisibility() {
  starterCountField.classList.toggle('hidden', starterModeSelect.value !== 'random');
}

/** Show wave input only for custom wave condition */
function updateWaveFieldVisibility() {
  const val = winConditionSelect.value;
  waveField.classList.toggle('hidden', val !== 'wave');
}

function updateMutualExclusion() {
  // No mutual exclusion — Nuzlocke death + respawn coexist:
  // Pokemon die permanently, but on full wipe you get your starters back at wave 1
}

function updateReadyUI(menuReady) {
  const r1 = menuReady[1];
  const r2 = menuReady[2];

  p1Ready.classList.toggle('is-ready', r1);
  p1ReadyText.textContent = r1 ? 'Bereit!' : 'Nicht bereit';

  if (!isSolo) {
    p2Ready.classList.toggle('is-ready', r2);
    p2ReadyText.textContent = r2 ? 'Bereit!' : 'Nicht bereit';
  }
}

function updateReadyButton() {
  if (isReady) {
    btnReady.textContent = 'BEREIT \u2713';
    btnReady.classList.add('is-ready');
  } else {
    btnReady.textContent = 'BEREIT';
    btnReady.classList.remove('is-ready');
  }
}

// --- Host Config Events ---
function saveRaceSettings() {
  try {
    localStorage.setItem('emmelrogue_race_settings', JSON.stringify({
      starterMode: starterModeSelect.value,
      starterCount: starterCountSelect.value,
      gameMode: gameModeSelect.value,
      winCondition: winConditionSelect.value,
      winWave: winWaveInput.value,
      nuzlockeDeath: nuzlockeDeathCb.checked,
      nuzlockeCatch: nuzlockeCatchCb.checked,
      respawnOnWipe: respawnWipeCb.checked,
      shinyMode: shinyModeSelect.value,
      luckLevel: luckLevelSelect.value,
    }));
  } catch {}
}

starterModeSelect.addEventListener('change', () => {
  if (!isHost) return;
  updateStarterCountVisibility();
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', {
    code: raceCode,
    starterMode: starterModeSelect.value,
  });
});

gameModeSelect.addEventListener('change', () => {
  if (!isHost) return;
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, gameMode: gameModeSelect.value });
});

winConditionSelect.addEventListener('change', () => {
  if (!isHost) return;
  const val = winConditionSelect.value;
  updateWaveFieldVisibility();
  let winCondition = val;
  let winWave = undefined;
  if (val === 'wave100') { winCondition = 'wave'; winWave = 100; winWaveInput.value = 100; }
  else if (val === 'wave200') { winCondition = 'wave'; winWave = 200; winWaveInput.value = 200; }
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, winCondition, ...(winWave !== undefined ? { winWave } : {}) });
});

let waveDebounce = null;
winWaveInput.addEventListener('input', () => {
  if (!isHost) return;
  clearTimeout(waveDebounce);
  waveDebounce = setTimeout(() => {
    saveRaceSettings();
    socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, winWave: parseInt(winWaveInput.value) || 20 });
  }, 500);
});

starterCountSelect.addEventListener('change', () => {
  if (!isHost) return;
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, starterCount: parseInt(starterCountSelect.value) || 3 });
});

nuzlockeDeathCb.addEventListener('change', () => {
  if (!isHost) return;
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, nuzlockeDeath: nuzlockeDeathCb.checked });
});

nuzlockeCatchCb.addEventListener('change', () => {
  if (!isHost) return;
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, nuzlockeCatch: nuzlockeCatchCb.checked });
});

respawnWipeCb.addEventListener('change', () => {
  if (!isHost) return;
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, respawnOnWipe: respawnWipeCb.checked });
});

shinyModeSelect.addEventListener('change', () => {
  if (!isHost) return;
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, shinyMode: shinyModeSelect.value });
});

luckLevelSelect.addEventListener('change', () => {
  if (!isHost) return;
  saveRaceSettings();
  socket.emit('RACE_CONFIG_UPDATE', { code: raceCode, luckLevel: parseInt(luckLevelSelect.value) });
});

// --- Ready ---
btnReady.addEventListener('click', () => {
  isReady = !isReady;
  updateReadyButton();

  socket.emit('RACE_PLAYER_READY', {
    code: raceCode,
    ready: isReady,
    cameraEnabled: cameraEnabled.checked,
    cameraDeviceId: cameraDevice.value || null,
  });
});

// --- Leave ---
btnLeave.addEventListener('click', () => {
  socket.emit('LEAVE_RACE', { code: raceCode });
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  window.location.href = '/lobby/';
});

// --- Copy Code ---
btnCopy.addEventListener('click', () => {
  if (!raceCode) return;
  navigator.clipboard.writeText(raceCode).then(() => {
    btnCopy.textContent = '\u2713';
    setTimeout(() => { btnCopy.innerHTML = '&#128203;'; }, 1500);
  }).catch(() => {});
});

// --- Camera ---
async function initCamera() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    cameraDevice.innerHTML = '';
    if (videoDevices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Keine Kamera gefunden';
      cameraDevice.appendChild(opt);
      cameraEnabled.checked = false;
      cameraEnabled.disabled = true;
      cameraPreviewWrapper.classList.add('disabled');
      return;
    }
    videoDevices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Kamera ${cameraDevice.options.length + 1}`;
      cameraDevice.appendChild(opt);
    });
    startCameraPreview();
  } catch {
    cameraEnabled.checked = false;
    cameraPreviewWrapper.classList.add('disabled');
  }
}

async function startCameraPreview() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }

  if (!cameraEnabled.checked) {
    cameraPreviewWrapper.classList.add('disabled');
    cameraPreview.srcObject = null;
    return;
  }

  cameraPreviewWrapper.classList.remove('disabled');
  try {
    const constraints = {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24 },
      },
      audio: false,
    };
    if (cameraDevice.value) {
      constraints.video.deviceId = { exact: cameraDevice.value };
    }
    camStream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraPreview.srcObject = camStream;
  } catch (err) {
    console.warn('Camera preview failed:', err);
    cameraPreviewWrapper.classList.add('disabled');
  }
}

cameraEnabled.addEventListener('change', startCameraPreview);
cameraDevice.addEventListener('change', startCameraPreview);

// --- Game Settings (per player, localStorage) ---

// Map of setting key (localStorage) -> DOM select id
const SETTINGS_MAP = {
  'GAME_SPEED': 'set-game-speed',
  'HP_BAR_SPEED': 'set-hp-bar-speed',
  'EXP_GAINS_SPEED': 'set-exp-gains-speed',
  'EXP_PARTY_DISPLAY': 'set-exp-party-display',
  'BATTLE_STYLE': 'set-battle-style',
  'DAMAGE_NUMBERS': 'set-damage-numbers',
  'MOVE_ANIMATIONS': 'set-move-animations',
  'TYPE_HINTS': 'set-type-hints',
  'SHOW_LEVEL_UP_STATS': 'set-show-level-up-stats',
  'TUTORIALS': 'set-tutorials',
  'SKIP_SEEN_DIALOGUES': 'set-skip-dialogues',
  'COMMAND_CURSOR_MEMORY': 'set-cursor-memory',
  'ENABLE_RETRIES': 'set-retries',
  'WINDOW_TYPE': 'set-window-type',
  'MONEY_FORMAT': 'set-money-format',
  'SHOW_MOVESET_FLYOUT': 'set-moveset-flyout',
  'SHOW_ARENA_FLYOUT': 'set-arena-flyout',
  'MOVE_INFO': 'set-move-info',
  'SPRITE_SET': 'set-sprite-set',
  'PLAYER_GENDER': 'set-player-gender',
  'SHOP_CURSOR_TARGET': 'set-shop-cursor',
  'SHOP_OVERLAY_OPACITY': 'set-shop-opacity',
  'SHOW_BGM_BAR': 'set-show-bgm-bar',
  'MASTER_VOLUME': 'set-master-volume',
  'BGM_VOLUME': 'set-bgm-volume',
  'SE_VOLUME': 'set-se-volume',
  'UI_SOUND_EFFECTS': 'set-ui-volume',
  'BATTLE_MUSIC': 'set-battle-music',
};

// Load existing settings from localStorage into the UI
function loadSettingsUI() {
  try {
    const raw = localStorage.getItem('settings');
    if (!raw) return;
    const settings = JSON.parse(raw);
    for (const [key, domId] of Object.entries(SETTINGS_MAP)) {
      if (settings[key] !== undefined) {
        const el = document.getElementById(domId);
        if (el) el.value = String(settings[key]);
      }
    }
  } catch { /* ignore */ }
}

// Save settings from UI to localStorage
function saveSettingsToLocalStorage() {
  let settings = {};
  try {
    const raw = localStorage.getItem('settings');
    if (raw) settings = JSON.parse(raw);
  } catch { /* ignore */ }

  for (const [key, domId] of Object.entries(SETTINGS_MAP)) {
    const el = document.getElementById(domId);
    if (el) settings[key] = parseInt(el.value);
  }

  localStorage.setItem('settings', JSON.stringify(settings));
}

// Build a readable export string of current settings
function exportSettingsText() {
  const lines = [];
  for (const [key, domId] of Object.entries(SETTINGS_MAP)) {
    const el = document.getElementById(domId);
    if (!el) continue;
    const selectedOption = el.options[el.selectedIndex];
    lines.push(`${key}: ${el.value} (${selectedOption.textContent})`);
  }
  return lines.join('\n');
}

// Toggle collapsible
const settingsToggle = document.getElementById('settings-toggle');
const settingsContent = document.getElementById('settings-content');
const settingsArrow = document.getElementById('settings-arrow');

settingsToggle.addEventListener('click', () => {
  const isHidden = settingsContent.classList.toggle('hidden');
  settingsArrow.classList.toggle('open', !isHidden);
});

// Export button
document.getElementById('btn-export-settings').addEventListener('click', () => {
  const text = exportSettingsText();
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-export-settings');
    btn.textContent = 'Kopiert!';
    setTimeout(() => { btn.textContent = 'Einstellungen kopieren'; }, 2000);
  }).catch(() => {});
});

// Load settings on page load
loadSettingsUI();

// --- Helpers ---
function showStatus(message, success) {
  statusBar.classList.remove('hidden', 'success');
  if (success) statusBar.classList.add('success');
  statusText.textContent = message;
}
