import { config } from "./config.js";
import type { AgentEvents } from "./agent.js";
import { runTurn } from "./agent.js";
import { systemStatusText } from "./tools.js";
import { applyBrainCommand, catalogStatus, formatCatalog } from "./brain.js";

const API = "https://api.telegram.org";

type ResolveApproval = (id: string, approved: boolean) => boolean;

let botToken: string | null = null;
let allowed = new Set<string>();
let resolveApproval: ResolveApproval | null = null;
const approvalMsgs = new Map<string, { chatId: string; messageId: number }>();

export function parseChatAllowlist(raw: string): Set<string> {
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export function telegramStatus() {
  return {
    enabled: Boolean(botToken && allowed.size),
    chats: [...allowed],
  };
}

async function api(token: string, method: string, body?: unknown) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  if (!json.ok) throw new Error(json.description || method);
  return json.result;
}

async function send(chatId: string, text: string, extra?: Record<string, unknown>): Promise<any> {
  if (!botToken) return null;
  return api(botToken, "sendMessage", {
    chat_id: Number(chatId) || chatId,
    text: text.slice(0, 3900),
    ...extra,
  });
}

/** Push a card to every allowlisted chat so the phone can authorise HUD-less turns. */
export async function sendApprovalCard(id: string, summary: string, detail: string): Promise<void> {
  if (!botToken || !allowed.size) return;
  const text = `⚠ APPROVAL REQUIRED\n${summary}\n\n${detail.slice(0, 2800)}`;
  for (const chatId of allowed) {
    try {
      const msg = await send(chatId, text, {
        reply_markup: {
          inline_keyboard: [[
            { text: "EXECUTE", callback_data: `yes:${id}` },
            { text: "DENY", callback_data: `no:${id}` },
          ]],
        },
      });
      if (msg?.message_id) {
        approvalMsgs.set(id, { chatId, messageId: msg.message_id });
      }
    } catch (err: any) {
      console.error("  Telegram approval send failed:", err?.message ?? err);
    }
  }
}

