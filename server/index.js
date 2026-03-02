require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const PORT = 3006;
const ALLOWED_ORIGINS = [
  'https://emmelrogue.emmel.tv',
  'http://localhost:8000',
];

// TURN credentials (shared with Imposter)
const TURN_USERNAME = process.env.TURN_USERNAME || 'matchme';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

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
    host: race.host ? { name: race.host.name, avatar: race.host.avatar, player: 1, ready: race.host.ready } : null,
    guest: race.guest ? { name: race.guest.name, avatar: race.guest.avatar, player: 2, ready: race.guest.ready } : null,
    starterMode: race.starterMode,
    status: race.status,
    progress: race.progress,
    startedAt: race.startedAt,
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

// Serve the built game from dist/
app.use(express.static(path.join(__dirname, '..', 'dist')));

// SPA fallback — serve index.html for all non-file routes (except lobby/overlay)
app.get('*', (req, res) => {
  if (req.path.startsWith('/lobby') || req.path.startsWith('/overlay') || req.path.startsWith('/api/')) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

// --- Socket.io ---
let connectionCount = 0;

io.on('connection', (socket) => {
  connectionCount++;
  console.log(`[EmmelRogue] Client connected: ${socket.id} (${connectionCount} online)`);

  socket.on('PING', () => {
    socket.emit('PONG', { timestamp: Date.now() });
  });

  // --- Race Events ---

  socket.on('CREATE_RACE', ({ name, avatar, twitchId, starterMode }) => {
    // Leave any existing race first
    const existing = getRaceBySocket(socket.id);
    if (existing) {
      socket.leave(`race:${existing.race.code}`);
      if (existing.role === 'host') {
        races.delete(existing.race.code);
        io.to(`race:${existing.race.code}`).emit('RACE_ENDED', { reason: 'Host left' });
      }
    }

    const code = generateRaceCode();
    const race = {
      code,
      host: { socketId: socket.id, name: name || 'Spieler 1', avatar: avatar || null, twitchId: twitchId || null, player: 1, ready: false },
      guest: null,
      seed: null,
      starterMode: starterMode || 'random',
      status: 'waiting',
      startedAt: null,
      progress: {
        1: { wave: 0, status: 'waiting' },
        2: { wave: 0, status: 'waiting' },
      },
    };
    races.set(code, race);
    socket.join(`race:${code}`);
    socket.data.raceCode = code;
    socket.data.playerNumber = 1;

    console.log(`[Race] Created: ${code} by ${name}`);
    socket.emit('RACE_CREATED', { code });
    broadcastRaceState(race);
  });

  socket.on('JOIN_RACE', ({ code, name, avatar, twitchId }) => {
    const race = races.get(code?.toUpperCase());
    if (!race) {
      return socket.emit('RACE_ERROR', { message: 'Race nicht gefunden' });
    }
    if (race.guest) {
      return socket.emit('RACE_ERROR', { message: 'Race ist bereits voll' });
    }
    if (race.status !== 'waiting') {
      return socket.emit('RACE_ERROR', { message: 'Race hat bereits begonnen' });
    }

    // Leave any existing race first
    const existing = getRaceBySocket(socket.id);
    if (existing) {
      socket.leave(`race:${existing.race.code}`);
    }

    race.guest = { socketId: socket.id, name: name || 'Spieler 2', avatar: avatar || null, twitchId: twitchId || null, player: 2, ready: false };
    socket.join(`race:${race.code}`);
    socket.data.raceCode = race.code;
    socket.data.playerNumber = 2;

    console.log(`[Race] ${name} joined ${code}`);
    socket.emit('RACE_JOINED', { code: race.code, player: 2 });
    broadcastRaceState(race);
  });

  socket.on('START_RACE', ({ code }) => {
    const race = races.get(code);
    if (!race) return socket.emit('RACE_ERROR', { message: 'Race nicht gefunden' });
    if (race.host.socketId !== socket.id) return socket.emit('RACE_ERROR', { message: 'Nur der Host kann starten' });
    if (!race.guest) return socket.emit('RACE_ERROR', { message: 'Warte auf zweiten Spieler' });

    race.seed = generateSeed();
    race.status = 'starting';
    race.startedAt = Date.now();
    race.progress[1] = { wave: 0, status: 'loading' };
    race.progress[2] = { wave: 0, status: 'loading' };

    console.log(`[Race] Starting ${code} — seed: ${race.seed}, starter: ${race.starterMode}`);
    io.to(`race:${code}`).emit('RACE_STARTING', {
      seed: race.seed,
      starterMode: race.starterMode,
      startedAt: race.startedAt,
    });
  });

  socket.on('RACE_READY', ({ code }) => {
    const race = races.get(code);
    if (!race) return;

    const playerNum = socket.data.playerNumber;
    if (!playerNum) return;

    if (playerNum === 1 && race.host) race.host.ready = true;
    if (playerNum === 2 && race.guest) race.guest.ready = true;

    // Both ready → race is live
    if (race.host?.ready && race.guest?.ready) {
      race.status = 'racing';
      race.progress[1].status = 'playing';
      race.progress[2].status = 'playing';
      console.log(`[Race] ${code} is LIVE!`);
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
      });
    }
  });

  socket.on('RACE_PROGRESS', ({ code, wave, status }) => {
    const race = races.get(code);
    if (!race) return;

    const playerNum = socket.data.playerNumber;
    if (!playerNum || !race.progress[playerNum]) return;

    race.progress[playerNum] = { wave: wave || 0, status: status || 'playing' };

    if (status === 'defeated' || status === 'victory') {
      console.log(`[Race] ${code} P${playerNum}: ${status} at wave ${wave}`);
      // Check if race is over (both finished)
      const other = playerNum === 1 ? 2 : 1;
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
      races.delete(code);
      io.to(`race:${code}`).emit('RACE_ENDED', { reason: 'Host hat das Race verlassen' });
      console.log(`[Race] ${code} ended — host left`);
    } else if (race.guest?.socketId === socket.id) {
      race.guest = null;
      console.log(`[Race] Guest left ${code}`);
      broadcastRaceState(race);
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
          races.delete(race.code);
          io.to(`race:${race.code}`).emit('RACE_ENDED', { reason: 'Host disconnected' });
          console.log(`[Race] ${race.code} ended — host disconnected`);
        } else {
          race.guest = null;
          broadcastRaceState(race);
        }
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
          // Check if still disconnected (not rejoined)
          if (race.progress[playerNum]?.status === 'disconnected') {
            race.progress[playerNum].status = 'defeated';
            console.log(`[Race] ${race.code} P${playerNum} auto-forfeit (timeout)`);

            // Check if race is now over
            const other = playerNum === 1 ? 2 : 1;
            if (race.progress[other].status === 'defeated' || race.progress[other].status === 'victory') {
              race.status = 'finished';
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

    // Clean up WebRTC peers
    if (socket.data.rtc?.raceCode) {
      await broadcastWebRtcPeers(socket.data.rtc.raceCode);
    }
  });
});

// Clean up stale races periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [code, race] of races) {
    // Remove races older than 3 hours
    if (race.startedAt && now - race.startedAt > 3 * 60 * 60 * 1000) {
      races.delete(code);
      io.to(`race:${code}`).emit('RACE_ENDED', { reason: 'Race timeout' });
      console.log(`[Race] ${code} cleaned up (timeout)`);
    }
    // Remove waiting races older than 30 minutes
    if (race.status === 'waiting' && !race.startedAt) {
      // No startedAt for waiting races, use creation time approximation
      // We'll skip this check since we don't track creation time
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EmmelRogue] Server running on http://127.0.0.1:${PORT}`);
});
