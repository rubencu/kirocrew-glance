// Glance v2 pure logic — no React, no DOM. Testable with plain node.
//
// The paradigm split:
//   - brief.json     → the AGENT's judgment (curator cron writes it). We only
//                      parse + validate here; no client-side classification.
//   - live blockers  → the only thing the UI still derives itself, because an
//                      answer box must never be stale: pending questions,
//                      approvals, and option gates, mapped 1:1 from API state.

// ---------- time ----------

// Normalize secs / millis / ISO-string timestamps to epoch seconds.
export function toEpoch(x) {
  if (x == null) return 0
  if (typeof x === 'number') return x > 1e12 ? Math.floor(x / 1000) : Math.floor(x)
  const t = Date.parse(x)
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000)
}

// Past-relative duration: '45s' / '12m' / '3h' / '2d'.
export function rel(ts, now) {
  const d = Math.max(0, now - toEpoch(ts))
  if (d < 60) return Math.floor(d) + 's'
  if (d < 3600) return Math.floor(d / 60) + 'm'
  if (d < 86400) return Math.floor(d / 3600) + 'h'
  return Math.floor(d / 86400) + 'd'
}

// Future-relative duration: '45s' / '12m' / '3h' / '2d'; '' once due or past
// (the caller decides how to say "due now").
export function until(ts, now) {
  const d = toEpoch(ts) - now
  if (d <= 0) return ''
  if (d < 60) return Math.floor(d) + 's'
  if (d < 3600) return Math.floor(d / 60) + 'm'
  if (d < 86400) return Math.floor(d / 3600) + 'h'
  return Math.floor(d / 86400) + 'd'
}

// ---------- the brief (agent-written, we just validate) ----------

const PRIORITIES = new Set(['now', 'soon', 'fyi'])
export const STALE_AFTER = 2700 // 45 min = 3 missed 15-min curator runs
const MAX_ITEMS = 10
const MAX_CHOICES = 4

// Truncate at a word boundary with a visible ellipsis — a clamp that chops
// mid-word looks like a rendering bug and hides that anything was lost.
export function clip(s, max) {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…'
}

// Parse + validate the curator's brief.json content. Never throws.
// Returns { ok:false, error } or
// { ok:true, generatedAt, ageSecs, stale, headline, items, quiet }.
export function parseBrief(raw, now) {
  let b
  try { b = JSON.parse(raw) } catch (e) { return { ok: false, error: 'unparseable brief: ' + e.message } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'brief is not an object' }
  if (b.v !== 1) return { ok: false, error: 'unknown brief version: ' + String(b.v) }
  const generatedAt = toEpoch(b.generated_at)
  if (!generatedAt) return { ok: false, error: 'missing generated_at' }
  const ageSecs = Math.max(0, now - generatedAt)
  const items = []
  for (const [i, it] of (Array.isArray(b.items) ? b.items : []).entries()) {
    if (items.length >= MAX_ITEMS) break
    if (!it || typeof it !== 'object' || typeof it.text !== 'string' || !it.text.trim()) continue
    const action = it.action && typeof it.action === 'object'
      && typeof it.action.label === 'string' && it.action.label.trim()
      && typeof it.action.message === 'string' && it.action.message.trim()
      ? { label: it.action.label.trim().slice(0, 30), message: it.action.message.trim() }
      : null
    const session = typeof it.session === 'string' ? it.session : ''
    // Decision choices: one-click answers sent verbatim as guidance to the
    // item's OWN session — meaningless without one, so dropped when absent.
    const choices = session && Array.isArray(it.choices)
      ? it.choices
          .filter((c) => typeof c === 'string' && c.trim())
          .map((c) => c.trim().slice(0, 60))
          .slice(0, MAX_CHOICES)
      : []
    items.push({
      id: typeof it.id === 'string' && it.id.trim() ? it.id.trim() : 'item-' + i,
      priority: PRIORITIES.has(it.priority) ? it.priority : 'fyi',
      text: clip(it.text.trim(), 400),
      session,
      action,
      choices,
      // When the underlying blocker started waiting (0 = unknown). Clamped to
      // generated_at so a garbage future value cannot render a negative age.
      since: Math.min(toEpoch(it.since), generatedAt) || 0,
    })
  }
  // now first, then soon, then fyi; stable within a priority (curator's order).
  const rank = { now: 0, soon: 1, fyi: 2 }
  items.sort((a, b2) => rank[a.priority] - rank[b2.priority])
  // Pulse: agent counts at a glance (optional; additive to schema v1).
  const clampCount = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(Math.floor(x), 999) : 0)
  const pulse = b.pulse && typeof b.pulse === 'object' && !Array.isArray(b.pulse)
    ? { working: clampCount(b.pulse.working), waiting: clampCount(b.pulse.waiting), stalled: clampCount(b.pulse.stalled) }
    : null
  return {
    ok: true,
    generatedAt,
    ageSecs,
    stale: ageSecs > STALE_AFTER,
    headline: typeof b.headline === 'string' ? clip(b.headline.trim(), 140) : '',
    pulse,
    items,
    quiet: typeof b.quiet === 'string' ? clip(b.quiet.trim(), 200) : '',
  }
}

