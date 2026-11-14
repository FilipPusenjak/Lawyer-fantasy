# Real Lawyers 2026–27 (starter pool)

Real attorneys and law firms on active federal cases, researched 2026-11-14 from
public court records (Supreme Court and court-of-appeals dockets, court filings
and orders, DOJ releases, and news that names counsel). Every lawyer–case link
was independently re-checked; links to closed cases were dropped.

- `1-lawyers.csv`, `2-cases.csv`, `3-appearances.csv` — the app's import format
  (Commissioner tools → Player pool → Import, or `scripts/import-pool.ts`).
- `4-sources.csv` — the public source and quote behind every lawyer–case link.

Totals: 160 lawyers (49 trial, 54 appellate, 33 prosecutors, 24 defense),
60 firms, 49 cases (13 Supreme Court, 11 appeals, 13 civil, 12 white-collar
criminal), 185 lawyer–case links. Cases involving violence, sexual offenses,
minors or family matters were excluded.

Notes: some Solicitor General lawyers argue as amicus supporting a side; the
`side` column records the side they support. Case status changes quickly —
re-check before the season and drop cases that end.

## Case outlooks for projections (researched 2026-11-14)

Projections and draft ranks use a researched outlook for each active case:

- `5-outlooks.json` — per case (matched by court + docket number): how busy the
  docket is (substantive filings and motion rulings per side per week, from dated
  docket entries) and the scoring events that are scheduled or likely during the
  season (Supreme Court arguments with the expected arguing lawyer, trials,
  decisions, rulings on major pending motions, pleas, settlements), each with a
  date window, a probability and its outcomes. Import with
  `npx tsx --env-file=.env.local scripts/import-outlooks.ts <poolId> data/real-pool-2026-27/5-outlooks.json`.
- `6-research-notes.json` — the research behind each outlook: status, counsel
  checks, docket evidence, the basis for every number, sources and the
  independent verifier's corrections.
- `scotus-decision-timing-OT2021-2025.csv` — all 303 argued Supreme Court cases
  in the 2021–2025 terms with argument and decision dates, used to calibrate
  decision timing: decided by May 30 — October sitting 98%, November 77%,
  December 61%, January 56%, February 31%, March 20%, April 10%; reversed or
  vacated in 71–73% of decided cases.

Base rates used where a case had no specific evidence (see the guide in the
research notes): federal criminal trials end in conviction about 83% of the time;
courts of appeals affirm about 75%; scheduled trials happen as set 25–40% of the
time (criminal) or ~30% (civil); settlements 2–25% depending on reported talks.

Pool corrections made from the same research (Nov 14, 2026): removed Dane H.
Butswinkas (died Oct 26, 2026; appearance withdrawn Nov 6), Abhishek S. Kambli
(withdrew May 2026 on leaving DOJ), A. Jeff Ifrah and James Trusty (withdrew
July 2026; David Markus took over) and Ifrah Law PLLC, and Brett A. Shumate
(resigned as Civil Division AAG Nov 9, 2026); added Charles L. McCloud to Perkins
Coie v. DOJ (Williams & Connolly, per the Nov 6 notice). Draft ranks are the
season projection order (most projected points over the season first).
