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

## v2.3.2 — the curator must not report its own output

Observed miss: a brief item ("summary of your four unanswered threads is
ready in a session with an options card") pointed at
`glance-h-stale-user-followups` — Glance's OWN delegation slot, created when
the human clicked a previous item's action button. The helper finished with
a summary and an `[OPTIONS]` trailer; the curator then saw a session gated
on the human and itemized it. Circular: the item's subject was the brief's
own delegated output, the UI already rendered that options card live at the
top of the board, and re-judging (v2.3.1) could never kill it because the
session genuinely stays gated forever. Two new Judge rules:

- `glance-h-*` / `glance-handler` / `glance-curator` slots are Glance's own
  plumbing — never an item, never an item's `session`, excluded from pulse
  (the `app` field can't be stamped on them yet; upstream #509).
- Option gates joined questions and approvals in the "live cards, counts
  only" rule: a fresh `[OPTIONS]` trailer is a live choice card the UI
  already shows, so it is counted, never itemized; one older than 48h is
  dead scrollback — neither an item nor `waiting`.

Also bumped the UI header's hardcoded `VERSION` (stuck at 2.3.0 since the
2.3.1 release).

## v2.3.3 — grouped actions must stay coherent

Observed miss: the curator compressed two unrelated dropped requests into a
single "Resume both" item. That saved one card but sent different repositories,
expertise, and success checks into one helper slot. The UI could then only say
that the combined item was sent; it could not show which workstream had
finished, retry one independently, or let both run in parallel.

Grouping now requires one shared decision or instruction. The curator applies a
concrete test: if one short, self-contained action cannot resolve every member
without becoming a numbered multi-task checklist, the subjects remain separate
items (within the five-item cap). Similar status alone — "dropped," "old," or
"unhealthy" — is not a reason to bundle unrelated work.

## v2.3.4 — external gates are not "needs you now"

Observed miss: the brief's only `now` item said a fork PR's CI was blocked on
an upstream maintainer's "Approve and run workflows" click. The human has
read-only access upstream and cannot perform that click, and a monitor loop
was already polling the PR. The card claimed the top urgency slot, offered no
action, and nothing the human did could change what happened next — a
progress report wearing a `now` badge.

The priority model only knew two states: blocked-on-human (`now`) and
needs-human-soon (`soon`). Work blocked on a third party fit neither, so the
curator promoted it by importance instead of by actionability. New Judge
rule: `now` requires naming the human's concrete move that ends the wait.
An externally-gated item is `working` while agents cover it; once the
external wait passes ~24h it may surface as ONE `soon` escalation card whose
action is the move an agent can actually execute (post a status comment on
the PR requesting workflow approval, look for an alternate reviewer). An
action-less card for an external gate is never emitted.

## v2.3.5 — blocker attribution must come from evidence

Observed miss, on the first run under v2.3.4: the same external-gate item
survived as `now` by flipping its attribution. The previous brief said the
wait was on "the maintainer's 'Approve and run workflows' click — someone
with write access"; the new run, judging identical live state, re-worded it
to "your 'Approve and run workflows' click". The v2.3.4 rule made
attribution load-bearing (`now` requires a move the human can make) but
gave no discipline for where attribution comes from, so the curator guessed
the flattering version.

New Judge rule: who can end a wait must come from the live evidence — the
covering session's or loop's own words, or the previous brief's finding.
Evidence naming a third party is believed, not re-attributed. Ambiguity
resolves to external (the weaker claim): a wrongly-demoted item costs one
late escalation card, while a false "your click" teaches the human to
distrust every `now`.

## v2.3.6 — prior briefs may demote attribution, never promote it

Observed miss, on the first run under v2.3.5: the "your click" item
survived again. Mechanism: v2.3.5 listed "the previous brief's finding" as
valid attribution evidence, and by then the wrong "your click" WAS the
previous brief's finding — each run cited the last run, laundering the
guess into evidence. The rule intended to stop invented attribution had
created a self-citation channel for it.

Fixed with an asymmetry. The previous brief is one-way evidence: it may
confirm a gate is external (demote), but it can never establish that the
human holds the key (promote). Human attribution must be re-earned from
the LIVE words read this run — the covering session's or loop's own text.
When the live words are silent or ambiguous about who holds the key, the
gate is external, the weaker claim.

## v2.3.7 — stalled is a judgment, not a timer

Observed miss: a brief reported `pulse.stalled: 1` while its own `quiet`
line explained that the counted session was "stalled only by the 15-min
rule (18 min silent, likely a long gate run)" — the curator disbelieved its
own count and published it anyway, rendered in warning color. On this host
sessions routinely go silent for 20–60 minutes inside legitimate gates
(full test suites, builds, CI polling), so the mechanical rule cries wolf,
and a warning the reader learns to ignore hides the real stall when it
comes.

`stalled` was the last purely mechanical verdict left in the brief — the
v2 thesis is that the agent reads so the human can glance, and every other
signal already passed through judgment. Now silence >15 min is only the
trigger to look: the curator reads the quiet session's `last_message`, and
a long-running gate legitimately in progress counts as `working` no matter
how long the silence. `stalled` is reserved for unexplained silence or
visible distress. A coherence rule backs it: never publish a count your
own `quiet` line argues against.

## v2.4.0 — decisions are answered, not delegated

Observed miss, from a visual QA pass rendering the live brief through the
real Board: the top `now` card said "only your call ends the wait" and
named the three options in its own prose (squash with force-with-lease,
fresh single-commit PR, leave it) — yet its affordances were "Handle it",
which spawns a helper agent to make a decision only the human can make,
and a free-text guide box requiring the human to retype a choice the
curator had already written out. The schema had no way to hand the
decision's options to the UI.

Items gain an optional `choices` field: 2–4 short answers in the human's
voice, valid only alongside a `session`. The UI renders each as a
one-click button that sends the label verbatim as guidance to the item's
own session — clicking one is the human answering the waiting agent's
question, the same routing as guide… with the typing removed. Choices
displace the delegate button on decision items; freeform guide… stays.
The curator may only list options the waiting agent itself offered (its
options trailer, its question, its last message) — never invented
alternatives, never a destructive addition of its own.

## v2.4.1 — choices survive heartbeat scroll-out

Observed miss, on the first run under v2.4.0: the live decision item kept
naming its three options in prose but emitted no `choices`. The waiting
monitor's recent messages were all heartbeats ("No material change;
monitoring continues") — the original offer had scrolled out of the one
message the curator can read, so the evidence-sourced rule correctly
found no live options to cite. A persistent decision gate watched by a
heartbeat-posting monitor is the COMMON case, and the rule as written
could never fire for it.

Choices may now also carry over verbatim from the same item (matching
`id`) in the previous brief. This is not the v2.3.6 laundering channel:
carry-over republishes content the item already displayed — the buttons
carry exactly the claim the text carries — and grants no authority
upgrade. The item must still re-earn its place every run; when it drops
or is re-keyed, its choices die with it.

## v2.5.0 — items carry their age

Observed gap: all three live items had been on the board for ~3 hours, but
neither the schema nor the UI carried that fact — every card rendered as
if freshly minted. The live-blocker cards below the brief already show
wait ages ("QUESTION · 15m"); the brief items, the top of the board, had
no age dimension. On a triage surface age is salience: a 6-hour nag and a
5-minute blocker must not look identical.

Items gain an optional `since` (epoch when the underlying blocker started
waiting). New items take it from evidence timestamps when the state read
carries one, else the run's time; carried-over ids keep the previous
brief's value unchanged — a blocker does not restart because the brief
regenerated. The UI appends a muted "· waiting 6h" chip after the item
text once the wait exceeds one curator cycle (15 min), in the same
language as the live-card wait pills. Future-dated values clamp to
`generated_at` so an age can never render negative.

## v2.5.1 — a missing clock self-heals

Observed on the first two v2.5.0 runs: the decision item got an
evidence-grade `since` (the real ~25h-old timestamp, held stable across
runs), but the two items predating the field stayed clock-less — and the
carry-over rule as written kept them clock-less forever, since each run
faithfully carried the previous run's omission. Any future run that
dropped the field once would have the same permanent effect.

Amendment: when a carried item's previous entry has no `since`, backfill
it now — from evidence, else the run's time — instead of carrying the
omission forward. A late-started clock understates the wait; no clock
hides it.

## v2.5.2 — the quiet line must fit its budget

Observed miss: the live quiet line ran 314 characters against the UI's
200-character clamp, so the board showed it chopped mid-word ("PR #4555
stay") — and what got cut was exactly the reassurance half ("no
questions, approvals … 77 idle sessions"), the clauses that make a quiet
line worth reading. The line had also drifted into per-session narration
("mid GPT review round, active 1m ago"), the reading the v2.1 no-narration
policy exists to spare.

Two-sided fix. Curator: `quiet` gets a hard 200-character budget spent on
counts and categories, not named sessions — naming individual sessions in
`quiet` is narrating; and the reassurance clauses must never be the part
at risk of being cut. Parser: headline, item text, and quiet now truncate
at a word boundary with a visible ellipsis instead of a silent mid-word
slice — an over-budget line degrades honestly. Choice labels keep the
hard slice: they are sent verbatim to sessions, and an added ellipsis
would corrupt the guidance.

## Known limits (v2.0)

- Brief freshness is poll-based (15 min + manual refresh); no push.
- `glance-handler` / `glance-curator` slots appear in the sidebar (no
  UI-side way to stamp `_app`; upstream #509 tracks app-owned worker slots).
- The curator costs one LLM turn per run; `every: 900` keeps that modest,
  and the live-blocker layer means staleness never blocks interaction.
