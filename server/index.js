require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { generateStarters } = require('./lib/starter-generator');
const chatFeature = require('./lib/chat-feature');
const gymLeader = require('./lib/gym-leader');
const pvpBattleManager = require('./lib/pvp-battle');

const PORT = 3006;
const ALLOWED_ORIGINS = [
  'https://emmelrogue.emmel.tv',
  'http://localhost:8000',
];

// TURN credentials (shared with Imposter)
const TURN_USERNAME = process.env.TURN_USERNAME || 'matchme';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const TOOL_SECRET = process.env.TOOL_SECRET || '';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
  pingInterval: 25000,
  pingTimeout: 60000,
});

// --- Race Room Management ---
const races = new Map();
const dcTimers = new Map(); // socketId -> setTimeout handle for auto-forfeit

function generateRaceCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (races.has(code));
  return code;
}

function generateSeed() {
  return crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 24);
}

function getRaceBySocket(socketId) {
  for (const [, race] of races) {
    if (race.host?.socketId === socketId) return { race, role: 'host' };
    if (race.guest?.socketId === socketId) return { race, role: 'guest' };
  }
  return null;
}

function broadcastRaceState(race) {
  io.to(`race:${race.code}`).emit('RACE_STATE', {
    code: race.code,
    solo: !!race.solo,
    host: race.host ? { name: race.host.name, avatar: race.host.avatar, twitchId: race.host.twitchId, player: 1, ready: race.host.ready } : null,
    guest: race.guest ? { name: race.guest.name, avatar: race.guest.avatar, twitchId: race.guest.twitchId, player: 2, ready: race.guest.ready } : null,
    starterMode: race.starterMode,
    status: race.status,
    progress: race.progress,
    startedAt: race.startedAt,
    gameMode: race.gameMode,
    winCondition: race.winCondition,
    winWave: race.winWave,
    nuzlockeDeath: race.nuzlockeDeath,
    nuzlockeCatch: race.nuzlockeCatch,
    starterCount: race.starterCount,
    respawnOnWipe: race.respawnOnWipe,
    shinyMode: race.shinyMode,
    luckLevel: race.luckLevel,
    menuReady: race.menuReady,
  });
}

async function broadcastWebRtcPeers(raceCode) {
  const sockets = await io.in(`race:${raceCode}`).fetchSockets();
  const peers = [];
  for (const s of sockets) {
    if (s.data.rtc) {
      peers.push({ id: s.data.rtc.id, role: s.data.rtc.role, socketId: s.id });
    }
  }
  io.to(`race:${raceCode}`).emit('WEBRTC_PEERS', peers);
}

app.use(express.json());

// --- TURN Credentials Endpoint ---
app.get('/api/turn-credentials', (req, res) => {
  if (!TURN_CREDENTIAL) {
    return res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  }
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:72.61.176.197:3478', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      { urls: 'turn:72.61.176.197:3478?transport=tcp', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    ],
  });
});

// --- Race API ---
app.get('/api/race/:code', (req, res) => {
  const code = req.params.code?.toUpperCase();
  const race = races.get(code);
  if (!race) {
    return res.status(404).json({ error: 'Race nicht gefunden' });
  }
  res.json({
    code: race.code,
    status: race.status,
    starterMode: race.starterMode,
    startedAt: race.startedAt,
    host: race.host ? { name: race.host.name, player: 1 } : null,
    guest: race.guest ? { name: race.guest.name, player: 2 } : null,
    progress: race.progress,
  });
});

// GET /api/races — list all active (non-finished) races
app.get('/api/races', (req, res) => {
  const active = [];
  for (const [, race] of races) {
    if (race.status === 'finished') continue;
    active.push({
      code: race.code,
      status: race.status,
      starterMode: race.starterMode,
      startedAt: race.startedAt,
      host: race.host ? { name: race.host.name, player: 1 } : null,
      guest: race.guest ? { name: race.guest.name, player: 2 } : null,
      progress: race.progress,
    });
  }
  res.json(active);
});

// Serve lobby static files
app.use('/lobby', express.static(path.join(__dirname, 'public', 'lobby')));

// Serve overlay static files
app.use('/overlay', express.static(path.join(__dirname, 'public', 'overlay')));

// Serve race-menu static files
app.use('/race-menu', express.static(path.join(__dirname, 'public', 'race-menu')));

// Serve community static files
app.use('/community', express.static(path.join(__dirname, 'public', 'community')));

// Serve layout editor static files
app.use('/layout', express.static(path.join(__dirname, 'public', 'layout')));

// Serve gym static files
app.use('/gym-admin', express.static(path.join(__dirname, 'public', 'gym-admin')));
app.use('/gym', express.static(path.join(__dirname, 'public', 'gym-challenger')));
app.use('/gym-overlay', express.static(path.join(__dirname, 'public', 'gym-overlay')));

// --- Chat Feature REST API ---

// Auth middleware for tool-secret protected endpoints
function requireToolSecret(req, res, next) {
  if (!TOOL_SECRET || req.headers['x-tool-secret'] !== TOOL_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// GET /api/sessions — list all chat sessions
app.get('/api/sessions', (req, res) => {
  res.json(chatFeature.getAllSessions());
});

// GET /api/session/:id — session info
app.get('/api/session/:id', (req, res) => {
  const session = chatFeature.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });
  res.json({
    sessionId: session.sessionId,
    seed: session.seed,
    raceCode: session.raceCode,
    status: session.status,
    currentWave: session.currentWave,
    currentBiome: session.currentBiome,
    config: session.config,
    activeVote: chatFeature.getVoteState(session),
    activeGimmicks: chatFeature.getActiveGimmicks(session.sessionId),
  });
});

// GET /api/session/:id/trainers — trainer list
app.get('/api/session/:id/trainers', (req, res) => {
  const trainers = chatFeature.getVisibleTrainers(req.params.id);
  res.json(trainers);
});

// GET /api/pokemon-data — pokemon data for community page
app.get('/api/pokemon-data', (req, res) => {
  res.json(chatFeature.pokemonData);
});

// GET /api/move-data — move names for gym admin moveset editor
const moveData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'move-data.json'), 'utf-8'));
app.get('/api/move-data', (_req, res) => {
  res.json(moveData);
});

// GET /api/pokemon-learnsets — level-up + egg moves per species
const pokemonLearnsets = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'pokemon-learnsets.json'), 'utf-8'));
app.get('/api/pokemon-learnsets', (_req, res) => {
  res.json(pokemonLearnsets);
});

// GET /api/trainer-sprites — available trainer sprites (scanned from filesystem + atlas frame data)
let cachedTrainerSprites = null;
function loadTrainerSprites() {
  if (cachedTrainerSprites) return cachedTrainerSprites;
  const spriteDir = path.join(__dirname, '..', 'dist', 'images', 'trainer');
  try {
    const files = fs.readdirSync(spriteDir).filter(f => f.endsWith('.png'));
    cachedTrainerSprites = files.map(f => {
      const key = f.replace('.png', '');
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      // Read atlas JSON for first frame coordinates
      let frame = null;
      try {
        const atlasPath = path.join(spriteDir, key + '.json');
        const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf-8'));
        const texFrames = atlas.textures?.[0]?.frames;
        const sheetSize = atlas.textures?.[0]?.size;
        if (texFrames && texFrames.length > 0 && sheetSize) {
          const f0 = texFrames[0];
          frame = {
            x: f0.frame.x, y: f0.frame.y,
            w: f0.frame.w, h: f0.frame.h,
            sw: sheetSize.w, sh: sheetSize.h,
          };
        }
      } catch (_) { /* no atlas = use full image */ }
      return { key, label, frame };
    }).sort((a, b) => a.label.localeCompare(b.label));
  } catch (e) {
    console.error('Failed to scan trainer sprites:', e.message);
    cachedTrainerSprites = [];
  }
  return cachedTrainerSprites;
}
loadTrainerSprites(); // pre-cache on startup

app.get('/api/trainer-sprites', (_req, res) => {
  res.json(loadTrainerSprites());
});

// POST /api/session/:id/trigger — trigger from tracker (bits/subs/points)
app.post('/api/session/:id/trigger', requireToolSecret, (req, res) => {
  const { type, amount, twitchUserId, displayName } = req.body;
  if (!type || !twitchUserId) return res.status(400).json({ error: 'Missing fields' });

  chatFeature.addTriggerCredits(req.params.id, twitchUserId, displayName || twitchUserId, type, amount || 0);
  res.json({ success: true });
});

// POST /api/session/:id/config — config update from tracker
app.post('/api/session/:id/config', requireToolSecret, (req, res) => {
  const config = chatFeature.updateConfig(req.params.id, req.body);
  if (!config) return res.status(404).json({ error: 'Session nicht gefunden' });
  io.to(`chat:${req.params.id}`).emit('CHAT_CONFIG_CHANGED', { config });
  res.json({ success: true, config });
});

// POST /api/session/:id/claim — claim via tracker chat command
app.post('/api/session/:id/claim', requireToolSecret, (req, res) => {
  const { waveIndex, twitchUserId, displayName } = req.body;
  if (!waveIndex || !twitchUserId) return res.status(400).json({ error: 'Missing fields' });

  const result = chatFeature.claimTrainer(req.params.id, parseInt(waveIndex), twitchUserId, displayName || twitchUserId);
  if (result.success) {
    io.to(`chat:${req.params.id}`).emit('CHAT_TRAINER_CLAIMED', {
      wave: waveIndex,
      claimedBy: twitchUserId,
      claimedByName: displayName,
    });
  }
  res.json(result);
});

// POST /api/session/:id/vote — cast vote via tracker
app.post('/api/session/:id/vote', requireToolSecret, (req, res) => {
  const { twitchUserId, optionId } = req.body;
  if (!twitchUserId || !optionId) return res.status(400).json({ error: 'Missing fields' });

  const result = chatFeature.castVote(req.params.id, twitchUserId, optionId);
  if (result.success) {
    const session = chatFeature.getSession(req.params.id);
    if (session) {
      io.to(`chat:${req.params.id}`).emit('CHAT_VOTE_UPDATE', chatFeature.getVoteState(session));
    }
  }
  res.json(result);
});

// GET /api/session/by-code/:code — find session by join code
app.get('/api/session/by-code/:code', (req, res) => {
  const session = chatFeature.findSessionByCode(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });
  res.json({
    sessionId: session.sessionId,
    code: session.code,
    seed: session.seed,
    status: session.status,
    currentWave: session.currentWave,
    currentBiome: session.currentBiome,
    streamerParty: session.streamerParty || [],
  });
});

