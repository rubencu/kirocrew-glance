// Glance — auto-triaged session board.
// Pure-UI KiroCrew app: reads existing gateway endpoints, classifies every
// session into Needs You / Working / On a Mission / Quiet. Zero management.
// v1.1: density-first layout — full width, card grid, 2-line tiles, quiet chips.
import { useState, useEffect, useRef, useCallback, createElement as h, Fragment } from 'react'
import { useNavigate } from '@kirocrew/app-sdk'
import { classify, toEpoch, rel, loopKind, loopGoal } from './classify.mjs'

const VERSION = '1.1.0'
const ACCENT = 'var(--accent, #7c3aed)'
const ACCENT_TINT = 'rgba(124, 58, 237, .14)'
const DANGER = 'var(--danger, #b91c1c)'
const OK = 'var(--ok, #047857)'
const WARN = '#b45309'
const WARN_TINT = 'rgba(180, 83, 9, .14)'

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

function Section({ label, color, count, grid, children }) {
  if (!count) return null
  return h('div', { style: { marginBottom: 12 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
      h('span', { style: { fontSize: 12, fontWeight: 600, color } }, label),
      h('span', { style: { fontSize: 11, color: 'var(--muted)' } }, String(count)),
    ),
    h('div', { style: grid }, children),
  )
}

const CARD_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 8, alignItems: 'start' }
const TILE_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6 }
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

function CardHeader({ item, now, navigate, label, labelBg, labelFg }) {
  const s = item.slot
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minWidth: 0 } },
    h(Pill, { bg: labelBg, fg: labelFg }, label),
    s ? h(SlotTitle, { slot: s, navigate }) : null,
    h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--muted)', flexShrink: 0 } },
      rel(item.waitTs, now)),
  )
}

function QuestionCard({ item, now, navigate, onDone }) {
  const [answers, setAnswers] = useState({})
  const [text, setText] = useState({})
  const [busy, setBusy] = useState(false)
  const ask = item.asks[0]
  const qs = (ask.questions || []).map((q) => ({
    text: String(q.question ?? q.text ?? ''),
    options: (q.options || []).map((o) => String(o?.label ?? o)),
  }))

  const submit = async (final) => {
    setBusy(true)
    try {
      await fetch('/api/ask-question/' + encodeURIComponent(ask.ask_id) + '/answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: final }),
      })
      onDone()
    } finally { setBusy(false) }
  }
  const pick = (qt, val) => {
    const next = { ...answers, [qt]: val }
    setAnswers(next)
    if (qs.every((q) => next[q.text])) submit(next)
  }

  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: 'QUESTION', labelBg: ACCENT_TINT, labelFg: ACCENT }),
    ...qs.map((q, i) => h('div', { key: i, style: { marginBottom: 4 } },
      h('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 5, whiteSpace: 'pre-wrap' } }, q.text),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
        ...q.options.map((o, j) => h(GhostBtn, {
          key: j, disabled: busy,
          onClick: () => pick(q.text, o),
        }, answers[q.text] === o ? '✓ ' + o : o)),
        h('input', {
          placeholder: 'custom…', disabled: busy,
          value: text[q.text] || '',
          onChange: (e) => setText({ ...text, [q.text]: e.target.value }),
          onKeyDown: (e) => { if (e.key === 'Enter' && (text[q.text] || '').trim()) pick(q.text, text[q.text].trim()) },
          style: {
            background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
            borderRadius: 9999, padding: '2px 9px', fontSize: 11, width: 110, outline: 'none',
          },
        }),
      ),
    )),
  ], ACCENT)
}

function ApprovalCard({ item, now, navigate, onDone }) {
  const [busy, setBusy] = useState(false)
  const s = item.slot
  const info = item.info
  const preview = typeof info.tool_input === 'string' ? info.tool_input : JSON.stringify(info.tool_input || {})
  const act = async (action) => {
    setBusy(true)
    try {
      await fetch('/api/chat/slots/' + encodeURIComponent(s.key) + '/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, request_id: info.request_id || '' }),
      })
      onDone()
    } finally { setBusy(false) }
  }
  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: 'APPROVAL', labelBg: WARN_TINT, labelFg: WARN }),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      h('code', null, (info.tool || 'tool') + '  ' + preview.slice(0, 140))),
    h('div', { key: 'a', style: { display: 'flex', gap: 5 } },
      h(SolidBtn, { disabled: busy, onClick: () => act('approved') }, 'Approve'),
      h(GhostBtn, { disabled: busy, danger: true, onClick: () => act('rejected') }, 'Deny'),
    ),
  ], WARN)
}

