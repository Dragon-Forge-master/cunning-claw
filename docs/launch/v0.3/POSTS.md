# Cunning Claw 0.3 — posts

Ready to paste. Every claim below is in the code on `main`; the numbers come
from `npm test` (599) and the tool-diet test (150 connector tools, 80% fewer
tokens of tool lists). Pair any of them with `social-0.3.png`.

Do not post the download link until the v0.3.0 release exists on
github.com/Dragon-Forge-master/cunning-claw/releases.

---

## Facebook

Big update to Cunning Claw, the AI assistant I've been building in Cardiff.

He runs on your own computer, not in someone else's cloud — and as of this
week he's cheaper, harder to fool and more private:

🔹 Costs less to run — he only loads the tools a job actually needs
🔹 His commands run inside a safety box on Linux and Mac
🔹 He can hear you without your voice leaving your computer
🔹 He remembers things by meaning, not just exact words
🔹 He reads PDFs, Word, Excel and scanned documents
🔹 If an email or web page tries to give him orders, he flags it and waits for you
🔹 Push alerts to your phone, no account needed

And the big one for anyone who isn't techy: you can now start free. The setup
page walks you through getting a free Google key in four steps — no card, no
typing commands.

Open source, built in Wales. No crypto token, ever. Link in the comments 👇

---

## X / Twitter

Cunning Claw 0.3 — the local AI assistant from Cardiff:

• 80% fewer tokens of tool lists per message, in a 150-tool test
• shell boxed in a sandbox on Linux & Mac
• speech-to-text on your own machine
• flags web pages that try to give it orders
• starts free with a Google key, no terminal

Open source. 599 tests. No token, ever.

---

## LinkedIn

Cunning Claw 0.3 is out of the forge.

It's a local-first AI assistant: it runs on your machine and can actually
operate it — shell, files, browser, email — which makes prompt injection the
threat that matters. This release is mostly about that, and about cost:

- Shell commands run in a sandbox (bubblewrap on Linux, sandbox-exec on
  macOS) that can only write to folders you allow. Going outside it always
  needs a human approval.
- A local injection scanner flags text that tries to give the assistant
  orders, including instructions hidden in invisible Unicode, and suspends
  any pre-approval for the rest of that turn.
- Tool schemas are loaded on demand. With 150 connector tools, each message
  carried 80% fewer tokens of tool lists.
- Speech-to-text and memory search can run entirely on the machine.
- A first-time user can start free: the setup page walks through a free
  Google Gemini key, with no terminal.

Two runtime dependencies. 599 tests. Built in Cardiff by Dragon Forge AI.
