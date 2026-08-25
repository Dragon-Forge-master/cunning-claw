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

export function startTelegram(events: AgentEvents, hooks: { resolveApproval: ResolveApproval }): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allow = process.env.TELEGRAM_CHAT_ID;
  if (!token) return;
  if (!allow) {
    console.warn("  ⚠ TELEGRAM_BOT_TOKEN set but TELEGRAM_CHAT_ID missing — ignoring Telegram (safety).");
    console.warn("    Message the bot /whoami from your phone, then put that chat id in .env.");
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
        await handleMessage(upd.message, events);
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
