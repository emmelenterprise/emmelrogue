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
}

function logout() {
  sessionStorage.removeItem('twitch-user');
  sessionStorage.removeItem('twitch-token');
  twitchUser = null;
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
btnCreate.addEventListener('click', () => {
  if (!twitchUser) return;
  const starterMode = document.querySelector('input[name="starter-mode"]:checked').value;
  socket.emit('CREATE_RACE', {
    name: twitchUser.display_name,
    avatar: twitchUser.profile_image_url,
    twitchId: twitchUser.id,
    starterMode,
  });
});

socket.on('RACE_CREATED', ({ code }) => {
  currentRaceCode = code;
  myPlayerNumber = 1;
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
  lobbyStarterMode.textContent = state.starterMode === 'random' ? 'Random (gleiche fuer beide)' : 'Freie Wahl';

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

  // Show start button only for host when guest has joined
  if (myPlayerNumber === 1 && state.guest && state.status === 'waiting') {
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
  socket.emit('START_RACE', { code: currentRaceCode });
});

socket.on('RACE_STARTING', () => {
  showStatus('Race startet! Lade Spiel...', true);
  btnStart.classList.add('hidden');
  btnLeave.classList.add('hidden');

  // Redirect to game with race params
  setTimeout(() => {
    const params = new URLSearchParams({
      race: currentRaceCode,
      player: String(myPlayerNumber),
    });
    window.location.href = '/?' + params.toString();
  }, 1000);
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
