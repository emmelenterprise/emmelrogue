/* eslint-disable no-undef */

// --- Config from URL ---
const params = new URLSearchParams(window.location.search);
const raceCode = params.get('race') || '';
const showDebug = params.get('debug') === '1';

// Player mode: if player= is set, this overlay is also the game window
const myPlayerNumber = parseInt(params.get('player') || '0');
const isPlayerMode = myPlayerNumber === 1 || myPlayerNumber === 2;
const opponentNumber = myPlayerNumber === 1 ? 2 : 1;
const isSoloMode = params.get('solo') === '1';

// Layout config: "CG-CG", "GC-GC", "CG-GC", "GC-CG", with optional T (community) slot
const layoutParam = params.get('layout') || 'CG-GC';

// Community overlay params
const comWidthParam = params.get('comW');
const comSessionParam = params.get('comSession') || '';

// Dynamic cam width from URL (set by lobby configurator)
const camWidthParam = params.get('camW');
if (camWidthParam) {
  const camW = parseInt(camWidthParam);
  if (camW === 0) {
    // No camera — hide cam slots, game takes full width
    document.documentElement.style.setProperty('--cam-width', '0px');
  } else if (camW > 0) {
    document.documentElement.style.setProperty('--cam-width', camW + 'px');
  }
}

// Dynamic cam zoom from URL (50 = 0.5x, 100 = 1x, 200 = 2x)
const camZoomParam = params.get('camZoom');
if (camZoomParam) {
  const zoom = parseInt(camZoomParam);
  if (zoom !== 100 && zoom > 0) {
    document.documentElement.style.setProperty('--cam-zoom', String(zoom / 100));
  }
}

// Per-game offsets from URL (applied per-slot via JS after DOM ready)
let g1x = parseInt(params.get('g1x') || '0');
let g1y = parseInt(params.get('g1y') || '0');
let g2x = parseInt(params.get('g2x') || '0');
let g2y = parseInt(params.get('g2y') || '0');

// Per-community (T-slot) offsets from URL
const t1x = parseInt(params.get('t1x') || '0');
const t1y = parseInt(params.get('t1y') || '0');
const t2x = parseInt(params.get('t2x') || '0');
const t2y = parseInt(params.get('t2y') || '0');

// HUD visibility (default: shown)
const hideHud = params.get('hud') === '0';
const hideTimer = params.get('timer') !== '1';

