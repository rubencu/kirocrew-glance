# Glance v2 — design

## The paradigm

v1.x was a dashboard: the browser recomputed a board every 5 seconds through
~400 lines of classification heuristics (urgency ramps, stall detection,
loop-cap warnings), and grew search, keyboard nav, and six card types so a
human could scan the result. The human still did the reading.

v2 inverts it: **the agent reads, the human glances.**

```
                    ┌──────────────────────────────────────┐
   every 15 min /   │ curator cron (LLM, silent)           │
   on demand        │  app token → 4 read endpoints        │
                    │  judgment → brief.json (atomic)      │
                    └──────────────┬───────────────────────┘
                                   │ ~/.kiro/crew/workspace/glance/brief.json
                                   ▼
                    ┌──────────────────────────────────────┐
   poll 5s/30s      │ UI (one screen)                      │
                    │  1. live blockers (questions,        │
                    │     approvals, option gates)         │
                    │  2. the brief (now/soon/fyi + one    │
                    │     action each)                     │
                    │  3. one free-text line               │
                    └──────────────┬───────────────────────┘
                                   │ POST /api/chat?ws=1
                                   ▼
                     glance-handler / glance-curator slots
```

## The three parts

1. **Live blockers** — the only client-derived content, because an answer box
   must never be stale: pending questions, tool approvals (slot + background),
   and option/plan gates, mapped 1:1 from API state with zero judgment
   (`ui/brief.mjs # extractBlockers`). No urgency ramps, no NEW pills — if
   judgment is needed, the curator narrates it.

2. **The brief** — written by the curator cron (`curator.md` is the whole
   procedure; the manifest cron just points at it). Schema `v:1`:
   `headline`, up to 7 items `{id, priority: now|soon|fyi, text, session?,
   action?: {label, message}}`, and a `quiet` line for what was deliberately
   left out. The UI validates hard (`parseBrief`), renders in priority order,
   and shows a stale warning after 45 min (3 missed runs). The curator's
   judgment covers everything v1 approximated: stalls, capped loops,
   review-ready PRs, overnight completions.

3. **Delegation** — each brief item has at most one button: the curator's
   suggested action, or generic "Handle it". Both send a self-contained
   message into the `glance-handler` background slot via `POST /api/chat?ws=1`
   and flip to "✓ sent — open ↗". A free-text bar posts to the same slot.
   Refresh posts the curator procedure to `glance-curator`.

## Trust model

- The curator's read access uses an **app-scoped token** minted with the
  app's own `.app_secret` (`POST /api/apps/glance/token`) — deny-by-default,
  confined by the gateway to the four read endpoints in the manifest's
  `permissions.api`. Same credentialed pattern as upstream's
  ops-mission-control bridge.
- The UI rides the dashboard user's session, as in v1.
- `curator.md` forbids destructive `action.message` content, and the brief is
  validated (clamped, priority-normalized) before rendering — a malformed or
  hostile brief degrades to text, never to actions the user didn't click.

## What v2 deletes (and why that's the point)

classify cascade · urgency()/wait-age ramps · stall + near-cap detection ·
NEW pills + first-seen tracking · desktop notifications + dedup stores ·
delta flashes · search/filter · j/k keyboard nav · tab badge · quiet decay
buckets · 6 bespoke card types → 4 slim ones.

Each of these was the UI approximating judgment. The curator *has* judgment,
so the approximations go. Net: ~1,000 lines of UI → ~530 (of which 120 are
pure, tested logic), plus an 88-line prose procedure that is the actual
product.

## Files

| file | role |
|---|---|
| `app.json` | manifest: UI page + curator cron + `permissions.api` |
| `curator.md` | the curator procedure (collection → judgment → atomic write) |
| `ui/index.mjs` | the whole UI (~400 lines) |
| `ui/brief.mjs` | pure logic: `parseBrief`, `extractBlockers` (~120 lines) |
| `tests/brief.test.mjs` | 15 unit tests over the pure logic |
| `tests/render.test-harness.mjs` | SSR smoke: all board states render |

## v2.1 — guidance at scale

Feedback after running 10+ concurrent agents: the brief still narrated what
individual agents were doing, and unblocking meant opening sessions. v2.1
changes both sides:

- **Curator**: progress and completion items are banned. An item exists only
  when the human's input changes what happens next. Same-shaped blockers are
  grouped into one item. Max 5 items, `now`/`soon` only. A new `pulse` field
  carries the scale counts (`working` / `waiting` / `stalled`) so activity is
  one line, not seven items.
- **UI**: a pulse strip under the headline; a `guide…` input on brief items
  and choice/plan cards that sends free text straight into the session that
  needs steering; `Approve all N` (two-click confirm) when 2+ approvals are
  pending. Sent-state now records where a message went so "open ↗" lands in
  the right session.

`fyi` and pulse-less briefs still parse — the schema stays `v:1`, additive.

## v2.2 — parallel delegation + push on new blockers

- Each delegated brief action now runs in its own `glance-h-<item-id>` slot
  (`handlerSlotFor` in `ui/brief.mjs`) — ten clicks means ten concurrent
  sessions, not a queue behind one shared handler. The free-text bar keeps
  the shared `glance-handler` slot.
- The curator may publish at most one bell notification per run, only when a
  `now` item with a previously-unseen id appeared — so a newly blocked agent
  reaches the human without the Glance tab open. Everything else stays pull.

## v2.3 — sent-state survives reloads

Delegation markers lived in React state, so a page reload forgot which items
were already handed off — at 10+ agents that invites double-delegating. The
sent map now persists to localStorage (`glance-sent-v1`) as
`{ [itemId]: { slot, ts } }`, pruned on every brief load (`pruneSent`):
entries whose item id left the brief or older than 24h are dropped. SSR-safe
(localStorage guarded), storage failures degrade to session-only state.

## v2.3.1 — items must survive an active-work cross-check

Observed miss: the brief kept a "PR #2713 needs your fix-or-close call" item
alive after the human had already answered — his decision was baked into an
active babysit loop's goal message ("hard caps armed … close and file, no
asking"), and a fix agent was dispatched. The curator had the evidence in
hand (`/api/autonudge` returns each loop's full goal message) but the Judge
step never told it to look, and the stable-id rule let the previous brief's
item carry over unexamined. Two new Judge rules:

- Before emitting an item, scan active loops and running sessions for the
  item's subject (PR/issue number, session title). Covered by active work —
  including a pre-authorized decision inside a loop's mandate — means it is
  `working`, not "waiting on you".
- Carried-over ids are re-judged against current live state every run;
  stable ids are for UI dedup, not for keeping items alive.

## Known limits (v2.0)

- Brief freshness is poll-based (15 min + manual refresh); no push.
- `glance-handler` / `glance-curator` slots appear in the sidebar (no
  UI-side way to stamp `_app`; upstream #509 tracks app-owned worker slots).
- The curator costs one LLM turn per run; `every: 900` keeps that modest,
  and the live-blocker layer means staleness never blocks interaction.
