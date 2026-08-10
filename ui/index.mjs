// Glance — auto-triaged session board.
// Pure-UI KiroCrew app: reads existing gateway endpoints, classifies every
// session into Needs You / Working / On a Mission / Quiet. Zero management.
// v1.1: density-first layout — full width, card grid, 2-line tiles, quiet chips.
// v1.2: proactive — desktop notifications, stall detection, loop near-cap
// early warning, attention aging, NEW pills. Still zero management.
// v1.3: act from the board — stop hung turns, resume capped loops, next-fire ETA.
// v1.4: urgency hierarchy — attention colors decoupled from the theme accent,
// wait-age escalates cards (pill + border), equal-height cards, wide-viewport
// fill, question-card compression, surfaced action failures, memoized classify.
import { useState, useEffect, useRef, useCallback, useMemo, createElement as h, Fragment } from 'react'
import { useNavigate } from '@kirocrew/app-sdk'
import { classify, toEpoch, rel, loopKind, loopGoal, itemKey, loopNextFire } from './classify.mjs'

const VERSION = '1.4.0'
const ACCENT = 'var(--accent, #7c3aed)'
const ACCENT_TINT = 'rgba(124, 58, 237, .14)'
// Urgency hue for "Needs you" — deliberately NOT the theme accent. With a green
// accent theme, accent-colored attention cards read "healthy" and disappear
// next to the Working section; a fixed violet keeps "act on me" distinct on
// every theme, and green stays reserved for health.
const AIM = '#8b5cf6'
const AIM_TINT = 'rgba(139, 92, 246, .16)'
const DANGER = 'var(--danger, #b91c1c)'
const DANGER_TINT = 'rgba(185, 28, 28, .12)'
const OK = 'var(--ok, #047857)'
const WARN = '#b45309'
const WARN_TINT = 'rgba(180, 83, 9, .14)'

// Future-duration formatter (rel() is past-only).
function fut(secs) {
  if (secs < 60) return 'soon'
  if (secs < 3600) return 'in ' + Math.floor(secs / 60) + 'm'
  return 'in ' + Math.floor(secs / 3600) + 'h'
}

// ---------- data ----------

async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(url + ' → ' + r.status)
  return r.json()
}

async function loadAll() {
  const [slots, nudge, questions, approvals] = await Promise.all([
    fetchJson('/api/chat/slots'),
    fetchJson('/api/autonudge').catch(() => ({ loops: [] })),
    fetchJson('/api/ask-question/pending').catch(() => []),
    fetchJson('/api/approvals').catch(() => []),
  ])
  const loops = Array.isArray(nudge) ? nudge : (nudge.loops || [])
  const appr = Array.isArray(approvals) ? approvals : (approvals.approvals || approvals.pending || [])
  return {
    slots: Array.isArray(slots) ? slots : [],
    loops, questions: Array.isArray(questions) ? questions : [], approvals: appr,
  }
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url)
  return r
}

// Shared action state: busy flag + surfaced failure. Actions must never fail
// silently — a failed Approve that looks like success reads as a board glitch
// when the card resurrects on the next poll.
function useAction(fn) {
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')
  const run = async (...args) => {
    setBusy(true)
    setFail('')
    try { await fn(...args) } catch (e) { setFail(String(e && e.message ? e.message : e)) } finally { setBusy(false) }
  }
  return [run, busy, fail]
}

function FailNote({ fail }) {
  if (!fail) return null
  return h('div', { style: { fontSize: 10, color: DANGER, marginTop: 4 } }, '⚠ action failed: ' + fail)
}

// ---------- attention freshness + notifications (localStorage-backed) ----------

const SEEN_KEY = 'glance-seen-v1'       // { itemKey: firstSeenEpoch } — drives NEW pills
const NOTIFIED_KEY = 'glance-notified-v1' // { itemKey: 1 } — desktop-notification dedup
const NOTIFY_PREF_KEY = 'glance-notify-v1'
const NEW_WINDOW = 300 // NEW pill shows for 5 min after an item first appears

