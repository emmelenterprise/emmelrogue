/* eslint-disable no-undef */

// --- Twitch OAuth Config ---
const TWITCH_CLIENT_ID = 'aoqvg74maqoulqjqs64osjwdkh4xut';
const REDIRECT_URI = window.location.origin + '/lobby/';
const TWITCH_SCOPES = ''; // No special scopes needed, just identity

// --- DOM Elements ---
const loginSection = document.getElementById('login-section');
const userInfoEl = document.getElementById('user-info');
const setupSection = document.getElementById('setup-section');
const lobbySection = document.getElementById('lobby-section');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const connectionEl = document.getElementById('connection');
const connectionText = document.getElementById('connection-text');

// Login
const btnTwitchLogin = document.getElementById('btn-twitch-login');
const btnLogout = document.getElementById('btn-logout');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');

// Join
const joinCodeInput = document.getElementById('join-code');
const btnJoin = document.getElementById('btn-join');
const btnCreate = document.getElementById('btn-create');

// Lobby
const lobbyCode = document.getElementById('lobby-code');
const lobbyStarterMode = document.getElementById('lobby-starter-mode');
const player1Name = document.getElementById('player1-name');
const player1Slot = document.getElementById('player1-slot');
const player1Status = document.getElementById('player1-status');
const player1Avatar = document.getElementById('player1-avatar');
const player2Name = document.getElementById('player2-name');
const player2Slot = document.getElementById('player2-slot');
const player2Status = document.getElementById('player2-status');
const player2Avatar = document.getElementById('player2-avatar');
const btnStart = document.getElementById('btn-start');
const btnLeave = document.getElementById('btn-leave');
const btnCopy = document.getElementById('btn-copy');

// --- State ---
let currentRaceCode = null;
let myPlayerNumber = null;
let twitchUser = null; // { id, login, display_name, profile_image_url }

// --- Twitch OAuth ---
function startTwitchLogin() {
  // Preserve join code across OAuth redirect
  const joinCode = joinCodeInput ? joinCodeInput.value.trim() : '';
  const state = joinCode ? `code:${joinCode}` : 'none';

  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.searchParams.set('client_id', TWITCH_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', TWITCH_SCOPES);
  url.searchParams.set('state', state);
  window.location.href = url.toString();
}

async function handleOAuthCallback() {
  const hash = window.location.hash;
  if (!hash || !hash.includes('access_token')) return false;

  // Parse token from hash fragment
  const params = new URLSearchParams(hash.substring(1));
  const accessToken = params.get('access_token');
  const state = params.get('state');

  if (!accessToken) return false;

  // Clear hash from URL
  history.replaceState(null, '', window.location.pathname + window.location.search);

  // Fetch user info from Twitch
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });
    const data = await res.json();
    if (!data.data || !data.data[0]) throw new Error('No user data');

    twitchUser = data.data[0];
    // Save to sessionStorage
    sessionStorage.setItem('twitch-user', JSON.stringify(twitchUser));
    sessionStorage.setItem('twitch-token', accessToken);

    // Also store in localStorage for cross-page sharing (community page)
    localStorage.setItem('twitch_community_user', JSON.stringify(twitchUser));
    localStorage.setItem('twitch_community_token', accessToken);

    // Check if we should redirect back to community page
    const returnUrl = localStorage.getItem('twitch_auth_return');
    if (returnUrl && (returnUrl.includes('/community') || returnUrl.includes('/gym'))) {
      localStorage.removeItem('twitch_auth_return');
      window.location.href = returnUrl;
      return true;
    }

    // Restore join code from state
    if (state && state.startsWith('code:')) {
      const code = state.substring(5);
      if (code && joinCodeInput) joinCodeInput.value = code;
    }

    return true;
  } catch (err) {
    console.error('Twitch auth failed:', err);
    showStatus('Twitch-Anmeldung fehlgeschlagen', false);
    return false;
  }
}

function restoreSession() {
  const saved = sessionStorage.getItem('twitch-user');
  if (saved) {
    try {
      twitchUser = JSON.parse(saved);
      return true;
    } catch { /* ignore */ }
  }
  return false;
}

function showLoggedInUI() {
  loginSection.classList.add('hidden');
  userInfoEl.classList.remove('hidden');
  setupSection.classList.remove('hidden');

  userAvatar.src = twitchUser.profile_image_url;
  userName.textContent = twitchUser.display_name;

  // Show streamer-only UI for janemmel
  const isStreamer = twitchUser.login === 'janemmel';
  if (isStreamer) {
    const layoutConfig = document.getElementById('layout-config');
    if (layoutConfig) {
      layoutConfig.classList.remove('hidden');
      updateLayoutPreview();
      startCamPreview();
    }
    const streamerTools = document.getElementById('streamer-tools');
    if (streamerTools) streamerTools.classList.remove('hidden');
    // Show gym button
    if (btnGym) btnGym.classList.remove('hidden');
  }

  // Nur Streamer kann Spiele erstellen — Buttons verstecken fuer alle anderen
  if (!isStreamer) {
    const btnCreate = document.getElementById('btn-create');
    const btnSolo = document.getElementById('btn-solo');
    if (btnCreate) btnCreate.style.display = 'none';
    if (btnSolo) btnSolo.style.display = 'none';
  }

  // If returning from a gym battle, auto-enter gym mode
  if (isStreamer && gymReturn) {
    // Check if gym session is still active via socket
    socket.emit('GYM_JOIN');
    socket.once('GYM_STATE', (state) => {
      if (state.active) {
        gymState = state;
        showGymLobby();
      }
    });
  }

  // Auto-join if ?code= is in URL
  if (urlCode && twitchUser) {
    socket.emit('JOIN_RACE', {
      code: urlCode.toUpperCase(),
      name: twitchUser.display_name,
      avatar: twitchUser.profile_image_url,
      twitchId: twitchUser.id,
    });
  }
}