// --- Apply layout ---
// Cam-Jump-Fix: idempotent — derselbe Layout-String löst keinen erneuten Reflow aus
// (LAYOUT_UPDATE schickt `layout` bei jedem Slider-Tick mit, auch wenn es unverändert ist).
let _lastAppliedLayout = null;
const setStyleIfChanged = (el, prop, val) => { if (el && el.style[prop] !== val) el.style[prop] = val; };
function applyLayout(layout) {
  if (layout === _lastAppliedLayout) return;
  _lastAppliedLayout = layout;
  const parts = layout.toUpperCase().split('-');
  const row1Order = (parts[0] || 'CG').trim();
  const row2Order = (parts[1] || 'CG').trim();

  const row1 = document.getElementById('row-1');
  const row2 = document.getElementById('row-2');

  const hasT1 = row1Order.includes('T');
  const hasT2 = row2Order.includes('T');

  // For layouts with T, use explicit flex order instead of row-reverse
  // For layouts without T, keep existing cam-right behavior
  function applyRowLayout(rowEl, orderStr, playerNum) {
    const hasT = orderStr.includes('T');

    if (hasT) {
      // Use explicit order values for each slot type
      const camSlot = document.getElementById(`cam-slot-${playerNum}`);
      const gameSlot = document.getElementById(`game-slot-${playerNum}`);
      const comSlot = document.getElementById(`community-slot-${playerNum}`);

      for (let i = 0; i < orderStr.length; i++) {
        const ch = orderStr[i];
        if (ch === 'C' && camSlot) setStyleIfChanged(camSlot, 'order', String(i));
        if (ch === 'G' && gameSlot) setStyleIfChanged(gameSlot, 'order', String(i));
        if (ch === 'T' && comSlot) setStyleIfChanged(comSlot, 'order', String(i));
      }

      // Hide cam if not in layout
      if (!orderStr.includes('C')) {
        setStyleIfChanged(document.getElementById(`cam-slot-${playerNum}`), 'display', 'none');
      }
    } else {
      // No T — use simple cam-right class
      const base = orderStr.replace(/T/g, '');
      if (base === 'GC') rowEl.classList.add('cam-right');
    }
  }

  applyRowLayout(row1, row1Order, 1);
  applyRowLayout(row2, row2Order, 2);

  // Handle T (Community) slots — show iframes + set width
  if (hasT1 || hasT2) {
    const comW = parseInt(comWidthParam) || 350;
    document.documentElement.style.setProperty('--community-width', comW + 'px');

    const comUrl = '/community/overlay.html' + (comSessionParam ? '?session=' + comSessionParam : '');

    if (hasT1) {
      const comSlot1 = document.getElementById('community-slot-1');
      const comIframe1 = document.getElementById('community-iframe-1');
      comSlot1.classList.remove('hidden');
      comIframe1.src = comUrl;
    }
    if (hasT2) {
      const comSlot2 = document.getElementById('community-slot-2');
      const comIframe2 = document.getElementById('community-iframe-2');
      comSlot2.classList.remove('hidden');
      comIframe2.src = comUrl;
    }

    // Apply T-slot offsets
    if (hasT1 && (t1x || t1y)) {
      const comIframe1 = document.getElementById('community-iframe-1');
      if (comIframe1) comIframe1.style.transform = `translate(${t1x}px, ${t1y}px)`;
    }
    if (hasT2 && (t2x || t2y)) {
      const comIframe2 = document.getElementById('community-iframe-2');
      if (comIframe2) comIframe2.style.transform = `translate(${t2x}px, ${t2y}px)`;
    }
  }
}

applyLayout(layoutParam);

// Apply per-game offsets to game slots
function applyGameOffsets() {
  const gameSlot1 = document.getElementById('game-slot-1');
  const gameSlot2 = document.getElementById('game-slot-2');

  if (gameSlot1 && (g1x || g1y)) {
    const transform = `translate(${g1x}px, ${g1y}px)`;
    const video1 = gameSlot1.querySelector('video');
    const iframe1 = gameSlot1.querySelector('.game-iframe');
    if (video1) video1.style.transform = transform;
    if (iframe1) iframe1.style.transform = transform;
  }
  if (gameSlot2 && (g2x || g2y)) {
    const transform = `translate(${g2x}px, ${g2y}px)`;
    const video2 = gameSlot2.querySelector('video');
    const iframe2 = gameSlot2.querySelector('.game-iframe');
    if (video2) video2.style.transform = transform;
    if (iframe2) iframe2.style.transform = transform;
  }
}
applyGameOffsets();

// Solo mode: cam left, game + community stacked right
if (isSoloMode) {
  const overlayEl = document.getElementById('overlay');
  const row2El = document.getElementById('row-2');
  const sepEl = document.querySelector('.separator');

  overlayEl.classList.add('solo');
  if (row2El) row2El.style.display = 'none';
  if (sepEl) sepEl.style.display = 'none';

  // Transparent background for OBS layering
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';

  // Show community panel (horizontal below game)
  const comSlot1 = document.getElementById('community-slot-1');
  const comIframe1 = document.getElementById('community-iframe-1');
  if (comSlot1) comSlot1.classList.remove('hidden');
  if (comIframe1) {
    const comUrl = '/community/overlay.html' + (comSessionParam ? '?session=' + comSessionParam : '');
    comIframe1.src = comUrl;
  }

  // Game split from URL param (default 65%)
  const gameSplitParam = params.get('gameSplit');
  if (gameSplitParam) {
    document.documentElement.style.setProperty('--game-split', parseInt(gameSplitParam) + '%');
  }

  // Chat area below cam — default ON in solo mode (opt-out with chat=0)
  const chatEnabled = params.get('chat') !== '0';
  if (chatEnabled) {
    overlayEl.classList.add('has-chat');
  }

}

