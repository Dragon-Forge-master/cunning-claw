# Installers

The founder downloaded a Linux bundle, double-clicked it, and it "just took me to the
files". People expect an installer. Each release now has one per system, alongside
(not instead of) the archives:

| System | Installer | The archive, still there |
|---|---|---|
| Windows | `Cunning-Claw-Setup-<version>.exe` — per-user, no administrator password | `cunningclaw-<version>-win-x64.zip` |
| macOS | `Cunning-Claw-<version>-mac-arm64.dmg` (Apple silicon), `…-mac-x64.dmg` (Intel) | `cunningclaw-<version>-darwin-*.zip` |
| Ubuntu, Debian | `cunningclaw_<version>_amd64.deb`, `…_arm64.deb` | `cunningclaw-<version>-linux-*.tar.gz` |
| Any other Linux | `Cunning-Claw-<version>-linux-x86_64.AppImage`, `…-aarch64.AppImage` | the same |

No spaces in the names: GitHub turns a space in a release file's name into a dot.
The `.deb` takes Debian's own `name_version_arch` shape, lower case, with a
pre-release's `-` written `~` so that `1.0.0~rc.1` sorts before `1.0.0` as semver's
`1.0.0-rc.1` does.

## The .deb

The founder's own machine is Ubuntu, and his first AppImage "didn't seem to do
anything" (see *Starting and stopping*). Ubuntu and Debian owners expect a package
the system knows about: a menu entry, an icon, `apt remove`. Built on the Linux CI
machine with `dpkg-deb` (`buildDeb` in `scripts/bundle.mjs`), from the same bundle as
the AppImage:

| Path | What |
|---|---|
| `/opt/cunningclaw/app`, `/opt/cunningclaw/runtime` | the code and its own Node, owned by root and read-only to the owner; `app/installed.json` is the marker that sends the owner's things to `~/.local/share/cunningclaw` |
| `/usr/bin/cunningclaw` | the launcher (`debLauncher()`): the same POSIX sh script as the AppImage's, with the code at `/opt/cunningclaw` |
| `/usr/share/applications/cunningclaw.desktop` | the menu entry: `Exec=cunningclaw`, `Terminal=false` (the launcher opens its own window, below) |
| `/usr/share/icons/hicolor/<n>x<n>/apps/cunningclaw.png` | 16 to 512 px |
| `/usr/share/doc/cunningclaw/README`, `copyright` | the read-me (`readMe("linux", v, "deb")`) and the MIT licence in Debian's machine-readable format |

The control file names `Package: cunningclaw`, the version, the architecture,
`Maintainer: Dragon Forge AI <placeholder@cunningclaw.com>` — a placeholder to be
replaced by the project's real address, never a person's own — `Installed-Size`
counted as dpkg counts it, `Section: utils`, the GitHub `Homepage` and a
description. `Depends` is only what the bundled Node itself links against, read from
its ELF header: `libc6 (>= 2.28), libstdc++6 (>= 5.2), libgcc-s1 | libgcc1` (it asks
for `GLIBC_2.28` and `GLIBCXX_3.4.21` at newest). Node is inside, so there is no
`nodejs` dependency. `Recommends: bubblewrap`, the shell's sandbox: he runs without
it, but apt installs what a package recommends unless told not to, so an owner gets
the boxed shell without having to know to ask.