function logout() {
  sessionStorage.removeItem('twitch-user');
  sessionStorage.removeItem('twitch-token');
  twitchUser = null;
  stopCamPreview();
  resetToSetup();
  loginSection.classList.remove('hidden');
  userInfoEl.classList.add('hidden');
  setupSection.classList.add('hidden');
}

// --- Socket.io ---
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  connectionEl.classList.add('connected');
  connectionEl.classList.remove('disconnected');
  connectionText.textContent = 'Verbunden';
});

socket.on('disconnect', () => {
  connectionEl.classList.remove('connected');
  connectionEl.classList.add('disconnected');
  connectionText.textContent = 'Getrennt';
});

// --- Create Race ---
const overlayLayoutSelect = document.getElementById('overlay-layout');
const camWidthSlider = document.getElementById('cam-width-slider');
const camWidthValue = document.getElementById('cam-width-value');
const camZoomSlider = document.getElementById('cam-zoom-slider');
const camZoomValue = document.getElementById('cam-zoom-value');
const g1xSlider = document.getElementById('g1x-slider');
const g1xValue = document.getElementById('g1x-value');
const g1ySlider = document.getElementById('g1y-slider');
const g1yValue = document.getElementById('g1y-value');
const g2xSlider = document.getElementById('g2x-slider');
const g2xValue = document.getElementById('g2x-value');
const g2ySlider = document.getElementById('g2y-slider');
const g2yValue = document.getElementById('g2y-value');
const btnCopySpecs = document.getElementById('btn-copy-specs');
const hudEnabled = document.getElementById('hud-enabled');
const timerEnabled = document.getElementById('timer-enabled');
const comWidthSlider = document.getElementById('com-width-slider');
const comWidthValue = document.getElementById('com-width-value');
const comWidthRow = document.getElementById('community-width-row');
const t1xSlider = document.getElementById('t1x-slider');
const t1xValue = document.getElementById('t1x-value');
const t1ySlider = document.getElementById('t1y-slider');
const t1yValue = document.getElementById('t1y-value');
const t2xSlider = document.getElementById('t2x-slider');
const t2xValue = document.getElementById('t2x-value');
const t2ySlider = document.getElementById('t2y-slider');
const t2yValue = document.getElementById('t2y-value');

// --- Slider <-> Input Sync Helper ---
function linkSliderInput(slider, input, storageKey, suffix) {
  suffix = suffix || '';
  // Slider → input
  slider.addEventListener('input', () => {
    input.value = slider.value;
    if (storageKey) sessionStorage.setItem(storageKey, slider.value);
    updateLayoutPreview();
    updateObsUrl();
  });
  // Input → slider
  input.addEventListener('change', () => {
    let v = parseInt(input.value) || 0;
    v = Math.max(parseInt(slider.min), Math.min(parseInt(slider.max), v));
    input.value = v;
    slider.value = v;
    if (storageKey) sessionStorage.setItem(storageKey, String(v));
    updateLayoutPreview();
    updateObsUrl();
  });
}

// Camera preview for layout configurator
let camPreviewStream = null;
const camPreviewVideo = document.getElementById('cam-preview');

async function startCamPreview() {
  if (camPreviewStream) return; // Already started
  try {
    camPreviewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 480 }, height: { ideal: 320 }, frameRate: { ideal: 15 } },
      audio: false,
    });
    if (camPreviewVideo) {
      camPreviewVideo.srcObject = camPreviewStream;
    }
  } catch (err) {
    console.warn('Cam preview failed:', err);
  }
}

function stopCamPreview() {
  if (camPreviewStream) {
    camPreviewStream.getTracks().forEach(t => t.stop());
    camPreviewStream = null;
    if (camPreviewVideo) camPreviewVideo.srcObject = null;
  }
}

// --- Layout Preview ---
const OBS_WIDTH = 1920; // Reference OBS canvas width
const OBS_HEIGHT = 1080; // Reference OBS canvas height
const GAME_ASPECT = 16 / 9; // PokeRogue game aspect ratio (~16:9)
const GAME_WIDTH = Math.round((OBS_HEIGHT / 2) * GAME_ASPECT); // 960
const REMAINING = OBS_WIDTH - GAME_WIDTH; // 960 — split between cam + community

