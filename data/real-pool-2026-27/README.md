# Real Lawyers 2026–27 (starter pool)

Real attorneys and law firms on active federal cases, researched 2026-11-14 from
public court records (Supreme Court and court-of-appeals dockets, court filings
and orders, DOJ releases, and news that names counsel). Every lawyer–case link
was independently re-checked; links to closed cases were dropped.

- `1-lawyers.csv`, `2-cases.csv`, `3-appearances.csv` — the app's import format
  (Commissioner tools → Player pool → Import, or `scripts/import-pool.ts`).
- `4-sources.csv` — the public source and quote behind every lawyer–case link.

Totals: 156 lawyers (49 trial, 51 appellate, 33 prosecutors, 23 defense),
57 firms, 50 cases (13 Supreme Court, 11 appeals, 13 civil, 13 criminal), 183
lawyer–case links. The starter research excluded cases involving violence,
sexual offenses, minors or family matters; United States v. Durk Banks was added
afterwards at the commissioner's request (Brian Steel's case). The CSVs mirror
the live pool as of Nov 14, 2026, and the `rank` column is the draft rank
(season projection order under the league's Steady scoring).

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

### Review corrections (Nov 14, 2026)

An independent review of the projected rankings found these errors; each is fixed
in the files above (details in `reviewCorrections` in `6-research-notes.json`):

- Google ad tech MDL (1:21-md-03010): linked Karen L. Dunn and Jeannie S. Rhee (Google's counsel, ECF 2046–2125) and Davida Brook and Steven Seigel (counsel for Index Exchange and Kargo, ECF 1958, 2062).
- Merged duplicate firms: "Boies Schiller Flexner" into Boies Schiller Flexner LLP, and "Susman Godfrey LLP" into Susman Godfrey L.L.P.
- United States v. Apple: joint notices of impasse are not counted as filings (filings 1.0/1.5 → 0.6/0.9 per week).
- FTC v. Amazon (2:23-cv-01495) and NYT v. Microsoft: a partial summary-judgment motion granted in full is projected as a granted motion, as the app records it.
- United States v. Patrick James and Edward James: rates weighted across trial scenarios (1.3/1.8 → 0.75/1.0); trial set for Feb 9, 2027.
- United States v. Thao: the verdict no longer ends the case (post-trial motions and sentencing follow); a post-verdict docket pace applies after it; verdict window Dec 4, 2026 – Jan 11, 2027.
- United States v. Huawei: verdict window Nov 30 – Dec 11, 2026.
- United States v. Left: sentencing split into the set date (Dec 1, 2026) and a later window if it moves.
- United States v. Durk Banks: a plea milestone no longer ends the case (co-defendants remain).
- Supreme Court: added the Solicitor General's office arguers named on the U.S. briefs (U.S. DOGE Service, DOJ v. McNutt, Grand, Apple v. Epic) and Kevin K. Russell for Epic; motion rulings set to 0, because the app does not score Supreme Court procedural motions.
- KalshiEX v. Martin: Rule 28(j) letters are not scored filings (0.5/0.65 → 0.04/0.04 per week).
- United States v. Google (D.C. Cir.): argument ordered for January 2027 (Oct 9, 2026 order); decision in season 0.28 → 0.44.
- State of Oregon v. Trump: only substantive motion rulings count (0.02 → 0.005 per side per week).

### Final check (Nov 14, 2026)

A second adversarial check of the model against these outlooks led to these data changes:

- Criminal verdicts no longer end the case (post-trial motions and sentencing papers follow): United States v. Chu, Earnest, Cherfilus-McCormick, Patrick James, Verges and Storm (retrial) now switch to a post-verdict docket pace after the verdict, as Thao already did.
- An acquittal of every defendant now ends the case where it would (Thao, Huawei, Chu, Patrick James, Verges), as do the case-ending ruling outcomes in Storm (Rule 29 granted in full) and Apple v. Liu (dismissal with prejudice).
- United States v. Thao: the 6% chance of no verdict in the window is an explicit outcome, so the post-verdict pace applies after the window.
- United States v. Earnest: Rozier's plea before trial no longer ends the case (Laster's trial goes on).
- United States v. Heppner: rates divided by the expected open weeks (filings 0.28/0.35 → 0.18/0.20, rulings 0.1/0.05 → 0.064/0.03 per week).