There are no maintainer scripts. The menu and icon caches are refreshed by the dpkg
triggers that `desktop-file-utils` and `hicolor-icon-theme` already hold on
`/usr/share/applications` and `/usr/share/icons/hicolor` (installing it here printed
"Processing triggers for hicolor-icon-theme"), and nothing of the owner's is under a
path dpkg knows, so `apt remove` and even `apt purge` cannot touch
`~/.local/share/cunningclaw` — apt's own manual says purge "does not affect any data
or configuration stored in your home directory"
([apt(8)](https://manpages.ubuntu.com/manpages/noble/man8/apt.8.html)).

**Installing it.** `sudo apt install ./cunningclaw_<version>_amd64.deb` from the folder
it downloaded to (the `./` is what tells apt it is a file, not a package name) always
works, on Ubuntu and on Debian. Double-clicking it depends on the release, so the
read-me gives the apt line first:

- Ubuntu's desktop docs name App Center as the way to install software, and say a deb
  "always" has full access to your resources, so "only install debs from sources you
  trust" ([Ubuntu Desktop docs: Install an application](https://ubuntu.com/desktop/docs/en/latest/how-to/software/install-an-application/)).
  They do not say what double-clicking a downloaded `.deb` does.
- On 24.04 LTS, an App Center update rolled out in July 2024 made a double-click (or
  *Open with App Center*) show the package with an **Install** button; before it,
  from 23.10, there was no app for `.deb` files at all. It cannot uninstall a `.deb`
  it installed, nor reinstall one ([OMG! Ubuntu, 12 July 2024](https://www.omgubuntu.co.uk/2024/07/app-center-update-adds-deb-install-support)).
  It's FOSS reported App Center opening and hanging on a double-clicked `.deb` on
  24.04 before that was reverted, and 26.04's App Center listing, updating and
  uninstalling debs ([It's FOSS, 28 March 2026](https://itsfoss.com/news/ubuntu-26-04-deb-in-app-center/)).
  Neither is Canonical's own documentation, and nothing found says what 25.10 does.
- So: double-clicking may open App Center with an Install button; when it does not,
  or for removal, it is the apt line. Remove with `sudo apt remove cunningclaw`.

Upgrading is the next `.deb` over this one, with `apt install` again.

## Where the owner's things live

An installed app's code is read-only — a folder upgrades replace, a `.app` dragged
from a disk image, an AppImage's squashfs, the `.deb`'s root-owned `/opt/cunningclaw` — so the owner's things cannot sit beside
it as they do in a clone or an unzipped download. They live in a per-user folder:

| System | The owner's folder |
|---|---|
| Windows | `%LOCALAPPDATA%\CunningClaw` |
| macOS | `~/Library/Application Support/cunningclaw` |
| Linux | `$XDG_DATA_HOME/cunningclaw`, by default `~/.local/share/cunningclaw` |

It holds `.env` (keys), `claw.config.json`, `data/` (memory, history, the journal)
and `workspace/` (notes and skills). Local rather than Roaming on Windows, because
history and the browser profile are too big to copy at every sign-in; one folder
rather than splitting config into `$XDG_CONFIG_HOME` on Linux, so there is one thing
to back up, import or delete. On Windows and macOS it is the folder the claw's own
Chrome profile already used. The Desk stays where it always was,
`Documents/CunningClaw`.

**How it is wired.** `src/config.ts` has two roots: `ROOT`, the code, and
`HOME_ROOT`, the owner's. `src/home-root.ts` decides `HOME_ROOT`:

1. `CLAW_HOME`, when set (a second claw, a test, things on another disk);
2. otherwise, when the code root holds `installed.json` — which only the installers
   write, never a clone or a zip — the per-user folder above;
3. otherwise `ROOT` itself, which is what every clone and download has always done.

`.env`, `claw.config.json`, `data/`, `workspace/`, `.mcp.json`, Piper's voice and the
local ears (`setup-voice.sh`, `setup-ears.sh`) all follow `HOME_ROOT`, and so do the
setup page and the Keys page when they save a key, the doctor, the sandbox's list of
protected paths and its hidden secrets, and the shell's default folder.
`CLAW_DATA_DIR` and `CLAW_CONFIG` still override their one thing each.

**First run** seeds the owner's folder from the shipped defaults — the config and the
workspace templates — file by file, and never overwrites a file that exists.
**Upgrades** are the next installer over the old one. Each start compares what is
shipped with what was seeded (`.seeded.json` in the owner's folder): a file still
exactly as seeded is refreshed to the new version's, a new one (a skill added since)
is copied in, and anything the owner changed or deleted is left as it is. That is
what `git pull` does for a clone. One consequence: an edited `claw.config.json`
does not gain new settings from an upgrade. So a setting added to `ClawConfig`
(`src/config.ts`) must be optional, with its default in code — as the later ones
there already are — or an owner who once changed their port stops starting.

**Coming from an unzipped download.** With the claw closed, run its launcher with
`--import` and the old folder:

```
"%LOCALAPPDATA%\Programs\Cunning Claw\Cunning Claw.cmd" --import "C:\Users\you\Downloads\cunningclaw-0.4.0-win-x64"
"/Applications/Cunning Claw.app/Contents/MacOS/Cunning Claw" --import ~/Downloads/cunningclaw-0.4.0-darwin-arm64
./Cunning-Claw-0.5.0-linux-x86_64.AppImage --import ~/Downloads/cunningclaw-0.4.0-linux-x64
cunningclaw --import ~/Downloads/cunningclaw-0.4.0-linux-x64          # the .deb
```

It copies `app/.env` (merged: the old keys win, a key added since is kept),
`app/claw.config.json`, `app/data` and `app/workspace`, except that this version's
copies of shipped skills and tax tables stay — an old download's would shadow every
later update. Anything it replaces goes into a dated `before-import-…` folder in the
owner's folder first. It refuses while a claw answers on the port. The archive's
launcher takes `--import` too, so moving from one unzipped version to the next works
the same way. Pointing it at a folder is the only way it runs: nothing searches
Downloads for old claws, because a folder that merely looks like one is not proof it
is the owner's.

## Getting past the warnings (unsigned, for now)

- **Windows:** SmartScreen says it protected your PC. **More info → Run anyway.**
  The installer then needs no administrator password.
- **macOS:** "cannot check it for malicious software". In Applications, **right-click
  Cunning Claw → Open → Open**. On macOS 15 and later that route is gone: open it
  once, then **System Settings → Privacy & Security → Open Anyway**.
- **Linux, the .deb:** no warning. apt installs it as it installs anything else, and asks
  for the administrator password because it writes to `/opt` and `/usr`.
- **Linux, the AppImage:** it needs permission to run: **right-click → Properties →
  Permissions → Allow executing file as program**, or `chmod +x`. Without FUSE, the
  AppImage runtime pinned here unpacks itself into a temporary folder instead of
  mounting (seen on a machine with no `fusermount`: it printed "No suitable
  fusermount binary found" and started anyway). If an older system's does not, run
  it with `--appimage-extract-and-run`, or set `APPIMAGE_EXTRACT_AND_RUN=1`.

## Starting and stopping

- **Windows:** the Start menu entry (and the desktop icon, if kept) runs
  `Cunning Claw.cmd`: a window stays open while he runs; closing it stops him.
- **macOS:** opened from Finder, the app opens Terminal on a two-line script it writes
  into the owner's folder (a file the app writes is not quarantined, where one inside
  the downloaded app might make Gatekeeper ask again); closing that window stops him.
  **This path has not been run on a Mac.** CI starts the app's own executable directly
  (`CLAW_NO_TERMINAL=1`), which proves everything after it; the Terminal hand-off is
  tested on Linux with a stand-in `open` (`src/bundle.test.ts`). Drag the app into
  Applications before opening it: run from the disk image or Downloads, macOS runs it
  from a randomised read-only copy, and the script would name that copy.
- **Linux:** the AppImage double-clicked, the `.deb`'s menu entry, and the download's
  `Cunning Claw.sh` run as a program all start with no window of their own, so each
  opens a terminal on itself (`posixLauncher` in `scripts/bundle.mjs`, one POSIX sh
  script for all three): `x-terminal-emulator` first, resolved to the program it
  points at, then `xdg-terminal-exec`, Ptyxis (Ubuntu 25.10's terminal, which takes
  the command after `--`, not `-e`), GNOME Terminal, GNOME Console, Konsole, Xfce,
  MATE and xterm, the first found. Closing the window stops him.

  **A double-click never flashes a window shut.** The founder's v0.5.1 AppImage "didn't
  seem to do anything": his git install was running as a service, so the copy in the
  new window found it on the port, handed over within seconds, and the window
  closed with the explanation in it. Now, in a window the launcher opened itself
  (`--in-terminal`), a claw that stops within a minute, or with an error, leaves its
  last words up, ending "Press Enter to close this window." Never in the owner's own
  terminal (no `--in-terminal`), never when stdin is not a terminal, never with
  `CLAW_NO_TERMINAL`, and not after a signal, which is the window being closed or
  Ctrl+C. The last words for a hand-over now say which it is (`src/port-clash.ts`):

  ```
  Cunning Claw is already running on this computer (v0.5.1), so I've opened that one instead of starting a second copy.
  ```

  with one more line, when the running one is older, on how to use this one instead.

  **No terminal to open**, or an AppImage unpacked rather than mounted (the runtime
  deletes the unpacked copy when the first process exits, under the terminal's
  feet): it runs without a window. The claw opens the browser, on itself or on the
  copy already running; and if it cannot start at all, `notify-send`, where there is
  one, puts "Cunning Claw could not start" on the desktop with the command to run in
  a terminal to see why.

  On a Mac, Terminal's default profile already keeps a finished script's window open
  ("When the shell exits: Don't close the window"), so the `.command` and the `.app`
  are unchanged.

The AppImage's desktop integration (a menu entry) is left to the owner's own tool —
AppImageLauncher or Gear Lever. Writing a `.desktop` file from inside the AppImage
would point at wherever the file sat that day, and go stale the day it moved. The
`.deb` has one, because its launcher is always at `/usr/bin/cunningclaw`.

## The sandbox, and known gap 5

An installed claw's code and the owner's folder are both on the sandbox's protected
list (`protectedFor` in `src/sandbox.ts`), so a boxed command cannot rewrite either —
even where they land inside a writable folder: an AppImage unpacked under `/tmp`, or a
`.app` in a writable `~/Applications` that the model names as its working folder. A
live bubblewrap test writes to a code root unpacked under the temp dir and is refused
(`src/sandbox.test.ts`). A clone or an unzipped download is its own build tree and
stays writable to its own commands; that is still gap 5 in
`docs/SECURITY-ARCHITECTURE.md`. Windows has no sandbox at all (gap 3).

## Built and tested where

| | Built | Started and checked |
|---|---|---|
| AppImage x86_64 | Linux build job; also built and run locally | CI: unpacked (`APPIMAGE_EXTRACT_AND_RUN=1`), `/` 302, `/welcome` 200, `.env` in `~/.local/share/cunningclaw`. Locally as well, mounted through FUSE and unpacked, the terminal hand-off with a stand-in terminal, and `--import` |
| AppImage aarch64 | Linux build job | Not started anywhere yet (no Arm runner in the matrix) |
| `.deb` amd64 | Linux build job (`dpkg-deb`); also built locally | CI: `apt-get install ./…deb` on ubuntu-latest, the files in place and `/opt/cunningclaw/app` not writable by the runner's user, `cunningclaw` started with `CLAW_NO_TERMINAL=1`, `/` 302, `/welcome` 200, `.env` in `~/.local/share/cunningclaw` and none under `/opt`, `apt-get remove`, the app gone and the owner's folder kept. Locally the same by hand on Ubuntu 24.04, as a non-root user, plus a second start in a stand-in window (`script`) that printed the hand-over line and waited for Enter, and `dpkg --verify` clean after a run |
| `.deb` arm64 | Linux build job; also built locally | `dpkg-deb --info` and `--contents` only; not installed anywhere yet |
| Windows Setup | Linux build job (`makensis`); built locally, a valid PE and NSIS archive | CI only: silent install (`/S`), Start menu entry, Add or remove programs entry, start, `/` 302, `/welcome` 200, `.env` in `%LOCALAPPDATA%\CunningClaw`, silent uninstall, the owner's folder kept |
| `.dmg` Apple silicon | macOS job (`hdiutil`) — CI only | CI only: attach, drag to Applications, start the app's executable, `/` 302, `/welcome` 200, `.env` in Application Support |
| `.dmg` Intel | macOS job — CI only | Not started anywhere yet |

The CI cells say what the workflow checks; when this was written it had not yet run
with the installers in it, so until the first green run they are a plan with code
behind it, not evidence. The release job uploads the installers with the archives,
and only once every smoke test above has passed.

**To test the workflow on a branch:** Actions → **Bundles** → **Run workflow**, choose
the branch, leave `release` empty. It builds and smoke-tests everything and
publishes nothing.

**To build locally:** `npm run bundle -- --target linux-x64 --target win-x64
--installer appimage,deb,nsis` on Linux (the `.deb` needs `dpkg-deb`, which every
Debian-family system has) (needs `apt install nsis`; appimagetool and the
AppImage runtime are fetched at pinned versions and checked by SHA-256 in
`APPIMAGE_TOOLS`), and `npm run bundle -- --target darwin-arm64 --installer dmg` on a
Mac.

## Signing: what removes the warnings, and what it costs

Planning figures from the vendors' public pages; check before buying.

- **Windows.** An Authenticode code-signing certificate from a CA. Since 2023 the
  CA/Browser Forum rules put the key on a hardware token or a cloud HSM, so expect a
  few hundred pounds a year, and an identity check of the business (Dragon Forge AI)
  or person. SmartScreen's warning fades as a signed publisher builds download
  reputation; it does not vanish the day the first signed build ships. Microsoft's
  own cloud signing service on Azure is cheaper per month where the publisher
  qualifies; its eligibility rules are the thing to check.
- **macOS.** The Apple Developer Program, **US$99 a year**, gives a Developer ID
  certificate; notarisation (Apple scanning each build) is included. Signed and
  notarised, the app opens after macOS's ordinary "downloaded from the Internet"
  question, with no warning and no trip to System Settings.
- **Linux.** Nothing to buy. AppImages can carry a GPG signature (`appimagetool
  --sign`); no desktop checks it by default, so it is not wired. A `.deb` installed
  from a file is not signature-checked by apt either; that only comes with an apt
  repository of our own, which is not built.

**The hooks are already in place**, each skipped while its secret is empty:

| Secret (repository → Settings → Secrets → Actions) | For |
|---|---|
| `WINDOWS_SIGN_PFX_BASE64`, `WINDOWS_SIGN_PASSWORD` | The certificate as a base64 `.pfx`, and its password. The build job hands them to `scripts/bundle.mjs`, which has makensis sign both the installer and the uninstaller inside it with `osslsigncode` (`!finalize`, `!uninstfinalize`) and a DigiCert timestamp |
| `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `MACOS_SIGN_IDENTITY` | The Developer ID Application certificate, its password, and its name ("Developer ID Application: …"). The app is signed with the hardened runtime and `packaging/macos/entitlements.plist` before the `.dmg` is made, and the `.dmg` after |
| `MACOS_NOTARY_APPLE_ID`, `MACOS_NOTARY_TEAM_ID`, `MACOS_NOTARY_PASSWORD` | Notarisation (`notarytool submit --wait`, then `stapler staple`). The password is an app-specific one from appleid.apple.com |

`osslsigncode` rather than `signtool`, because the installer is built on Linux and
the uninstaller is signed while makensis builds it; it writes the same Authenticode
signature. The Windows hook was run locally with a throwaway self-signed certificate:
`osslsigncode verify` found the signature and the timestamp on the installer and on
the uninstaller extracted from it. The macOS hook has not run: it needs the
Developer ID the project does not have yet, and the entitlements list is a first
guess that the first signed build will prove or correct.