// Debug
const debugEl = document.getElementById('debug');
const debugText = document.getElementById('debug-text');
if (showDebug) debugEl.classList.remove('hidden');

// HUD elements
const hudNameP1 = document.getElementById('hud-name-1');
const hudWaveP1 = document.getElementById('hud-wave-1');
const hudStatusP1 = document.getElementById('hud-status-1');
const hudNameP2 = document.getElementById('hud-name-2');
const hudWaveP2 = document.getElementById('hud-wave-2');
const hudStatusP2 = document.getElementById('hud-status-2');
const hudTimer = document.getElementById('hud-timer');

// Apply HUD visibility
const hudP1 = document.getElementById('hud-1');
const hudP2 = document.getElementById('hud-2');
if (hideHud) {
  if (hudP1) hudP1.classList.add('hud-hidden');
  if (hudP2) hudP2.classList.add('hud-hidden');
}
if (hideTimer) {
  const timerEl = document.getElementById('timer-overlay');
  if (timerEl) timerEl.style.display = 'none';
}

// Finish banner
const finishBanner = document.getElementById('finish-banner');
const finishText = document.getElementById('finish-text');
const finishSub = document.getElementById('finish-sub');

// Video elements
const videoElements = {
  'game-1': document.getElementById('game-1'),
  'cam-1': document.getElementById('cam-1'),
  'game-2': document.getElementById('game-2'),
  'cam-2': document.getElementById('cam-2'),
};

// Slot elements
const slotElements = {
  'game-1': document.getElementById('game-slot-1'),
  'cam-1': document.getElementById('cam-slot-1'),
  'game-2': document.getElementById('game-slot-2'),
  'cam-2': document.getElementById('cam-slot-2'),
};

// Iframe elements
const iframeElements = {
  1: document.getElementById('game-iframe-1'),
  2: document.getElementById('game-iframe-2'),
};

// --- Player Mode: Embed game in iframe ---
if (isPlayerMode) {
  log(`Player mode: P${myPlayerNumber}`);

  // Build game URL from our URL params (pass all race params to the game)
  const gameParams = new URLSearchParams();
  gameParams.set('race', raceCode);
  gameParams.set('player', String(myPlayerNumber));
  // Forward all game-relevant params
  for (const key of ['twitchId', 'seed', 'starters', 'starterMode', 'gameMode', 'winCondition', 'winWave', 'cam', 'camDev', 'perf']) {
    const val = params.get(key);
    if (val) gameParams.set(key, val);
  }
  // Tell the game it's embedded (skip in-game race HUD, don't start cam streaming since overlay handles display)
  gameParams.set('embedded', '1');

  const gameUrl = '/?' + gameParams.toString();
  log(`Loading game: ${gameUrl}`);

  const myIframe = iframeElements[myPlayerNumber];
  const mySlot = slotElements[`game-${myPlayerNumber}`];
  myIframe.src = gameUrl;
  myIframe.classList.remove('hidden');
  mySlot.classList.add('has-iframe');

  // Auto-focus iframe so keyboard input goes to the game
  myIframe.addEventListener('load', () => {
    myIframe.focus();
    log('Game iframe loaded');
  });

  // Click on overlay refocuses iframe
  document.addEventListener('click', (e) => {
    // Only refocus if clicking on the game area (not other UI)
    if (e.target === myIframe || mySlot.contains(e.target)) {
      myIframe.focus();
    }
  });

  // Forward keyboard to iframe when overlay has focus
  document.addEventListener('keydown', (e) => {
    if (document.activeElement !== myIframe) {
      myIframe.focus();
    }
  });

  // Capture local camera for player's overlay (screen capture mode)
  const camEnabled = params.get('cam') === '1';
  if (camEnabled) {
    const camDevParam = params.get('camDev');
    const camConstraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    };
    if (camDevParam) camConstraints.video.deviceId = { exact: camDevParam };

    navigator.mediaDevices.getUserMedia(camConstraints).then(stream => {
      const myCamVideo = videoElements[`cam-${myPlayerNumber}`];
      const myCamSlot = slotElements[`cam-${myPlayerNumber}`];
      if (myCamVideo && myCamSlot) {
        myCamVideo.srcObject = new MediaStream(stream.getVideoTracks());
        myCamSlot.classList.add('has-stream');
        log(`Local camera assigned to cam-${myPlayerNumber}`);
      }
    }).catch(err => {
      log(`Local camera failed: ${err.message}`);
    });
  }
}

