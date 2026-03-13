import { getSocket } from "./multiplayer";
import { raceManager } from "./race-manager";
import { assignOpponentTrack, setLocalCamStream } from "./race-hud";

const PREFIX = "[WebRTC]";

// Embedded mode: game runs inside overlay iframe, overlay handles opponent display.
// In this mode, racer-to-racer connections are unnecessary (overlay receives opponent stream).
const isEmbedded = new URLSearchParams(window.location.search).get("embedded") === "1";

// Performance quality: per-player setting (high/medium/low)
const perfQuality = new URLSearchParams(window.location.search).get("perf") || "medium";
const PERF_SETTINGS = {
  high:   { canvasFps: 20, gameBitrate: 2_500_000, gameMaxFps: 20, camBitrate: 800_000 },
  medium: { canvasFps: 12, gameBitrate: 1_500_000, gameMaxFps: 12, camBitrate: 500_000 },
  low:    { canvasFps: 8, gameBitrate: 800_000, gameMaxFps: 8, camBitrate: 300_000 },
};
const perf = PERF_SETTINGS[perfQuality as keyof typeof PERF_SETTINGS] || PERF_SETTINGS.medium;

interface PeerConnection {
  pc: RTCPeerConnection;
  peerId: string;
  targetRole: string; // "overlay" or "racer"
}

let iceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
let localStreams: { cam: MediaStream | null; game: MediaStream | null } = { cam: null, game: null };
let peers: Map<string, PeerConnection> = new Map();
let myId: string = "";
let iceCandidateBuffer: Map<string, RTCIceCandidateInit[]> = new Map();

/** Fetch TURN credentials from server */
async function fetchIceServers(): Promise<void> {
  try {
    const res = await fetch("/api/turn-credentials");
    const data = await res.json();
    if (data.iceServers) {
      iceServers = data.iceServers;
      console.log(`${PREFIX} ICE servers loaded (${iceServers.length})`);
    }
  } catch (err) {
    console.warn(`${PREFIX} Failed to fetch TURN credentials, using STUN only`, err);
  }
}

/** Get the game canvas stream — lower FPS to reduce CPU load */
function getCanvasStream(): MediaStream | null {
  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.warn(`${PREFIX} No canvas found`);
    return null;
  }
  console.log(`${PREFIX} Canvas capture at ${perf.canvasFps}fps (quality: ${perfQuality})`);
  return canvas.captureStream(perf.canvasFps);
}

/** Get webcam stream — optimized resolution for overlay cam slot */
async function getCamStream(): Promise<MediaStream | null> {
  if (!raceManager.getCameraEnabled()) {
    console.log(`${PREFIX} Camera disabled by user in Race-Menu`);
    return null;
  }

  try {
    const constraints: MediaStreamConstraints = {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24 },
      } as MediaTrackConstraints,
      audio: false,
    };
    const deviceId = raceManager.getCameraDeviceId();
    if (deviceId) {
      (constraints.video as MediaTrackConstraints).deviceId = { exact: deviceId };
    }
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.log(`${PREFIX} No cam available (this is fine)`, err);
    return null;
  }
}

/** Prefer H.264 codec — hardware-accelerated on virtually all devices (Intel QSV, NVENC, AMD VCN, Apple).
 *  VP8/VP9 is CPU-only encoding which is massively more expensive. */
function preferH264(pc: RTCPeerConnection): void {
  if (typeof RTCRtpReceiver?.getCapabilities !== "function") return;
  const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs;
  if (!codecs) return;
  const h264 = codecs.filter((c: RTCRtpCodecCapability) => c.mimeType === "video/H264");
  const others = codecs.filter((c: RTCRtpCodecCapability) => c.mimeType !== "video/H264");
  if (!h264.length) return;
  for (const t of pc.getTransceivers()) {
    if (t.sender.track?.kind === "video" || t.receiver.track?.kind === "video") {
      try { t.setCodecPreferences([...h264, ...others]); } catch { /* browser doesn't support */ }
    }
  }
}

/** Apply bandwidth limits to reduce CPU/GPU and network usage */
async function applyBandwidthLimits(pc: RTCPeerConnection): Promise<void> {
  const senders = pc.getSenders();
  for (const sender of senders) {
    if (sender.track?.kind !== "video") continue;

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }

    // Determine if this is the game stream or cam stream based on track label
    const isGameTrack = sender.track.label?.includes("canvas") || !sender.track.label?.includes("Camera");
    if (isGameTrack) {
      params.encodings[0].maxBitrate = perf.gameBitrate;
      params.encodings[0].maxFramerate = perf.gameMaxFps;
    } else {
      params.encodings[0].maxBitrate = perf.camBitrate;
      params.encodings[0].maxFramerate = 24;
    }

    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn(`${PREFIX} Failed to set bandwidth limit:`, err);
    }
  }
}