/** Strip buttons once HUD or Telegram settles the request. */
export function approvalSettled(id: string, approved: boolean): void {
  const ref = approvalMsgs.get(id);
  approvalMsgs.delete(id);
  if (!ref || !botToken) return;
  void api(botToken, "editMessageReplyMarkup", {
    chat_id: Number(ref.chatId) || ref.chatId,
    message_id: ref.messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => { /* message may already be gone */ });
  void send(ref.chatId, approved ? "Authorised." : "Denied.");
}

/**
 * Setup-mode listener: replies to every message with the sender's chat id and
 * nothing else. It carries no tools, reads no instructions, and dies the
 * moment the real loop can start (after .env gains the id and a restart).
 */
async function bootstrapWhoamiLoop(token: string): Promise<void> {
  let offset = 0;
  for (;;) {
    try {
      const updates = (await api(token, "getUpdates", {
        timeout: 50,
        offset,
        allowed_updates: ["message"],
      })) as any[];
      for (const u of updates) {
        offset = u.update_id + 1;
        const chatId = u.message?.chat?.id;
        if (!chatId) continue;
        await api(token, "sendMessage", {
          chat_id: chatId,
          text:
            `Your chat id is: ${chatId}\n\n` +
            `Ask the operator to put TELEGRAM_CHAT_ID=${chatId} in .env and restart Cunning Claw. ` +
            `Until then I take no instructions here.`,
        }).catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function startTelegram(events: AgentEvents, hooks: { resolveApproval: ResolveApproval }): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allow = process.env.TELEGRAM_CHAT_ID;
  if (!token) return;
  if (!allow) {
    // The old behaviour was a chicken-and-egg: no chat id -> no polling at
    // all -> the advertised /whoami could never be answered. Now a bootstrap
    // listener runs that does exactly one thing: tell whoever messages the
    // bot what their chat id is, so it can be put in .env. No instruction of
    // any kind is processed until the allowlist exists.
    console.warn("  ⚠ TELEGRAM_BOT_TOKEN set but TELEGRAM_CHAT_ID missing — commands disabled (safety).");
    console.warn("    Message the bot anything from your phone; it replies with the chat id for .env.");
    void bootstrapWhoamiLoop(token);
    return;
  }
  botToken = token;
  allowed = parseChatAllowlist(allow);
  resolveApproval = hooks.resolveApproval;
  console.log(`  Telegram: polling (allow ${[...allowed].join(", ")})`);
  void send([...allowed][0], `CUNNING CLAW online. HUD at http://${config.server.host}:${config.server.port}`).catch(() => {});
  void loop(events);
}

async function loop(events: AgentEvents): Promise<void> {
  let offset = 0;
  while (true) {
    try {
      const updates = await api(botToken!, "getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const upd of updates as any[]) {
        offset = upd.update_id + 1;
        if (upd.callback_query) {
          await handleCallback(upd.callback_query);
          continue;
        }
        // Do NOT await the turn inside the poll loop. A turn that parks on an
        // approval is released only by a callback_query (the EXECUTE button) —
        // which this same loop must stay free to fetch. Awaiting handleMessage
        // froze getUpdates until the approval timed out, so the button press
        // never arrived and every Telegram approval silently expired. Run the
        // turn alongside the poll; runTurn's own `busy` guard serialises them.
        void handleMessage(upd.message, events).catch((err) =>
          console.error("  Telegram message handler error:", err?.message ?? err),
        );
      }
    } catch (err: any) {
      console.error("  Telegram poll error:", err?.message ?? err);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

async function handleCallback(cb: any): Promise<void> {
  const data = String(cb.data ?? "");
  const chatId = String(cb.message?.chat?.id ?? "");
  try {
    await api(botToken!, "answerCallbackQuery", { callback_query_id: cb.id });
  } catch { /* already answered */ }
  const m = /^(yes|no):(.+)$/.exec(data);
  if (!m || !allowed.has(chatId)) return;
  const approved = m[1] === "yes";
  const id = m[2];
  if (!resolveApproval?.(id, approved)) {
    await send(chatId, "That request has already been settled, sir.");
  }
}

async function handleMessage(msg: any, events: AgentEvents): Promise<void> {
  const chatId = String(msg?.chat?.id ?? "");
  const text = String(msg?.text ?? "").trim();
  if (!chatId || !text) return;

  // /whoami works from unknown chats so the operator can learn their id.
  if (text === "/whoami" || (text === "/start" && !allowed.has(chatId))) {
    await send(chatId, `Your Telegram chat id is ${chatId}. Put it in TELEGRAM_CHAT_ID and restart CUNNING CLAW.`);
    return;
  }

  if (!allowed.has(chatId)) {
    console.warn(`  Telegram ignored chat ${chatId} (not in TELEGRAM_CHAT_ID)`);
    return;
  }

  if (text === "/start" || text === "/help") {
    await send(
      chatId,
      "Dragon Forge CUNNING CLAW.\n" +
        "/help — this\n" +
        "/status — machine + brains\n" +
        "/brain — list / pin a model (same tools)\n" +
        "/whoami — this chat id\n\n" +
        "Anything else is a turn. Risky tools still need EXECUTE on this chat or the HUD.",
    );
    return;
  }

  if (text === "/status") {
    const body = await systemStatusText();
    const brains = catalogStatus();
    const a = brains.active;
    await send(
      chatId,
      `Brain: ${a.id} / ${a.model} (${a.source}${a.ready ? "" : ", NO KEY"})\n` +
        `${formatCatalog()}\n\n${body}`,
    );
    return;
  }

  const brainReply = applyBrainCommand(text);
  if (brainReply !== null) {
    await send(chatId, brainReply);
    return;
  }

  const reply = await runTurn(text, events, { kind: "user" });
  if (reply === null) {
    await send(chatId, "Still working on the previous request, sir.");
    return;
  }
  if (reply.trim() && reply.trim() !== "HEARTBEAT_OK") {
    await send(chatId, reply);
  }
}