// --- Race State ---
let raceState = {
  startedAt: null,
  progress: {
    1: { wave: 0, status: 'waiting' },
    2: { wave: 0, status: 'waiting' },
  },
};

// --- Timer ---
let timerInterval = null;

function startTimer(startedAt) {
  raceState.startedAt = startedAt;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function updateTimer() {
  if (!raceState.startedAt) return;
  const elapsed = Math.floor((Date.now() - raceState.startedAt) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const min = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const sec = String(elapsed % 60).padStart(2, '0');
  hudTimer.textContent = hours > 0 ? `${hours}:${min}:${sec}` : `${min}:${sec}`;
}

// Track previous wave counts for pulse animation
let prevWaves = { 1: 0, 2: 0 };

function updateHUD() {
  const p1 = raceState.progress[1];
  const p2 = raceState.progress[2];

  // Wave pulse animation on change
  if (p1.wave > prevWaves[1]) {
    hudWaveP1.classList.remove('pulse');
    void hudWaveP1.offsetWidth;
    hudWaveP1.classList.add('pulse');
  }
  if (p2.wave > prevWaves[2]) {
    hudWaveP2.classList.remove('pulse');
    void hudWaveP2.offsetWidth;
    hudWaveP2.classList.add('pulse');
  }
  prevWaves[1] = p1.wave;
  prevWaves[2] = p2.wave;

  hudWaveP1.textContent = `Wave ${p1.wave}`;
  hudWaveP2.textContent = `Wave ${p2.wave}`;

  // Highlight who's ahead
  hudWaveP1.classList.remove('ahead', 'behind');
  hudWaveP2.classList.remove('ahead', 'behind');
  if (p1.wave > p2.wave) {
    hudWaveP1.classList.add('ahead');
    hudWaveP2.classList.add('behind');
  } else if (p2.wave > p1.wave) {
    hudWaveP2.classList.add('ahead');
    hudWaveP1.classList.add('behind');
  }

  updateStatusEl(hudStatusP1, p1.status);
  updateStatusEl(hudStatusP2, p2.status);
  checkFinish();
}

function updateStatusEl(el, status) {
  el.className = 'hud-status';
  switch (status) {
    case 'defeated':
      el.textContent = 'DEFEATED';
      el.classList.add('defeated');
      break;
    case 'victory':
      el.textContent = 'VICTORY';
      el.classList.add('victory');
      break;
    case 'disconnected':
      el.textContent = 'DC';
      el.classList.add('disconnected');
      break;
    default:
      el.textContent = '';
  }
}

let playerNames = { 1: 'Spieler 1', 2: 'Spieler 2' };
let finishShown = false;

function checkFinish() {
  if (finishShown) return;
  const p1 = raceState.progress[1];
  const p2 = raceState.progress[2];

  const p1Done = p1.status === 'defeated' || p1.status === 'victory';
  const p2Done = p2.status === 'defeated' || p2.status === 'victory';
  if (!p1Done && !p2Done) return;

  if (p1.status === 'defeated' && p2.status !== 'defeated') {
    showFinish(2, p1, p2);
  } else if (p2.status === 'defeated' && p1.status !== 'defeated') {
    showFinish(1, p1, p2);
  } else if (p1Done && p2Done) {
    if (p1.wave > p2.wave) {
      showFinish(1, p1, p2);
    } else if (p2.wave > p1.wave) {
      showFinish(2, p1, p2);
    } else {
      showFinish(0, p1, p2);
    }
  }
}

function showFinish(winner, p1, p2) {
  finishShown = true;
  if (winner === 0) {
    finishText.textContent = 'UNENTSCHIEDEN!';
    finishSub.textContent = `Beide Wave ${p1.wave}`;
  } else {
    finishText.textContent = `${playerNames[winner]} GEWINNT!`;
    const wp = winner === 1 ? p1 : p2;
    const lp = winner === 1 ? p2 : p1;
    finishSub.textContent = `Wave ${wp.wave} vs Wave ${lp.wave}`;
  }
  finishBanner.classList.remove('hidden');
  if (timerInterval) clearInterval(timerInterval);
  log('Race finished — winner: ' + (winner === 0 ? 'draw' : playerNames[winner]));

  // Show lobby button after a short delay (let the finish banner animate in)
  setTimeout(() => showLobbyButton(), 2000);

  // Confetti animation for wins
  if (winner !== 0) spawnConfetti();
}

function spawnConfetti() {
  const colors = ['#a855f7', '#22c55e', '#eab308', '#ef4444', '#3b82f6', '#ec4899', '#fff'];
  const container = document.querySelector('.overlay');
  for (let i = 0; i < 80; i++) {
    const el = document.createElement('div');
    el.className = 'confetti';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDuration = (2 + Math.random() * 3) + 's';
    el.style.animationDelay = Math.random() * 1.5 + 's';
    el.style.width = (6 + Math.random() * 8) + 'px';
    el.style.height = (4 + Math.random() * 6) + 'px';
    container.appendChild(el);
  }
}

// --- Socket.io ---
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  log('Connected to server');

  if (!raceCode) {
    log('ERROR: No race code in URL (?race=XXXX)');
    return;
  }

  socket.emit('REGISTER_WEBRTC', {
    role: 'overlay',
    id: `overlay-${Date.now().toString(36)}`,
    raceCode,
  });
});