function BgApprovalCard({ item, now, onDone }) {
  const [busy, setBusy] = useState(false)
  const a = item.appr
  const act = async (action) => {
    setBusy(true)
    try {
      await fetch('/api/approvals/' + encodeURIComponent(a.id) + '/' + action, { method: 'POST' })
      onDone()
    } finally { setBusy(false) }
  }
  return card([
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
      h(Pill, { bg: WARN_TINT, fg: WARN }, 'APPROVAL'),
      h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--text)' } }, a.source || 'background'),
      h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' } }, rel(item.waitTs, now)),
    ),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      h('code', null, (a.tool || '') + '  ' + String(a.tool_purpose || '').slice(0, 120))),
    h('div', { key: 'a', style: { display: 'flex', gap: 5 } },
      h(SolidBtn, { disabled: busy, onClick: () => act('approve') }, 'Approve'),
      h(GhostBtn, { disabled: busy, danger: true, onClick: () => act('reject') }, 'Deny'),
    ),
  ], WARN)
}

function ChoiceCard({ item, now, navigate, onDone, plan }) {
  const [busy, setBusy] = useState(false)
  const s = item.slot
  const act = async (opt) => {
    setBusy(true)
    try {
      if (plan) {
        await fetch('/api/chat/slots/' + encodeURIComponent(s.key) + '/plan-action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: opt.toLowerCase() }),
        })
      } else {
        await fetch('/api/chat?ws=1', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: opt, slot: s.key }),
        })
      }
      onDone()
    } finally { setBusy(false) }
  }
  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: plan ? 'PLAN GATE' : 'CHOICE', labelBg: ACCENT_TINT, labelFg: ACCENT }),
    s.prompt_preview ? h('div', { key: 'p', style: { fontSize: 11, color: 'var(--muted)', marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } },
      String(s.prompt_preview).slice(0, 200)) : null,
    h('div', { key: 'o', style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
      ...s.options.map((o, i) => h(GhostBtn, { key: i, disabled: busy, onClick: () => act(String(o)) }, String(o)))),
  ], ACCENT)
}

function CappedCard({ item, now, navigate }) {
  const lp = item.loop
  return card([
    h(CardHeader, { key: 'h', item, now, navigate, label: 'LOOP ENDED', labelBg: WARN_TINT, labelFg: WARN }),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)' } },
      (lp.stopped_reason === 'cycle_cap' ? 'Hit its cycle cap (' + lp.cycle_count + ') ' : 'Hit its runtime budget ') +
      'without finishing: ' + loopGoal(lp)),
  ], WARN)
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
  return h('div', {
    style: tileStyle(),
    onClick: () => navigate('/chat?sid=' + encodeURIComponent(s.key)),
    onMouseEnter: (e) => tileHover(e, true), onMouseLeave: (e) => tileHover(e, false),
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h(Dot, { color: OK, pulse: true }),
      ellip(s.title || s.key, { fontWeight: 600, fontSize: 12, flex: 1 }),
      s.queue_depth > 0 ? h(Pill, { bg: ACCENT_TINT, fg: ACCENT }, '+' + s.queue_depth) : null,
      h('span', { style: { fontSize: 10, color: 'var(--muted)', flexShrink: 0 } }, rel(item.lastTs, now)),
    ),
    h('div', { style: { fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 } },
      s.stopping ? 'stopping…' : (s.last_message || '\u00a0')),
  )
}

const LOOP_LABEL = { research: '🔬', goal: '🎯', monitor: '👁' }