function readStore(k) {
  try { return JSON.parse(localStorage.getItem(k) || '{}') } catch { return {} }
}
function writeStore(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode etc. */ }
}

function sameMap(a, b) {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

// Track first-seen per attention item; returns the updated map. Items that
// resolved are dropped so a re-appearance counts as new again. A completely
// empty store (first ever visit) is seeded as already-seen to avoid a NEW burst.
function trackSeen(keys, now) {
  const seen = readStore(SEEN_KEY)
  const empty = Object.keys(seen).length === 0
  const next = {}
  for (const k of keys) next[k] = k in seen ? seen[k] : (empty ? now - NEW_WINDOW - 1 : now)
  if (!sameMap(seen, next)) writeStore(SEEN_KEY, next) // most polls change nothing
  return next
}

// Fire a desktop notification once per attention item (dedup persisted).
// Click focuses the dashboard and jumps to the session.
function notifyNew(items, enabled, navigate) {
  if (!enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const notified = readStore(NOTIFIED_KEY)
  const next = {}
  for (const item of items) {
    const k = itemKey(item)
    next[k] = 1
    if (notified[k]) continue
    const title = item.slot ? (item.slot.title || item.slot.key) : ((item.appr && item.appr.source) || 'background')
    const kindLabel = { question: 'has a question', approval: 'wants an approval', bgApproval: 'wants an approval', plan: 'plan awaits Go', choice: 'offers choices', capped: 'loop ran out of rope', stalled: 'looks stalled (30m+ without activity)' }[item.kind] || 'needs you'
    const slotKey = item.slot ? item.slot.key : ''
    try {
      const n = new Notification('Glance — ' + title, { body: kindLabel, tag: 'glance-' + k })
      n.onclick = () => {
        window.focus()
        if (slotKey && navigate) navigate('/chat?sid=' + encodeURIComponent(slotKey))
        n.close()
      }
    } catch { /* notification construction can throw on some platforms */ }
  }
  if (!sameMap(notified, next)) writeStore(NOTIFIED_KEY, next) // pruned to live items — re-appearance re-notifies
}

// Wait-age escalation for attention cards. The pill and left border shift from
// the kind's base color to amber (≥1h) then red (≥4h), and the wait-age joins
// the label text — the board's most important fact rendered big, not as a
// 10px corner footnote. Never downgrades a card whose base is already hotter.
function urgency(item, now, base, baseTint) {
  const d = now - (item.waitTs || now)
  if (base !== DANGER && d >= 4 * 3600) return { color: DANGER, tint: DANGER_TINT, hot: true }
  if (base !== DANGER && base !== WARN && d >= 3600) return { color: WARN, tint: WARN_TINT, hot: true }
  return { color: base, tint: baseTint, hot: d >= 3600 }
}

// ---------- shared bits ----------

function Dot({ color, pulse }) {
  return h('span', {
    style: {
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color,
      flexShrink: 0, animation: pulse ? 'glancePulse 1.6s ease-in-out infinite' : 'none',
    },
  })
}

function Pill({ bg, fg, children }) {
  return h('span', {
    style: {
      background: bg, color: fg, padding: '0 7px', borderRadius: 9999,
      fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, lineHeight: '16px',
    },
  }, children)
}

function GhostBtn({ onClick, disabled, children, danger }) {
  return h('button', {
    onClick, disabled,
    style: {
      background: 'transparent', color: disabled ? 'var(--muted)' : (danger ? DANGER : ACCENT),
      border: `1px solid ${danger ? DANGER : ACCENT_TINT}`, padding: '3px 11px', borderRadius: 9999,
      fontSize: 11, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
    },
  }, children)
}

function SolidBtn({ onClick, disabled, children }) {
  return h('button', {
    onClick, disabled,
    style: {
      background: disabled ? 'var(--border)' : ACCENT, color: disabled ? 'var(--muted)' : 'var(--accent-fg, #fff)',
      border: 'none', padding: '3px 13px', borderRadius: 9999,
      fontSize: 11, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
    },
  }, children)
}

function SlotTitle({ slot, navigate }) {
  return h('span', {
    onClick: (e) => { e.stopPropagation(); navigate('/chat?sid=' + encodeURIComponent(slot.key)) },
    title: slot.title || slot.key,
    style: {
      fontWeight: 600, fontSize: 12, color: 'var(--text)', cursor: 'pointer',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },
  }, slot.title || slot.key)
}

function ellip(txt, style) {
  return h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...style } }, txt)
}

