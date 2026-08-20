// Glance v2 — the brief. Simple, agentic.
//
// The old paradigm (v1.x) computed a board in the browser: ~400 lines of
// classification heuristics approximating judgment. The new paradigm moves
// judgment to an agent: a curator cron (see ../curator.md) reads gateway
// state and writes a short prioritized brief; this UI just renders it.
//
// Three parts, nothing else:
//   1. Live blockers — questions/approvals/option gates, polled directly
//      (an answer box must never be stale).
//   2. The brief — the curator's natural-language triage, with one suggested
//      action per item, delegated back to an agent with one click.
//   3. One free-text line to the agent.
import { useState, useEffect, useRef, createElement as h, Fragment } from 'react'
import { useNavigate } from '@kirocrew/app-sdk'
import { parseBrief, extractBlockers, blockerKey, handlerSlotFor, pruneSent, rel } from './brief.mjs'

const VERSION = '2.3.7'
const BRIEF_PATH = '~/.kiro/crew/workspace/glance/brief.json'
const HANDLER_SLOT = 'glance-handler'
const CURATOR_SLOT = 'glance-curator'
const REFRESH_MSG = 'You are the Glance curator. Follow the procedure in ~/.kiro/crew/apps/glance/curator.md exactly, then stop. Do not do any other work.'

// Urgency hues deliberately NOT the theme accent (a green accent would make
// "act on me" read as "healthy"). Violet = interactive, red/amber = priority.
const ACCENT = 'var(--accent, #7c3aed)'
const ACCENT_TINT = 'rgba(124, 58, 237, .14)'
const AIM = '#8b5cf6'
const AIM_TINT = 'rgba(139, 92, 246, .16)'
const DANGER = 'var(--danger, #b91c1c)'
const WARN = '#b45309'
const MUTED = 'var(--muted)'
const PRIORITY_DOT = { now: DANGER, soon: WARN, fyi: 'var(--border)' }

// ---------- data ----------

async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(url + ' → ' + r.status)
  return r.json()
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url)
  return r
}

async function loadLive() {
  const [slots, questions, approvals] = await Promise.all([
    fetchJson('/api/chat/slots').catch(() => []),
    fetchJson('/api/ask-question/pending').catch(() => []),
    fetchJson('/api/approvals').catch(() => []),
  ])
  const appr = Array.isArray(approvals) ? approvals : (approvals.approvals || approvals.pending || [])
  return {
    slots: Array.isArray(slots) ? slots : [],
    questions: Array.isArray(questions) ? questions : [],
    approvals: appr,
  }
}

async function loadBrief(now) {
  try {
    const r = await fetch('/api/file-read?path=' + encodeURIComponent(BRIEF_PATH))
    if (!r.ok) return null // no brief yet (or unreadable) → first-run state
    const parsed = parseBrief(await r.text(), now)
    return parsed.ok ? parsed : null
  } catch {
    return null
  }
}

// Hand a message to the agent in a named background slot (fire-and-forget).
function toAgent(message, slot) {
  return post('/api/chat?ws=1', { message, slot })
}

// Busy flag + surfaced failure — actions must never fail silently.
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

// ---------- primitives ----------

function FailNote({ fail }) {
  if (!fail) return null
  return h('div', { style: { fontSize: 10, color: DANGER, marginTop: 4 } }, '⚠ action failed: ' + fail)
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
      background: 'transparent', color: disabled ? MUTED : (danger ? DANGER : ACCENT),
      border: `1px solid ${danger ? DANGER : ACCENT_TINT}`, padding: '3px 11px', borderRadius: 9999,
      fontSize: 11, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
    },
  }, children)
}

function SolidBtn({ onClick, disabled, children }) {
  return h('button', {
    onClick, disabled,
    style: {
      background: disabled ? 'var(--border)' : ACCENT, color: disabled ? MUTED : 'var(--accent-fg, #fff)',
      border: 'none', padding: '3px 13px', borderRadius: 9999,
      fontSize: 11, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
    },
  }, children)
}

