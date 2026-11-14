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