function MissionTile({ item, now, navigate }) {
  const { slot: s, loop: lp } = item
  const kind = loopKind(lp)
  const running = s && (s.running || s.orchestrating)
  const title = s ? (s.title || s.key) : (kind === 'research' ? 'Research ' + lp.slot_key.slice(9, 17) : lp.slot_key)
  return h('div', {
    style: tileStyle(),
    onClick: () => { if (s) navigate('/chat?sid=' + encodeURIComponent(s.key)) },
    onMouseEnter: (e) => tileHover(e, true), onMouseLeave: (e) => tileHover(e, false),
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h('span', { style: { fontSize: 11, flexShrink: 0 } }, LOOP_LABEL[kind]),
      running ? h(Dot, { color: OK, pulse: true }) : null,
      ellip(title, { fontWeight: 600, fontSize: 12, flex: 1 }),
      h('span', { style: { fontSize: 10, color: 'var(--muted)', flexShrink: 0 } }, rel(toEpoch(lp.last_fire_ts), now)),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginTop: 1 } },
      ellip(loopGoal(lp), { fontSize: 11, color: 'var(--muted)', flex: 1 }),
      h(Pill, { bg: ACCENT_TINT, fg: ACCENT }, lp.cycle_count + '/' + (lp.max_cycles || '∞')),
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

export function Board({ c, now, navigate, onAction, showOlder, setShowOlder }) {
  return h(Fragment, null,
    c.needsYou.length
      ? h(Section, { label: 'Needs you', color: ACCENT, count: c.needsYou.length, grid: CARD_GRID },
          ...c.needsYou.map((item, i) => {
            const key = item.kind + '-' + (item.slot ? item.slot.key : (item.appr ? item.appr.id : i))
            if (item.kind === 'question') return h(QuestionCard, { key, item, now, navigate, onDone: onAction })
            if (item.kind === 'approval') return h(ApprovalCard, { key, item, now, navigate, onDone: onAction })
            if (item.kind === 'bgApproval') return h(BgApprovalCard, { key, item, now, onDone: onAction })
            if (item.kind === 'plan') return h(ChoiceCard, { key, item, now, navigate, onDone: onAction, plan: true })
            if (item.kind === 'choice') return h(ChoiceCard, { key, item, now, navigate, onDone: onAction, plan: false })
            return h(CappedCard, { key, item, now, navigate })
          }))
      : h('div', { style: { border: '1px dashed var(--border)', borderRadius: 6, padding: '6px 12px', marginBottom: 12, fontSize: 11, color: 'var(--muted)' } },
          'Nothing needs you right now ✨'),
    h(Section, { label: 'Working', color: OK, count: c.working.length, grid: TILE_GRID },
      ...c.working.map((item) => h(WorkTile, { key: item.slot.key, item, now, navigate }))),
    h(Section, { label: 'On a mission', color: 'var(--text)', count: c.mission.length, grid: TILE_GRID },
      ...c.mission.map((item, i) => h(MissionTile, { key: item.loop.id || i, item, now, navigate }))),
    h(Section, {
      label: 'Quiet', color: 'var(--muted)',
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
  const navigate = useNavigate()
  const timer = useRef(null)

  const load = useCallback(async () => {
    try {
      setData(await loadAll())
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

  const now = Date.now() / 1000
  const c = data ? classify(data, now) : null
  const quietTotal = c ? c.quietToday.length + c.quietEarlier.length + c.older.length : 0

  return h('div', { style: { padding: '10px 14px', color: 'var(--text)', position: 'relative' } },
    h('style', null, '@keyframes glancePulse { 0%,100% {opacity:1; transform:scale(1)} 50% {opacity:.35; transform:scale(.8)} }'),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
      h('svg', { xmlns: 'http://www.w3.org/2000/svg', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: ACCENT, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('circle', { cx: 12, cy: 12, r: 2 }),
        h('path', { d: 'M12 6a6 6 0 0 1 6 6' }),
        h('path', { d: 'M12 2a10 10 0 0 1 10 10' }),
        h('path', { d: 'M12 18a6 6 0 0 1-6-6' }),
        h('path', { d: 'M12 22A10 10 0 0 1 2 12' })),
      h('h2', { style: { margin: 0, fontSize: 16 } }, 'Glance'),
      c ? h('span', { style: { fontSize: 11, color: 'var(--muted)' } },
        [c.needsYou.length + ' need you', c.working.length + ' working', c.mission.length + ' on a mission', quietTotal + ' quiet'].join(' · '))
        : h('span', { style: { fontSize: 11, color: 'var(--muted)' } }, 'loading…'),
      h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' } }, 'v' + VERSION),
    ),
    err ? h('div', { style: { border: '1px solid ' + DANGER, borderRadius: 6, padding: '6px 10px', fontSize: 11, color: DANGER, marginBottom: 10 } }, err) : null,
    c ? h(Board, { c, now, navigate, onAction: load, showOlder, setShowOlder }) : null,
  )
}
