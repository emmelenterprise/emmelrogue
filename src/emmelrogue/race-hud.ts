import { raceManager } from "./race-manager";

const PREFIX = "[RaceHUD]";

let timerInterval: ReturnType<typeof setInterval> | null = null;
let progressInterval: ReturnType<typeof setInterval> | null = null;

// DOM elements (cached after init)
let hudEl: HTMLElement | null = null;
let timerEl: HTMLElement | null = null;
let waveEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let gameVideoEl: HTMLVideoElement | null = null;
let camVideoEl: HTMLVideoElement | null = null;
let myCamVideoEl: HTMLVideoElement | null = null;
let myCamWrapper: HTMLElement | null = null;
let opponentEl: HTMLElement | null = null;

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateTimer(): void {
  if (!timerEl) return;
  const startedAt = raceManager.getStartedAt();
  if (!startedAt) {
    timerEl.textContent = "00:00";
    return;
  }
  const elapsed = Date.now() - startedAt;
  timerEl.textContent = formatTime(elapsed);
}

function updateOpponentProgress(): void {
  if (!waveEl || !statusEl) return;
  const progress = raceManager.getOpponentProgress();
  waveEl.textContent = `Wave ${progress.wave}`;

  if (progress.status === "defeated") {
    statusEl.textContent = "DEFEATED";
    statusEl.className = "defeated";
  } else if (progress.status === "victory") {
    statusEl.textContent = "VICTORY";
    statusEl.className = "victory";
  } else {
    statusEl.textContent = "";
    statusEl.className = "";
  }
}

/** Show the race HUD and start timers */
export function initRaceHud(): void {
  if (!raceManager.isRaceMode()) return;

  hudEl = document.getElementById("race-hud");
  timerEl = document.getElementById("race-hud-timer");
  waveEl = document.getElementById("race-hud-wave");
  statusEl = document.getElementById("race-hud-status");
  gameVideoEl = document.getElementById("race-hud-game") as HTMLVideoElement | null;
  camVideoEl = document.getElementById("race-hud-cam") as HTMLVideoElement | null;
  myCamVideoEl = document.getElementById("race-hud-my-cam") as HTMLVideoElement | null;
  myCamWrapper = document.getElementById("race-hud-my-cam-wrapper");
  opponentEl = document.getElementById("race-hud-opponent");

  if (!hudEl) {
    console.warn(`${PREFIX} HUD elements not found in DOM`);
    return;
  }

  // Show HUD
  hudEl.style.display = "flex";

  // Show "waiting for opponent" state initially
  if (opponentEl) {
    opponentEl.classList.add("no-stream");
  }

  // Start timer updates
  timerInterval = setInterval(updateTimer, 1000);
  // Start opponent progress polling
  progressInterval = setInterval(updateOpponentProgress, 500);

  console.log(`${PREFIX} HUD initialized`);
}

/** Assign a received opponent track to the appropriate video element */
export function assignOpponentTrack(track: MediaStreamTrack, streams: readonly MediaStream[]): void {
  if (!gameVideoEl || !camVideoEl) return;

  const stream = streams[0];
  if (!stream) return;

  // First video track goes to game, second to cam
  // We check if game video already has a srcObject with active tracks
  if (!gameVideoEl.srcObject || !(gameVideoEl.srcObject as MediaStream).getVideoTracks().length) {
    console.log(`${PREFIX} Assigning track to opponent game video (stream ${stream.id})`);
    gameVideoEl.srcObject = stream;
    // Remove "waiting" state
    if (opponentEl) {
      opponentEl.classList.remove("no-stream");
    }
  } else if (!camVideoEl.srcObject || !(camVideoEl.srcObject as MediaStream).getVideoTracks().length) {
    console.log(`${PREFIX} Assigning track to opponent cam video (stream ${stream.id})`);
    camVideoEl.srcObject = stream;
  } else {
    console.log(`${PREFIX} Extra track received, ignoring (stream ${stream.id})`);
  }
}

/** Set the local camera stream on the "my cam" video element */
export function setLocalCamStream(stream: MediaStream | null): void {
  if (!myCamVideoEl || !myCamWrapper) return;

  if (stream) {
    myCamVideoEl.srcObject = stream;
    myCamWrapper.style.display = "";
    console.log(`${PREFIX} Local cam assigned`);
  } else {
    myCamWrapper.style.display = "none";
  }
}

/** Mark race as finished (show gold border etc.) */
export function setRaceFinished(): void {
  if (hudEl) {
    hudEl.classList.add("finished");
  }
}

/** Clean up intervals */
export function destroyRaceHud(): void {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  if (hudEl) {
    hudEl.style.display = "none";
  }
}
