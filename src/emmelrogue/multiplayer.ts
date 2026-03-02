import { io, type Socket } from "socket.io-client";
import { raceManager } from "./race-manager";

const PREFIX = "[EmmelRogue]";

let socket: Socket | null = null;

export function connect(): void {
  if (socket?.connected) {
    return;
  }

  // Relative URL — works with both dev server and production proxy
  socket = io({
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  });

  socket.on("connect", () => {
    console.log(`${PREFIX} Connected to server (id: ${socket!.id})`);
    socket!.emit("PING");

    // Initialize race mode after socket connects
    raceManager.init();
  });

  socket.io.on("reconnect", () => {
    console.log(`${PREFIX} Reconnected to server`);
    raceManager.handleReconnect();
  });

  socket.on("PONG", (data: { timestamp: number }) => {
    const latency = Date.now() - data.timestamp;
    console.log(`${PREFIX} Server latency: ${latency}ms`);
  });

  socket.on("disconnect", (reason: string) => {
    console.log(`${PREFIX} Disconnected: ${reason}`);
  });

  socket.on("connect_error", (err: Error) => {
    console.warn(`${PREFIX} Connection error: ${err.message}`);
  });
}

export function disconnect(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    console.log(`${PREFIX} Disconnected manually`);
  }
}

export function isConnected(): boolean {
  return socket?.connected ?? false;
}

export function getSocket(): Socket | null {
  return socket;
}
