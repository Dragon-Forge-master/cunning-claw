import assert from "node:assert/strict";
import test from "node:test";
import { agentFromTitle, agentInTree, answersPrompt, bypassFlag, clearPending, leavesInstructionPending, notePending, relayCard, takePending, type Proc } from "./agent-prompt.js";
import { executeTool, setKeyboardForTests, toolDefinitions, type ToolContext } from "./tools.js";
import { clearTaskGrant, grantForTask } from "./consequence.js";

// Field report, 24 November 2026: the claw drove Claude Code in a terminal,
// and when it stopped at a permission prompt the claw typed "1" and Return
// itself, under an earlier "Allow for this task". These hold the rule that
// replaced it: instructions may be typed, answers go to the operator.

test("a terminal running Claude Code is found by its title or by what runs under it", () => {
  assert.equal(agentFromTitle("Claude Code"), "Claude Code");
  assert.equal(agentFromTitle("✳ Port Estimatic"), "Claude Code", "Claude Code titles the terminal with the task behind a ✳");
  assert.equal(agentFromTitle("⠂ Port Estimatic"), "Claude Code", "or a braille spinner while it works");
  assert.equal(agentFromTitle("codex — ~/projects"), "Codex");
  assert.equal(agentFromTitle("Terminal"), null);
  assert.equal(agentFromTitle("Ask Claude about this — Chrome"), null, "a page that mentions Claude is not the agent");
  assert.equal(agentFromTitle(null), null);

  const procs: Proc[] = [
    { pid: 10, ppid: 1, comm: "gnome-terminal-", argv: ["/usr/libexec/gnome-terminal-server"] },
    { pid: 11, ppid: 10, comm: "bash", argv: ["bash"] },
    { pid: 12, ppid: 11, comm: "node", argv: ["node", "/home/u/.npm-global/bin/claude"] },
    { pid: 20, ppid: 1, comm: "bash", argv: ["bash"] },
  ];
  assert.equal(agentInTree(10, procs), "Claude Code", "a node CLI shows its script's name");
  assert.equal(agentInTree(20, procs), null);
  assert.equal(agentInTree(10, [{ pid: 30, ppid: 10, comm: "codex", argv: ["codex"] }]), "Codex");
});

test("short replies and option keys answer a prompt; instructions and stopping do not", () => {
  for (const t of ["1", "y", "Yes", "yes!", "ok", "go ahead", "\n", "2\n", "a"]) {
    assert.equal(answersPrompt({ kind: "text", text: t }, false), true, JSON.stringify(t));
  }
  assert.equal(answersPrompt({ kind: "text", text: "Carry on porting the front page and the marketing copy" }, false), false);
  for (const k of ["Return", "1", "1 Return", "Down Return", "shift+Tab", "y"]) {
    assert.equal(answersPrompt({ kind: "keys", keys: k }, false), true, k);
  }
  assert.equal(answersPrompt({ kind: "keys", keys: "ctrl+c" }, false), false, "stopping it is always safe");
  assert.equal(answersPrompt({ kind: "keys", keys: "Escape" }, false), false);
  assert.equal(answersPrompt({ kind: "keys", keys: "Return" }, true), false, "Return straight after a typed instruction sends it");
  assert.equal(answersPrompt({ kind: "keys", keys: "1 Return" }, true), true, "but a digit first is still an answer");
});

test("an instruction typed without a newline waits for its Return, for one minute, in that window only", () => {
  clearPending();
  assert.equal(leavesInstructionPending({ kind: "text", text: "Carry on with the front page" }), true);
  assert.equal(leavesInstructionPending({ kind: "text", text: "Carry on with the front page\n" }), false, "it sent itself");
  assert.equal(leavesInstructionPending({ kind: "text", text: "1" }), false);
  notePending("✳ Port Estimatic", 1_000);
  assert.equal(takePending("other window", 2_000), false);
  assert.equal(takePending("✳ Port Estimatic", 2_000), true);
  assert.equal(takePending("✳ Port Estimatic", 2_000), false, "used once");
  notePending("✳ Port Estimatic", 1_000);
  assert.equal(takePending("✳ Port Estimatic", 1_000 + 61_000), false, "after a minute a Return may be an answer");
});

test("flags that switch off another AI's prompts are found wherever they are written", () => {
  assert.equal(bypassFlag('claude -p "ping" --dangerously-skip-permissions'), "--dangerously-skip-permissions");
  assert.ok(bypassFlag("claude --allow-dangerously-skip-permissions"));
  assert.ok(bypassFlag("claude --permission-mode bypassPermissions"));
  assert.ok(bypassFlag("claude --permission-mode=bypassPermissions"));
  assert.ok(bypassFlag("codex --dangerously-bypass-approvals-and-sandbox"));
  assert.ok(bypassFlag("gemini -p hi --yolo"));
  assert.equal(bypassFlag("claude -p ping"), null);
  assert.equal(bypassFlag("claude --permission-mode plan"), null);
  assert.equal(bypassFlag("some-tool --yolo"), null, "--yolo is only refused where it means skip the prompts");
});