// ---------- live blockers (must never be stale → derived client-side) ----------

// Map raw API state to interactive blocker items. 1:1 mapping only — no
// urgency judgment here; that is the curator's job. One exception: option
// gates (choice/plan) older than 48h are dropped — sessions keep their last
// [OPTIONS] trailer forever, so without a recency gate every stale multi-day
// session floods the board. Questions and approvals are never gated: they
// block a live turn regardless of age.
// Returns [{ kind, waitTs, slot?, asks?, info?, appr?, plan? }] oldest-first.
export const OPTIONS_FRESH_SECS = 48 * 3600

export function extractBlockers({ slots = [], questions = [], approvals = [] }, now) {
  const byKey = new Map(slots.map((s) => [s.key, s]))
  const hidden = (s) => Boolean(s && s.app) // app-owned plumbing slots
  const out = []

  // Pending questions, grouped per slot: first ask is active, rest queued.
  const asksBySlot = new Map()
  for (const q of questions) {
    const k = q.slot || ''
    if (hidden(byKey.get(k))) continue
    if (!asksBySlot.has(k)) asksBySlot.set(k, [])
    asksBySlot.get(k).push(q)
  }
  for (const [k, asks] of asksBySlot) {
    asks.sort((a, b) => toEpoch(a.ts) - toEpoch(b.ts))
    out.push({ kind: 'question', slot: byKey.get(k) || null, asks, waitTs: toEpoch(asks[0].ts) })
  }

  for (const s of slots) {
    if (hidden(s)) continue
    if (s.pending_approval) {
      out.push({ kind: 'approval', slot: s, info: s.pending_approval_info || {}, waitTs: toEpoch(s.last_activity_ts) })
    } else if (s.has_options && Array.isArray(s.options) && s.options.length) {
      const waitTs = toEpoch(s.last_activity_ts)
      if (typeof now === 'number' && now - waitTs > OPTIONS_FRESH_SECS) continue // stale trailer, not a live gate
      out.push({ kind: 'choice', slot: s, plan: s.mode === 'orchestrator', waitTs })
    }
  }

  for (const a of approvals) {
    out.push({ kind: 'bgApproval', appr: a, waitTs: toEpoch(a.ts) })
  }

  out.sort((a, b) => a.waitTs - b.waitTs) // longest-waiting first
  return out
}

// Stable identity for a blocker (React keys, send-state tracking).
export function blockerKey(b) {
  if (b.kind === 'question') return 'q-' + b.asks[0].ask_id
  if (b.kind === 'bgApproval') return 'bga-' + b.appr.id
  return b.kind + '-' + (b.slot ? b.slot.key : '?')
}