socket.on('RACE_STATE', (state) => {
  if (state.host) {
    hudNameP1.textContent = state.host.name;
    playerNames[1] = state.host.name;
  }
  if (state.guest) {
    hudNameP2.textContent = state.guest.name;
    playerNames[2] = state.guest.name;
  }
  if (state.startedAt) startTimer(state.startedAt);
  if (state.progress) {
    raceState.progress = state.progress;
    updateHUD();
  }
});

socket.on('RACE_STARTING', (data) => {
  startTimer(data.startedAt);
  log('Race starting!');
});

socket.on('RACE_UPDATE', (data) => {
  if (data.progress) {
    raceState.progress = data.progress;
    updateHUD();
  }
});

socket.on('RACE_ENDED', ({ reason }) => {
  log('Race ended: ' + reason);
  if (timerInterval) clearInterval(timerInterval);

  // If this is a viewer overlay (not player mode), redirect back to live page
  // so it picks up the next race automatically
  if (!isPlayerMode) {
    log('Viewer overlay — returning to /overlay/live in 5s');
    setTimeout(() => {
      const twitchId = params.get('twitchId') || '647322993';
      window.location.href = '/overlay/live?twitchId=' + twitchId;
    }, 5000);
  }
});

// --- Live Layout Updates (from layout editor page) ---
// Cam-Jump-Fix: CSS-Variable nur setzen wenn sich der Wert WIRKLICH ändert. Ein redundantes
// setProperty auf :root erzwingt sonst einen vollen Style-Recalc/Reflow → OBS-Render-Reset,
// selbst wenn der Wert identisch ist (z.B. Preset-Load oder Coupling-Echo sendet denselben Wert).
function setVarIfChanged(name, value) {
  const root = document.documentElement;
  if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
}

