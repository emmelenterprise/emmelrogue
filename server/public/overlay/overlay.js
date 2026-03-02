/* eslint-disable no-undef */

// --- Config from URL ---
const params = new URLSearchParams(window.location.search);
const raceCode = params.get('race') || '';
const layout = params.get('layout') || 'standard';
const showDebug = params.get('debug') === '1';

// Apply layout class
const overlayEl = document.getElementById('overlay');
overlayEl.className = `overlay layout-${layout}`;

// Debug
const debugEl = document.getElementById('debug');
const debugText = document.getElementById('debug-text');
if (showDebug) debugEl.classList.remove('hidden');

// HUD elements
const hudNameP1 = document.getElementById('hud-name-p1');
const hudWaveP1 = document.getElementById('hud-wave-p1');
const hudStatusP1 = document.getElementById('hud-status-p1');
const hudNameP2 = document.getElementById('hud-name-p2');
const hudWaveP2 = document.getElementById('hud-wave-p2');
const hudStatusP2 = document.getElementById('hud-status-p2');
const hudTimer = document.getElementById('hud-timer');

// Race header
const raceHeaderCode = document.getElementById('race-header-code');
const raceHeaderMode = document.getElementById('race-header-mode');

// Finish banner
const finishBanner = document.getElementById('finish-banner');
const finishText = document.getElementById('finish-text');
const finishSub = document.getElementById('finish-sub');

// Set initial header info
if (raceCode) {
  raceHeaderCode.textContent = `RACE ${raceCode}`;
}

// Set initial connecting state on placeholders
document.querySelectorAll('.slot-placeholder').forEach(el => {
  el.classList.add('connecting');
  const nameEl = el.querySelector('.placeholder-name');
  if (nameEl) nameEl.textContent = 'Verbinde...';
});

// Video elements — mapping depends on layout
// Standard: TL=Cam1, TR=Game1, BL=Game2, BR=Cam2
// Mirrored: TL=Game1, TR=Cam1, BL=Cam2, BR=Game2
const videoElements = {
  tl: document.getElementById('video-tl'),
  tr: document.getElementById('video-tr'),
  bl: document.getElementById('video-bl'),
  br: document.getElementById('video-br'),
};

const slots = {
  tl: document.getElementById('slot-tl'),
  tr: document.getElementById('slot-tr'),
  bl: document.getElementById('slot-bl'),
  br: document.getElementById('slot-br'),
};

// Stream mapping: which video element gets which stream
// This maps racer-1/racer-2 cam/game to grid positions
function getVideoMapping() {
  switch (layout) {
    case 'mirrored':
      return {
        'racer-1-game': 'tl', 'racer-1-cam': 'tr',
        'racer-2-cam': 'bl', 'racer-2-game': 'br',
      };
    case 'side-by-side':
      return {
        'racer-1-cam': 'tl', 'racer-1-game': 'tr',
        'racer-2-game': 'bl', 'racer-2-cam': 'br',
      };
    case 'games-only':
      return {
        'racer-1-game': 'tr', 'racer-2-game': 'bl',
      };
    default: // standard
      return {
        'racer-1-cam': 'tl', 'racer-1-game': 'tr',
        'racer-2-game': 'bl', 'racer-2-cam': 'br',
      };
  }
}

const videoMapping = getVideoMapping();

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
    void hudWaveP1.offsetWidth; // reflow to restart animation
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

  // Status icons
  updateStatusEl(hudStatusP1, p1.status);
  updateStatusEl(hudStatusP2, p2.status);

  // Check for finish condition
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

// Player names cache for finish screen
let playerNames = { 1: 'Spieler 1', 2: 'Spieler 2' };
let finishShown = false;

function checkFinish() {
  if (finishShown) return;
  const p1 = raceState.progress[1];
  const p2 = raceState.progress[2];

  // Both must have a terminal status
  const p1Done = p1.status === 'defeated' || p1.status === 'victory';
  const p2Done = p2.status === 'defeated' || p2.status === 'victory';
  if (!p1Done && !p2Done) return;

  // At least one player defeated → the other wins (or both defeated = draw)
  if (p1.status === 'defeated' && p2.status !== 'defeated') {
    showFinish(2, p1, p2);
  } else if (p2.status === 'defeated' && p1.status !== 'defeated') {
    showFinish(1, p1, p2);
  } else if (p1Done && p2Done) {
    // Both done — winner is whoever got further
    if (p1.wave > p2.wave) {
      showFinish(1, p1, p2);
    } else if (p2.wave > p1.wave) {
      showFinish(2, p1, p2);
    } else {
      showFinish(0, p1, p2); // draw
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
    const loser = winner === 1 ? 2 : 1;
    const wp = winner === 1 ? p1 : p2;
    const lp = winner === 1 ? p2 : p1;
    finishSub.textContent = `Wave ${wp.wave} vs Wave ${lp.wave}`;
  }
  finishBanner.classList.remove('hidden');
  if (timerInterval) clearInterval(timerInterval);
  log('Race finished — winner: ' + (winner === 0 ? 'draw' : playerNames[winner]));
}

// --- Socket.io ---
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  log('Connected to server');

  if (!raceCode) {
    log('ERROR: No race code in URL (?race=XXXX)');
    return;
  }

  // Register as overlay for WebRTC
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

  // Update header info
  if (state.starterMode) {
    raceHeaderMode.textContent = state.starterMode === 'random' ? 'Random Starter' : 'Free Pick';
  }

  // Remove connecting state from placeholders once we have player info
  document.querySelectorAll('.slot-placeholder.connecting').forEach(el => {
    el.classList.remove('connecting');
  });

  // Update placeholder names
  updatePlaceholderNames(state);
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
});

