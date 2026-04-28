export type ServerConnectionState =
  | { type: "unavailable" }
  | { type: "connecting" }
  | { type: "connected" }
  | { type: "retrying"; delayMs: number; message: string }
  | { type: "locked" };