function updateLayoutPreview() {
  const layout = overlayLayoutSelect.value;
  const camW = parseInt(camWidthSlider.value);
  const comW = parseInt(comWidthSlider.value) || 0;
  const parts = layout.toUpperCase().split('-');

  const row1 = document.getElementById('lp-row-1');
  const row2 = document.getElementById('lp-row-2');
  const cam1 = document.getElementById('lp-cam-1');
  const cam2 = document.getElementById('lp-cam-2');
  const gc1 = document.getElementById('lp-gc-1');
  const gc2 = document.getElementById('lp-gc-2');

  // Community preview elements
  const com1 = document.getElementById('lp-com-1');
  const com2 = document.getElementById('lp-com-2');

  const row1Order = (parts[0] || 'CG').trim();
  const row2Order = (parts[1] || 'CG').trim();
  const row1Base = row1Order.replace(/T/g, '');
  const row2Base = row2Order.replace(/T/g, '');

  // Detect T-slot presence
  const hasT1 = row1Order.includes('T');
  const hasT2 = row2Order.includes('T');
  const hasT = hasT1 || hasT2;

  // Show/hide community width slider + T-slot offset controls
  if (comWidthRow) comWidthRow.classList.toggle('hidden', !hasT);
  document.getElementById('t1-offset-label').classList.toggle('hidden', !hasT1);
  document.getElementById('t1x-row').classList.toggle('hidden', !hasT1);
  document.getElementById('t1y-row').classList.toggle('hidden', !hasT1);
  document.getElementById('t2-offset-label').classList.toggle('hidden', !hasT2);
  document.getElementById('t2x-row').classList.toggle('hidden', !hasT2);
  document.getElementById('t2y-row').classList.toggle('hidden', !hasT2);

  // Cam position (flex-direction: row or row-reverse)
  // Only use cam-right (row-reverse) for simple 2-element layouts without T
  row1.classList.toggle('cam-right', row1Base === 'GC' && !hasT1);
  row2.classList.toggle('cam-right', row2Base === 'GC' && !hasT2);

  // For layouts with T, use explicit flex order on preview elements
  if (hasT1) {
    const cam1El = document.getElementById('lp-cam-1');
    const game1El = document.getElementById('lp-game-1');
    // Set order based on layout string position
    for (let i = 0; i < row1Order.length; i++) {
      const ch = row1Order[i];
      if (ch === 'C' && cam1El) cam1El.style.order = String(i);
      if (ch === 'G' && game1El) game1El.style.order = String(i);
      // T elements are positioned via left/right DOM elements, not order
    }
  } else {
    // Reset order for non-T layouts
    cam1.style.order = '';
    document.getElementById('lp-game-1').style.order = '';
  }
  if (hasT2) {
    const cam2El = document.getElementById('lp-cam-2');
    const game2El = document.getElementById('lp-game-2');
    for (let i = 0; i < row2Order.length; i++) {
      const ch = row2Order[i];
      if (ch === 'C' && cam2El) cam2El.style.order = String(i);
      if (ch === 'G' && game2El) game2El.style.order = String(i);
    }
  } else {
    cam2.style.order = '';
    document.getElementById('lp-game-2').style.order = '';
  }

  // Detect if layout has cameras
  const hasCam1 = row1Order.includes('C');
  const hasCam2 = row2Order.includes('C');

  // Cam width as percentage of preview width
  if (camW === 0 || !hasCam1) {
    cam1.classList.add('lp-hidden');
  } else {
    cam1.classList.remove('lp-hidden');
    const pct = (camW / OBS_WIDTH * 100).toFixed(1);
    cam1.style.width = pct + '%';
  }
  if (camW === 0 || !hasCam2) {
    cam2.classList.add('lp-hidden');
  } else {
    cam2.classList.remove('lp-hidden');
    const pct = (camW / OBS_WIDTH * 100).toFixed(1);
    cam2.style.width = pct + '%';
  }
  if (camW === 0) {
    camWidthValue.textContent = 'Aus';
  } else {
    camWidthValue.textContent = camW + 'px';
  }

  // Community slots in preview
  // Hide all community preview slots first + reset order
  com1.classList.add('lp-hidden');
  com1.style.order = '';
  com2.classList.add('lp-hidden');
  com2.style.order = '';

  const effectiveComW = hasT ? comW : 0;

  if (hasT1 && effectiveComW > 0) {
    const comPct = (effectiveComW / OBS_WIDTH * 100).toFixed(1);
    const tIdx = row1Order.indexOf('T');
    // Use left element (com1) and set its order for correct positioning
    com1.classList.remove('lp-hidden');
    com1.style.width = comPct + '%';
    com1.style.order = String(tIdx);
  }
  if (hasT2 && effectiveComW > 0) {
    const comPct = (effectiveComW / OBS_WIDTH * 100).toFixed(1);
    const tIdx = row2Order.indexOf('T');
    com2.classList.remove('lp-hidden');
    com2.style.width = comPct + '%';
    com2.style.order = String(tIdx);
  }

  // Calculate game content area (object-fit: contain simulation)
  // Each row is half of OBS height
  const rowHeight = OBS_HEIGHT / 2;
  const camUsed1 = (hasCam1 && camW > 0) ? camW : 0;
  const camUsed2 = (hasCam2 && camW > 0) ? camW : 0;
  const comUsed = hasT ? effectiveComW : 0;
  const gameSlotWidth1 = OBS_WIDTH - camUsed1 - (hasT1 ? comUsed : 0);
  const gameSlotWidth2 = OBS_WIDTH - camUsed2 - (hasT2 ? comUsed : 0);

  function calcGameFit(slotW) {
    // Game always fills full height — only width adjusts (black bars left/right)
    const gH = 100;
    const gW = (GAME_ASPECT / (slotW / rowHeight)) * 100;
    return { gW: Math.min(gW, 100), gH };
  }

  const fit1 = calcGameFit(gameSlotWidth1);
  const fit2 = calcGameFit(gameSlotWidth2);

  // Per-game offsets
  const offsets = [
    { gc: gc1, x: parseInt(g1xSlider.value), y: parseInt(g1ySlider.value), slotW: gameSlotWidth1, fit: fit1 },
    { gc: gc2, x: parseInt(g2xSlider.value), y: parseInt(g2ySlider.value), slotW: gameSlotWidth2, fit: fit2 },
  ];

  for (const { gc, x, y, slotW, fit } of offsets) {
    if (!gc) continue;
    gc.style.width = fit.gW + '%';
    gc.style.height = fit.gH + '%';
    const transforms = [];
    if (x !== 0) transforms.push(`translateX(${(x / slotW * 100).toFixed(1)}%)`);
    if (y !== 0) transforms.push(`translateY(${(y / rowHeight * 100).toFixed(1)}%)`);
    gc.style.transform = transforms.length ? transforms.join(' ') : '';
    gc.textContent = `${slotW}x${rowHeight}`;

    // Show border indicators in the black bar areas
    const gameEl = gc.parentElement;
    gameEl.querySelectorAll('.lp-border-indicator').forEach(el => el.remove());
    if (fit.gW < 99) {
      const borderPct = ((100 - fit.gW) / 2).toFixed(1) + '%';
      const leftInd = document.createElement('div');
      leftInd.className = 'lp-border-indicator left';
      leftInd.style.width = borderPct;
      leftInd.innerHTML = '<span>Rand</span>';
      const rightInd = document.createElement('div');
      rightInd.className = 'lp-border-indicator right';
      rightInd.style.width = borderPct;
      rightInd.innerHTML = '<span>Rand</span>';
      gameEl.appendChild(leftInd);
      gameEl.appendChild(rightInd);
    }
  }

  // Cam zoom preview
  const camZoom = parseInt(camZoomSlider.value);
  if (camPreviewVideo) {
    const z = camZoom / 100;
    camPreviewVideo.style.transform = `scale(${z})`;
  }
}