// ---------- monitor loops (read-only ambient status) ----------

// Map the /api/autonudge payload to display rows. Read-only by design: the
// strip shows what the babysit loops are doing; controlling a loop stays in
// the session that owns it (and the dashboard's own loop popover). A loop's
// message is its full standing instruction — often a page of it — so only
// the first line is surfaced; that is the loop's self-given headline.
// Unlike blockers, app-owned slots are NOT hidden here: a loop on a
// plumbing slot is still a real loop the human may be waiting on.
export const LOOP_SUMMARY_MAX = 120

export function extractLoops(payload, slots, now) {
  const loops = payload && typeof payload === 'object' && Array.isArray(payload.loops) ? payload.loops : []
  const byKey = new Map((Array.isArray(slots) ? slots : []).map((s) => [s.key, s]))
  const out = []
  for (const lp of loops) {
    if (!lp || typeof lp !== 'object' || !lp.active) continue
    const slotKey = typeof lp.slot_key === 'string' ? lp.slot_key : ''
    const slot = byKey.get(slotKey)
    const firstLine = typeof lp.message === 'string' ? (lp.message.split('\n', 1)[0] || '').trim() : ''
    out.push({
      id: typeof lp.id === 'string' && lp.id ? lp.id : 'loop-' + slotKey,
      slotKey,
      title: (slot && slot.title) || slotKey,
      summary: clip(firstLine, LOOP_SUMMARY_MAX),
      cycle: typeof lp.cycle_count === 'number' && Number.isFinite(lp.cycle_count) ? lp.cycle_count : 0,
      maxCycles: typeof lp.max_cycles === 'number' && Number.isFinite(lp.max_cycles) ? lp.max_cycles : 0,
      nextDueTs: toEpoch(lp.next_due_ts),
      stalled: Boolean(lp.approval_stalled),
    })
  }
  // Soonest-firing first; loops with no scheduled fire sink to the bottom.
  const due = (l) => l.nextDueTs || Number.MAX_SAFE_INTEGER
  out.sort((a, b) => due(a) - due(b))
  return out
}

// ---------- delegation ----------

// Per-item handler slot, so ten delegated actions run in ten parallel
// sessions instead of queueing behind one shared handler. Derived from the
// item id (curator keeps ids stable), sanitized to a safe slot key.
export function handlerSlotFor(itemId) {
  const safe = String(itemId || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return 'glance-h-' + (safe || 'item')
}

// Fresh slot for each free-text "Tell the agent…" send: every message from
// that bar starts its OWN session instead of appending to one shared
// handler, so unrelated asks never share context or queue behind each
// other. The 'glance-h-' prefix keeps these inside the curator's
// own-plumbing exclusion (curator.md: glance-h-* is never curated). A short
// random suffix disambiguates two sends landing in the same millisecond.
export function freshChatSlot(nowMs = Date.now()) {
  return 'glance-h-chat-' + nowMs.toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

// ---------- sent-state ----------

// Sent-state persists across reloads (localStorage) so an already-delegated
// item is not delegated twice. Entries: { [itemId]: { slot, ts } }.
// Prune: keep only well-formed entries whose id is still in the brief and
// younger than the TTL — resolved items must not pin storage forever.
export const SENT_TTL_SECS = 24 * 3600

export function pruneSent(sent, itemIds, now) {
  const ids = new Set(itemIds)
  const keep = {}
  for (const [id, v] of Object.entries(sent && typeof sent === 'object' ? sent : {})) {
    if (!v || typeof v !== 'object') continue
    if (typeof v.slot !== 'string' || !v.slot) continue
    if (typeof v.ts !== 'number' || !Number.isFinite(v.ts) || now - v.ts > SENT_TTL_SECS) continue
    if (!ids.has(id)) continue
    keep[id] = { slot: v.slot, ts: v.ts }
  }
  return keep
}
