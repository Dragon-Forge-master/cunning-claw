# Cunning Claw 0.3 — launch kit

Everything for the 0.3 launch, what each piece is for, and whether it can go
out now. The plan that sequences it is [MARKETING-PLAN.md](MARKETING-PLAN.md).

**R-day** is the day the v0.3.0 downloads (Windows, Mac and Linux; unzip and
double-click, Node inside) go live on the GitHub releases page. They are built
and have been tested on real Windows, Mac and Linux machines in CI, but are not
published yet. Nothing in this kit prints a download link.

Status key:

- **Ready now**: true today, and says nothing that depends on the downloads.
- **R-day**: mentions or depends on the downloads; hold it until the release exists.
- **Just Works**: mentions the £7-a-month plan as *coming*; update it the day the plan goes live.

Before posting anything, re-check the numbers (73 tools, 94 connectors, 31
skills, 623 tests, 2 runtime dependencies); the plan's first table says how.

## Written

| File | What it is | Where it goes | Status |
|---|---|---|---|
| [MARKETING-PLAN.md](MARKETING-PLAN.md) | Audiences, message pillars and their proof, channels, the four weeks from R-day, what to measure, cold-email rules, what we never say | Internal | Ready now |
| [COPY.md](COPY.md) · Show HN | Title (72 characters) and body | news.ycombinator.com, R+1 | R-day |
| [COPY.md](COPY.md) · r/selfhosted | Post with limits up front | Reddit, R+2 | R-day |
| [COPY.md](COPY.md) · r/LocalLLaMA | Post on the local stack, with the caveat about small models | Reddit, R+3 | R-day |
| [COPY.md](COPY.md) · Product Hunt | Tagline (47 characters), description (241), maker's comment, gallery and topics | producthunt.com, R+15 | R-day · Just Works |
| [COPY.md](COPY.md) · LinkedIn: security | Post to go with the security PDF | LinkedIn, R+16 | Ready now (scheduled R+16) |
| [COPY.md](COPY.md) · Carousel captions | Instagram and Facebook page captions, alt text for all eleven slides, story note | Instagram, Facebook page | Ready now |
| [COPY.md](COPY.md) · Friends | WhatsApp message and personal Facebook post from Chris | WhatsApp, Facebook | R-day (a non-technical friend needs the download to start) |
| [COPY.md](COPY.md) · Local business group post | Short post for groups Chris belongs to | Facebook groups, R+8 | R-day |
| [COPY.md](COPY.md) · Cold email | Subject lines and body, with the business PDF attached | Email to limited companies, R+9 | R-day |
| [COPY.md](COPY.md) · Press release | Announcement with notes to editors; **the quote is a draft for Chris to approve** | Local press, R-day or R+1 | R-day · Just Works · needs Chris's approval and contact details |
| [COPY.md](COPY.md) · About Dragon Forge AI | 50-word and 100-word boilerplate | Press, directories, profiles | Ready now |
| [POSTS.md](POSTS.md) | Facebook, X and LinkedIn release posts (corrected: Mac box, "no terminal", connector coach) | Facebook, X, LinkedIn, R-day | R-day |
| [../X-THREAD.md](../X-THREAD.md) | The seven-post X thread, rewritten for 0.3, and a week of follow-ups | X (@Dragon_forge_ai), R-day | R-day |

## Visuals

All PNGs are rendered at deviceScaleFactor 1 at their exact pixel size from
the HTML beside them. To re-render after a change: `node docs/launch/v0.3/render.cjs`
(or name one job: `carousel`, `story`, `banner`, `social`, `business`,
`security`). The renderer reports anything that overflows its frame.

| File | Size | What it is | Where it goes | Status |
|---|---|---|---|---|
| `carousel/01-cover.png` … `carousel/11-close.png` (source `carousel.html`) | 1080×1080 ×11 | Cover, one slide per upgrade with its honest bit, closing slide with the numbers and the doctrine line | Instagram and Facebook carousel; single slides for X and LinkedIn | Ready now |
| `story-0.3.png` (source `story.html`) | 1080×1920 | All nine upgrades on one screen, with the app's top and bottom bands kept clear | Instagram and Facebook stories | Ready now |
| `linkedin-banner-0.3.png` (source `linkedin-banner.html`) | 1584×396 | "The local AI assistant that asks before it acts", with the left side kept clear for the profile photo | Chris's LinkedIn profile and the company page | Ready now |
| `site-social-0.3.png` (source `site-social.html`) | 1600×900 | The share image refreshed for all nine upgrades; the sandbox line now says Linux | og:image for cunningclaw.com (for whoever owns `site/` to install), link previews, Product Hunt gallery | Ready now |
| `social-0.3.png` (source `social-card.html`) | 1600×900 | The earlier eight-item card | Superseded by `site-social-0.3.png`; its "Linux & Mac" line overstates the Mac box, so do not use it again | Retired |
| `site-new.png`, `site-new-phone.png` | — | Earlier captures of the site, kept for reference | — | Not part of this kit; untouched |

## Print

| File | What it is | Where it goes | Status |
|---|---|---|---|
| `cunning-claw-for-your-business.pdf` (source `business-onepager.html`, preview `cunning-claw-for-your-business-preview.png`) | One A4 page for small businesses: what he can do, how to start free, safety in plain words, price, the honest bit | Attached to cold emails, printed for in-person demos | R-day (its "start free" steps describe the download) · Just Works |
| `security-at-a-glance.pdf` (source `security-at-a-glance.html`, preview `security-at-a-glance-preview.png`) | One A4 page summarising [SECURITY-ARCHITECTURE.md](../../SECURITY-ARCHITECTURE.md): threat model, seven layers, the floor, approvals, sandbox, scanner, what leaves the machine, the six known gaps | LinkedIn, sent on request to security people | Ready now; regenerate if the architecture document changes |

## Sources and shared files

| File | What it is |
|---|---|
| `kit.css` | Shared look for the screen visuals: BRAND.md tokens, the ink frame with grid and glow, wordmark, honest and proof boxes |
| `print.css` | Shared look for the A4 pages: parchment ground, ink type, the mark as a stamp |
| `forge-mark-ink.svg` | `../../assets/forge-mark.svg` with its colour set to ink, for the print pages (a mask or `<use>` pointing at the master is refused across `file://` origins). Regenerate with `sed 's/fill="currentColor"/fill="#0a111c"/'` if the master changes |
| `render.cjs` | Renders every PNG and PDF; needs Playwright, a Chromium and the network (Google Fonts) |

## When the Just Works plan goes live

Update, in this order: the price box in `business-onepager.html` (then
re-render), the Product Hunt maker's comment, the press release's
availability paragraph, and MARKETING-PLAN.md's "never available" line. Until
then every piece says the plan is *coming*.