// --- Cam ↔ Community Coupling ---
// Game is always GAME_WIDTH px wide. cam + com = REMAINING.
let _coupling = false;
function applyCoupling(changedIsCam) {
  const layout = overlayLayoutSelect.value.toUpperCase();
  const hasT = layout.includes('T');
  const hasC = layout.includes('C');
  if (!hasT || !hasC || _coupling) return;
  _coupling = true;
  if (changedIsCam) {
    const camW = parseInt(camWidthSlider.value) || 0;
    const newComW = Math.max(0, Math.min(REMAINING, REMAINING - camW));
    comWidthSlider.value = newComW;
    comWidthValue.value = newComW;
    sessionStorage.setItem('com-width', String(newComW));
  } else {
    const comW = parseInt(comWidthSlider.value) || 0;
    const newCamW = Math.max(0, Math.min(REMAINING, REMAINING - comW));
    camWidthSlider.value = newCamW;
    camWidthValue.value = newCamW;
    sessionStorage.setItem('cam-width', String(newCamW));
  }
  _coupling = false;
}

// Restore saved settings
const savedCamWidth = sessionStorage.getItem('cam-width');
const savedLayout = sessionStorage.getItem('overlay-layout');
const savedCamZoom = sessionStorage.getItem('cam-zoom');
const savedComWidth = sessionStorage.getItem('com-width');
if (savedCamWidth) camWidthSlider.value = savedCamWidth;
if (savedLayout) overlayLayoutSelect.value = savedLayout;
if (savedCamZoom) camZoomSlider.value = savedCamZoom;
if (savedComWidth) { comWidthSlider.value = savedComWidth; comWidthValue.value = savedComWidth; }
// Per-game offsets
for (const [key, slider, input] of [
  ['g1x', g1xSlider, g1xValue], ['g1y', g1ySlider, g1yValue],
  ['g2x', g2xSlider, g2xValue], ['g2y', g2ySlider, g2yValue],
  ['t1x', t1xSlider, t1xValue], ['t1y', t1ySlider, t1yValue],
  ['t2x', t2xSlider, t2xValue], ['t2y', t2ySlider, t2yValue],
]) {
  const saved = sessionStorage.getItem(key);
  if (saved) { slider.value = saved; input.value = saved; }
}

// Restore HUD/Timer toggles
const savedHud = sessionStorage.getItem('hud-enabled');
if (savedHud !== null) hudEnabled.checked = savedHud === '1';
const savedTimer = sessionStorage.getItem('timer-enabled');
if (savedTimer !== null) timerEnabled.checked = savedTimer === '1';

// Init display values (sync inputs with sliders)
camWidthValue.value = camWidthSlider.value;
camZoomValue.value = camZoomSlider.value;

// Init preview
updateLayoutPreview();

// Apply coupling on init (cam is master)
applyCoupling(true);
updateLayoutPreview();

// Link cam width (with coupling)
camWidthSlider.addEventListener('input', () => {
  camWidthValue.value = camWidthSlider.value;
  sessionStorage.setItem('cam-width', camWidthSlider.value);
  applyCoupling(true);
  updateLayoutPreview();
  updateObsUrl();
});
camWidthValue.addEventListener('change', () => {
  let v = parseInt(camWidthValue.value) || 0;
  v = Math.max(0, Math.min(parseInt(camWidthSlider.max), v));
  camWidthValue.value = v;
  camWidthSlider.value = v;
  sessionStorage.setItem('cam-width', String(v));
  applyCoupling(true);
  updateLayoutPreview();
  updateObsUrl();
});

// Link cam zoom (normal, no coupling)
linkSliderInput(camZoomSlider, camZoomValue, 'cam-zoom');

