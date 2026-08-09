# Glance

Auto-triaged session board for KiroCrew. One page that answers, at a glance:

- **Needs you** — sessions blocked on a question, tool approval, plan gate, or
  choice. Rich cards quote the actual pending ask and let you answer inline
  without opening the session. Loops that hit their cycle/runtime cap without
  finishing surface here too. Sorted longest-waiting first.
- **Working** — turns running right now, with live activity previews.
- **On a mission** — sessions driven by an autonudge loop (babysit monitors 👁,
  goal loops 🎯, research campaigns 🔬) with the goal text and cycle N/M.
- **Quiet** — everything else, decaying automatically: today → earlier →
  collapsed "N older sessions". No folders, no tags, no archiving. Ever.

Pure-UI app: reads the gateway's existing endpoints (`/api/chat/slots`,
`/api/autonudge`, `/api/ask-question/pending`, `/api/approvals`); classification
happens client-side in `ui/classify.mjs` (unit-tested, React-free). No Python
backend, no crons, no stored state — the board is a stateless projection of
live gateway state.

## Install

```bash
kirocrew app install /path/to/glance-app
kirocrew app enable glance
```

## Develop

```bash
kirocrew app dev glance          # hot-reload UI serving
node --test tests/               # classifier unit tests (Node 20+)
```