// --- WebRTC: Receive streams from racers ---
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const peerConnections = new Map(); // peerId -> RTCPeerConnection
const iceCandidateBuffers = new Map();
let myOverlayId = '';

// Fetch TURN credentials
fetch('/api/turn-credentials')
  .then(r => r.json())
  .then(data => {
    if (data.iceServers) iceServers = data.iceServers;
    log(`ICE servers loaded (${iceServers.length})`);
  })
  .catch(() => log('TURN fetch failed, using STUN only'));

socket.on('WEBRTC_PEERS', (peers) => {
  log('Peers: ' + peers.map(p => `${p.role}(${p.id})`).join(', '));

  // Store our own overlay ID
  for (const p of peers) {
    if (p.socketId === socket.id) myOverlayId = p.id;
  }

  // For each racer peer, create an offer if we don't have a connection yet
  for (const peer of peers) {
    if (peer.role !== 'racer') continue;
    if (peerConnections.has(peer.id)) continue;
    createOfferForRacer(peer.id);
  }
});

async function createOfferForRacer(racerId) {
  log(`Creating offer for ${racerId}`);
  const pc = new RTCPeerConnection({ iceServers });

  // We need to add transceivers to receive media
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' }); // Two video tracks per racer (game + cam)

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
    assignTrackToVideo(racerId, event.streams[0] || new MediaStream([event.track]), event.track);
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
  if (!pc) {
    log(`No PC for ${fromId}, ignoring signal`);
    return;
  }

  if (data.type === 'answer') {
    await pc.setRemoteDescription(data.sdp);
    // Flush buffered ICE candidates
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

// Track assignment
const trackCountPerPeer = new Map(); // racerId -> number of tracks assigned

function assignTrackToVideo(racerId, stream, track) {
  if (track.kind !== 'video') return;

  const count = trackCountPerPeer.get(racerId) || 0;
  trackCountPerPeer.set(racerId, count + 1);

  // First track = game canvas, second track = cam
  // (racer adds game first, then cam in webrtc.ts)
  const streamType = count === 0 ? 'game' : 'cam';
  const mappingKey = `${racerId}-${streamType}`;
  const slotKey = videoMapping[mappingKey];

  if (!slotKey) {
    log(`No slot for ${mappingKey} in layout ${layout}`);
    return;
  }

  const videoEl = videoElements[slotKey];
  const slotEl = slots[slotKey];
  if (!videoEl || !slotEl) return;

  const mediaStream = new MediaStream([track]);
  videoEl.srcObject = mediaStream;
  slotEl.classList.add('has-stream');
  log(`Assigned ${mappingKey} -> slot ${slotKey}`);
}

function updatePlaceholderNames(state) {
  const p1Name = state.host?.name || 'Spieler 1';
  const p2Name = state.guest?.name || 'Spieler 2';

  // Update placeholder names based on layout
  for (const [key, slotKey] of Object.entries(videoMapping)) {
    const nameEl = document.getElementById(`name-${slotKey}`);
    if (!nameEl) continue;
    if (key.startsWith('racer-1')) nameEl.textContent = p1Name;
    if (key.startsWith('racer-2')) nameEl.textContent = p2Name;
  }

  // Update placeholder sub-labels
  for (const [key, slotKey] of Object.entries(videoMapping)) {
    const subEl = document.querySelector(`#placeholder-${slotKey} .placeholder-sub`);
    if (!subEl) continue;
    subEl.textContent = key.endsWith('cam') ? 'Cam' : 'Game';
  }
}

function log(msg) {
  console.log('[Overlay]', msg);
  if (showDebug) debugText.textContent = msg;
}

// --- Init ---
if (!raceCode) {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#a855f7;font-size:1.5rem;font-family:sans-serif;">Kein Race-Code! Nutze ?race=XXXX</div>';
}