// Link community width (with coupling)
comWidthSlider.addEventListener('input', () => {
  comWidthValue.value = comWidthSlider.value;
  sessionStorage.setItem('com-width', comWidthSlider.value);
  applyCoupling(false);
  updateLayoutPreview();
  updateObsUrl();
});
comWidthValue.addEventListener('change', () => {
  let v = parseInt(comWidthValue.value) || 0;
  v = Math.max(0, Math.min(parseInt(comWidthSlider.max), v));
  comWidthValue.value = v;
  comWidthSlider.value = v;
  sessionStorage.setItem('com-width', String(v));
  applyCoupling(false);
  updateLayoutPreview();
  updateObsUrl();
});
linkSliderInput(g1xSlider, g1xValue, 'g1x');
linkSliderInput(g1ySlider, g1yValue, 'g1y');
linkSliderInput(g2xSlider, g2xValue, 'g2x');
linkSliderInput(g2ySlider, g2yValue, 'g2y');
linkSliderInput(t1xSlider, t1xValue, 't1x');
linkSliderInput(t1ySlider, t1yValue, 't1y');
linkSliderInput(t2xSlider, t2xValue, 't2x');
linkSliderInput(t2ySlider, t2yValue, 't2y');

// --- Solo Mode ---
const btnSolo = document.getElementById('btn-solo');
btnSolo.addEventListener('click', () => {
  if (!twitchUser) return;
  const starterMode = document.querySelector('input[name="starter-mode"]:checked').value;
  const overlayLayout = overlayLayoutSelect.value;
  socket.emit('CREATE_RACE', {
    name: twitchUser.display_name,
    avatar: twitchUser.profile_image_url,
    twitchId: twitchUser.id,
    starterMode,
    solo: true,
    overlayLayout,
    overlayCamWidth: camWidthSlider.value,
    overlayCamZoom: camZoomSlider.value,
    overlayCommunityWidth: comWidthSlider.value,
    overlayG1X: g1xSlider.value,
    overlayG1Y: g1ySlider.value,
    overlayG2X: g2xSlider.value,
    overlayG2Y: g2ySlider.value,
    overlayT1X: t1xSlider.value,
    overlayT1Y: t1ySlider.value,
    overlayT2X: t2xSlider.value,
    overlayT2Y: t2ySlider.value,
    overlayHud: hudEnabled.checked ? '1' : '0',
    overlayTimer: timerEnabled.checked ? '1' : '0',
  });
});

btnCreate.addEventListener('click', () => {
  if (!twitchUser) return;
  const starterMode = document.querySelector('input[name="starter-mode"]:checked').value;
  const overlayLayout = overlayLayoutSelect.value;
  socket.emit('CREATE_RACE', {
    name: twitchUser.display_name,
    avatar: twitchUser.profile_image_url,
    twitchId: twitchUser.id,
    starterMode,
    overlayLayout,
    overlayCamWidth: camWidthSlider.value,
    overlayCamZoom: camZoomSlider.value,
    overlayCommunityWidth: comWidthSlider.value,
    overlayG1X: g1xSlider.value,
    overlayG1Y: g1ySlider.value,
    overlayG2X: g2xSlider.value,
    overlayG2Y: g2ySlider.value,
    overlayT1X: t1xSlider.value,
    overlayT1Y: t1ySlider.value,
    overlayT2X: t2xSlider.value,
    overlayT2Y: t2ySlider.value,
    overlayHud: hudEnabled.checked ? '1' : '0',
    overlayTimer: timerEnabled.checked ? '1' : '0',
  });
});

let chatSessionId = null;
socket.on('RACE_CREATED', ({ code, solo, chatSessionId: csId }) => {
  currentRaceCode = code;
  chatSessionId = csId || null;
  myPlayerNumber = 1;
  if (solo) {
    isSoloMode = true;
  }
  showLobby();
});

// --- Join Race ---
btnJoin.addEventListener('click', () => {
  if (!twitchUser) return;
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code || code.length < 4) {
    showStatus('Bitte gib einen gueltigen Code ein', false);
    joinCodeInput.focus();
    return;
  }
  socket.emit('JOIN_RACE', {
    code,
    name: twitchUser.display_name,
    avatar: twitchUser.profile_image_url,
    twitchId: twitchUser.id,
  });
});

socket.on('RACE_JOINED', ({ code, player }) => {
  currentRaceCode = code;
  myPlayerNumber = player;
  showLobby();
  hideStatus();
});

socket.on('RACE_ERROR', ({ message }) => {
  showStatus(message, false);
});

// --- Race State Updates ---
socket.on('RACE_STATE', (state) => {
  if (!currentRaceCode) return;

  lobbyCode.textContent = state.code;
  const modeLabels = {
    'random': 'Random',
    'free': 'Freie Wahl',
  };
  lobbyStarterMode.textContent = modeLabels[state.starterMode] || state.starterMode;

  // Player 1
  if (state.host) {
    player1Name.textContent = state.host.name;
    player1Name.classList.remove('waiting');
    player1Slot.classList.add('connected');
    player1Status.textContent = '';
    if (state.host.avatar) {
      player1Avatar.src = state.host.avatar;
      player1Avatar.classList.add('visible');
    }
  } else {
    player1Name.textContent = 'Warte...';
    player1Name.classList.add('waiting');
    player1Slot.classList.remove('connected');
    player1Avatar.classList.remove('visible');
  }

  // Player 2
  if (state.guest) {
    player2Name.textContent = state.guest.name;
    player2Name.classList.remove('waiting');
    player2Slot.classList.add('connected');
    player2Status.textContent = '';
    if (state.guest.avatar) {
      player2Avatar.src = state.guest.avatar;
      player2Avatar.classList.add('visible');
    }
  } else {
    player2Name.textContent = 'Warte...';
    player2Name.classList.add('waiting');
    player2Slot.classList.remove('connected');
    player2Avatar.classList.remove('visible');
  }

  // Show start button only for host when guest has joined (or solo mode)
  if (isSoloMode) {
    // Solo: don't hide start button (RACE_TO_MENU handler shows it)
  } else if (myPlayerNumber === 1 && state.guest && state.status === 'waiting') {
    btnStart.classList.remove('hidden');
    btnStart.classList.add('pulse');
  } else {
    btnStart.classList.add('hidden');
    btnStart.classList.remove('pulse');
  }
});

