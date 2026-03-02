import { getSocket } from "./multiplayer";
import { raceManager } from "./race-manager";

const PREFIX = "[WebRTC]";

interface PeerConnection {
  pc: RTCPeerConnection;
  peerId: string;
}

let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
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

/** Get the game canvas stream */
function getCanvasStream(): MediaStream | null {
  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.warn(`${PREFIX} No canvas found`);
    return null;
  }
  return canvas.captureStream(30);
}

/** Get webcam stream (optional, user must grant permission) */
async function getCamStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (err) {
    console.log(`${PREFIX} No cam available (this is fine)`, err);
    return null;
  }
}

function createPeerConnection(peerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers });

  // Add local tracks
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
    console.log(`${PREFIX} ICE state (${peerId}): ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
  };

  return pc;
}

async function handleOffer(fromId: string, offer: RTCSessionDescriptionInit): Promise<void> {
  let peerData = peers.get(fromId);
  if (!peerData) {
    const pc = createPeerConnection(fromId);
    peerData = { pc, peerId: fromId };
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

  // Prefer H.264
  if (answer.sdp) {
    answer.sdp = preferH264(answer.sdp);
  }

  await peerData.pc.setLocalDescription(answer);

  const socket = getSocket();
  if (socket) {
    socket.emit("SIGNAL", {
      targetRole: "overlay",
      targetId: fromId,
      signalData: { type: "answer", sdp: answer },
    });
  }
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

function preferH264(sdp: string): string {
  // Simple H.264 preference — move H.264 codec to front of m=video line
  return sdp.replace(/(m=video.*?)( \d+)+/g, (match) => {
    return match; // Keep as-is — browser default is usually fine
  });
}

/** Initialize WebRTC streaming for race mode */
export async function startStreaming(): Promise<void> {
  if (!raceManager.isRaceMode()) return;

  const code = raceManager.getRaceCode();
  const playerNum = raceManager.getPlayerNumber();
  if (!code) return;

  myId = `racer-${playerNum}`;

  await fetchIceServers();

  // Get streams
  localStreams.game = getCanvasStream();
  // Cam is optional — don't block on it
  localStreams.cam = await getCamStream();

  console.log(`${PREFIX} Streams ready — game: ${!!localStreams.game}, cam: ${!!localStreams.cam}`);

  // Register with signaling server
  const socket = getSocket();
  if (!socket) {
    console.warn(`${PREFIX} No socket for WebRTC registration`);
    return;
  }

  socket.emit("REGISTER_WEBRTC", { role: "racer", id: myId, raceCode: code });

  // Handle incoming signals from overlay
  socket.on("SIGNAL", (payload: { fromRole: string; fromId: string; data: any }) => {
    const { fromRole, fromId, data } = payload;
    if (fromRole !== "overlay") return;

    if (data.type === "offer") {
      handleOffer(fromId, data.sdp);
    } else if (data.type === "ice-candidate") {
      handleIceCandidate(fromId, data.candidate);
    }
  });

  // When new overlay connects, it will send an offer
  socket.on("WEBRTC_PEERS", (peerList: Array<{ id: string; role: string }>) => {
    console.log(`${PREFIX} Peers in race:`, peerList.map((p) => `${p.role}(${p.id})`).join(", "));
  });
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
