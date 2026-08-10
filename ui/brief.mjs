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

// ---------- the brief (agent-written, we just validate) ----------

const PRIORITIES = new Set(['now', 'soon', 'fyi'])
export const STALE_AFTER = 2700 // 45 min = 3 missed 15-min curator runs
const MAX_ITEMS = 10

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
    items.push({
      id: typeof it.id === 'string' && it.id.trim() ? it.id.trim() : 'item-' + i,
      priority: PRIORITIES.has(it.priority) ? it.priority : 'fyi',
      text: it.text.trim().slice(0, 400),
      session: typeof it.session === 'string' ? it.session : '',
      action,
    })
  }
  // now first, then soon, then fyi; stable within a priority (curator's order).
  const rank = { now: 0, soon: 1, fyi: 2 }
  items.sort((a, b2) => rank[a.priority] - rank[b2.priority])
  return {
    ok: true,
    generatedAt,
    ageSecs,
    stale: ageSecs > STALE_AFTER,
    headline: typeof b.headline === 'string' ? b.headline.trim().slice(0, 140) : '',
    items,
    quiet: typeof b.quiet === 'string' ? b.quiet.trim().slice(0, 200) : '',
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