// --- Start Race ---
btnStart.addEventListener('click', () => {
  if (!currentRaceCode) return;
  btnStart.disabled = true;
  btnStart.textContent = 'Starte...';

  // Solo: already got RACE_TO_MENU data, just redirect
  if (isSoloMode && soloMenuData) {
    redirectToMenu();
    return;
  }

  socket.emit('START_RACE', { code: currentRaceCode });
});

let isSoloMode = false;
let soloMenuData = null;

function redirectToMenu() {
  const params = new URLSearchParams({
    code: currentRaceCode,
    player: String(myPlayerNumber),
  });
  if (isSoloMode) params.set('solo', '1');
  if (chatSessionId) params.set('chatSession', chatSessionId);
  if (twitchUser && twitchUser.id) {
    params.set('twitchId', twitchUser.id);
  }
  window.location.href = '/race-menu/?' + params.toString();
}

socket.on('RACE_TO_MENU', (data) => {
  if (data && data.solo) isSoloMode = true;
  if (data && data.chatSessionId) chatSessionId = data.chatSessionId;

  // Solo: don't redirect yet — user is in lobby viewing the code
  // They'll click "Start" to proceed
  if (isSoloMode && !soloMenuData) {
    soloMenuData = data;
    btnStart.classList.remove('hidden');
    btnStart.textContent = 'Solo starten';
    return;
  }

  showStatus('Weiter zum Race-Menu...', true);
  btnStart.classList.add('hidden');
  btnLeave.classList.add('hidden');
  setTimeout(redirectToMenu, 1000);
});

// --- Leave Race ---
btnLeave.addEventListener('click', () => {
  if (!currentRaceCode) return;
  socket.emit('LEAVE_RACE', { code: currentRaceCode });
  resetToSetup();
});

socket.on('RACE_ENDED', ({ reason }) => {
  showStatus(reason || 'Race beendet', false);
  resetToSetup();
});

// --- OBS URL ---
const obsUrlSection = document.getElementById('obs-url-section');
const obsUrlInput = document.getElementById('obs-url');
const btnCopyObs = document.getElementById('btn-copy-obs');

function updateObsUrl() {
  if (!currentRaceCode) return;
  const layout = overlayLayoutSelect.value;
  const camW = camWidthSlider.value;
  const camZoom = camZoomSlider.value;
  const comW = comWidthSlider.value;
  const hasT = layout.toUpperCase().includes('T');
  let url = `${window.location.origin}/overlay/?race=${currentRaceCode}&layout=${layout}`;
  if (isSoloMode) url += '&solo=1';
  if (camW !== '340') url += `&camW=${camW}`;
  if (camZoom && camZoom !== '100') url += `&camZoom=${camZoom}`;
  if (hasT && comW && comW !== '0') url += `&comW=${comW}`;
  if (g1xSlider.value !== '0') url += `&g1x=${g1xSlider.value}`;
  if (g1ySlider.value !== '0') url += `&g1y=${g1ySlider.value}`;
  if (g2xSlider.value !== '0') url += `&g2x=${g2xSlider.value}`;
  if (g2ySlider.value !== '0') url += `&g2y=${g2ySlider.value}`;
  if (hasT && t1xSlider.value !== '0') url += `&t1x=${t1xSlider.value}`;
  if (hasT && t1ySlider.value !== '0') url += `&t1y=${t1ySlider.value}`;
  if (hasT && t2xSlider.value !== '0') url += `&t2x=${t2xSlider.value}`;
  if (hasT && t2ySlider.value !== '0') url += `&t2y=${t2ySlider.value}`;
  if (!hudEnabled.checked) url += '&hud=0';
  if (!timerEnabled.checked) url += '&timer=0';
  obsUrlInput.value = url;
  obsUrlSection.classList.remove('hidden');
}

btnCopyObs.addEventListener('click', () => {
  if (!obsUrlInput.value) return;
  navigator.clipboard.writeText(obsUrlInput.value).then(() => {
    btnCopyObs.textContent = '\u2713';
    setTimeout(() => { btnCopyObs.innerHTML = '&#128203;'; }, 1500);
  });
});

overlayLayoutSelect.addEventListener('change', () => {
  sessionStorage.setItem('overlay-layout', overlayLayoutSelect.value);
  // Apply coupling when switching to T+C layout
  const layout = overlayLayoutSelect.value.toUpperCase();
  if (layout.includes('T') && layout.includes('C')) {
    applyCoupling(true); // Cam is master, com adjusts
  }
  updateLayoutPreview();
  updateObsUrl();
});

hudEnabled.addEventListener('change', () => {
  sessionStorage.setItem('hud-enabled', hudEnabled.checked ? '1' : '0');
  updateObsUrl();
});

timerEnabled.addEventListener('change', () => {
  sessionStorage.setItem('timer-enabled', timerEnabled.checked ? '1' : '0');
  updateObsUrl();
});