/** Create a peer connection for sending to overlay (send-only, existing behavior) */
function createOverlayPeerConnection(peerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });

  // Add local tracks (send-only to overlay)
  if (localStreams.game) {
    for (const track of localStreams.game.getTracks()) {
      pc.addTrack(track, localStreams.game);
    }
  }
  if (localStreams.cam) {
    for (const track of localStreams.cam.getTracks()) {
      pc.addTrack(track, localStreams.cam);
    }
  }

  preferH264(pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const socket = getSocket();
      if (socket) {
        socket.emit("SIGNAL", {
          targetRole: "overlay",
          targetId: peerId,
          signalData: { type: "ice-candidate", candidate: event.candidate },
        });
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`${PREFIX} ICE state overlay(${peerId}): ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
  };

  return pc;
}

/** Create a peer connection for racer-to-racer (bidirectional: send game+cam, receive opponent's) */
function createRacerPeerConnection(peerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });

  // Add local tracks (send our game+cam to opponent)
  if (localStreams.game) {
    for (const track of localStreams.game.getTracks()) {
      pc.addTrack(track, localStreams.game);
    }
  }
  if (localStreams.cam) {
    for (const track of localStreams.cam.getTracks()) {
      pc.addTrack(track, localStreams.cam);
    }
  }

  // Receive opponent's tracks
  pc.ontrack = (event) => {
    console.log(`${PREFIX} Received track from ${peerId}: kind=${event.track.kind} stream=${event.streams[0]?.id}`);
    assignOpponentTrack(event.track, event.streams);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const socket = getSocket();
      if (socket) {
        socket.emit("SIGNAL", {
          targetRole: "racer",
          targetId: peerId,
          signalData: { type: "ice-candidate", candidate: event.candidate },
        });
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`${PREFIX} ICE state racer(${peerId}): ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
  };

  return pc;
}

/** Handle an offer from overlay (send-only response) */
async function handleOverlayOffer(fromId: string, offer: RTCSessionDescriptionInit): Promise<void> {
  let peerData = peers.get(fromId);
  if (!peerData) {
    const pc = createOverlayPeerConnection(fromId);
    peerData = { pc, peerId: fromId, targetRole: "overlay" };
    peers.set(fromId, peerData);
  }

  await peerData.pc.setRemoteDescription(offer);

  // Flush buffered ICE candidates
  const buffered = iceCandidateBuffer.get(fromId) || [];
  for (const candidate of buffered) {
    await peerData.pc.addIceCandidate(candidate);
  }
  iceCandidateBuffer.delete(fromId);

  const answer = await peerData.pc.createAnswer();
  await peerData.pc.setLocalDescription(answer);

  // Apply bandwidth limits after connection is established
  await applyBandwidthLimits(peerData.pc);

  const socket = getSocket();
  if (socket) {
    socket.emit("SIGNAL", {
      targetRole: "overlay",
      targetId: fromId,
      signalData: { type: "answer", sdp: answer },
    });
  }
}

/** Handle an offer from another racer (bidirectional) */
async function handleRacerOffer(fromId: string, offer: RTCSessionDescriptionInit): Promise<void> {
  let peerData = peers.get(fromId);
  if (!peerData) {
    const pc = createRacerPeerConnection(fromId);
    peerData = { pc, peerId: fromId, targetRole: "racer" };
    peers.set(fromId, peerData);
  }

  await peerData.pc.setRemoteDescription(offer);

  // Flush buffered ICE candidates
  const buffered = iceCandidateBuffer.get(fromId) || [];
  for (const candidate of buffered) {
    await peerData.pc.addIceCandidate(candidate);
  }
  iceCandidateBuffer.delete(fromId);

  const answer = await peerData.pc.createAnswer();
  await peerData.pc.setLocalDescription(answer);

  await applyBandwidthLimits(peerData.pc);

  const socket = getSocket();
  if (socket) {
    socket.emit("SIGNAL", {
      targetRole: "racer",
      targetId: fromId,
      signalData: { type: "answer", sdp: answer },
    });
  }
}

/** Handle an answer (from overlay or racer) */
async function handleAnswer(fromId: string, answer: RTCSessionDescriptionInit): Promise<void> {
  const peerData = peers.get(fromId);
  if (!peerData) {
    console.warn(`${PREFIX} Answer from unknown peer ${fromId}`);
    return;
  }
  await peerData.pc.setRemoteDescription(answer);

  // Flush buffered ICE candidates
  const buffered = iceCandidateBuffer.get(fromId) || [];
  for (const candidate of buffered) {
    await peerData.pc.addIceCandidate(candidate);
  }
  iceCandidateBuffer.delete(fromId);

  // Apply bandwidth limits after connection is fully established
  await applyBandwidthLimits(peerData.pc);
}

