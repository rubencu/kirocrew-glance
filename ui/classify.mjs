// Glance classifier — pure functions, no React. Unit-tested in ../tests.
export const DAY = 86400
export const CAPPED_WINDOW = 2 * DAY
export const STALL_SECS = 600 // running turn with no activity this long → possibly stuck
export const STALL_ESCALATE_SECS = 1800 // no activity this long while running → attention card
export const NEAR_CAP_FRACTION = 0.8 // loop at ≥80% of its cap → early warning

export function toEpoch(v) {
  if (v == null) return 0
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v
  const p = Date.parse(v)
  return Number.isNaN(p) ? 0 : p / 1000
}

export function rel(ts, now) {
  if (!ts) return ''
  const d = Math.max(0, now - ts)
  if (d < 60) return 'now'
  if (d < 3600) return Math.floor(d / 60) + 'm'
  if (d < DAY) return Math.floor(d / 3600) + 'h'
  return Math.floor(d / DAY) + 'd'
}

export function loopKind(lp) {
  if ((lp.slot_key || '').startsWith('research-')) return 'research'
  if ((lp.stop_sentinel_path || '').includes('goal-stop')) return 'goal'
  return 'monitor'
}

export function loopGoal(lp) {
  const msg = lp.message || ''
  const m = msg.match(/^Goal:\s*(.+)$/m)
  return (m ? m[1] : msg.split('\n')[0]).slice(0, 160)
}

// Loop at ≥80% of its cycle cap or runtime budget → about to run out of rope.
export function loopNearCap(lp, now) {
  if (!lp.active) return false
  if (lp.max_cycles > 0 && lp.cycle_count >= NEAR_CAP_FRACTION * lp.max_cycles) return true
  if (lp.max_runtime_secs > 0) {
    const created = toEpoch(lp.created_ts)
    if (created && now - created >= NEAR_CAP_FRACTION * lp.max_runtime_secs) return true
  }
  return false
}

// When an active loop is expected to fire next (epoch secs), 0 if unknown.
// The idle gap is measured from turn END, so this is a floor, not a promise.
export function loopNextFire(lp) {
  const last = toEpoch(lp.last_fire_ts) || toEpoch(lp.created_ts)
  if (!last || !lp.idle_secs) return 0
  return last + lp.idle_secs
}

// Stable identity for an attention item — used for NEW pills and notification dedup.
export function itemKey(item) {
  if (item.kind === 'bgApproval') return 'bg-' + item.appr.id
  if (item.kind === 'question') return 'q-' + item.asks[0].ask_id
  return item.kind + '-' + item.slot.key
}

export function planOptions(s) {
  if (!s.has_options || !Array.isArray(s.options) || !s.options.length) return false
  const low = s.options.map((o) => String(o).trim().toLowerCase())
  return s.mode === 'orchestrator' && low.includes('go') && low.every((o) => ['go', 'go all', 'cancel'].includes(o))
}

// First match wins per slot:
// hidden (app-owned) → needsYou (question > approval > plan > choice > capped loop)
// → mission (active loop) → working (running turn) → quiet (decay buckets).
export function classify(data, now) {
  const { slots, loops, questions, approvals } = data
  const loopBySlot = new Map()
  for (const lp of loops) loopBySlot.set(lp.slot_key, lp)
  const qBySlot = new Map()
  for (const q of questions) {
    const arr = qBySlot.get(q.slot) || []
    arr.push(q)
    qBySlot.set(q.slot, arr)
  }
  const out = { needsYou: [], working: [], mission: [], quietToday: [], quietEarlier: [], older: [] }
  const matchedLoops = new Set()

  for (const s of slots) {
    if (s.app) continue // app-owned worker plumbing → surfaces via its loop instead
    const lp = loopBySlot.get(s.key)
    if (lp) matchedLoops.add(s.key)
    const lastTs = toEpoch(s.last_activity_ts) || toEpoch(s.created)
    const qs = qBySlot.get(s.key) || []

    if (qs.length) {
      out.needsYou.push({ kind: 'question', slot: s, asks: qs, waitTs: Math.min(...qs.map((q) => toEpoch(q.ts) || now)) })
    } else if (s.pending_approval) {
      out.needsYou.push({ kind: 'approval', slot: s, info: s.pending_approval_info || {}, waitTs: lastTs })
    } else if (planOptions(s)) {
      out.needsYou.push({ kind: 'plan', slot: s, waitTs: lastTs })
    } else if (s.has_options && Array.isArray(s.options) && s.options.length) {
      out.needsYou.push({ kind: 'choice', slot: s, waitTs: lastTs })
    } else if (lp && !lp.active && ['cycle_cap', 'runtime_budget'].includes(lp.stopped_reason) && now - toEpoch(lp.last_fire_ts) < CAPPED_WINDOW) {
      out.needsYou.push({ kind: 'capped', slot: s, loop: lp, waitTs: toEpoch(lp.last_fire_ts) })
    } else if ((s.running || s.orchestrating) && !s.stopping && lastTs > 0 && now - lastTs > STALL_ESCALATE_SECS) {
      // A turn hung this long needs a human whether or not a loop is bound.
      out.needsYou.push({ kind: 'stalled', slot: s, waitTs: lastTs })
    } else if (lp && lp.active) {
      out.mission.push({ slot: s, loop: lp, lastTs, nearCap: loopNearCap(lp, now) })
    } else if (s.running || s.orchestrating || s.stopping) {
      out.working.push({ slot: s, lastTs, stalled: !s.stopping && lastTs > 0 && now - lastTs > STALL_SECS })
    } else {
      const age = now - lastTs
      if (age < DAY) out.quietToday.push({ slot: s, lastTs })
      else if (age < 7 * DAY) out.quietEarlier.push({ slot: s, lastTs })
      else out.older.push({ slot: s, lastTs })
    }
  }

  // Loops with no visible slot (research campaigns, channel-bound monitors)
  for (const lp of loops) {
    if (matchedLoops.has(lp.slot_key) || !lp.active) continue
    out.mission.push({ slot: null, loop: lp, lastTs: toEpoch(lp.last_fire_ts) || toEpoch(lp.created_ts), nearCap: loopNearCap(lp, now) })
  }

  // Background approvals (cron/subagent sources) — always attention
  for (const a of approvals) {
    out.needsYou.push({ kind: 'bgApproval', appr: a, waitTs: toEpoch(a.ts) })
  }

  out.needsYou.sort((a, b) => (a.waitTs || 0) - (b.waitTs || 0)) // longest-waiting first
  out.working.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
  out.mission.sort((a, b) => (toEpoch(b.loop.last_fire_ts) || 0) - (toEpoch(a.loop.last_fire_ts) || 0))
  out.quietToday.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
  out.quietEarlier.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
  out.older.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
  return out
}