function Section({ id, label, color, count, grid, children }) {
  if (!count) return null
  return h('div', { id, style: { marginBottom: 9 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
      h('span', { style: { fontSize: 12, fontWeight: 600, color } }, label),
      h('span', { style: { fontSize: 11, color: 'var(--muted)' } }, String(count)),
    ),
    h('div', { style: grid }, children),
  )
}

// auto-fit (not auto-fill) so tracks collapse and content uses the full width on
// wide viewports; default stretch (no alignItems:start) so short cards next to
// tall neighbors fill the row instead of stranding dead background pockets.
const CARD_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8 }
const TILE_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 6 }
const CHIP_FLOW = { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }

// ---------- attention cards ----------

function card(children, accent) {
  return h('div', {
    style: {
      background: 'var(--card, var(--bg))', border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`, borderRadius: 6, padding: '9px 11px', minWidth: 0,
    },
  }, children)
}

function CardHeader({ item, now, navigate, label, base, baseTint, fresh, extra }) {
  const s = item.slot
  const u = urgency(item, now, base, baseTint)
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minWidth: 0 } },
    h(Pill, { bg: u.tint, fg: u.color }, u.hot ? label + ' · ' + rel(item.waitTs, now) : label),
    fresh ? h(Pill, { bg: AIM, fg: '#fff' }, 'NEW') : null,
    extra || null,
    s ? h(SlotTitle, { slot: s, navigate }) : null,
    u.hot ? null : h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--muted)', flexShrink: 0 } },
      rel(item.waitTs, now)),
  )
}

function QuestionCard({ item, now, navigate, onDone, fresh }) {
  const [answers, setAnswers] = useState({})
  const [text, setText] = useState({})
  const [custom, setCustom] = useState({}) // custom-answer input revealed on demand
  const ask = item.asks[0]
  const qs = (ask.questions || []).map((q) => ({
    text: String(q.question ?? q.text ?? ''),
    options: (q.options || []).map((o) => String(o?.label ?? o)),
  }))

  const [submit, busy, fail] = useAction(async (final) => {
    await post('/api/ask-question/' + encodeURIComponent(ask.ask_id) + '/answer', { answers: final })
    onDone()
  })
  const pick = (qt, val) => {
    const next = { ...answers, [qt]: val }
    setAnswers(next)
    if (qs.every((q) => next[q.text])) submit(next)
  }
  const queued = item.asks.length - 1

  return card([
    h(CardHeader, {
      key: 'h', item, now, navigate, label: 'QUESTION', base: AIM, baseTint: AIM_TINT, fresh,
      extra: queued > 0 ? h(Pill, { bg: 'var(--border)', fg: 'var(--muted)' }, '+' + queued + ' queued') : null,
    }),
    ...qs.map((q, i) => h('div', { key: i, style: { marginBottom: 4 } },
      h('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 5, whiteSpace: 'pre-wrap' } }, q.text),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
        ...q.options.map((o, j) => h(GhostBtn, {
          key: j, disabled: busy,
          onClick: () => pick(q.text, o),
        }, answers[q.text] === o ? '✓ ' + o : o)),
        custom[q.text]
          ? h('input', {
              placeholder: 'custom…', disabled: busy, autoFocus: true,
              value: text[q.text] || '',
              onChange: (e) => setText({ ...text, [q.text]: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter' && (text[q.text] || '').trim()) pick(q.text, text[q.text].trim()) },
              style: {
                background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
                borderRadius: 9999, padding: '2px 9px', fontSize: 11, width: 110, outline: 'none',
              },
            })
          : h('button', {
              disabled: busy,
              onClick: () => setCustom({ ...custom, [q.text]: true }),
              style: {
                background: 'transparent', color: 'var(--muted)', border: '1px dashed var(--border)',
                borderRadius: 9999, padding: '2px 9px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
              },
            }, 'custom…'),
      ),
    )),
    h(FailNote, { key: 'f', fail }),
  ], urgency(item, now, AIM, AIM_TINT).color)
}

function ApprovalCard({ item, now, navigate, onDone, fresh }) {
  const s = item.slot
  const info = item.info
  const preview = typeof info.tool_input === 'string' ? info.tool_input : JSON.stringify(info.tool_input || {})
  const [act, busy, fail] = useAction(async (action) => {
    await post('/api/chat/slots/' + encodeURIComponent(s.key) + '/approve', { action, request_id: info.request_id || '' })
    onDone()
  })
  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: 'APPROVAL', base: WARN, baseTint: WARN_TINT, fresh }),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      h('code', null, (info.tool || 'tool') + '  ' + preview.slice(0, 140))),
    h('div', { key: 'a', style: { display: 'flex', gap: 5 } },
      h(SolidBtn, { disabled: busy, onClick: () => act('approved') }, 'Approve'),
      h(GhostBtn, { disabled: busy, danger: true, onClick: () => act('rejected') }, 'Deny'),
    ),
    h(FailNote, { key: 'f', fail }),
  ], urgency(item, now, WARN, WARN_TINT).color)
}

function BgApprovalCard({ item, now, onDone, fresh }) {
  const a = item.appr
  const u = urgency(item, now, WARN, WARN_TINT)
  const [act, busy, fail] = useAction(async (action) => {
    await post('/api/approvals/' + encodeURIComponent(a.id) + '/' + action)
    onDone()
  })
  return card([
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
      h(Pill, { bg: u.tint, fg: u.color }, u.hot ? 'APPROVAL · ' + rel(item.waitTs, now) : 'APPROVAL'),
      fresh ? h(Pill, { bg: AIM, fg: '#fff' }, 'NEW') : null,
      h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--text)' } }, a.source || 'background'),
      u.hot ? null : h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' } }, rel(item.waitTs, now)),
    ),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      h('code', null, (a.tool || '') + '  ' + String(a.tool_purpose || '').slice(0, 120))),
    h('div', { key: 'a', style: { display: 'flex', gap: 5 } },
      h(SolidBtn, { disabled: busy, onClick: () => act('approve') }, 'Approve'),
      h(GhostBtn, { disabled: busy, danger: true, onClick: () => act('reject') }, 'Deny'),
    ),
    h(FailNote, { key: 'f', fail }),
  ], u.color)
}

function ChoiceCard({ item, now, navigate, onDone, plan, fresh }) {
  const s = item.slot
  const [act, busy, fail] = useAction(async (opt) => {
    if (plan) {
      await post('/api/chat/slots/' + encodeURIComponent(s.key) + '/plan-action', { action: opt.toLowerCase() })
    } else {
      await post('/api/chat?ws=1', { message: opt, slot: s.key })
    }
    onDone()
  })
  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: plan ? 'PLAN GATE' : 'CHOICE', base: AIM, baseTint: AIM_TINT, fresh }),
    s.prompt_preview ? h('div', { key: 'p', style: { fontSize: 11, color: 'var(--muted)', marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } },
      String(s.prompt_preview).slice(0, 200)) : null,
    h('div', { key: 'o', style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
      ...s.options.map((o, i) => h(GhostBtn, { key: i, disabled: busy, onClick: () => act(String(o)) }, String(o)))),
    h(FailNote, { key: 'f', fail }),
  ], urgency(item, now, AIM, AIM_TINT).color)
}

function CappedCard({ item, now, navigate, onDone, fresh }) {
  const lp = item.loop
  const s = item.slot
  const capDesc = lp.stopped_reason === 'cycle_cap' ? 'cycle cap (' + lp.cycle_count + ')' : 'runtime budget'
  const [resume, busy, fail] = useAction(async () => {
    // Background message into the same slot: the agent re-arms its own loop.
    await post('/api/chat?ws=1', {
      slot: s.key,
      message: 'Your monitoring loop stopped after hitting its ' + capDesc +
        ' without meeting the exit condition. If the goal is still worth pursuing, re-arm the loop' +
        ' (monitor_start, or monitor_update with a higher cap) and continue; otherwise summarize' +
        ' where things stand and what you need from me. Goal: ' + loopGoal(lp),
    })
    onDone()
  })
  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: 'LOOP ENDED', base: WARN, baseTint: WARN_TINT, fresh }),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6 } },
      'Hit its ' + capDesc + ' without finishing: ' + loopGoal(lp)),
    h('div', { key: 'a', style: { display: 'flex', gap: 5, alignItems: 'center' } },
      h(SolidBtn, { disabled: busy, onClick: resume }, busy ? 'Resuming…' : 'Resume loop'),
      h('span', { style: { fontSize: 10, color: 'var(--muted)' } }, 'asks the agent to re-arm and continue'),
    ),
    h(FailNote, { key: 'f', fail }),
  ], urgency(item, now, WARN, WARN_TINT).color)
}

function StalledCard({ item, now, navigate, onDone, fresh }) {
  const s = item.slot
  const [stop, busy, fail] = useAction(async () => {
    // Cooperative stop — same endpoint as the chat UI's Stop button.
    await post('/api/chat/slots/' + encodeURIComponent(s.key) + '/stop')
    onDone()
  })
  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: 'STALLED', base: DANGER, baseTint: DANGER_TINT, fresh }),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6 } },
      'Running with no activity for ' + rel(item.waitTs, now) + ' — the turn may be hung.' +
      (s.last_message ? ' Last: ' + String(s.last_message).slice(0, 120) : '')),
    h('div', { key: 'a', style: { display: 'flex', gap: 5, alignItems: 'center' } },
      h(GhostBtn, { disabled: busy, danger: true, onClick: stop }, busy ? 'Stopping…' : 'Stop turn'),
      h('span', { style: { fontSize: 10, color: 'var(--muted)' } }, 'cooperative stop — click title to inspect first'),
    ),
    h(FailNote, { key: 'f', fail }),
  ], DANGER)
}

// ---------- tiles (working / mission) ----------

function tileStyle() {
  return {
    border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px',
    cursor: 'pointer', minWidth: 0, background: 'var(--card, var(--bg))',
  }
}

function tileHover(e, on) { e.currentTarget.style.borderColor = on ? ACCENT : 'var(--border)' }

function WorkTile({ item, now, navigate }) {
  const s = item.slot
  const sub = s.stopping ? 'stopping…' : (s.last_message || '')
  return h('div', {
    style: tileStyle(),
    title: item.stalled ? 'No activity for ' + rel(item.lastTs, now) + ' while running — the turn may be stuck' : undefined,
    onClick: () => navigate('/chat?sid=' + encodeURIComponent(s.key)),
    onMouseEnter: (e) => tileHover(e, true), onMouseLeave: (e) => tileHover(e, false),
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h(Dot, { color: item.stalled ? WARN : OK, pulse: !item.stalled }),
      ellip(s.title || s.key, { fontWeight: 600, fontSize: 12, flex: 1 }),
      item.stalled ? h(Pill, { bg: WARN_TINT, fg: WARN }, 'stalled ' + rel(item.lastTs, now)) : null,
      s.queue_depth > 0 ? h(Pill, { bg: ACCENT_TINT, fg: ACCENT }, '+' + s.queue_depth) : null,
      h('span', { style: { fontSize: 10, color: 'var(--muted)', flexShrink: 0 } }, rel(item.lastTs, now)),
    ),
    // No blank second line when there is no preview — free density win.
    sub ? h('div', { style: { fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 } }, sub) : null,
  )
}

const LOOP_LABEL = { research: '🔬', goal: '🎯', monitor: '👁' }

function MissionTile({ item, now, navigate }) {
  const { slot: s, loop: lp } = item
  const kind = loopKind(lp)
  const running = s && (s.running || s.orchestrating)
  const nf = loopNextFire(lp)
  const title = s ? (s.title || s.key) : (kind === 'research' ? 'Research ' + lp.slot_key.slice(9, 17) : lp.slot_key)
  return h('div', {
    style: tileStyle(),
    onClick: () => { if (s) navigate('/chat?sid=' + encodeURIComponent(s.key)) },
    onMouseEnter: (e) => tileHover(e, true), onMouseLeave: (e) => tileHover(e, false),
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h('span', { style: { fontSize: 13, flexShrink: 0 } }, LOOP_LABEL[kind]),
      running ? h(Dot, { color: OK, pulse: true }) : null,
      ellip(title, { fontWeight: 600, fontSize: 12, flex: 1 }),
      h('span', { style: { fontSize: 10, color: 'var(--muted)', flexShrink: 0 } }, rel(toEpoch(lp.last_fire_ts), now)),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginTop: 1 } },
      ellip(loopGoal(lp), { fontSize: 11, color: 'var(--muted)', flex: 1 }),
      !running && nf ? h('span', { style: { fontSize: 10, color: 'var(--muted)', flexShrink: 0 } },
        nf > now ? fut(nf - now) : 'due') : null,
      h(Pill, item.nearCap ? { bg: WARN_TINT, fg: WARN } : { bg: ACCENT_TINT, fg: ACCENT },
        (item.nearCap ? '⚠ ' : '') + lp.cycle_count + '/' + (lp.max_cycles || '∞')),
    ),
  )
}

// ---------- quiet chips ----------

function QuietChip({ item, now, navigate, dim }) {
  const s = item.slot
  return h('span', {
    onClick: () => navigate('/chat?sid=' + encodeURIComponent(s.key)),
    title: s.title || s.key,
    onMouseEnter: (e) => { e.currentTarget.style.borderColor = ACCENT },
    onMouseLeave: (e) => { e.currentTarget.style.borderColor = 'var(--border)' },
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 220,
      border: '1px solid var(--border)', borderRadius: 9999, padding: '1px 9px',
      fontSize: 11, color: 'var(--text)', cursor: 'pointer', opacity: dim ? 0.55 : 0.85,
      whiteSpace: 'nowrap', lineHeight: '18px',
    },
  },
    ellip(s.title || s.key, {}),
    h('span', { style: { fontSize: 10, color: 'var(--muted)', flexShrink: 0 } }, rel(item.lastTs, now)),
  )
}

// ---------- board (pure presentational — exported for render tests) ----------

export function Board({ c, now, navigate, onAction, showOlder, setShowOlder, firstSeen }) {
  const fs = firstSeen || {}
  const total = c.needsYou.length + c.working.length + c.mission.length +
    c.quietToday.length + c.quietEarlier.length + c.older.length
  if (!total) {
    return h('div', { style: { border: '1px dashed var(--border)', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: 'var(--muted)' } },
      'No sessions yet — the board fills in as agents pick up work.')
  }
  return h(Fragment, null,
    h(Section, { id: 'glance-sec-needs', label: 'Needs you', color: AIM, count: c.needsYou.length, grid: CARD_GRID },
      ...c.needsYou.map((item) => {
        const key = itemKey(item) // identity key — a NEW question on the same slot must not inherit typed state
        const fresh = now - (fs[key] || 0) < NEW_WINDOW
        if (item.kind === 'question') return h(QuestionCard, { key, item, now, navigate, onDone: onAction, fresh })
        if (item.kind === 'approval') return h(ApprovalCard, { key, item, now, navigate, onDone: onAction, fresh })
        if (item.kind === 'bgApproval') return h(BgApprovalCard, { key, item, now, onDone: onAction, fresh })
        if (item.kind === 'plan') return h(ChoiceCard, { key, item, now, navigate, onDone: onAction, plan: true, fresh })
        if (item.kind === 'choice') return h(ChoiceCard, { key, item, now, navigate, onDone: onAction, plan: false, fresh })
        if (item.kind === 'stalled') return h(StalledCard, { key, item, now, navigate, onDone: onAction, fresh })
        return h(CappedCard, { key, item, now, navigate, onDone: onAction, fresh })
      })),
    h(Section, { id: 'glance-sec-working', label: 'Working', color: OK, count: c.working.length, grid: TILE_GRID },
      ...c.working.map((item) => h(WorkTile, { key: item.slot.key, item, now, navigate }))),
    h(Section, { id: 'glance-sec-mission', label: 'On a mission', color: 'var(--text)', count: c.mission.length, grid: TILE_GRID },
      ...c.mission.map((item, i) => h(MissionTile, { key: item.loop.id || i, item, now, navigate }))),
    h(Section, {
      id: 'glance-sec-quiet', label: 'Quiet', color: 'var(--muted)',
      count: c.quietToday.length + c.quietEarlier.length + c.older.length, grid: CHIP_FLOW,
    },
      ...c.quietToday.map((item) => h(QuietChip, { key: item.slot.key, item, now, navigate })),
      ...c.quietEarlier.map((item) => h(QuietChip, { key: item.slot.key, item, now, navigate, dim: true })),
      c.older.length ? h('span', {
        key: '__older',
        onClick: () => setShowOlder(!showOlder),
        style: {
          border: '1px dashed var(--border)', borderRadius: 9999, padding: '1px 9px',
          fontSize: 11, color: 'var(--muted)', cursor: 'pointer', lineHeight: '18px',
        },
      }, (showOlder ? '▾' : '▸') + ' ' + c.older.length + ' older') : null,
      showOlder ? c.older.map((item) => h(QuietChip, { key: item.slot.key, item, now, navigate, dim: true })) : null,
    ),
  )
}

// ---------- root ----------

export default function GlanceApp() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [showOlder, setShowOlder] = useState(false)
  const [firstSeen, setFirstSeen] = useState({})
  const [tick, setTick] = useState(0)
  const [notify, setNotify] = useState(() => {
    try { return localStorage.getItem(NOTIFY_PREF_KEY) === '1' } catch { return false }
  })
  const navigate = useNavigate()
  const timer = useRef(null)
  const lastRaw = useRef('')

  const load = useCallback(async () => {
    try {
      const next = await loadAll()
      const raw = JSON.stringify(next)
      if (raw !== lastRaw.current) { // most polls change nothing — skip the re-render churn
        lastRaw.current = raw
        setData(next)
      }
      setErr('')
    } catch (e) {
      setErr(String(e && e.message ? e.message : e))
    }
  }, [])

  useEffect(() => {
    load()
    const arm = () => {
      clearInterval(timer.current)
      timer.current = setInterval(load, document.hidden ? 30000 : 5000)
    }
    arm()
    document.addEventListener('visibilitychange', arm)
    return () => { clearInterval(timer.current); document.removeEventListener('visibilitychange', arm) }
  }, [load])

  // Slow clock: with no-op polls skipped, time-driven states (rel labels, stall
  // escalation, urgency ramp) still need to advance while the data stands still.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  // classify() is pure and the payload only changes on real updates — memoize on
  // [data, tick] instead of re-deriving 2-3x per render cycle.
  const view = useMemo(() => {
    if (!data) return null
    const now = Date.now() / 1000
    return { c: classify(data, now), now }
  }, [data, tick])

  // Track first-seen for NEW pills and fire desktop notifications on new items.
  useEffect(() => {
    if (!view) return
    const items = view.c.needsYou
    const next = trackSeen(items.map(itemKey), view.now)
    setFirstSeen((prev) => (sameMap(prev, next) ? prev : next))
    notifyNew(items, notify, navigate)
  }, [view, notify, navigate])

  const toggleNotify = useCallback(() => {
    const next = !notify
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }
    // Seed dedup with current items so enabling doesn't burst-notify the backlog.
    if (next && view) {
      const seed = {}
      for (const item of view.c.needsYou) seed[itemKey(item)] = 1
      writeStore(NOTIFIED_KEY, seed)
    }
    setNotify(next)
    try { localStorage.setItem(NOTIFY_PREF_KEY, next ? '1' : '0') } catch { /* ignore */ }
  }, [notify, view])

  const now = view ? view.now : Date.now() / 1000
  const c = view ? view.c : null
  const quietTotal = c ? c.quietToday.length + c.quietEarlier.length + c.older.length : 0
  const stalled = c ? c.working.filter((w) => w.stalled).length : 0
  const notifyBlocked = typeof Notification !== 'undefined' && Notification.permission === 'denied'

  const scrollTo = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const seg = (txt, id, color) => h('span', {
    onClick: () => scrollTo(id),
    style: { cursor: 'pointer', color: color || 'var(--muted)' },
  }, txt)

  return h('div', { style: { padding: '0 14px 10px', color: 'var(--text)', position: 'relative' } },
    h('style', null, '@keyframes glancePulse { 0%,100% {opacity:1; transform:scale(1)} 50% {opacity:.35; transform:scale(.8)} }'),
    // Sticky summary strip: the counts stay visible however far the board scrolls;
    // each count jumps to its section.
    h('div', { style: { position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0 6px', marginBottom: 6 } },
      h('svg', { xmlns: 'http://www.w3.org/2000/svg', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: ACCENT, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('circle', { cx: 12, cy: 12, r: 2 }),
        h('path', { d: 'M12 6a6 6 0 0 1 6 6' }),
        h('path', { d: 'M12 2a10 10 0 0 1 10 10' }),
        h('path', { d: 'M12 18a6 6 0 0 1-6-6' }),
        h('path', { d: 'M12 22A10 10 0 0 1 2 12' })),
      h('h2', { style: { margin: 0, fontSize: 16 } }, 'Glance'),
      c ? h('span', { style: { fontSize: 11, color: 'var(--muted)' } },
        c.needsYou.length
          ? seg(c.needsYou.length + ' need you', 'glance-sec-needs', AIM)
          : '✨ nothing needs you',
        ' · ', seg(c.working.length + ' working', 'glance-sec-working'),
        ' · ', seg(c.mission.length + ' on a mission', 'glance-sec-mission'),
        ' · ', seg(quietTotal + ' quiet', 'glance-sec-quiet'),
      ) : h('span', { style: { fontSize: 11, color: 'var(--muted)' } }, 'loading…'),
      stalled ? h(Pill, { bg: WARN_TINT, fg: WARN }, stalled + ' stalled') : null,
      h('button', {
        onClick: toggleNotify,
        title: notifyBlocked
          ? 'Browser notifications are blocked for this site — allow them in browser settings'
          : (notify ? 'Desktop notifications ON — click to disable' : 'Notify me when something needs me'),
        style: {
          marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 13, lineHeight: 1, padding: '2px 4px', opacity: notify && !notifyBlocked ? 1 : 0.45,
        },
      }, notify && !notifyBlocked ? '🔔' : '🔕'),
      h('span', { style: { fontSize: 10, color: 'var(--muted)' } }, 'v' + VERSION),
    ),
    err ? h('div', { style: { border: '1px solid ' + DANGER, borderRadius: 6, padding: '6px 10px', fontSize: 11, color: DANGER, marginBottom: 10 } }, err) : null,
    c ? h(Board, { c, now, navigate, onAction: load, showOlder, setShowOlder, firstSeen }) : null,
  )
}