test("the card names the agent, the keys and the claw's reading, and the refusal says to wait", () => {
  const c = relayCard({ agent: "Claude Code", window: "✳ Port Estimatic", send: "1 Return", asking: "Do you want to run npm install?" });
  assert.match(c.summary, /Claude Code is asking permission/);
  assert.match(c.detail, /1 Return/);
  assert.match(c.detail, /Do you want to run npm install\?/);
  assert.match(c.detail, /Allow for this task" does not cover them/);
  assert.match(relayCard({ agent: "Codex", window: null, send: "y" }).detail, /look at the screen/);
  assert.match(c.declined, /nothing was typed/i);
});

// --- the wiring: executeTool with a stand-in keyboard ---

function harness(agent: string | null, answer: boolean) {
  const cards: string[] = [];
  const sent: string[] = [];
  setKeyboardForTests({
    agentTarget: async () => ({ agent, title: agent ? "✳ Port Estimatic" : "Terminal" }),
    pressKeys: async (keys) => { sent.push(`keys:${keys}`); return "Pressed"; },
    typeOnDesktop: async (text) => { sent.push(`text:${text}`); return "Typed"; },
  });
  const ctx: ToolContext = {
    requestApproval: async (summary) => { cards.push(summary); return answer; },
    emit: () => {},
    tainted: () => false,
  } as unknown as ToolContext;
  return { cards, sent, ctx };
}

test("under a task grant, an answer to Claude Code's prompt still asks the operator, and a no types nothing", async () => {
  clearPending();
  grantForTask();
  try {
    const h = harness("Claude Code", false);
    const out = String(await executeTool("press_keys", { keys: "1 Return", window: "Port Estimatic", asking: "Allow npm install?" }, h.ctx));
    assert.deepEqual(h.cards, ["Claude Code is asking permission — answer it?"]);
    assert.deepEqual(h.sent, [], "declined: not a key reached the terminal");
    assert.match(out, /Do not answer its prompt another way/);

    const t = harness("Claude Code", false);
    await executeTool("type_on_desktop", { text: "1\n", window: "Port Estimatic" }, t.ctx);
    assert.deepEqual(t.sent, [], "a typed answer is caught the same way");

    const yes = harness("Claude Code", true);
    await executeTool("press_keys", { keys: "1 Return", window: "Port Estimatic" }, yes.ctx);
    assert.equal(yes.cards.length, 1, "one card, the relay's, not a second ordinary one");
    assert.deepEqual(yes.sent, ["keys:1 Return"], "approved: exactly the keys on the card");
  } finally {
    clearTaskGrant();
    setKeyboardForTests(null);
  }
});

test("under a task grant, instructions into the agent's terminal flow, and so does the Return that sends them", async () => {
  clearPending();
  grantForTask();
  try {
    const h = harness("Claude Code", false);
    await executeTool("type_on_desktop", { text: "Carry on with the front page and the marketing copy", window: "Port Estimatic" }, h.ctx);
    await executeTool("press_keys", { keys: "Return", window: "Port Estimatic" }, h.ctx);
    assert.deepEqual(h.cards, [], "the driving the operator asked for is not interrupted");
    assert.equal(h.sent.length, 2);

    const again = harness("Claude Code", false);
    await executeTool("press_keys", { keys: "Return", window: "Port Estimatic" }, again.ctx);
    assert.equal(again.cards.length, 1, "a second Return with no instruction waiting could be accepting a prompt");
    assert.deepEqual(again.sent, []);
  } finally {
    clearTaskGrant();
    setKeyboardForTests(null);
  }
});

test("an ordinary window keeps the ordinary rules: the grant covers it", async () => {
  clearPending();
  grantForTask();
  try {
    const h = harness(null, false);
    await executeTool("press_keys", { keys: "1 Return" }, h.ctx);
    assert.deepEqual(h.cards, []);
    assert.deepEqual(h.sent, ["keys:1 Return"]);
  } finally {
    clearTaskGrant();
    setKeyboardForTests(null);
  }
});

test("the skip-permissions flags are refused by shell and by typing, before any card", async () => {
  const h = harness("Claude Code", true);
  try {
    const typed = String(await executeTool("type_on_desktop", { text: 'claude -p "ping" --dangerously-skip-permissions\n' }, h.ctx));
    assert.match(typed, /^Refused: --dangerously-skip-permissions/);
    const shell = String(await executeTool("run_command", { command: 'claude -p "ping" --dangerously-skip-permissions' }, h.ctx));
    assert.match(shell, /^Refused: --dangerously-skip-permissions/);
    assert.deepEqual(h.cards, []);
    assert.deepEqual(h.sent, []);
  } finally {
    setKeyboardForTests(null);
  }
});

test("both typing tools tell the model to pass what the other AI is asking", () => {
  for (const name of ["press_keys", "type_on_desktop"]) {
    const def = toolDefinitions.find((t: { name: string }) => t.name === name)!;
    assert.ok((def.input_schema as any).properties.asking, `${name} takes asking`);
    assert.match(def.description!, /operator/);
  }
});
