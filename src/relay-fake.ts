import { Room, type RoomSocket } from "../relay/pocket/src/room.js";

/**
 * A relay for the tests: the real room logic (relay/pocket/src/room.js), the
 * code Cloudflare runs, with in-memory sockets in place of the Worker and
 * its Durable Objects. Frames are delivered asynchronously and in order, as
 * a WebSocket would. The server never imports this file.
 *
 * `tamper` stands the relay operator in the path: it sees every frame the
 * room hands to a client and may change, drop, duplicate or reorder it — the
 * same power a hostile relay has over the opaque `d` it forwards.
 * `reroute` sends a connection for one room to another room.
 */

type Who = "claw" | "phone";
export type Tamper = (frame: string, to: Who, url: string) => string | string[] | null;

export class FakeSocket {
  readyState = 0;
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  /** Every frame this client sent, as sent. */
  sent: string[] = [];
  /** Every frame this client received, as received. */
  got: string[] = [];
  server!: RoomSocket & { client: FakeSocket };
  constructor(public url: string, private net: FakeRelayNet, public who: Who) {}
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
    this.net.toServer(this, data);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.net.clientClosed(this, code, reason);
  }
}

export class FakeRelayNet {
  rooms = new Map<string, { room: Room; socks: Set<RoomSocket & { client: FakeSocket }> }>();
  tamper: Tamper | null = null;
  reroute: ((room: string) => string) | null = null;
  /** URLs that fail to connect, as an undeployed relay does. */
  down = false;
  sockets: FakeSocket[] = [];
  private queue: Promise<void> = Promise.resolve();
  constructor(public now: () => number = Date.now) {}

  /** A `connect(url)` for one side: the claw's transport or the phone's link. */
  connector(who: Who) {
    return (url: string) => this.open(url, who);
  }

  private later(fn: () => void | Promise<void>): void {
    // One queue for the whole network keeps every socket's frames in order.
    this.queue = this.queue.then(() => new Promise<void>((r) => setImmediate(r))).then(fn).catch(() => {});
  }

  /** Resolves once everything sent so far has been delivered and handled. */
  async settle(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await this.queue;
      await new Promise((r) => setImmediate(r));
    }
  }

  open(url: string, who: Who): FakeSocket {
    const client = new FakeSocket(url, this, who);
    this.sockets.push(client);
    const m = /\/v1\/room\/([A-Za-z0-9_-]{43})$/.exec(url);
    this.later(async () => {
      if (this.down || !m) {
        client.readyState = 3;
        client.onerror?.({});
        client.onclose?.({ code: 1006, reason: "" });
        return;
      }
      const id = this.reroute ? this.reroute(m[1]) : m[1];
      let r = this.rooms.get(id);
      if (!r) {
        const socks = new Set<RoomSocket & { client: FakeSocket }>();
        r = { room: new Room({ roomId: id, sockets: () => [...socks], now: this.now }), socks };
        this.rooms.set(id, r);
      }
      const entry = r;
      let att: unknown = null;
      const server = {
        client,
        send: (text: string) => this.toClient(client, text),
        close: (code?: number, reason?: string) => {
          entry.socks.delete(server);
          this.later(() => {
            if (client.readyState === 3) return;
            client.readyState = 3;
            client.onclose?.({ code, reason });
          });
        },
        get att() { return att; },
        set att(v) { att = v; },
      };
      client.server = server;
      entry.socks.add(server);
      entry.room.accept(server);
      if (!entry.socks.has(server)) return; // refused on arrival
      client.readyState = 1;
      client.onopen?.({});
    });
    return client;
  }

  roomOf(client: FakeSocket) {
    for (const r of this.rooms.values()) if (r.socks.has(client.server)) return r.room;
    return null;
  }

  toServer(client: FakeSocket, data: string): void {
    this.later(async () => {
      const room = this.roomOf(client);
      if (room) await room.message(client.server, data);
    });
  }

  toClient(client: FakeSocket, text: string): void {
    let frames: string[] = [text];
    if (this.tamper) {
      const t = this.tamper(text, client.who, client.url);
      frames = t === null ? [] : Array.isArray(t) ? t : [t];
    }
    for (const f of frames) {
      this.later(() => {
        if (client.readyState !== 1) return;
        client.got.push(f);
        client.onmessage?.({ data: f });
      });
    }
  }

  clientClosed(client: FakeSocket, code: number, reason: string): void {
    this.later(() => {
      const room = this.roomOf(client);
      if (room && client.server) {
        for (const r of this.rooms.values()) r.socks.delete(client.server);
        room.closed(client.server);
      }
      client.readyState = 3;
      client.onclose?.({ code, reason });
    });
  }
}