socket.on('LAYOUT_UPDATE', (data) => {
  log('Layout update received');
  const root = document.documentElement;

  if (data.layout !== undefined) {
    applyLayout(data.layout);
  }
  if (data.camW !== undefined) {
    const camW = parseInt(data.camW);
    setVarIfChanged('--cam-width', camW === 0 ? '0px' : camW + 'px');
  }
  if (data.camZoom !== undefined) {
    const zoom = parseInt(data.camZoom);
    setVarIfChanged('--cam-zoom', String(zoom / 100));
  }
  if (data.comW !== undefined) {
    setVarIfChanged('--community-width', parseInt(data.comW) + 'px');
  }
  if (data.g1x !== undefined || data.g1y !== undefined) {
    g1x = parseInt(data.g1x ?? g1x);
    g1y = parseInt(data.g1y ?? g1y);
    applyGameOffsets();
  }
  if (data.g2x !== undefined || data.g2y !== undefined) {
    g2x = parseInt(data.g2x ?? g2x);
    g2y = parseInt(data.g2y ?? g2y);
    applyGameOffsets();
  }
  if (data.t1x !== undefined || data.t1y !== undefined) {
    const tx = parseInt(data.t1x ?? 0);
    const ty = parseInt(data.t1y ?? 0);
    const comIframe1 = document.getElementById('community-iframe-1');
    if (comIframe1) comIframe1.style.transform = (tx || ty) ? `translate(${tx}px, ${ty}px)` : '';
  }
  if (data.t2x !== undefined || data.t2y !== undefined) {
    const tx = parseInt(data.t2x ?? 0);
    const ty = parseInt(data.t2y ?? 0);
    const comIframe2 = document.getElementById('community-iframe-2');
    if (comIframe2) comIframe2.style.transform = (tx || ty) ? `translate(${tx}px, ${ty}px)` : '';
  }
  if (data.gameSplit !== undefined) {
    setVarIfChanged('--game-split', parseInt(data.gameSplit) + '%');
  }
  if (data.chat !== undefined) {
    const overlayEl = document.getElementById('overlay');
    if (overlayEl) overlayEl.classList.toggle('has-chat', data.chat === '1');
  }
  if (data.hud !== undefined) {
    const hudP1 = document.getElementById('hud-1');
    const hudP2 = document.getElementById('hud-2');
    if (hudP1) hudP1.classList.toggle('hud-hidden', data.hud === '0');
    if (hudP2) hudP2.classList.toggle('hud-hidden', data.hud === '0');
  }
  if (data.timer !== undefined) {
    const timerEl = document.getElementById('timer-overlay');
    if (timerEl) timerEl.style.display = data.timer === '0' ? 'none' : '';
  }
  // Forward community style vars to community iframes
  if (data.comStyle) {
    const comIframes = [
      document.getElementById('community-iframe-1'),
      document.getElementById('community-iframe-2'),
    ];
    for (const iframe of comIframes) {
      if (iframe && iframe.contentWindow) {
        try { iframe.contentWindow.postMessage({ type: 'COMMUNITY_STYLE', vars: data.comStyle }, '*'); } catch {}
      }
    }
  }
  // Forward community header visibility to community iframes
  if (data.comHeader !== undefined) {
    const comIframes = [
      document.getElementById('community-iframe-1'),
      document.getElementById('community-iframe-2'),
    ];
    for (const iframe of comIframes) {
      if (iframe && iframe.contentWindow) {
        try { iframe.contentWindow.postMessage({ type: 'COMMUNITY_HEADER', visible: data.comHeader === '1' }, '*'); } catch {}
      }
    }
  }
});

// --- WebRTC: Receive streams from racers ---
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

// Prefer H.264 — hardware-accelerated on virtually all devices (vs VP8/VP9 CPU-only)
function preferH264(pc) {
  if (typeof RTCRtpReceiver?.getCapabilities !== 'function') return;
  const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs;
  if (!codecs) return;
  const h264 = codecs.filter(c => c.mimeType === 'video/H264');
  const others = codecs.filter(c => c.mimeType !== 'video/H264');
  if (!h264.length) return;
  pc.getTransceivers().forEach(t => {
    try { t.setCodecPreferences([...h264, ...others]); } catch { /* unsupported */ }
  });
}
const peerConnections = new Map();
const iceCandidateBuffers = new Map();

fetch('/api/turn-credentials')
  .then(r => r.json())
  .then(data => {
    if (data.iceServers) iceServers = data.iceServers;
    log(`ICE servers loaded (${iceServers.length})`);
  })
  .catch(() => log('TURN fetch failed, using STUN only'));