// POST /api/session/create — manually create session (streamer or community page)
app.post('/api/session/create', (req, res) => {
  // Auth: nur mit TOOL_SECRET oder von localhost
  const authHeader = req.headers.authorization;
  const toolSecret = process.env.TOOL_SECRET;
  if (toolSecret && authHeader !== `Bearer ${toolSecret}` && req.ip !== '127.0.0.1' && req.ip !== '::1') {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }
  const seed = req.body.seed || require('crypto').randomBytes(12).toString('hex');
  const sessionId = chatFeature.createSession(seed, req.body.raceCode || null);
  const session = chatFeature.getSession(sessionId);
  res.json({ success: true, sessionId, code: session.code });
});

// --- Gym Leader REST API ---
app.get('/api/gym/state', (_req, res) => {
  res.json(gymLeader.getState());
});

// GET /api/pvp/battle/:battleId — get battle config for a side
app.get('/api/pvp/battle/:battleId', (req, res) => {
  const { battleId } = req.params;
  const { side } = req.query;
  const room = pvpBattleManager.getBattle(battleId);
  if (!room) return res.status(404).json({ error: 'Battle not found' });
  if (side !== 'boss' && side !== 'challenger') return res.status(400).json({ error: 'Invalid side' });
  res.json(room.getConfigForSide(side));
});

// GET /api/pvp/battles — list active battles (admin)
app.get('/api/pvp/battles', (_req, res) => {
  res.json(pvpBattleManager.getActiveBattles());
});

app.get('/api/gym/leaderboard', (_req, res) => {
  res.json(gymLeader.getLeaderboard());
});

app.get('/api/gym/queue', (_req, res) => {
  const session = gymLeader.getSession();
  if (!session) return res.json([]);
  res.json(session.queue.map(c => ({
    twitchId: c.twitchId,
    displayName: c.displayName,
    profileImage: c.profileImage,
    teamBudget: c.teamBudget,
    joinedAt: c.joinedAt,
  })));
});

// POST /api/gym/join — join queue via chat command (tracker)
app.post('/api/gym/join', requireToolSecret, (req, res) => {
  const { twitchId, displayName, profileImage, team, trainerLines, spriteKey, twitchRole } = req.body;
  if (!twitchId || !displayName) return res.status(400).json({ success: false, error: 'Missing fields' });
  const result = gymLeader.joinQueue(twitchId, displayName, profileImage || '', team || [], trainerLines, spriteKey, twitchRole);
  if (result.success) {
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  }
  res.json(result);
});

// POST /api/gym/leave — leave queue via chat command
app.post('/api/gym/leave', requireToolSecret, (req, res) => {
  const { twitchId } = req.body;
  if (!twitchId) return res.status(400).json({ success: false, error: 'Missing twitchId' });
  gymLeader.leaveQueue(twitchId);
  io.to('gym').emit('GYM_STATE', gymLeader.getState());
  res.json({ success: true });
});

// POST /api/gym/badge — award badge via chat command (streamer only)
app.post('/api/gym/badge', requireToolSecret, (req, res) => {
  const { challengerId, challengerName } = req.body;
  const session = gymLeader.getSession();
  if (!session) return res.json({ success: false, error: 'Keine Session' });
  // If no specific target, badge current challenger
  const cc = session.currentChallenger;
  const targetId = challengerId || cc?.twitchId;
  const targetName = challengerName || cc?.displayName;
  if (!targetId) return res.json({ success: false, error: 'Kein Herausforderer' });
  const result = gymLeader.awardBadge(targetId, targetName);
  io.to('gym').emit('GYM_STATE', gymLeader.getState());
  io.to('gym').emit('GYM_BADGE_AWARDED', { twitchId: targetId, displayName: targetName, totalBadges: result.totalBadges });
  res.json({ success: true, totalBadges: result.totalBadges });
});

// POST /api/gym/loss — record loss via chat command
app.post('/api/gym/loss', requireToolSecret, (req, res) => {
  const session = gymLeader.getSession();
  if (!session) return res.json({ success: false, error: 'Keine Session' });
  const cc = session.currentChallenger;
  if (!cc) return res.json({ success: false, error: 'Kein Herausforderer' });
  gymLeader.recordLoss(cc.twitchId, cc.displayName);
  io.to('gym').emit('GYM_STATE', gymLeader.getState());
  res.json({ success: true });
});

// POST /api/gym/skip — skip current challenger
app.post('/api/gym/skip', requireToolSecret, (req, res) => {
  const result = gymLeader.skipChallenger();
  if (result.success) io.to('gym').emit('GYM_STATE', gymLeader.getState());
  res.json(result);
});

// POST /api/gym/check-role — detect user role via Twitch OAuth token
const TWITCH_CLIENT_ID_GYM = process.env.TWITCH_CLIENT_ID || 'aoqvg74maqoulqjqs64osjwdkh4xut';
const BROADCASTER_ID = '647322993';

async function detectTwitchRole(twitchId, token) {
  if (!token) return 'everyone';
  if (twitchId === BROADCASTER_ID) return 'mod';

  const userHeaders = { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID_GYM };
  let role = 'everyone';

  // Get broadcaster token for mod/VIP checks
  const session = gymLeader.getSession();
  const broadcasterToken = session?.broadcasterToken;
  const broadcasterHeaders = broadcasterToken
    ? { 'Authorization': `Bearer ${broadcasterToken}`, 'Client-Id': TWITCH_CLIENT_ID_GYM }
    : null;

  // Check subscription status (uses user's own token)
  try {
    const subRes = await fetch(
      `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${BROADCASTER_ID}&user_id=${twitchId}`,
      { headers: userHeaders }
    );
    if (subRes.ok) {
      const subData = await subRes.json();
      if (subData.data && subData.data.length > 0) {
        const tier = subData.data[0].tier; // "1000", "2000", "3000"
        if (tier === '3000') role = 'sub3';
        else if (tier === '2000') role = 'sub2';
        else role = 'sub1';
      }
    }
  } catch (e) {
    console.error('[Gym] Sub check failed:', e.message);
  }

  // Check moderator status (needs broadcaster token!)
  if (broadcasterHeaders) {
    try {
      const modRes = await fetch(
        `https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${BROADCASTER_ID}&user_id=${twitchId}`,
        { headers: broadcasterHeaders }
      );
      if (modRes.ok) {
        const modData = await modRes.json();
        if (modData.data && modData.data.length > 0) {
          role = 'mod';
        }
      } else {
        console.warn(`[Gym] Mod check returned ${modRes.status} for ${twitchId}`);
      }
    } catch (e) {
      console.error('[Gym] Mod check failed:', e.message);
    }

    // Check VIP status (also needs broadcaster token)
    if (role !== 'mod') {
      try {
        const vipRes = await fetch(
          `https://api.twitch.tv/helix/channels/vips?broadcaster_id=${BROADCASTER_ID}&user_id=${twitchId}`,
          { headers: broadcasterHeaders }
        );
        if (vipRes.ok) {
          const vipData = await vipRes.json();
          if (vipData.data && vipData.data.length > 0) {
            role = 'vip';
          }
        }
      } catch (e) { /* non-critical */ }
    }
  } else {
    // Fallback: use known roles from tracker
    const knownRole = gymLeader.getKnownRole(twitchId);
    if (knownRole === 'mod' || knownRole === 'vip') {
      role = knownRole;
    }
  }

  gymLeader.setKnownRole(twitchId, role);
  console.log(`[Gym] Role detected for ${twitchId}: ${role}`);
  return role;
}

app.post('/api/gym/check-role', async (req, res) => {
  const { twitchId, token } = req.body;
  if (!twitchId) return res.status(400).json({ error: 'Missing twitchId' });
  const role = await detectTwitchRole(twitchId, token);
  const session = gymLeader.getSession();
  const budget = session ? gymLeader.getRoleBudget(role, session.config) : 10;
  res.json({ role, budget });
});

// GET /api/gym/my-team/:twitchId — get user's community team for import
app.get('/api/gym/my-team/:twitchId', (req, res) => {
  const twitchId = req.params.twitchId;
  // Search across all active chat sessions for this user's last customized team
  const sessions = chatFeature.getAllSessions();
  let bestTeam = null;
  let bestSprite = null;
  for (const session of sessions) {
    if (session.status !== 'active') continue;
    const fullSession = chatFeature.getSession(session.sessionId);
    if (!fullSession || !fullSession.trainers) continue;
    for (const [, trainer] of fullSession.trainers) {
      if (trainer.claimedBy === twitchId && trainer.customParty && trainer.customParty.length > 0) {
        bestTeam = trainer.customParty;
        bestSprite = trainer.customSprite || trainer.spriteKey;
      }
    }
  }
  if (!bestTeam) return res.json({ found: false });
  res.json({
    found: true,
    team: bestTeam.map(p => ({ speciesId: p.speciesId, name: p.name, cost: p.cost })),
    spriteKey: bestSprite,
  });
});

// Live Overlay — server-side redirect to active race overlay (no iframe nesting)
app.get('/overlay/live', (req, res) => {
  const twitchId = req.query.twitchId || '647322993';
  for (const [code, race] of races) {
    if (race.host?.twitchId === twitchId && race.status !== 'finished') {
      return res.redirect(buildOverlayUrl(race));
    }
  }
  // No active race — serve the waiting page (will auto-redirect via socket when race starts)
  res.sendFile(path.join(__dirname, 'public', 'overlay', 'live.html'));
});

// Root redirect zur Lobby (nur wenn keine Game-Parameter)
app.get('/', (req, res, next) => {
  if (Object.keys(req.query).length > 0) return next();
  res.redirect('/lobby/');
});

// Serve the built game from dist/
app.use(express.static(path.join(__dirname, '..', 'dist')));

