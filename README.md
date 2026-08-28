<p align="center">
  <img src="docs/logo.svg" width="160" alt="Glance logo — an open eye with radar pulse arcs">
</p>

# Glance

**The agent reads, you glance.**

Running several agents at once makes *you* the bottleneck: a dozen sessions,
each needing a scroll-through just to find the one question that actually
blocks progress. Glance flips that. A curator agent reads everything in
flight on your KiroCrew host and hands you a short brief, so your attention
goes only where it changes an outcome.

![The Glance board: live blockers on top, the curator's prioritized brief below, one text line to the agent](docs/screenshot-board.png)

Every 15 minutes the curator triages all your sessions and writes a
prioritized brief: what needs you **now**, what needs you **soon**, and what
resolved while you were away — each item with one suggested action. Between
briefs, anything that blocks an agent surfaces live, the moment it happens.

## One screen, three parts

1. **Live blockers** — pending questions, approvals, and plan gates, polled
   directly and answerable inline. An answer box is never stale.
2. **The brief** — the curator's judgment in plain language. One click
   delegates any item back to an agent.
3. **One text line** — tell the agent anything; each message starts its own
   fresh background session.

![Live blockers: choice, approval, and question cards, each answerable with one click](docs/screenshot-blockers.png)

Nothing to scan, filter, or configure. The curator decides what deserves your
attention, and whatever it left out is accounted for in a single closing line
— so an empty board really means nothing needs you. Curious how it works?
See [DESIGN.md](DESIGN.md).

## Install

```bash
git clone https://github.com/rubencu/kirocrew-glance
kirocrew app install ./kirocrew-glance
kirocrew config set agent.apps_trusted '["glance"]'
kirocrew app enable glance
```

Open the dashboard → Glance. The curator cron registers with the app; hit
"Write the first brief" instead of waiting for the first 15-minute tick.

## Tests

```bash
node --test tests/            # pure-logic unit tests
bash tests/run-render-test.sh # SSR render smoke (self-skips without a React host)
```