socket.on('WEBRTC_PEERS', (peers) => {
  log('Peers: ' + peers.map(p => `${p.role}(${p.id})`).join(', '));

  for (const peer of peers) {
    if (peer.role !== 'racer') continue;
    if (peerConnections.has(peer.id)) continue;

    // In player mode, only connect to the OPPONENT's racer (skip our own game)
    if (isPlayerMode) {
      const peerPlayerNum = peer.id === 'racer-1' ? 1 : 2;
      if (peerPlayerNum === myPlayerNumber) {
        log(`Skipping own game stream (${peer.id})`);
        continue;
      }
    }

    createOfferForRacer(peer.id);
  }
});

async function createOfferForRacer(racerId) {
  log(`Creating offer for ${racerId}`);
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });

  // Two recvonly video tracks per racer (game + cam)
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });

  preferH264(pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('SIGNAL', {
        targetRole: 'racer',
        targetId: racerId,
        signalData: { type: 'ice-candidate', candidate: event.candidate },
      });
    }
  };

  pc.ontrack = (event) => {
    log(`Track received from ${racerId}: kind=${event.track.kind}`);
    assignTrackToVideo(racerId, event.track);
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE(${racerId}): ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      pc.restartIce();
    }
  };

  peerConnections.set(racerId, pc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('SIGNAL', {
    targetRole: 'racer',
    targetId: racerId,
    signalData: { type: 'offer', sdp: pc.localDescription },
  });
}

socket.on('SIGNAL', async (payload) => {
  const { fromRole, fromId, data } = payload;
  if (fromRole !== 'racer') return;

  const pc = peerConnections.get(fromId);
  if (!pc) return;

  if (data.type === 'answer') {
    await pc.setRemoteDescription(data.sdp);
    const buffered = iceCandidateBuffers.get(fromId) || [];
    for (const c of buffered) {
      await pc.addIceCandidate(c);
    }
    iceCandidateBuffers.delete(fromId);
  } else if (data.type === 'ice-candidate') {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(data.candidate);
    } else {
      if (!iceCandidateBuffers.has(fromId)) iceCandidateBuffers.set(fromId, []);
      iceCandidateBuffers.get(fromId).push(data.candidate);
    }
  }
});

// --- Track Assignment ---
const trackCountPerPeer = new Map();

function assignTrackToVideo(racerId, track) {
  if (track.kind !== 'video') return;

  const count = trackCountPerPeer.get(racerId) || 0;
  trackCountPerPeer.set(racerId, count + 1);

  // First track = game canvas, second = cam
  const streamType = count === 0 ? 'game' : 'cam';
  const playerNum = racerId === 'racer-1' ? '1' : '2';
  const slotKey = `${streamType}-${playerNum}`;

  const videoEl = videoElements[slotKey];
  const slotEl = slotElements[slotKey];
  if (!videoEl || !slotEl) {
    log(`No element for ${slotKey}`);
    return;
  }

  // In player mode, don't assign streams to our own iframe slot
  if (isPlayerMode && streamType === 'game' && parseInt(playerNum) === myPlayerNumber) {
    log(`Skipping own game track assignment for ${slotKey} (iframe active)`);
    return;
  }

  videoEl.srcObject = new MediaStream([track]);
  slotEl.classList.add('has-stream');
  log(`Assigned ${racerId} ${streamType} -> ${slotKey}`);
}

function log(msg) {
  console.log('[Overlay]', msg);
  if (showDebug) debugText.textContent = msg;
}

// --- Back to Lobby (player mode only) ---
const btnLobby = document.getElementById('btn-lobby');

if (isPlayerMode && btnLobby) {
  btnLobby.addEventListener('click', () => {
    window.location.href = '/lobby/?code=' + encodeURIComponent(raceCode);
  });
}

// Show lobby button when finish banner appears (in player mode)
function showLobbyButton() {
  if (isPlayerMode && btnLobby) {
    btnLobby.classList.remove('hidden');
  }
}

// Listen for game iframe postMessage (RACE_GAME_OVER)
window.addEventListener('message', (event) => {
  if (event.data?.type === 'RACE_GAME_OVER') {
    log('Game iframe reported game over');
    showLobbyButton();
  }
});

// --- Init ---
if (!raceCode) {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#a855f7;font-size:1.5rem;font-family:sans-serif;">Kein Race-Code! Nutze ?race=XXXX&layout=CG-CG</div>';
}
