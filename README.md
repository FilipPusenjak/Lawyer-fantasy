# Lawyer Fantasy

A fantasy-football-style league for a high school mock trial club. Teams draft
real lawyers and law firms and score points from what happens in their public
court cases. Every scoring event is approved by the commissioner.

Live: https://lawyer-fantasy.vercel.app

## Features (Phase 1)

- Accounts (username + password); only site admins create leagues; members join with an invite code
- Live snake draft with pick clock, queue, auto-pick and commissioner controls
- Weekly lineups that lock at a set time; 2-week head-to-head matchups (configurable)
- Standings with tiebreakers, automatic playoff bracket, league median games for odd team counts
- Waivers (rolling priority, weekly run), free agents, trades with commissioner review/veto
- Commissioner tools: settings, members/co-commissioners, player pool (lawyers, firms, cases, CSV import),
  scoring review queue, manual events with source links, finalize/reopen weeks
- Scouting: projected weekly points and rankings from public court activity

See `docs/ARCHITECTURE.md` for the domain model, conventions and routes.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in DATABASE_URL and CRON_SECRET
npm run db:migrate           # apply the schema
npm run db:seed              # optional: fictional demo leagues (re-runnable)
npm run dev
```

Make yourself a site admin (needed to create leagues) after signing up:

```bash
npm run make-admin -- <username>
```

To target another database (e.g. production), set `DATABASE_URL` in the
environment for the command; it overrides `.env.local`.

## Demo data

`npm run db:seed` creates a fictional pool (170 lawyers, 18 firms, 70 cases),
a 10-team league in week 7 and a 6-team league ready to draft. All demo logins
use the password `demo-pass-2026`: `demo_commish` (commissioner of both) and
`demo_player1` … `demo_player9`. Re-running replaces only demo data.

## Checks

```bash
npm run typecheck
npm run lint
npm test          # unit tests (Vitest)
npm run build
```

## Deployment

Vercel (project `lawyer-fantasy`) builds every push. Environment variables:
`DATABASE_URL` (Neon) and `CRON_SECRET`. `vercel.json` runs `/api/cron/daily`
once a day; league pages also catch up lazily on every visit.