// Copy layout specs button
btnCopySpecs.addEventListener('click', () => {
  const specs = [];
  const layout = overlayLayoutSelect.value;
  const hasT = layout.toUpperCase().includes('T');
  specs.push(`layout=${layout}`);
  specs.push(`camW=${camWidthSlider.value}`);
  if (camZoomSlider.value !== '100') specs.push(`camZoom=${camZoomSlider.value}`);
  if (hasT && comWidthSlider.value !== '0') specs.push(`comW=${comWidthSlider.value}`);
  if (g1xSlider.value !== '0') specs.push(`g1x=${g1xSlider.value}`);
  if (g1ySlider.value !== '0') specs.push(`g1y=${g1ySlider.value}`);
  if (g2xSlider.value !== '0') specs.push(`g2x=${g2xSlider.value}`);
  if (g2ySlider.value !== '0') specs.push(`g2y=${g2ySlider.value}`);
  if (hasT && t1xSlider.value !== '0') specs.push(`t1x=${t1xSlider.value}`);
  if (hasT && t1ySlider.value !== '0') specs.push(`t1y=${t1ySlider.value}`);
  if (hasT && t2xSlider.value !== '0') specs.push(`t2x=${t2xSlider.value}`);
  if (hasT && t2ySlider.value !== '0') specs.push(`t2y=${t2ySlider.value}`);
  if (!hudEnabled.checked) specs.push('hud=0');
  if (!timerEnabled.checked) specs.push('timer=0');
  const specStr = specs.join('&');
  navigator.clipboard.writeText(specStr).then(() => {
    btnCopySpecs.textContent = 'Kopiert! \u2713';
    setTimeout(() => { btnCopySpecs.textContent = 'Layout kopieren'; }, 1500);
  }).catch(() => {});
});

// Save initial settings
sessionStorage.setItem('overlay-layout', overlayLayoutSelect.value);
sessionStorage.setItem('cam-width', camWidthSlider.value);
sessionStorage.setItem('cam-zoom', camZoomSlider.value);
sessionStorage.setItem('com-width', comWidthSlider.value);
sessionStorage.setItem('g1x', g1xSlider.value);
sessionStorage.setItem('g1y', g1ySlider.value);
sessionStorage.setItem('g2x', g2xSlider.value);
sessionStorage.setItem('g2y', g2ySlider.value);
sessionStorage.setItem('t1x', t1xSlider.value);
sessionStorage.setItem('t1y', t1ySlider.value);
sessionStorage.setItem('t2x', t2xSlider.value);
sessionStorage.setItem('t2y', t2ySlider.value);