// SPA fallback — serve index.html for all non-file routes (except lobby/overlay/race-menu)
app.get('*', (req, res) => {
  if (req.path.startsWith('/lobby') || req.path.startsWith('/overlay') || req.path.startsWith('/race-menu') || req.path.startsWith('/community') || req.path.startsWith('/gym') || req.path.startsWith('/api/')) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

// --- Live Overlay Helper ---
function buildOverlayUrl(race) {
  const p = new URLSearchParams();
  p.set('race', race.code);
  p.set('layout', race.overlayLayout || 'CG-CG');
  if (race.solo) p.set('solo', '1');
  if (race.overlayCamWidth && race.overlayCamWidth !== 340) p.set('camW', String(race.overlayCamWidth));
  if (race.overlayCamZoom && race.overlayCamZoom !== 100) p.set('camZoom', String(race.overlayCamZoom));
  const layout = (race.overlayLayout || '').toUpperCase();
  if (layout.includes('T') && race.overlayCommunityWidth) p.set('comW', String(race.overlayCommunityWidth));
  if (race.overlayG1X) p.set('g1x', String(race.overlayG1X));
  if (race.overlayG1Y) p.set('g1y', String(race.overlayG1Y));
  if (race.overlayG2X) p.set('g2x', String(race.overlayG2X));
  if (race.overlayG2Y) p.set('g2y', String(race.overlayG2Y));
  if (layout.includes('T')) {
    if (race.overlayT1X) p.set('t1x', String(race.overlayT1X));
    if (race.overlayT1Y) p.set('t1y', String(race.overlayT1Y));
    if (race.overlayT2X) p.set('t2x', String(race.overlayT2X));
    if (race.overlayT2Y) p.set('t2y', String(race.overlayT2Y));
  }
  if (!race.overlayHud) p.set('hud', '0');
  if (!race.overlayTimer) p.set('timer', '0');
  if (race.chatSessionId) p.set('comSession', race.chatSessionId);
  if (race.host?.twitchId) p.set('twitchId', race.host.twitchId);
  return '/overlay/?' + p.toString();
}

function notifyLiveOverlay(twitchId, race) {
  if (!twitchId) return;
  const room = `live-overlay:${twitchId}`;
  if (race) {
    const overlayUrl = buildOverlayUrl(race);
    io.to(room).emit('LIVE_OVERLAY_UPDATE', { overlayUrl, code: race.code });
  } else {
    io.to(room).emit('LIVE_OVERLAY_CLEAR');
  }
}

// --- Socket.io ---
let connectionCount = 0;

io.on('connection', (socket) => {
  connectionCount++;
  console.log(`[EmmelRogue] Client connected: ${socket.id} (${connectionCount} online)`);

  socket.on('PING', () => {
    socket.emit('PONG', { timestamp: Date.now() });
  });

  // --- Race Events ---

  socket.on('CREATE_RACE', ({ name, avatar, twitchId, starterMode, solo, overlayLayout, overlayCamWidth, overlayCamZoom, overlayCommunityWidth, overlayG1X, overlayG1Y, overlayG2X, overlayG2Y, overlayT1X, overlayT1Y, overlayT2X, overlayT2Y, overlayHud, overlayTimer }) => {
    // Nur janemmel darf Spiele erstellen
    if (!twitchId || twitchId !== '647322993') {
      return socket.emit('RACE_ERROR', { message: 'Nur der Streamer kann Spiele erstellen' });
    }

    // Leave any existing race first
    const existing = getRaceBySocket(socket.id);
    if (existing) {
      socket.leave(`race:${existing.race.code}`);
      if (existing.role === 'host') {
        notifyLiveOverlay(existing.race.host?.twitchId, null);
        races.delete(existing.race.code);
        io.to(`race:${existing.race.code}`).emit('RACE_ENDED', { reason: 'Host left' });
      }
    }

    const code = generateRaceCode();
    const validMode = (starterMode === 'free') ? 'free' : 'random';
    const race = {
      code,
      host: { socketId: socket.id, name: name || 'Spieler 1', avatar: avatar || null, twitchId: twitchId || null, player: 1, ready: false },
      guest: null,
      solo: !!solo,
      seed: null,
      starterMode: validMode,
      status: 'waiting',
      createdAt: Date.now(),
      startedAt: null,
      progress: {
        1: { wave: 0, status: 'waiting' },
        2: { wave: 0, status: 'waiting' },
      },
      gameMode: 'classic',
      winCondition: 'wave',
      winWave: 20,
      nuzlockeDeath: false,
      nuzlockeCatch: false,
      starterCount: 3,
      respawnOnWipe: false,
      shinyMode: 'off',
      luckLevel: -1,
      starters: null, // Generated for 'random' mode on START_RACE
      cameraSettings: { 1: null, 2: null },
      menuReady: { 1: false, 2: false },
      overlayLayout: overlayLayout || 'CG-CG',
      overlayCamWidth: parseInt(overlayCamWidth) || 340,
      overlayCamZoom: parseInt(overlayCamZoom) || 100,
      overlayCommunityWidth: parseInt(overlayCommunityWidth) || 0,
      overlayG1X: parseInt(overlayG1X) || 0,
      overlayG1Y: parseInt(overlayG1Y) || 0,
      overlayG2X: parseInt(overlayG2X) || 0,
      overlayG2Y: parseInt(overlayG2Y) || 0,
      overlayT1X: parseInt(overlayT1X) || 0,
      overlayT1Y: parseInt(overlayT1Y) || 0,
      overlayT2X: parseInt(overlayT2X) || 0,
      overlayT2Y: parseInt(overlayT2Y) || 0,
      overlayHud: overlayHud !== '0',
      overlayTimer: overlayTimer !== '0',
    };
    races.set(code, race);
    socket.join(`race:${code}`);
    socket.data.raceCode = code;
    socket.data.playerNumber = 1;

    // Auto-create a chat session for the race so community can connect immediately
    const chatSessionId = chatFeature.createSession(`race-${code}`, code, race.winWave);
    const chatSession = chatFeature.getSession(chatSessionId);
    race.chatSessionId = chatSessionId;
    if (chatSession) chatSession.hostSocketId = socket.id;
    socket.join(`chat:${chatSessionId}`);
    // Pre-register fixed trainers so community can claim before game loads
    chatFeature.registerTrainerBatch(chatSessionId, [
      { waveIndex: 5, trainerClass: 'Youngster', isFixed: true, isBoss: false },
      { waveIndex: 8, trainerClass: 'Rivale', isFixed: true, isBoss: false },
      { waveIndex: 25, trainerClass: 'Rivale', isFixed: true, isBoss: false },
      { waveIndex: 35, trainerClass: 'Team Grunt', isFixed: true, isBoss: false },
    ]);
    // Broadcast so community overlays auto-join
    io.emit('CHAT_SESSION_AVAILABLE', { sessionId: chatSessionId, code: chatSession?.code || '' });

    console.log(`[Race] Created: ${code} by ${name} (starter: ${validMode}, solo: ${!!solo}, chat: ${chatSessionId})`);
    socket.emit('RACE_CREATED', { code, chatSessionId, solo: !!solo });
    broadcastRaceState(race);

    // Notify persistent live overlay
    notifyLiveOverlay(twitchId, race);

    // Solo mode: skip waiting for guest, go straight to menu
    if (solo) {
      race.seed = generateSeed();
      race.status = 'menu';
      race.menuReady = { 1: false };
      if (race.starterMode === 'random') {
        race.starters = generateStarters(race.seed, race.starterCount);
      }
      console.log(`[Race] ${code} solo → menu (seed: ${race.seed})`);
      socket.emit('RACE_TO_MENU', { code: race.code, seed: race.seed, starterMode: race.starterMode, solo: true, chatSessionId: race.chatSessionId });
    }
  });

  socket.on('JOIN_RACE', ({ code, name, avatar, twitchId }) => {
    const race = races.get(code?.toUpperCase());
    if (!race) {
      return socket.emit('RACE_ERROR', { message: 'Race nicht gefunden' });
    }

    // If race is finished, reset it so players can rematch with the same code
    if (race.status === 'finished') {
      console.log(`[Race] ${code} was finished — resetting for rematch (solo: ${!!race.solo})`);
      race.status = race.solo ? 'menu' : 'waiting';
      race.seed = race.solo ? generateSeed() : null;
      race.starters = (race.solo && race.starterMode === 'random') ? generateStarters(race.seed, race.starterCount) : null;
      race.startedAt = null;
      race.menuReady = race.solo ? { 1: false } : { 1: false, 2: false };
      race.cameraSettings = { 1: null, 2: null };
      race.progress = {
        1: { wave: 0, status: 'waiting' },
        2: { wave: 0, status: 'waiting' },
      };

      // Check if this is the original host reconnecting
      if (race.host && race.host.twitchId === twitchId) {
        race.host.socketId = socket.id;
        race.host.name = name || race.host.name;
        race.host.avatar = avatar || race.host.avatar;
        race.host.ready = false;
        race.guest = null;
        socket.join(`race:${race.code}`);
        socket.data.raceCode = race.code;
        socket.data.playerNumber = 1;
        console.log(`[Race] ${name} rejoined ${code} as host (rematch)`);
        socket.emit('RACE_JOINED', { code: race.code, player: 1 });
        broadcastRaceState(race);
        return;
      }

      // Otherwise, the guest (or a new player) is joining — host slot stays, clear guest
      race.guest = null;
    }

    if (race.status !== 'waiting') {
      return socket.emit('RACE_ERROR', { message: 'Race hat bereits begonnen' });
    }

    // Leave any existing race first
    const existing = getRaceBySocket(socket.id);
    if (existing) {
      socket.leave(`race:${existing.race.code}`);
    }

    // If this is the host reconnecting (e.g. page reload while waiting)
    if (race.host && race.host.twitchId === twitchId) {
      race.host.socketId = socket.id;
      race.host.name = name || race.host.name;
      race.host.avatar = avatar || race.host.avatar;
      race.host.ready = false;
      socket.join(`race:${race.code}`);
      socket.data.raceCode = race.code;
      socket.data.playerNumber = 1;
      console.log(`[Race] ${name} rejoined ${code} as host`);
      socket.emit('RACE_JOINED', { code: race.code, player: 1 });
      broadcastRaceState(race);
      return;
    }

    if (race.guest) {
      return socket.emit('RACE_ERROR', { message: 'Race ist bereits voll' });
    }

    race.guest = { socketId: socket.id, name: name || 'Spieler 2', avatar: avatar || null, twitchId: twitchId || null, player: 2, ready: false };
    socket.join(`race:${race.code}`);
    socket.data.raceCode = race.code;
    socket.data.playerNumber = 2;

    console.log(`[Race] ${name} joined ${code}`);
    socket.emit('RACE_JOINED', { code: race.code, player: 2 });
    broadcastRaceState(race);
  });

  // START_RACE transitions to 'menu' — starters generated for random mode
  socket.on('START_RACE', ({ code }) => {
    const race = races.get(code);
    if (!race) return socket.emit('RACE_ERROR', { message: 'Race nicht gefunden' });
    if (race.host.socketId !== socket.id) return socket.emit('RACE_ERROR', { message: 'Nur der Host kann starten' });
    if (!race.solo && !race.guest) return socket.emit('RACE_ERROR', { message: 'Warte auf zweiten Spieler' });

    race.seed = generateSeed();
    race.status = 'menu';
    race.menuReady = { 1: false, 2: false };

    // Generate starters for random mode
    if (race.starterMode === 'random') {
      race.starters = generateStarters(race.seed, race.starterCount);
    } else {
      race.starters = null;
    }

    console.log(`[Race] ${code} → menu (seed: ${race.seed}, mode: ${race.starterMode})`);
    io.to(`race:${code}`).emit('RACE_TO_MENU', {
      code: race.code,
      seed: race.seed,
      starterMode: race.starterMode,
      chatSessionId: race.chatSessionId,
    });
  });

  // Race-Menu: Player connects after redirect
  socket.on('RACE_MENU_JOIN', ({ code, playerNumber, twitchId }) => {
    const race = races.get(code?.toUpperCase());
    if (!race) return socket.emit('RACE_ERROR', { message: 'Race nicht gefunden' });
    if (race.status !== 'menu') return socket.emit('RACE_ERROR', { message: 'Race ist nicht im Menu' });

    const playerNum = parseInt(playerNumber);
    if (playerNum !== 1 && playerNum !== 2) return;

    const slot = playerNum === 1 ? 'host' : 'guest';
    if (!race[slot] || race[slot].twitchId !== twitchId) {
      return socket.emit('RACE_ERROR', { message: 'Spieler-Identitaet passt nicht' });
    }

    // Cancel any DC timer
    const oldSocketId = race[slot].socketId;
    if (dcTimers.has(oldSocketId)) {
      clearTimeout(dcTimers.get(oldSocketId));
      dcTimers.delete(oldSocketId);
    }

    // Update socket reference
    race[slot].socketId = socket.id;
    socket.join(`race:${code}`);
    socket.data.raceCode = code;
    socket.data.playerNumber = playerNum;

    console.log(`[Race] ${race[slot].name} joined menu for ${code} as P${playerNum}`);

    // Send full menu state
    socket.emit('RACE_MENU_STATE', {
      code: race.code,
      solo: !!race.solo,
      seed: race.seed,
      starterMode: race.starterMode,
      gameMode: race.gameMode,
      winCondition: race.winCondition,
      winWave: race.winWave,
      nuzlockeDeath: race.nuzlockeDeath,
      nuzlockeCatch: race.nuzlockeCatch,
      starterCount: race.starterCount,
      respawnOnWipe: race.respawnOnWipe,
      shinyMode: race.shinyMode,
      luckLevel: race.luckLevel,
      menuReady: race.menuReady,
      host: race.host ? { name: race.host.name, avatar: race.host.avatar, twitchId: race.host.twitchId, player: 1 } : null,
      guest: race.guest ? { name: race.guest.name, avatar: race.guest.avatar, twitchId: race.guest.twitchId, player: 2 } : null,
    });

    broadcastRaceState(race);
  });

  // Host updates game config (starter mode, game mode, win condition, wave, nuzlocke, starter count, respawn)
  socket.on('RACE_CONFIG_UPDATE', ({ code, starterMode, gameMode, winCondition, winWave, nuzlockeDeath, nuzlockeCatch, starterCount, respawnOnWipe, shinyMode, luckLevel }) => {
    const race = races.get(code);
    if (!race || race.status !== 'menu') return;
    if (race.host.socketId !== socket.id) return; // Host only

    if (starterMode && (starterMode === 'random' || starterMode === 'free')) {
      if (starterMode !== race.starterMode) {
        race.starterMode = starterMode;
        // Regenerate starters if switching to random
        if (starterMode === 'random') {
          race.starters = generateStarters(race.seed, race.starterCount);
        } else {
          race.starters = null;
        }
        // Reset ready when starter mode changes
        race.menuReady = { 1: false, 2: false };
      }
    }
    if (gameMode) race.gameMode = gameMode;
    if (winCondition) race.winCondition = winCondition;
    if (winWave !== undefined) race.winWave = Math.max(1, Math.min(200, parseInt(winWave) || 20));
    if (nuzlockeDeath !== undefined) race.nuzlockeDeath = !!nuzlockeDeath;
    if (nuzlockeCatch !== undefined) race.nuzlockeCatch = !!nuzlockeCatch;
    if (starterCount !== undefined) {
      const newCount = Math.max(1, Math.min(6, parseInt(starterCount) || 3));
      if (newCount !== race.starterCount) {
        race.starterCount = newCount;
        // Regenerate starters with new count if in random mode
        if (race.starterMode === 'random') {
          race.starters = generateStarters(race.seed, race.starterCount);
          race.menuReady = { 1: false, 2: false };
        }
      }
    }
    if (respawnOnWipe !== undefined) race.respawnOnWipe = !!respawnOnWipe;
    if (shinyMode !== undefined && ['off', 'boosted', 'guaranteed'].includes(shinyMode)) race.shinyMode = shinyMode;
    if (luckLevel !== undefined) race.luckLevel = Math.max(-1, Math.min(14, parseInt(luckLevel)));

    // Propagate winWave to chat session
    if (winWave !== undefined && race.chatSessionId) {
      const chatSession = chatFeature.getSession(race.chatSessionId);
      if (chatSession) chatSession.winWave = race.winWave;
      io.to(`chat:${race.chatSessionId}`).emit('CHAT_WIN_WAVE_CHANGED', { winWave: race.winWave });
    }

    // Propagate nuzlockeCatch to chat session
    if (nuzlockeCatch !== undefined && race.chatSessionId) {
      chatFeature.setNuzlockeCatch(race.chatSessionId, !!nuzlockeCatch);
      io.to(`chat:${race.chatSessionId}`).emit('CHAT_NUZLOCKE_CHANGED', { nuzlockeCatch: !!nuzlockeCatch });
    }

    console.log(`[Race] ${code} config: starter=${race.starterMode} mode=${race.gameMode} win=${race.winCondition} wave=${race.winWave} nuzDeath=${race.nuzlockeDeath} nuzCatch=${race.nuzlockeCatch} starters=${race.starterCount} respawn=${race.respawnOnWipe} shiny=${race.shinyMode} luck=${race.luckLevel}`);
    io.to(`race:${code}`).emit('RACE_CONFIG_CHANGED', {
      starterMode: race.starterMode,
      gameMode: race.gameMode,
      winCondition: race.winCondition,
      winWave: race.winWave,
      nuzlockeDeath: race.nuzlockeDeath,
      nuzlockeCatch: race.nuzlockeCatch,
      starterCount: race.starterCount,
      respawnOnWipe: race.respawnOnWipe,
      shinyMode: race.shinyMode,
      luckLevel: race.luckLevel,
      menuReady: race.menuReady,
    });
  });

  // Player ready in menu
  socket.on('RACE_PLAYER_READY', ({ code, ready, cameraEnabled, cameraDeviceId }) => {
    const race = races.get(code);
    if (!race || race.status !== 'menu') return;

    const playerNum = socket.data.playerNumber;
    if (!playerNum) return;

    race.menuReady[playerNum] = !!ready;
    race.cameraSettings[playerNum] = {
      enabled: !!cameraEnabled,
      deviceId: cameraDeviceId || null,
    };

    io.to(`race:${code}`).emit('RACE_READY_STATE', {
      menuReady: race.menuReady,
    });

    console.log(`[Race] ${code} P${playerNum} ready=${ready} (P1=${race.menuReady[1]} P2=${race.menuReady[2]} solo=${!!race.solo})`);

    // Both ready (or P1 ready in solo) → start the game
    const allReady = race.solo ? race.menuReady[1] : (race.menuReady[1] && race.menuReady[2]);
    if (allReady) {
      race.status = 'starting';
      race.startedAt = Date.now();
      race.progress[1] = { wave: 0, status: 'loading' };
      race.progress[2] = { wave: 0, status: 'loading' };

      // For random mode, both get the same starters
      const startersP1 = race.starterMode === 'random' && race.starters ? race.starters.map(s => s.id) : null;
      const startersP2 = startersP1; // Same starters for both

      if (startersP1) {
        console.log(`[Race] ${code} STARTING (random) — starters: [${race.starters.map(s => s.name).join(',')}]`);
      } else {
        console.log(`[Race] ${code} STARTING (free) — players choose in-game`);
      }

      io.to(`race:${code}`).emit('RACE_STARTING', {
        seed: race.seed,
        starterMode: race.starterMode,
        startedAt: race.startedAt,
        gameMode: race.gameMode,
        winCondition: race.winCondition,
        winWave: race.winWave,
        nuzlockeDeath: race.nuzlockeDeath,
        nuzlockeCatch: race.nuzlockeCatch,
        starterCount: race.starterCount,
        respawnOnWipe: race.respawnOnWipe,
        shinyMode: race.shinyMode,
        luckLevel: race.luckLevel,
        startersP1,
        startersP2,
        cameraSettings: race.cameraSettings,
        overlayLayout: race.overlayLayout,
        overlayCamWidth: race.overlayCamWidth,
        overlayCamZoom: race.overlayCamZoom,
        overlayCommunityWidth: race.overlayCommunityWidth,
        overlayG1X: race.overlayG1X,
        overlayG1Y: race.overlayG1Y,
        overlayG2X: race.overlayG2X,
        overlayG2Y: race.overlayG2Y,
        overlayT1X: race.overlayT1X,
        overlayT1Y: race.overlayT1Y,
        overlayT2X: race.overlayT2X,
        overlayT2Y: race.overlayT2Y,
        overlayHud: race.overlayHud,
        overlayTimer: race.overlayTimer,
      });
    }
  });

  socket.on('RACE_READY', ({ code, playerNumber }) => {
    const race = races.get(code);
    if (!race) {
      socket.emit('RACE_ERROR', { message: 'Race nicht gefunden' });
      return;
    }

    // Game client sends playerNumber from URL params — assign to socket.data
    const playerNum = playerNumber || socket.data.playerNumber;
    if (!playerNum) return;

    socket.data.raceCode = code;
    socket.data.playerNumber = playerNum;
    socket.join(`race:${code}`);

    // Update socket reference (game client is a NEW socket, lobby socket is gone)
    if (playerNum === 1 && race.host) {
      race.host.socketId = socket.id;
      race.host.ready = true;
    }
    if (playerNum === 2 && race.guest) {
      race.guest.socketId = socket.id;
      race.guest.ready = true;
    }

    // If race already has a seed (started from menu), send it to this game client
    if (race.seed && race.status === 'starting') {
      const myStarters = race.starterMode === 'random' && race.starters ? race.starters.map(s => s.id) : null;

      socket.emit('RACE_STARTING', {
        seed: race.seed,
        starterMode: race.starterMode,
        startedAt: race.startedAt,
        gameMode: race.gameMode,
        winCondition: race.winCondition,
        winWave: race.winWave,
        nuzlockeDeath: race.nuzlockeDeath,
        nuzlockeCatch: race.nuzlockeCatch,
        starterCount: race.starterCount,
        respawnOnWipe: race.respawnOnWipe,
        shinyMode: race.shinyMode,
        luckLevel: race.luckLevel,
        startersP1: playerNum === 1 ? myStarters : undefined,
        startersP2: playerNum === 2 ? myStarters : undefined,
        overlayLayout: race.overlayLayout,
        overlayCamWidth: race.overlayCamWidth,
        overlayCamZoom: race.overlayCamZoom,
        overlayCommunityWidth: race.overlayCommunityWidth,
        overlayG1X: race.overlayG1X,
        overlayG1Y: race.overlayG1Y,
        overlayG2X: race.overlayG2X,
        overlayG2Y: race.overlayG2Y,
        overlayT1X: race.overlayT1X,
        overlayT1Y: race.overlayT1Y,
        overlayT2X: race.overlayT2X,
        overlayT2Y: race.overlayT2Y,
        cameraSettings: race.cameraSettings,
      });
      console.log(`[Race] Sent seed to P${playerNum} (late join) for ${code}`);
    }

    // Both ready (or just host in solo) → race is live
    const gameReady = race.solo ? race.host?.ready : (race.host?.ready && race.guest?.ready);
    if (gameReady) {
      race.status = 'racing';
      race.progress[1].status = 'playing';
      if (!race.solo) race.progress[2].status = 'playing';
      console.log(`[Race] ${code} is LIVE!${race.solo ? ' (solo)' : ''}`);
    }

    broadcastRaceState(race);
  });

  socket.on('RACE_REJOIN', ({ code, twitchId, playerNumber }) => {
    const race = races.get(code?.toUpperCase());
    if (!race) {
      return socket.emit('RACE_ERROR', { message: 'Race nicht gefunden' });
    }

    // Validate player identity
    let slot = null;
    if (playerNumber === 1 && race.host && race.host.twitchId === twitchId) {
      slot = 'host';
    } else if (playerNumber === 2 && race.guest && race.guest.twitchId === twitchId) {
      slot = 'guest';
    }

    if (!slot) {
      return socket.emit('RACE_ERROR', { message: 'Spieler-Identitaet passt nicht' });
    }

    // Cancel any pending auto-forfeit timer for the old socket
    const oldSocketId = race[slot].socketId;
    if (dcTimers.has(oldSocketId)) {
      clearTimeout(dcTimers.get(oldSocketId));
      dcTimers.delete(oldSocketId);
      console.log(`[Race] Cancelled forfeit timer for ${oldSocketId}`);
    }

    // Replace socket reference
    race[slot].socketId = socket.id;
    socket.join(`race:${race.code}`);
    socket.data.raceCode = race.code;
    socket.data.playerNumber = playerNumber;

    // Restore status from 'disconnected' to 'playing' if race is still going
    if (race.progress[playerNumber].status === 'disconnected') {
      race.progress[playerNumber].status = 'playing';
    }

    console.log(`[Race] ${race[slot].name} rejoined ${code} as P${playerNumber}`);

    // Send current state + seed back to the reconnecting client
    broadcastRaceState(race);
    if (race.seed) {
      socket.emit('RACE_STARTING', {
        seed: race.seed,
        starterMode: race.starterMode,
        startedAt: race.startedAt,
        gameMode: race.gameMode,
        winCondition: race.winCondition,
        winWave: race.winWave,
        nuzlockeDeath: race.nuzlockeDeath,
        nuzlockeCatch: race.nuzlockeCatch,
        starterCount: race.starterCount,
        respawnOnWipe: race.respawnOnWipe,
        shinyMode: race.shinyMode,
        luckLevel: race.luckLevel,
        cameraSettings: race.cameraSettings,
        overlayLayout: race.overlayLayout,
        overlayCamWidth: race.overlayCamWidth,
        overlayCamZoom: race.overlayCamZoom,
        overlayCommunityWidth: race.overlayCommunityWidth,
        overlayG1X: race.overlayG1X,
        overlayG1Y: race.overlayG1Y,
        overlayG2X: race.overlayG2X,
        overlayG2Y: race.overlayG2Y,
        overlayT1X: race.overlayT1X,
        overlayT1Y: race.overlayT1Y,
        overlayT2X: race.overlayT2X,
        overlayT2Y: race.overlayT2Y,
        overlayHud: race.overlayHud,
        overlayTimer: race.overlayTimer,
      });
    }
  });

  socket.on('RACE_PROGRESS', ({ code, wave, status }) => {
    const race = races.get(code);
    if (!race) return;

    const playerNum = socket.data.playerNumber;
    if (!playerNum || !race.progress[playerNum]) return;

    race.progress[playerNum] = { wave: wave || 0, status: status || 'playing' };
    const other = playerNum === 1 ? 2 : 1;

    // Client reports victory (win condition checked in VictoryPhase) — set opponent to defeated
    if (status === 'victory') {
      console.log(`[Race] ${code} P${playerNum}: VICTORY at wave ${wave}`);
      if (race.progress[other].status === 'playing' || race.progress[other].status === 'waiting') {
        race.progress[other].status = 'defeated';
      }
      race.status = 'finished';
      console.log(`[Race] ${code} FINISHED`);
    } else if (status === 'wiped') {
      // Player wiped but respawn is enabled — don't end the race
      console.log(`[Race] ${code} P${playerNum}: WIPED at wave ${wave} (respawning)`);
      race.progress[playerNum] = { wave: 0, status: 'respawning' };
    } else if (status === 'defeated') {
      console.log(`[Race] ${code} P${playerNum}: DEFEATED at wave ${wave}`);
      if (race.progress[other].status === 'defeated' || race.progress[other].status === 'victory') {
        race.status = 'finished';
        console.log(`[Race] ${code} FINISHED`);
      }
    }

    io.to(`race:${code}`).emit('RACE_UPDATE', {
      progress: race.progress,
      status: race.status,
    });
  });

  socket.on('LEAVE_RACE', ({ code }) => {
    const race = races.get(code);
    if (!race) return;

    socket.leave(`race:${code}`);
    delete socket.data.raceCode;
    delete socket.data.playerNumber;

    if (race.host?.socketId === socket.id) {
      // Host left → end race
      notifyLiveOverlay(race.host?.twitchId, null);
      races.delete(code);
      io.to(`race:${code}`).emit('RACE_ENDED', { reason: 'Host hat das Race verlassen' });
      console.log(`[Race] ${code} ended — host left`);
    } else if (race.guest?.socketId === socket.id) {
      // In menu: guest leaving resets to waiting
      if (race.status === 'menu') {
        race.guest = null;
        race.status = 'waiting';
        race.starters = null;
        race.menuReady = { 1: false, 2: false };
        race.seed = null;
        console.log(`[Race] Guest left menu ${code} — back to waiting`);
      } else {
        race.guest = null;
        console.log(`[Race] Guest left ${code}`);
      }
      broadcastRaceState(race);
    }
  });

  // --- Live Layout Editor ---
  socket.on('LAYOUT_UPDATE', ({ code, ...layoutData }) => {
    if (!code) return;
    const race = races.get(code.toUpperCase());
    if (!race) return;
    // Only host can update layout
    if (race.host?.socketId !== socket.id && !socket.data.isLayoutEditor) return;
    // Broadcast to all in race room (including overlay)
    io.to(`race:${code.toUpperCase()}`).emit('LAYOUT_UPDATE', layoutData);
    console.log(`[Layout] Update for ${code}:`, Object.keys(layoutData).join(', '));
  });

  // Layout editor registers for a race
  socket.on('LAYOUT_EDITOR_JOIN', ({ code }) => {
    if (!code) return;
    const raceCode = code.toUpperCase();
    socket.join(`race:${raceCode}`);
    socket.data.isLayoutEditor = true;
    socket.data.raceCode = raceCode;
    const race = races.get(raceCode);
    if (race) {
      socket.emit('RACE_STATE', {
        code: raceCode,
        host: race.host ? { name: race.host.name } : null,
        guest: race.guest ? { name: race.guest.name } : null,
        status: race.status,
      });
    }
    console.log(`[Layout] Editor joined ${raceCode}`);
  });

  // --- Live Overlay (persistent OBS browser source) ---
  socket.on('REGISTER_LIVE_OVERLAY', ({ twitchId }) => {
    if (!twitchId) return;
    const room = `live-overlay:${twitchId}`;
    socket.join(room);
    socket.data.liveOverlayFor = twitchId;
    console.log(`[LiveOverlay] Registered for twitchId ${twitchId}`);

    // Check if streamer already has an active race
    for (const [code, race] of races) {
      if (race.host?.twitchId === twitchId && race.status !== 'finished') {
        const overlayUrl = buildOverlayUrl(race);
        socket.emit('LIVE_OVERLAY_UPDATE', { overlayUrl, code });
        console.log(`[LiveOverlay] Sent active race ${code} to new overlay`);
        break;
      }
    }
  });

  // --- WebRTC Signaling ---

  socket.on('REGISTER_WEBRTC', async (payload) => {
    const { role, id, raceCode } = payload;
    socket.data.rtc = { role, id, raceCode };

    // Join race room if not already in it (overlay connects directly)
    if (raceCode) {
      socket.join(`race:${raceCode}`);
    }

    console.log(`[WebRTC] Registered: ${socket.id} as ${role} id=${id} race=${raceCode}`);
    if (raceCode) {
      await broadcastWebRtcPeers(raceCode);
    }
  });

  socket.on('SIGNAL', async (payload) => {
    const { targetRole, targetId, signalData } = payload;
    const sender = socket.data.rtc;
    if (!sender) return;

    const raceCode = sender.raceCode;
    if (!raceCode) return;

    const sockets = await io.in(`race:${raceCode}`).fetchSockets();
    let routed = 0;
    for (const targetSocket of sockets) {
      if (targetSocket.id === socket.id) continue;
      const targetData = targetSocket.data.rtc;
      if (!targetData) continue;
      const roleMatch = targetData.role === targetRole;
      const idMatch = targetId === undefined || targetData.id === targetId;
      if (roleMatch && idMatch) {
        targetSocket.emit('SIGNAL', {
          fromRole: sender.role,
          fromId: sender.id,
          data: signalData,
        });
        routed++;
      }
    }
    if (signalData?.type) {
      console.log(`[WebRTC] Signal ${sender.role}(${sender.id}) -> ${targetRole}(${targetId ?? 'any'}) [${signalData.type}] routed=${routed}`);
    }
  });

  // --- Chat Feature Events ---

  // Game Client: start a chat session
  socket.on('CHAT_SESSION_START', ({ seed, raceCode }) => {
    if (!seed) return;

    // Check if there's already a session for this race code (created in lobby)
    if (raceCode) {
      const sessions = chatFeature.getAllSessions();
      const existing = sessions.find(s => s.raceCode === raceCode && s.status === 'active');
      if (existing) {
        // Reuse existing session, update seed
        existing.seed = seed;
        existing.hostSocketId = socket.id;
        socket.data.chatSessionId = existing.sessionId;
        socket.join(`chat:${existing.sessionId}`);
        socket.emit('CHAT_SESSION_STARTED', { sessionId: existing.sessionId, code: existing.code, fixedTrainerOverrides: existing.config?.fixedTrainerOverrides || null });
        // Send all existing customizations (claimed/inserted trainers) to game client
        const customs = chatFeature.getAllCustomizations(existing.sessionId);
        for (const c of customs) {
          socket.emit('CHAT_CUSTOMIZATION', c);
        }
        console.log(`[Chat] Game joined existing race session: ${existing.sessionId} (race: ${raceCode}, ${customs.length} customizations)`);
        return;
      }
    }

    // winWave aus dem Race holen wenn vorhanden
    const race = raceCode ? races.get(raceCode) : null;
    const sessionId = chatFeature.createSession(seed, raceCode, race?.winWave);
    const session = chatFeature.getSession(sessionId);
    if (session) session.hostSocketId = socket.id;
    socket.data.chatSessionId = sessionId;
    socket.join(`chat:${sessionId}`);
    socket.emit('CHAT_SESSION_STARTED', { sessionId, code: session.code, fixedTrainerOverrides: session.config?.fixedTrainerOverrides || null });
    // Notify any waiting community pages
    io.emit('CHAT_SESSION_AVAILABLE', { sessionId: session.sessionId, code: session.code });
    console.log(`[Chat] Session started: ${sessionId} code=${session.code} by ${socket.id}`);
  });

  // Game Client: join existing session (P2 in race mode)
  socket.on('CHAT_SESSION_JOIN', ({ raceCode }) => {
    if (!raceCode) return;
    // Find active session with this race code
    const sessions = chatFeature.getAllSessions();
    const match = sessions.find(s => s.raceCode === raceCode && s.status === 'active');
    if (match) {
      socket.data.chatSessionId = match.sessionId;
      socket.join(`chat:${match.sessionId}`);
      socket.emit('CHAT_SESSION_STARTED', { sessionId: match.sessionId, fixedTrainerOverrides: match.config?.fixedTrainerOverrides || null });
      // Send all existing customizations to P2
      const customs = chatFeature.getAllCustomizations(match.sessionId);
      for (const c of customs) {
        socket.emit('CHAT_CUSTOMIZATION', c);
      }
      console.log(`[Chat] P2 joined session: ${match.sessionId} (race: ${raceCode}, ${customs.length} customizations)`);
    }
  });

  // Game Client: end session
  socket.on('CHAT_SESSION_END', ({ sessionId }) => {
    if (!sessionId) return;
    io.to(`chat:${sessionId}`).emit('CHAT_SESSION_ENDED', { sessionId });
    chatFeature.destroySession(sessionId);
  });

  // Game Client: report streamer's party
  socket.on('CHAT_PARTY_UPDATE', ({ sessionId, party }) => {
    if (!sessionId || !party) return;
    chatFeature.updateStreamerParty(sessionId, party);
    io.to(`chat:${sessionId}`).emit('CHAT_STREAMER_PARTY', { party });
  });

  // Game Client: report trainers (batch)
  socket.on('CHAT_TRAINER_REPORT', ({ sessionId, trainers }) => {
    if (!sessionId || !trainers) return;
    chatFeature.registerTrainerBatch(sessionId, trainers);
    // Broadcast updated list
    const visible = chatFeature.getVisibleTrainers(sessionId);
    io.to(`chat:${sessionId}`).emit('CHAT_TRAINER_LIST', { trainers: visible });
  });

  // Game Client: wave update
  socket.on('CHAT_WAVE_UPDATE', ({ sessionId, wave, biome }) => {
    if (!sessionId) return;
    chatFeature.updateWave(sessionId, wave, biome);
    io.to(`chat:${sessionId}`).emit('CHAT_WAVE_PROGRESS', { wave, biome });
    // Refresh trainer list (locked status may change)
    const visible = chatFeature.getVisibleTrainers(sessionId);
    io.to(`chat:${sessionId}`).emit('CHAT_TRAINER_LIST', { trainers: visible });
    // Send gimmick state to game client + community
    const gimmicks = chatFeature.getActiveGimmicks(sessionId);
    socket.emit('CHAT_GIMMICK_STATE', { activeGimmicks: gimmicks });
    io.to(`chat:${sessionId}`).emit('CHAT_GIMMICK_STATE', { activeGimmicks: gimmicks });
    // Re-sync vote timer if active
    const session = chatFeature.getSession(sessionId);
    if (session) {
      const voteState = chatFeature.getVoteState(session);
      if (voteState) {
        io.to(`chat:${sessionId}`).emit('CHAT_VOTE_UPDATE', voteState);
      }
    }
  });

  // Game Client: biome prescan
  socket.on('CHAT_BIOME_PRESCAN', ({ sessionId, trainers }) => {
    if (!sessionId || !trainers) return;
    chatFeature.registerTrainerBatch(sessionId, trainers);
    const visible = chatFeature.getVisibleTrainers(sessionId);
    io.to(`chat:${sessionId}`).emit('CHAT_TRAINER_LIST', { trainers: visible });
  });

  // Game Client: request customization for a wave
  socket.on('CHAT_REQUEST_CUSTOMIZATION', ({ sessionId, wave }) => {
    if (!sessionId) return;
    const custom = chatFeature.getCustomization(sessionId, wave);
    socket.emit('CHAT_CUSTOMIZATION', custom || { wave, trainerName: null, spriteKey: null, customParty: null, pokemonNicknames: {}, isCustomInserted: false });
  });

  // Community Page: join session room
  socket.on('COMMUNITY_JOIN', ({ sessionId }) => {
    if (!sessionId) return;
    const session = chatFeature.getSession(sessionId);
    if (!session) {
      socket.emit('CHAT_ERROR', { message: 'Session nicht gefunden' });
      return;
    }
    // Fallback: winWave aus dem Race holen falls Session es nicht hat
    if (!session.winWave && session.raceCode) {
      const race = races.get(session.raceCode);
      if (race?.winWave) session.winWave = race.winWave;
    }

    socket.join(`chat:${sessionId}`);
    socket.data.chatSessionId = sessionId;

    // Send initial state
    socket.emit('CHAT_SESSION_STATE', {
      sessionId: session.sessionId,
      code: session.code,
      seed: session.seed,
      raceCode: session.raceCode,
      status: session.status,
      currentWave: session.currentWave,
      currentBiome: session.currentBiome,
      config: session.config,
      winWave: session.winWave || 200,
      nuzlockeCatch: session.nuzlockeCatch || false,
      streamerParty: session.streamerParty || [],
      activeVote: chatFeature.getVoteState(session),
      activeGimmicks: chatFeature.getActiveGimmicks(sessionId),
    });

    // Send trainer list
    const visible = chatFeature.getVisibleTrainers(sessionId);
    socket.emit('CHAT_TRAINER_LIST', { trainers: visible });
  });

  // Community Page: claim trainer
  socket.on('COMMUNITY_CLAIM_TRAINER', ({ sessionId, wave, twitchUserId, displayName, anonymous, spriteKey, trainerLines, presetParty }) => {
    if (!sessionId || !wave || !twitchUserId) return;
    const requestedWave = parseInt(wave);
    const result = chatFeature.claimTrainer(sessionId, requestedWave, twitchUserId, displayName || twitchUserId, !!anonymous, spriteKey || null, trainerLines || null, presetParty || null);
    if (result.success) {
      const claimedWave = result.waveIndex || requestedWave;
      const claimedTrainer = chatFeature.getSession(sessionId)?.trainers?.get(claimedWave);
      io.to(`chat:${sessionId}`).emit('CHAT_TRAINER_CLAIMED', {
        wave: claimedWave,
        claimedBy: twitchUserId,
        claimedByName: anonymous ? '???' : displayName,
        anonymous: !!anonymous,
        spriteKey: claimedTrainer?.customSprite || null,
        trainerLines: claimedTrainer?.trainerLines || null,
      });
      // Push customization to game client in real-time
      const custom = chatFeature.getCustomization(sessionId, claimedWave);
      if (custom) {
        io.to(`chat:${sessionId}`).emit('CHAT_CUSTOMIZATION', custom);
      }
      // Include requestedWave so client can show fallback info
      result.requestedWave = requestedWave;
    }
    socket.emit('COMMUNITY_CLAIM_RESULT', result);
  });

  // Admin: unclaim trainer (streamer only)
  socket.on('COMMUNITY_UNCLAIM_TRAINER', ({ sessionId, wave }) => {
    if (!sessionId || wave === undefined) return;
    const result = chatFeature.unclaimTrainer(sessionId, parseInt(wave));
    if (result.success) {
      io.to(`chat:${sessionId}`).emit('CHAT_TRAINER_UNCLAIMED', { wave: parseInt(wave) });
    }
    socket.emit('COMMUNITY_UNCLAIM_RESULT', result);
  });

  // Community Page: edit team
  socket.on('COMMUNITY_EDIT_TEAM', ({ sessionId, wave, twitchUserId, newParty }) => {
    if (!sessionId || !wave || !twitchUserId || !newParty) return;
    const result = chatFeature.editTeam(sessionId, parseInt(wave), twitchUserId, newParty);
    if (result.success) {
      io.to(`chat:${sessionId}`).emit('CHAT_TEAM_EDITED', {
        wave: parseInt(wave),
        customParty: result.customParty,
      });
      // Push customization to game client in real-time
      const custom = chatFeature.getCustomization(sessionId, parseInt(wave));
      if (custom) {
        io.to(`chat:${sessionId}`).emit('CHAT_CUSTOMIZATION', custom);
      }
    }
    socket.emit('COMMUNITY_EDIT_RESULT', result);
  });

  // Community Page: change sprite
  // Community Page: toggle anonymous mode
  socket.on('COMMUNITY_TOGGLE_ANONYMOUS', ({ sessionId, wave, twitchUserId, anonymous }) => {
    if (!sessionId || wave === undefined || !twitchUserId) return;
    const result = chatFeature.toggleAnonymous(sessionId, parseInt(wave), twitchUserId, anonymous);
    if (result.success) {
      // Re-send trainer list so all clients see the updated name
      const visible = chatFeature.getVisibleTrainers(sessionId);
      io.to(`chat:${sessionId}`).emit('CHAT_TRAINER_LIST', { trainers: visible });
      // Push updated customization to game client
      const custom = chatFeature.getCustomization(sessionId, parseInt(wave));
      if (custom) {
        io.to(`chat:${sessionId}`).emit('CHAT_CUSTOMIZATION', custom);
      }
    }
    socket.emit('COMMUNITY_ANONYMOUS_RESULT', result);
  });

  socket.on('COMMUNITY_CHANGE_SPRITE', ({ sessionId, wave, twitchUserId, spriteKey }) => {
    if (!sessionId || !wave || !twitchUserId || !spriteKey) return;
    const result = chatFeature.changeSprite(sessionId, parseInt(wave), twitchUserId, spriteKey);
    if (result.success) {
      io.to(`chat:${sessionId}`).emit('CHAT_SPRITE_CHANGED', {
        wave: parseInt(wave),
        spriteKey,
      });
      // Push customization to game client in real-time
      const custom = chatFeature.getCustomization(sessionId, parseInt(wave));
      if (custom) {
        io.to(`chat:${sessionId}`).emit('CHAT_CUSTOMIZATION', custom);
      }
    }
    socket.emit('COMMUNITY_SPRITE_RESULT', result);
  });

  // Community Page: claim pokemon nickname
  socket.on('COMMUNITY_CLAIM_POKEMON', ({ sessionId, wave, slot, twitchUserId, displayName }) => {
    if (!sessionId || wave === undefined || slot === undefined || !twitchUserId) return;
    const result = chatFeature.claimPokemon(sessionId, parseInt(wave), parseInt(slot), twitchUserId, displayName || twitchUserId);
    if (result.success) {
      io.to(`chat:${sessionId}`).emit('CHAT_POKEMON_CLAIMED', {
        wave: parseInt(wave),
        slot: parseInt(slot),
        nickname: result.nickname,
      });
    }
    socket.emit('COMMUNITY_POKEMON_RESULT', result);
  });

  // Community Page: insert custom trainer (Wild → Trainer)
  socket.on('COMMUNITY_INSERT_TRAINER', ({ sessionId, wave, twitchUserId, displayName, anonymous, spriteKey, party, trainerLines }) => {
    if (!sessionId || !wave || !twitchUserId) return;
    const result = chatFeature.insertCustomTrainer(sessionId, parseInt(wave), twitchUserId, displayName || twitchUserId, spriteKey, party || [], !!anonymous, trainerLines || null);
    if (result.success) {
      const visible = chatFeature.getVisibleTrainers(sessionId);
      io.to(`chat:${sessionId}`).emit('CHAT_TRAINER_LIST', { trainers: visible });
      // Push customization to game client in real-time
      const custom = chatFeature.getCustomization(sessionId, parseInt(wave));
      if (custom) {
        io.to(`chat:${sessionId}`).emit('CHAT_CUSTOMIZATION', custom);
      }
    }
    socket.emit('COMMUNITY_INSERT_RESULT', result);
  });

  // Community Page: cast vote
  socket.on('COMMUNITY_CAST_VOTE', ({ sessionId, twitchUserId, option }) => {
    if (!sessionId || !twitchUserId || !option) return;
    const result = chatFeature.castVote(sessionId, twitchUserId, option);
    if (result.success) {
      const session = chatFeature.getSession(sessionId);
      if (session) {
        io.to(`chat:${sessionId}`).emit('CHAT_VOTE_UPDATE', chatFeature.getVoteState(session));
      }
    }
    socket.emit('COMMUNITY_VOTE_RESULT', result);
  });

  // Community Page: config update (streamer only)
  socket.on('COMMUNITY_CONFIG_UPDATE', ({ sessionId, config }) => {
    if (!sessionId || !config) return;
    const session = chatFeature.getSession(sessionId);
    if (!session) return;
    // Only the host socket (game client) should update config, or we verify via twitchId
    const updatedConfig = chatFeature.updateConfig(sessionId, config);
    if (updatedConfig) {
      io.to(`chat:${sessionId}`).emit('CHAT_CONFIG_CHANGED', { config: updatedConfig });
    }
  });

  // Community Page: start vote (streamer only)
  socket.on('COMMUNITY_START_VOTE', ({ sessionId, options, duration }) => {
    if (!sessionId || !options) return;
    const result = chatFeature.startVote(sessionId, options, duration || 60, io);
    if (result.success) {
      io.to(`chat:${sessionId}`).emit('CHAT_VOTE_UPDATE', result.vote);
    }
    socket.emit('COMMUNITY_VOTE_START_RESULT', result);
  });

  // Community Page: activate gimmick (streamer only)
  socket.on('COMMUNITY_ACTIVATE_GIMMICK', ({ sessionId, gimmickId, label, duration }) => {
    if (!sessionId || !gimmickId) return;
    const session = chatFeature.getSession(sessionId);
    if (!session) return;
    const dur = duration || session.config.gimmickDurations?.[gimmickId] || 10;
    chatFeature.activateGimmick(sessionId, gimmickId, label || gimmickId, dur);
    const gimmicks = chatFeature.getActiveGimmicks(sessionId);
    io.to(`chat:${sessionId}`).emit('CHAT_GIMMICK_ACTIVATED', { gimmickId, label: label || gimmickId, duration: dur });
    io.to(`chat:${sessionId}`).emit('CHAT_GIMMICK_STATE', { activeGimmicks: gimmicks });
    // Send to game client specifically
    if (session.hostSocketId) {
      io.to(session.hostSocketId).emit('CHAT_GIMMICK_STATE', { activeGimmicks: gimmicks });
    }
  });

  // --- Gym Leader Events ---

  socket.on('GYM_JOIN', () => {
    socket.join('gym');
    const state = gymLeader.getState();
    socket.emit('GYM_STATE', state);
  });

  socket.on('GYM_CREATE_SESSION', ({ twitchId, broadcasterToken }) => {
    if (twitchId !== '647322993') {
      return socket.emit('GYM_ERROR', { message: 'Nur der Streamer kann eine Gym-Session erstellen' });
    }
    const result = gymLeader.createSession();
    if (!result.success) return socket.emit('GYM_ERROR', { message: result.error });
    // Store broadcaster token for mod/VIP role detection
    if (broadcasterToken) {
      gymLeader.getSession().broadcasterToken = broadcasterToken;
      console.log(`[Gym] Broadcaster token stored for role detection`);
    }
    socket.data.gymAdmin = true;
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
    console.log(`[Gym] Session created by admin`);
  });

  socket.on('GYM_END_SESSION', ({ twitchId }) => {
    if (twitchId !== '647322993') return;
    gymLeader.endSession();
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
    console.log(`[Gym] Session ended by admin`);
  });

  socket.on('GYM_SET_BOSS_TEAM', ({ twitchId, team, spriteKey }) => {
    if (twitchId !== '647322993') return;
    const result = gymLeader.setBossTeam(team, spriteKey);
    if (!result.success) return socket.emit('GYM_ERROR', { message: result.error });
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_SAVE_PRESET', ({ twitchId, presetIndex, team, spriteKey, presetName }) => {
    if (twitchId !== '647322993') return;
    const result = gymLeader.saveBossPreset(presetIndex, team, spriteKey, presetName);
    if (!result.success) return socket.emit('GYM_ERROR', { message: result.error });
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_SWITCH_PRESET', ({ twitchId, presetIndex }) => {
    if (twitchId !== '647322993') return;
    const result = gymLeader.switchBossPreset(presetIndex);
    if (!result.success) return socket.emit('GYM_ERROR', { message: result.error });
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_UPDATE_CONFIG', ({ twitchId, config }) => {
    if (twitchId !== '647322993') return;
    const updated = gymLeader.updateConfig(config);
    if (!updated) return socket.emit('GYM_ERROR', { message: 'Keine Session aktiv' });
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_JOIN_QUEUE', async ({ twitchId, displayName, profileImage, team, trainerLines, spriteKey, twitchRole, token }) => {
    // Detect actual role from Twitch token if available
    let role = twitchRole || 'everyone';
    if (token && twitchId) {
      try {
        role = await detectTwitchRole(twitchId, token);
      } catch (e) {
        console.error('[Gym] Role detection failed:', e.message);
      }
    }
    const result = gymLeader.joinQueue(twitchId, displayName, profileImage, team, trainerLines, spriteKey, role);
    if (!result.success) return socket.emit('GYM_ERROR', { message: result.error });
    socket.emit('GYM_QUEUE_JOINED', { position: result.position, role, budget: gymLeader.getRoleBudget(role, gymLeader.getSession()?.config || {}) });
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_LEAVE_QUEUE', ({ twitchId }) => {
    gymLeader.leaveQueue(twitchId);
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_SKIP_CHALLENGER', ({ twitchId }) => {
    if (twitchId !== '647322993') return;
    const result = gymLeader.skipChallenger();
    if (!result.success) return socket.emit('GYM_ERROR', { message: result.error });
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_KICK_FROM_QUEUE', ({ twitchId, targetId }) => {
    if (twitchId !== '647322993') return;
    gymLeader.kickFromQueue(targetId);
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  socket.on('GYM_AWARD_BADGE', ({ twitchId, challengerId, challengerName }) => {
    if (twitchId !== '647322993') return;
    const result = gymLeader.awardBadge(challengerId, challengerName);
    // Clear battle state
    const session = gymLeader.getSession();
    if (session) {
      session.activeBattleId = null;
      session.revealedBossSlots = [];
    }
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
    io.to('gym').emit('GYM_BADGE_AWARDED', { twitchId: challengerId, displayName: challengerName, totalBadges: result.totalBadges });
  });

  socket.on('GYM_RECORD_LOSS', ({ twitchId, challengerId, challengerName }) => {
    if (twitchId !== '647322993') return;
    gymLeader.recordLoss(challengerId, challengerName);
    // Clear battle state
    const session = gymLeader.getSession();
    if (session) {
      session.activeBattleId = null;
      session.revealedBossSlots = [];
    }
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  // --- PvP Battle Events ---
  pvpBattleManager.setupSocketHandlers(io, socket, (battleId, revealedSlots) => {
    // onBossReveal
    const session = gymLeader.getSession();
    if (session && session.activeBattleId === battleId) {
      session.revealedBossSlots = revealedSlots;
    }
  }, (battleId, winner, reason) => {
    // onBattleEnd — automatically advance gym queue
    const session = gymLeader.getSession();
    if (!session || session.activeBattleId !== battleId) return;
    const challenger = session.currentChallenger;
    if (!challenger) return;

    console.log(`[Gym] Auto-processing battle result: ${winner} won (${reason})`);

    if (winner === 'challenger') {
      const result = gymLeader.awardBadge(challenger.twitchId, challenger.displayName);
      io.to('gym').emit('GYM_BADGE_AWARDED', {
        twitchId: challenger.twitchId,
        displayName: challenger.displayName,
        totalBadges: result.totalBadges,
      });
    } else {
      gymLeader.recordLoss(challenger.twitchId, challenger.displayName);
    }

    // Clear battle state
    session.activeBattleId = null;
    session.revealedBossSlots = [];
    io.to('gym').emit('GYM_STATE', gymLeader.getState());
  });

  // Gym: Start PvP battle (admin triggers when challenger is ready)
  socket.on('GYM_START_BATTLE', ({ twitchId }) => {
    if (twitchId !== '647322993') return;
    const session = gymLeader.getSession();
    if (!session || !session.currentChallenger) {
      return socket.emit('GYM_ERROR', { message: 'Kein Challenger bereit' });
    }

    const challenger = session.currentChallenger;
    const bossTeam = session.bossTeam || [];

    // Create PvP battle room
    const gymCfg = session.config || {};
    const room = pvpBattleManager.createBattle({
      bossTeam: bossTeam,
      challengerTeam: challenger.team,
      bossName: 'Gym Leader',
      bossSprite: session.bossSprite || 'youngster',
      challengerName: challenger.displayName,
      challengerSprite: challenger.spriteKey || 'youngster',
      level: 50,
      bossEggMoves: gymCfg.bossEggMoves !== false,
      challengerEggMoves: gymCfg.challengerEggMoves || 'none',
    });

    // Store battle ID in gym session
    session.activeBattleId = room.battleId;
    session.revealedBossSlots = [0]; // Lead pokemon always revealed

    // Broadcast battle info to gym room
    io.to('gym').emit('GYM_BATTLE_CREATED', {
      battleId: room.battleId,
      seed: room.seed,
      bossTeam: bossTeam.map(p => ({ speciesId: p.speciesId, name: p.name, formIndex: p.formIndex })),
      challengerTeam: challenger.team.map(p => ({ speciesId: p.speciesId, name: p.name, formIndex: p.formIndex })),
      challengerName: challenger.displayName,
    });

    io.to('gym').emit('GYM_STATE', gymLeader.getState());
    console.log(`[Gym] PvP battle created: ${room.battleId}`);
  });

  // --- Helper: Clean up chat session for a race code ---
  function cleanupChatSessionForRace(raceCode) {
    if (!raceCode) return;
    const sessions = chatFeature.getAllSessions();
    const match = sessions.find(s => s.raceCode === raceCode && s.status === 'active');
    if (match) {
      io.to(`chat:${match.sessionId}`).emit('CHAT_SESSION_ENDED', { sessionId: match.sessionId });
      chatFeature.destroySession(match.sessionId);
      console.log(`[Chat] Session auto-destroyed for race ${raceCode}: ${match.sessionId}`);
    }
  }

  // --- Disconnect ---

  socket.on('disconnect', async (reason) => {
    connectionCount--;
    console.log(`[EmmelRogue] Client disconnected: ${socket.id} — ${reason} (${connectionCount} online)`);

    // Clean up race membership
    const found = getRaceBySocket(socket.id);
    if (found) {
      const { race, role } = found;
      const playerNum = role === 'host' ? 1 : 2;

      if (race.status === 'waiting') {
        if (role === 'host') {
          notifyLiveOverlay(race.host?.twitchId, null);
          races.delete(race.code);
          io.to(`race:${race.code}`).emit('RACE_ENDED', { reason: 'Host disconnected' });
          cleanupChatSessionForRace(race.code);
          console.log(`[Race] ${race.code} ended — host disconnected`);
        } else {
          race.guest = null;
          broadcastRaceState(race);
        }
      } else if (race.status === 'menu') {
        // During menu — 60s to rejoin
        race.menuReady[playerNum] = false;
        io.to(`race:${race.code}`).emit('RACE_READY_STATE', { menuReady: race.menuReady });

        console.log(`[Race] ${race.code} P${playerNum} disconnected from menu — 60s to rejoin`);
        const timer = setTimeout(() => {
          dcTimers.delete(socket.id);
          if (race.status === 'menu') {
            if (role === 'host') {
              races.delete(race.code);
              io.to(`race:${race.code}`).emit('RACE_ENDED', { reason: 'Host hat das Race verlassen' });
              cleanupChatSessionForRace(race.code);
              console.log(`[Race] ${race.code} ended — host DC timeout in menu`);
            } else {
              race.guest = null;
              race.status = 'waiting';
              race.starters = null;
              race.menuReady = { 1: false, 2: false };
              race.seed = null;
              console.log(`[Race] ${race.code} guest DC timeout in menu — back to waiting`);
              broadcastRaceState(race);
            }
          }
        }, 60_000);
        dcTimers.set(socket.id, timer);
      } else {
        // During active race → mark as disconnected + start 60s auto-forfeit timer
        race.progress[playerNum].status = 'disconnected';
        io.to(`race:${race.code}`).emit('RACE_UPDATE', {
          progress: race.progress,
          status: race.status,
        });

        console.log(`[Race] ${race.code} P${playerNum} disconnected — 60s to rejoin`);
        const timer = setTimeout(() => {
          dcTimers.delete(socket.id);
          if (race.progress[playerNum]?.status === 'disconnected') {
            race.progress[playerNum].status = 'defeated';
            console.log(`[Race] ${race.code} P${playerNum} auto-forfeit (timeout)`);

            const other = playerNum === 1 ? 2 : 1;
            if (race.progress[other].status === 'defeated' || race.progress[other].status === 'victory') {
              race.status = 'finished';
              cleanupChatSessionForRace(race.code);
            }

            io.to(`race:${race.code}`).emit('RACE_UPDATE', {
              progress: race.progress,
              status: race.status,
            });
          }
        }, 60_000);
        dcTimers.set(socket.id, timer);
      }
    }

    // Clean up chat session if this socket was the host
    if (socket.data.chatSessionId) {
      const session = chatFeature.getSession(socket.data.chatSessionId);
      if (session && session.hostSocketId === socket.id) {
        io.to(`chat:${session.sessionId}`).emit('CHAT_SESSION_ENDED', { sessionId: session.sessionId });
        chatFeature.destroySession(session.sessionId);
        console.log(`[Chat] Session auto-destroyed on host disconnect: ${session.sessionId}`);
      }
    }

    // Clean up WebRTC peers
    if (socket.data.rtc?.raceCode) {
      await broadcastWebRtcPeers(socket.data.rtc.raceCode);
    }
  });
});

// Clean up stale races periodically (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [code, race] of races) {
    // Remove started races older than 3 hours
    if (race.startedAt && now - race.startedAt > 3 * 60 * 60 * 1000) {
      races.delete(code);
      io.to(`race:${code}`).emit('RACE_ENDED', { reason: 'Race timeout' });
      console.log(`[Race] ${code} cleaned up (started >3h ago)`);
      continue;
    }
    // Remove unstarted races (waiting/menu) older than 15 minutes
    if (!race.startedAt && race.createdAt && now - race.createdAt > 15 * 60 * 1000) {
      races.delete(code);
      io.to(`race:${code}`).emit('RACE_ENDED', { reason: 'Race abgelaufen' });
      console.log(`[Race] ${code} cleaned up (idle >15min)`);
      continue;
    }
    // Remove unstarted races without createdAt (legacy) older than 15 min — check if no sockets connected
    if (!race.startedAt && !race.createdAt) {
      races.delete(code);
      console.log(`[Race] ${code} cleaned up (no createdAt, stale)`);
    }
  }
  if (races.size > 0) {
    console.log(`[Race] Active races: ${races.size}`);
  }
}, 2 * 60 * 1000);

// Clean up stale chat sessions periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const sessions = chatFeature.getAllSessions();
  for (const session of sessions) {
    // Remove sessions older than 4 hours
    if (session.createdAt && now - session.createdAt > 4 * 60 * 60 * 1000) {
      io.to(`chat:${session.sessionId}`).emit('CHAT_SESSION_ENDED', { sessionId: session.sessionId });
      chatFeature.destroySession(session.sessionId);
      console.log(`[Chat] Session cleaned up (>4h old): ${session.sessionId}`);
      continue;
    }
    // Remove sessions with raceCode but no matching active race (orphaned)
    if (session.raceCode && !races.has(session.raceCode)) {
      // Grace period: 2 minutes after race deletion
      if (session.createdAt && now - session.createdAt > 2 * 60 * 1000) {
        io.to(`chat:${session.sessionId}`).emit('CHAT_SESSION_ENDED', { sessionId: session.sessionId });
        chatFeature.destroySession(session.sessionId);
        console.log(`[Chat] Orphaned session cleaned up (race ${session.raceCode} gone): ${session.sessionId}`);
      }
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EmmelRogue] Server running on http://127.0.0.1:${PORT}`);
});
