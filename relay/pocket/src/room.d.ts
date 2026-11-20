// Types for room.js, so the claw's TypeScript tests can drive the relay's own code.

export declare const LIMITS: Readonly<{
  maxFrame: number;
  maxPhones: number;
  maxPending: number;
  helloMs: number;
  maxAllow: number;
  maxTickets: number;
  maxTicketSeconds: number;
  phoneFramesPerMinute: number;
  phoneBytesPerMinute: number;
  failures: number;
  failureWindowMs: number;
}>;

export declare const CLOSE: Readonly<Record<"bad" | "denied" | "kicked" | "offline" | "slow" | "replaced" | "clawMoved" | "tooMuch", number>>;

export declare function roomIdFor(secretBytes: Uint8Array): Promise<string>;
export declare function relayHash(value: string): Promise<string>;

export interface RoomSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  att: any;
}

export declare class Room {
  constructor(opts: { roomId: string; sockets: () => RoomSocket[]; now?: () => number; limits?: typeof LIMITS });
  roomId: string;
  accept(sock: RoomSocket): void;
  message(sock: RoomSocket, data: unknown): Promise<void>;
  closed(sock: RoomSocket): void;
}