function handleIceCandidate(fromId: string, candidate: RTCIceCandidateInit): void {
  const peerData = peers.get(fromId);
  if (peerData && peerData.pc.remoteDescription) {
    peerData.pc.addIceCandidate(candidate);
  } else {
    // Buffer until remote description is set
    if (!iceCandidateBuffer.has(fromId)) iceCandidateBuffer.set(fromId, []);
    iceCandidateBuffer.get(fromId)!.push(candidate);
  }
}

/** Initiate a WebRTC connection to the other racer (we create the offer) */
async function connectToRacer(peerId: string): Promise<void> {
  if (peers.has(peerId)) return; // Already connected

  console.log(`${PREFIX} Creating offer to racer ${peerId}`);
  const pc = createRacerPeerConnection(peerId);
  peers.set(peerId, { pc, peerId, targetRole: "racer" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const socket = getSocket();
  if (socket) {
    socket.emit("SIGNAL", {
      targetRole: "racer",
      targetId: peerId,
      signalData: { type: "offer", sdp: offer },
    });
  }
}

/** Initialize WebRTC streaming for race mode */
export async function startStreaming(): Promise<void> {
  if (!raceManager.isRaceMode()) return;

  // In embedded mode (game runs as iframe inside overlay), skip WebRTC.
  // Player uses OBS screen capture of their browser — better quality, less CPU.
  // WebRTC quality fix for OBS browser source is a separate TODO.
  if (isEmbedded) {
    console.log(`${PREFIX} Embedded mode — WebRTC disabled (screen capture preferred)`);
    return;
  }

  const code = raceManager.getRaceCode();
  const playerNum = raceManager.getPlayerNumber();
  if (!code) return;

  myId = `racer-${playerNum}`;

  await fetchIceServers();

  localStreams.game = getCanvasStream();
  localStreams.cam = await getCamStream();

  console.log(`${PREFIX} Streams ready — game: ${!!localStreams.game}, cam: ${!!localStreams.cam}`);

  // Show local cam in HUD
  setLocalCamStream(localStreams.cam);

  // Register with signaling server
  const socket = getSocket();
  if (!socket) {
    console.warn(`${PREFIX} No socket for WebRTC registration`);
    return;
  }

  socket.emit("REGISTER_WEBRTC", { role: "racer", id: myId, raceCode: code });

  // Handle incoming signals from overlay AND other racers
  socket.on("SIGNAL", (payload: { fromRole: string; fromId: string; data: any }) => {
    const { fromRole, fromId, data } = payload;

    if (fromRole === "overlay") {
      // Overlay sends offers, we respond (send-only)
      if (data.type === "offer") {
        handleOverlayOffer(fromId, data.sdp);
      } else if (data.type === "ice-candidate") {
        handleIceCandidate(fromId, data.candidate);
      }
    } else if (fromRole === "racer" && !isEmbedded) {
      // Other racer: bidirectional connection (only when NOT embedded —
      // in embedded mode the overlay handles receiving opponent streams)
      if (data.type === "offer") {
        handleRacerOffer(fromId, data.sdp);
      } else if (data.type === "answer") {
        handleAnswer(fromId, data.sdp);
      } else if (data.type === "ice-candidate") {
        handleIceCandidate(fromId, data.candidate);
      }
    }
  });

  // When peer list updates, check if we should initiate connection to other racer
  // In embedded mode, skip racer-to-racer — overlay handles opponent display
  socket.on("WEBRTC_PEERS", (peerList: Array<{ id: string; role: string }>) => {
    console.log(`${PREFIX} Peers in race:`, peerList.map((p) => `${p.role}(${p.id})`).join(", "));

    if (isEmbedded) {
      console.log(`${PREFIX} Embedded mode — skipping racer-to-racer connections`);
      return;
    }

    // Find the other racer
    for (const peer of peerList) {
      if (peer.role === "racer" && peer.id !== myId) {
        // Only the lower-numbered racer creates the offer
        if (myId < peer.id) {
          connectToRacer(peer.id);
        }
      }
    }
  });

  // Stale peer cleanup every 30s — close failed/closed connections
  setInterval(() => {
    for (const [key, peerData] of peers) {
      const s = peerData.pc.connectionState || peerData.pc.iceConnectionState;
      if (s === "failed" || s === "closed") {
        console.log(`${PREFIX} Cleaning up stale peer: ${key} (${s})`);
        peerData.pc.close();
        peers.delete(key);
      }
    }
  }, 30_000);
}

/** Stop all streams and close connections */
export function stopStreaming(): void {
  for (const [, peerData] of peers) {
    peerData.pc.close();
  }
  peers.clear();
  iceCandidateBuffer.clear();

  if (localStreams.cam) {
    localStreams.cam.getTracks().forEach((t) => t.stop());
    localStreams.cam = null;
  }
  // Don't stop game stream — it's the canvas
  localStreams.game = null;
}