// --- Copy Code ---
btnCopy.addEventListener('click', () => {
  if (!currentRaceCode) return;
  navigator.clipboard.writeText(currentRaceCode).then(() => {
    btnCopy.textContent = '\u2713';
    setTimeout(() => { btnCopy.innerHTML = '&#128203;'; }, 1500);
  }).catch(() => {
    const range = document.createRange();
    range.selectNode(lobbyCode);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
});

// --- Helpers ---
function showLobby() {
  setupSection.classList.add('hidden');
  userInfoEl.classList.add('hidden');
  lobbySection.classList.remove('hidden');
  hideStatus();
  updateObsUrl();
}

function resetToSetup() {
  currentRaceCode = null;
  myPlayerNumber = null;
  lobbySection.classList.add('hidden');
  if (twitchUser) {
    setupSection.classList.remove('hidden');
    userInfoEl.classList.remove('hidden');
  }
  btnStart.classList.add('hidden');
  btnStart.disabled = false;
  btnStart.textContent = 'Race starten';
  btnLeave.classList.remove('hidden');
}

function showStatus(message, success) {
  statusBar.classList.remove('hidden', 'success');
  if (success) statusBar.classList.add('success');
  statusText.textContent = message;
}

function hideStatus() {
  statusBar.classList.add('hidden');
}

// Auto-uppercase code input
joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

// Login button
btnTwitchLogin.addEventListener('click', startTwitchLogin);
btnLogout.addEventListener('click', logout);

// Check for race code in URL (for sharing links)
const urlParams = new URLSearchParams(window.location.search);
const urlCode = urlParams.get('code');
if (urlCode) {
  joinCodeInput.value = urlCode.toUpperCase();
}

// =====================
// --- GYM LOBBY MODE ---
// =====================
const gymSection = document.getElementById('gym-section');
const btnGym = document.getElementById('btn-gym');
let gymState = null;
let gymActive = false;

function getIconPath(speciesId) {
  return `/images/pokemon/icons/9/${speciesId}.png`; // fallback gen
}

btnGym.addEventListener('click', () => {
  if (!twitchUser) return;
  // First check if a session already exists
  socket.emit('GYM_JOIN');
  socket.once('GYM_STATE', (state) => {
    if (state.active) {
      // Session exists — just show the gym lobby
      gymState = state;
      showGymLobby();
      renderGymLobby();
    } else {
      // No session — create one
      const token = sessionStorage.getItem('twitch-token') || localStorage.getItem('twitch_community_token');
      socket.emit('GYM_CREATE_SESSION', {
        twitchId: twitchUser.id,
        broadcasterToken: token,
      });
    }
  });
});

socket.on('GYM_STATE', (state) => {
  gymState = state;
  if (state.active && !gymActive && twitchUser && twitchUser.login === 'janemmel') {
    showGymLobby();
    renderGymLobby();
  } else if (state.active && gymActive) {
    renderGymLobby();
  } else if (!state.active && gymActive) {
    endGymSession();
  }
});

socket.on('GYM_ERROR', ({ message }) => {
  showStatus(message, false);
});

socket.on('GYM_BATTLE_CREATED', ({ battleId }) => {
  if (!gymActive) return;
  // Redirect to game as boss
  const url = `${window.location.origin}/?pvp=${battleId}&side=boss`;
  window.location.href = url;
});

function showGymLobby() {
  gymActive = true;
  setupSection.classList.add('hidden');
  userInfoEl.classList.add('hidden');
  lobbySection.classList.add('hidden');
  gymSection.classList.remove('hidden');
  hideStatus();
  socket.emit('GYM_JOIN');

  const streamerTools = document.getElementById('streamer-tools');
  if (streamerTools) streamerTools.classList.add('hidden');
}

function endGymSession() {
  if (!twitchUser) return;
  socket.emit('GYM_END_SESSION', { twitchId: twitchUser.id });
  gymActive = false;
  gymSection.classList.add('hidden');
  if (twitchUser) {
    setupSection.classList.remove('hidden');
    userInfoEl.classList.remove('hidden');
  }
  const streamerTools = document.getElementById('streamer-tools');
  if (streamerTools) streamerTools.classList.remove('hidden');
}

function switchGymPreset(index) {
  if (!twitchUser) return;
  socket.emit('GYM_SWITCH_PRESET', { twitchId: twitchUser.id, presetIndex: index });

  // Update tab UI immediately
  document.querySelectorAll('.gym-preset-tab').forEach((tab, i) => {
    tab.classList.toggle('active', i === index);
  });
}

function startGymBattle() {
  if (!twitchUser) return;
  socket.emit('GYM_START_BATTLE', { twitchId: twitchUser.id });
}

function renderGymLobby() {
  if (!gymState || !gymState.active) return;

  // Boss team
  const teamContainer = document.getElementById('gym-boss-team');
  const bossTeam = gymState.bossTeam || [];
  if (bossTeam.length === 0) {
    teamContainer.innerHTML = '<span class="gym-waiting">Kein Team gesetzt — konfiguriere in den Einstellungen</span>';
  } else {
    teamContainer.innerHTML = bossTeam.map(p =>
      `<img class="gym-poke-icon" src="${getIconPath(p.speciesId)}" alt="${p.name}" title="${p.name} (${p.cost})" onerror="this.style.display='none'">`
    ).join('');
  }

  // Preset tabs
  const presets = gymState.bossTeamPresets || [];
  document.querySelectorAll('.gym-preset-tab').forEach((tab, i) => {
    const p = presets[i];
    const count = p && p.team ? p.team.length : 0;
    tab.textContent = count > 0 ? `Team ${i + 1} (${count})` : `Team ${i + 1}`;
    tab.classList.toggle('active', gymState.activeBossPreset === i);
  });

  // Current challenger
  const challSlot = document.getElementById('gym-current-challenger');
  const cc = gymState.currentChallenger;
  if (cc) {
    const teamIcons = (cc.team || []).map(p =>
      `<img src="${getIconPath(p.speciesId)}" alt="${p.name}" title="${p.name}">`
    ).join('');
    challSlot.className = 'gym-challenger-slot has-challenger';
    challSlot.innerHTML = `
      <img class="gym-challenger-avatar" src="${cc.profileImage || ''}" alt="" onerror="this.style.display='none'">
      <div class="gym-challenger-info">
        <div class="gym-challenger-name">${cc.displayName}</div>
        <div class="gym-challenger-team">${teamIcons}</div>
      </div>
    `;
  } else {
    challSlot.className = 'gym-challenger-slot';
    challSlot.innerHTML = '<span class="gym-waiting">Warte auf Herausforderer...</span>';
  }

  // Fight button
  const fightBtn = document.getElementById('btn-gym-fight');
  if (cc && bossTeam.length > 0) {
    fightBtn.classList.remove('hidden');
  } else {
    fightBtn.classList.add('hidden');
  }

  // Queue
  const queue = gymState.queue || [];
  document.getElementById('gym-queue-count').textContent = queue.length;
  const queueList = document.getElementById('gym-queue-list');
  if (queue.length === 0) {
    queueList.innerHTML = '<div class="gym-queue-empty">Keine Herausforderer in der Warteschlange</div>';
  } else {
    queueList.innerHTML = queue.map((c, i) => {
      const teamIcons = (c.team || []).map(p =>
        `<img src="${getIconPath(p.speciesId)}" alt="${p.name}">`
      ).join('');
      return `
        <div class="gym-queue-item">
          <span class="gym-queue-pos">#${i + 1}</span>
          <img class="gym-queue-avatar" src="${c.profileImage || ''}" alt="" onerror="this.style.display='none'">
          <span class="gym-queue-name">${c.displayName}</span>
          <div class="gym-queue-team">${teamIcons}</div>
        </div>
      `;
    }).join('');
  }
}

// Handle returning from a PvP battle (URL has ?fromGym=1)
const gymReturn = urlParams.get('fromGym');
if (gymReturn) {
  // Clear the param
  const cleanUrl = window.location.pathname;
  history.replaceState(null, '', cleanUrl);
}

// --- Init ---
(async () => {
  // First check OAuth callback
  const fromOAuth = await handleOAuthCallback();
  if (fromOAuth) {
    showLoggedInUI();
    return;
  }

  // Then check stored session
  if (restoreSession()) {
    showLoggedInUI();
    return;
  }

  // Otherwise show login
  loginSection.classList.remove('hidden');
})();