function SlotLink({ slotKey, title, navigate }) {
  if (!slotKey) return null
  return h('span', {
    onClick: () => navigate('/chat?sid=' + encodeURIComponent(slotKey)),
    title: title || slotKey,
    style: { fontWeight: 600, fontSize: 12, color: 'var(--text)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }, title || slotKey)
}

function card(children, accent) {
  return h('div', {
    style: {
      background: 'var(--card, var(--bg))', border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`, borderRadius: 6, padding: '9px 11px',
      minWidth: 0, boxSizing: 'border-box',
    },
  }, children)
}

// ---------- live blocker cards ----------

function QuestionCard({ b, now, navigate, onAction }) {
  const [text, setText] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const ask = b.asks[0]
  const q = (ask.questions || [])[0] || {}
  const qText = String(q.question ?? q.text ?? '')
  const options = (q.options || []).map((o) => String(o?.label ?? o))
  const [submit, busy, fail] = useAction(async (val) => {
    await post('/api/ask-question/' + encodeURIComponent(ask.ask_id) + '/answer', { answers: { [qText]: val } })
    onAction()
  })
  const queued = b.asks.length - 1
  return card([
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minWidth: 0 } },
      h(Pill, { bg: AIM_TINT, fg: AIM }, 'QUESTION · ' + rel(b.waitTs, now)),
      queued > 0 ? h(Pill, { bg: 'var(--border)', fg: MUTED }, '+' + queued + ' queued') : null,
      b.slot ? h(SlotLink, { slotKey: b.slot.key, title: b.slot.title, navigate }) : null,
    ),
    h('div', { key: 'q', style: { fontSize: 12, color: 'var(--text)', marginBottom: 5, whiteSpace: 'pre-wrap' } }, qText),
    h('div', { key: 'o', style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
      ...options.map((o, i) => h(GhostBtn, { key: i, disabled: busy, onClick: () => submit(o) }, o)),
      showCustom
        ? h('input', {
            placeholder: 'custom…', disabled: busy, autoFocus: true, value: text,
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && text.trim()) submit(text.trim()) },
            style: { background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9999, padding: '2px 9px', fontSize: 11, width: 130, outline: 'none' },
          })
        : h('button', {
            disabled: busy, onClick: () => setShowCustom(true),
            style: { background: 'transparent', color: MUTED, border: '1px dashed var(--border)', borderRadius: 9999, padding: '2px 9px', fontSize: 11, cursor: 'pointer' },
          }, 'custom…'),
    ),
    h(FailNote, { key: 'f', fail }),
  ], AIM)
}

function ApprovalCard({ b, now, navigate, onAction }) {
  const info = b.info
  const preview = typeof info.tool_input === 'string' ? info.tool_input : JSON.stringify(info.tool_input || {})
  const [act, busy, fail] = useAction(async (action) => {
    await post('/api/chat/slots/' + encodeURIComponent(b.slot.key) + '/approve', { action, request_id: info.request_id || '' })
    onAction()
  })
  return card([
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minWidth: 0 } },
      h(Pill, { bg: 'rgba(180, 83, 9, .14)', fg: WARN }, 'APPROVAL · ' + rel(b.waitTs, now)),
      h(SlotLink, { slotKey: b.slot.key, title: b.slot.title, navigate }),
    ),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      h('code', null, (info.tool || 'tool') + '  ' + preview.slice(0, 140))),
    h('div', { key: 'a', style: { display: 'flex', gap: 5 } },
      h(SolidBtn, { disabled: busy, onClick: () => act('approved') }, 'Approve'),
      h(GhostBtn, { disabled: busy, danger: true, onClick: () => act('rejected') }, 'Deny'),
    ),
    h(FailNote, { key: 'f', fail }),
  ], WARN)
}

function BgApprovalCard({ b, now, onAction }) {
  const a = b.appr
  const [act, busy, fail] = useAction(async (action) => {
    await post('/api/approvals/' + encodeURIComponent(a.id) + '/' + action)
    onAction()
  })
  return card([
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
      h(Pill, { bg: 'rgba(180, 83, 9, .14)', fg: WARN }, 'APPROVAL · ' + rel(b.waitTs, now)),
      h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--text)' } }, a.source || 'background'),
    ),
    h('div', { key: 'b', style: { fontSize: 11, color: 'var(--text)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      h('code', null, (a.tool || '') + '  ' + String(a.tool_purpose || '').slice(0, 120))),
    h('div', { key: 'a', style: { display: 'flex', gap: 5 } },
      h(SolidBtn, { disabled: busy, onClick: () => act('approve') }, 'Approve'),
      h(GhostBtn, { disabled: busy, danger: true, onClick: () => act('reject') }, 'Deny'),
    ),
    h(FailNote, { key: 'f', fail }),
  ], WARN)
}

function ChoiceCard({ b, now, navigate, onAction }) {
  const s = b.slot
  const [guide, setGuide] = useState('')
  const [showGuide, setShowGuide] = useState(false)
  const [act, busy, fail] = useAction(async (opt) => {
    if (b.plan) await post('/api/chat/slots/' + encodeURIComponent(s.key) + '/plan-action', { action: opt.toLowerCase() })
    else await toAgent(opt, s.key)
    onAction()
  })
  // Free-text guidance always goes straight into the session as a user
  // message — preset options rarely fit what a stuck agent actually needs.
  const [sendGuide, guideBusy, guideFail] = useAction(async () => {
    const msg = guide.trim()
    if (!msg) return
    await toAgent(msg, s.key)
    setGuide('')
    setShowGuide(false)
    onAction()
  })
  return card([
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minWidth: 0 } },
      h(Pill, { bg: AIM_TINT, fg: AIM }, (b.plan ? 'PLAN GATE' : 'CHOICE') + ' · ' + rel(b.waitTs, now)),
      h(SlotLink, { slotKey: s.key, title: s.title, navigate }),
    ),
    s.prompt_preview ? h('div', { key: 'p', style: { fontSize: 11, color: MUTED, marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } },
      String(s.prompt_preview).slice(0, 200)) : null,
    h('div', { key: 'o', style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
      ...s.options.map((o, i) => h(GhostBtn, { key: i, disabled: busy || guideBusy, onClick: () => act(String(o)) }, String(o))),
      showGuide
        ? h('input', {
            placeholder: 'guidance…', disabled: guideBusy, autoFocus: true, value: guide,
            onChange: (e) => setGuide(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && guide.trim()) sendGuide() },
            style: { background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9999, padding: '2px 9px', fontSize: 11, width: 160, outline: 'none' },
          })
        : h('button', {
            disabled: busy || guideBusy, onClick: () => setShowGuide(true),
            style: { background: 'transparent', color: MUTED, border: '1px dashed var(--border)', borderRadius: 9999, padding: '2px 9px', fontSize: 11, cursor: 'pointer' },
          }, 'guide…'),
    ),
    h(FailNote, { key: 'f', fail: fail || guideFail }),
  ], AIM)
}

const BLOCKER_CARD = { question: QuestionCard, approval: ApprovalCard, bgApproval: BgApprovalCard, choice: ChoiceCard }

// ---------- the brief ----------

function BriefItem({ item, navigate, sent, onSent }) {
  const [guide, setGuide] = useState('')
  const [showGuide, setShowGuide] = useState(false)
  const [send, busy, fail] = useAction(async () => {
    const msg = item.action ? item.action.message : 'From the Glance brief, please handle this: ' + item.text
    // Per-item slot: ten delegated actions run as ten parallel sessions
    // instead of queueing behind one shared handler.
    const slot = handlerSlotFor(item.id)
    await toAgent(msg, slot)
    onSent(item.id, slot)
  })
  // Guidance goes into the item's OWN session — that is the agent that needs
  // steering, not the generic handler.
  const [sendGuide, guideBusy, guideFail] = useAction(async () => {
    const msg = guide.trim()
    if (!msg) return
    await toAgent(msg, item.session)
    setGuide('')
    setShowGuide(false)
    onSent(item.id, item.session)
  })
  const sentTo = sent[item.id] && sent[item.id].slot
  return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 2px', borderBottom: '1px solid var(--border)', minWidth: 0 } },
    h('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: PRIORITY_DOT[item.priority], flexShrink: 0, position: 'relative', top: -1 } }),
    h('div', { style: { minWidth: 0, flex: 1 } },
      h('span', { style: { fontSize: 13, color: 'var(--text)' } }, item.text),
      fail || guideFail ? h(FailNote, { fail: fail || guideFail }) : null,
    ),
    sentTo
      ? h('span', {
          onClick: () => navigate('/chat?sid=' + encodeURIComponent(sentTo)),
          style: { fontSize: 11, color: 'var(--ok, #047857)', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 },
        }, '✓ sent — open ↗')
      : h(Fragment, null,
          item.priority !== 'fyi' || item.action
            ? h(GhostBtn, { disabled: busy || guideBusy, onClick: send }, item.action ? item.action.label : 'Handle it')
            : null,
          item.session
            ? (showGuide
                ? h('input', {
                    placeholder: 'guidance…', disabled: guideBusy, autoFocus: true, value: guide,
                    onChange: (e) => setGuide(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter' && guide.trim()) sendGuide() },
                    style: { background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9999, padding: '2px 9px', fontSize: 11, width: 150, outline: 'none', flexShrink: 0 },
                  })
                : h('button', {
                    disabled: busy || guideBusy, onClick: () => setShowGuide(true),
                    style: { background: 'transparent', color: MUTED, border: '1px dashed var(--border)', borderRadius: 9999, padding: '2px 9px', fontSize: 11, cursor: 'pointer', flexShrink: 0 },
                  }, 'guide…'))
            : null,
          item.session ? h('span', {
              onClick: () => navigate('/chat?sid=' + encodeURIComponent(item.session)),
              style: { fontSize: 11, color: MUTED, cursor: 'pointer', flexShrink: 0 },
            }, '↗') : null,
        ),
  )
}

function AgentBar({ onSent, navigate, sentFree }) {
  const [text, setText] = useState('')
  const [send, busy, fail] = useAction(async () => {
    const msg = text.trim()
    if (!msg) return
    await toAgent(msg, HANDLER_SLOT)
    setText('')
    onSent()
  })
  return h('div', { style: { marginTop: 14 } },
    h('div', { style: { display: 'flex', gap: 6 } },
      h('input', {
        placeholder: 'Tell the agent…', value: text, disabled: busy,
        onChange: (e) => setText(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') send() },
        style: { flex: 1, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9999, padding: '6px 13px', fontSize: 12, outline: 'none' },
      }),
      h(SolidBtn, { disabled: busy || !text.trim(), onClick: send }, 'Send'),
    ),
    sentFree ? h('span', {
      onClick: () => navigate('/chat?sid=' + HANDLER_SLOT),
      style: { fontSize: 11, color: 'var(--ok, #047857)', cursor: 'pointer' },
    }, '✓ sent — open ↗') : null,
    h(FailNote, { fail }),
  )
}

// ---------- board ----------

// Bulk-approve every pending approval (slot + background). Two clicks by
// design: bulk tool-execution approval must never happen on a slip.
function ApproveAll({ approvals, onAction }) {
  const [armed, setArmed] = useState(false)
  const [run, busy, fail] = useAction(async () => {
    for (const b of approvals) {
      if (b.kind === 'approval') {
        await post('/api/chat/slots/' + encodeURIComponent(b.slot.key) + '/approve', { action: 'approved', request_id: (b.info && b.info.request_id) || '' })
      } else {
        await post('/api/approvals/' + encodeURIComponent(b.appr.id) + '/approve')
      }
    }
    setArmed(false)
    onAction()
  })
  return h(Fragment, null,
    armed
      ? h(Fragment, null,
          h(SolidBtn, { disabled: busy, onClick: run }, busy ? 'approving…' : 'Confirm approve all ' + approvals.length),
          h(GhostBtn, { disabled: busy, onClick: () => setArmed(false) }, 'Cancel'),
        )
      : h(GhostBtn, { onClick: () => setArmed(true) }, 'Approve all ' + approvals.length),
    fail ? h(FailNote, { fail }) : null,
  )
}

function Pulse({ pulse }) {
  if (!pulse || (pulse.working + pulse.waiting + pulse.stalled) === 0) return null
  const seg = (n, label, color) => (n > 0 ? h('span', { style: { color: color || MUTED } }, n + ' ' + label) : null)
  const parts = [
    seg(pulse.working, 'working'),
    seg(pulse.waiting, 'waiting on you', AIM),
    seg(pulse.stalled, 'stalled', WARN),
  ].filter(Boolean)
  const joined = []
  parts.forEach((p, i) => { if (i) joined.push(' · '); joined.push(p) })
  return h('div', { style: { fontSize: 12, marginBottom: 6 } }, ...joined)
}

export function Board({ brief, blockers, now, navigate, onAction, sent, onSent, sentFree, onSentFree, onRefresh, refreshBusy }) {
  const approvals = blockers.filter((b) => b.kind === 'approval' || b.kind === 'bgApproval')
  return h('div', null,
    // Live blockers — interactive, never stale.
    blockers.length ? h('div', { style: { marginBottom: 14 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
        h('span', { style: { fontSize: 12, fontWeight: 600, color: AIM } }, 'Needs you now · ' + blockers.length),
        approvals.length >= 2 ? h(ApproveAll, { approvals, onAction }) : null,
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8 } },
        ...blockers.map((b) => h(BLOCKER_CARD[b.kind], { key: blockerKey(b), b, now, navigate, onAction })),
      ),
    ) : null,
    // The brief — the agent's judgment.
    brief
      ? h('div', null,
          brief.headline ? h('div', { style: { fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 4 } }, brief.headline) : null,
          h(Pulse, { pulse: brief.pulse }),
          h('div', { style: { fontSize: 11, color: brief.stale ? WARN : MUTED, marginBottom: 8 } },
            (brief.stale ? '⚠ stale — written ' : 'as of ') + rel(brief.generatedAt, now) + ' ago',
            h('span', { onClick: refreshBusy ? undefined : onRefresh, style: { marginLeft: 8, color: ACCENT, cursor: refreshBusy ? 'default' : 'pointer' } },
              refreshBusy ? 'refreshing…' : '↻ refresh'),
          ),
          brief.items.length
            ? h('div', null, ...brief.items.map((it) => h(BriefItem, { key: it.id, item: it, navigate, sent, onSent })))
            : h('div', { style: { fontSize: 13, color: MUTED, padding: '10px 0' } }, 'All quiet — nothing needs you.'),
          brief.quiet ? h('div', { style: { fontSize: 11, color: MUTED, marginTop: 8 } }, brief.quiet) : null,
        )
      : h('div', { style: { padding: '18px 0', textAlign: 'center' } },
          h('div', { style: { fontSize: 13, color: MUTED, marginBottom: 8 } }, 'No brief yet — the curator writes one every 15 minutes.'),
          h(SolidBtn, { disabled: refreshBusy, onClick: onRefresh }, refreshBusy ? 'writing…' : 'Write the first brief'),
        ),
    h(AgentBar, { onSent: onSentFree, navigate, sentFree }),
  )
}

// ---------- root ----------

// Sent-state survives reloads so an already-delegated item is not delegated
// twice. Guarded: localStorage does not exist under SSR.
const SENT_KEY = 'glance-sent-v1'

function loadSentStore() {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(SENT_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveSentStore(map) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SENT_KEY, JSON.stringify(map))
  } catch { /* storage full/denied — sent-state degrades to session-only */ }
}

export default function GlanceApp() {
  const navigate = useNavigate()
  const [live, setLive] = useState(null)
  const [brief, setBrief] = useState(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [err, setErr] = useState('')
  const [sent, setSent] = useState(loadSentStore)
  const [sentFree, setSentFree] = useState(false)
  const timer = useRef(null)

  const poll = async () => {
    const t = Math.floor(Date.now() / 1000)
    setNow(t)
    try {
      const [lv, br] = await Promise.all([loadLive(), loadBrief(t)])
      setLive(lv)
      setBrief(br)
      if (br) {
        // Drop sent entries for items the curator resolved (and expired ones).
        setSent((p) => {
          const pruned = pruneSent(p, br.items.map((i) => i.id), t)
          if (Object.keys(pruned).length !== Object.keys(p).length) saveSentStore(pruned)
          return pruned
        })
      }
      setErr('')
    } catch (e) {
      setErr(String(e && e.message ? e.message : e))
    }
  }

  useEffect(() => {
    const arm = () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = setInterval(poll, document.visibilityState === 'visible' ? 5000 : 30000)
    }
    poll()
    arm()
    document.addEventListener('visibilitychange', arm)
    return () => { clearInterval(timer.current); document.removeEventListener('visibilitychange', arm) }
  }, [])

  const [refresh, refreshBusy, refreshFail] = useAction(async () => {
    await toAgent(REFRESH_MSG, CURATOR_SLOT)
  })

  const blockers = live ? extractBlockers(live, now) : []

  return h('div', { style: { padding: '14px 18px', maxWidth: 980, margin: '0 auto', fontFamily: 'inherit' } },
    h('style', null, '@keyframes glancePulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }'),
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 } },
      h('span', { style: { fontSize: 16, fontWeight: 700, color: 'var(--text)' } }, 'Glance'),
      h('span', { style: { fontSize: 10, color: MUTED } }, 'v' + VERSION + ' · the agent reads, you glance'),
      err ? h('span', { style: { fontSize: 10, color: DANGER, marginLeft: 'auto' } }, '⚠ ' + err) : null,
    ),
    live === null && brief === null
      ? h('div', { style: { fontSize: 12, color: MUTED } }, 'loading…')
      : h(Board, {
          brief, blockers, now, navigate,
          onAction: poll,
          sent, onSent: (id, target) => setSent((p) => {
            const next = { ...p, [id]: { slot: target || HANDLER_SLOT, ts: Math.floor(Date.now() / 1000) } }
            saveSentStore(next)
            return next
          }),
          sentFree, onSentFree: () => setSentFree(true),
          onRefresh: refresh, refreshBusy,
        }),
    refreshFail ? h(FailNote, { fail: refreshFail }) : null,
  )
}
