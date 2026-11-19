# Cunning Claw 0.3 — posts

Ready to paste on **R-day**, the day the v0.3.0 downloads go live: the
Facebook post mentions the download, so it waits for the release. Every claim
below is in the code on `main`; the numbers come from `npm test` (622) and the
tool-diet test (150 connector tools, 80% fewer tokens of tool lists). Pair any
of them with `site-social-0.3.png` (or the older `social-0.3.png`).

Do not post the download link until the v0.3.0 release exists on
github.com/Dragon-Forge-master/cunning-claw/releases; point people to
cunningclaw.com instead. The rest of the kit, and which pieces wait for what,
is in [README.md](README.md).

*Corrected for accuracy: the Mac sandbox is built but has not yet been run on
a real Mac, so "a safety box on Linux and Mac" now says Linux; "no terminal"
only holds with the downloads, so it is tied to them; the connector coach was
missing from LinkedIn.*

---

## Facebook

Big update to Cunning Claw, the AI assistant I've been building in Cardiff.

He runs on your own computer, not in someone else's cloud, and as of this
week he's cheaper, harder to fool and more private:

🔹 Costs less to run: he only loads the tools a job actually needs
🔹 On Linux, his commands run inside a safety box that hides your passwords and keys (the Mac version is built and being tested)
🔹 He can hear you without your voice leaving your computer (after a one-off setup)
🔹 He remembers things by meaning, not just exact words
🔹 He reads PDFs, Word, Excel and scanned documents
🔹 If an email or web page tries to give him orders, he flags it and waits for you
🔹 Push alerts to your phone, no account needed
🔹 Stuck connecting Xero, Canva or GitHub? Press "Guide me" and he walks you through it, step by step

And the big one for anyone who isn't techy: you can now start free. Download
it, double-click, and the setup page walks you through getting a free Google
key in four steps. No card, no typing commands.

It's new and very few people use it yet, so tell me what you think. Open
source, built in Wales. No crypto token, ever. Link in the comments 👇

---

## X / Twitter

Cunning Claw 0.3, a local AI assistant:

• 80% fewer tool-list tokens per message (150-tool test)
• shell sandboxed on Linux
• speech-to-text on your own machine
• flags pages that try to give it orders
• starts free with a Google key

Open source. 622 tests. No token, ever.

---

## LinkedIn

Cunning Claw 0.3 is out of the forge.

It's a local-first AI assistant: it runs on your machine and can actually
operate it (shell, files, browser, email), which makes prompt injection the
threat that matters. This release is mostly about that, and about cost:

- Shell commands run in a sandbox that can only write to folders you allow,
  with ssh and GPG keys, cloud and git credentials, keyrings and browser
  profiles hidden. That is bubblewrap on Linux; on macOS, sandbox-exec, built
  but not yet tested on a real Mac; on Windows there is none yet, and it says
  so. Going outside the box always needs a human approval.
- A local injection scanner flags text that tries to give the assistant
  orders, including instructions hidden in invisible Unicode, and suspends
  any pre-approval for the rest of that turn. It is a heuristic; the approval
  card is the real boundary.
- Tool schemas are loaded on demand. With 150 connector tools, each message
  carried 80% fewer tokens of tool lists.
- Speech-to-text and memory search can run entirely on the machine.
- Every connector has a "Guide me" button that walks you through setting it
  up.
- A first-time user can start free: the setup page walks through a free
  Google Gemini key, and the new downloads for Windows, macOS and Linux need
  no terminal.

It's alpha, with very few users so far. Two runtime dependencies. 622 tests.
Built in Cardiff by Dragon Forge AI.
