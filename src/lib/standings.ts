/**
 * Pure standings computation from final regular-season matchups.
 * Tiebreakers: win% → points for → head-to-head win% among tied teams →
 * fewer points against → deterministic coin flip.
 */

export type StandingsMatchup = {
  teamAId: string;
  teamBId: string | null; // null = median game
  scoreA: number;
  scoreB: number; // median value for median games
  final: boolean;
  isPlayoff: boolean;
};

export type StandingRow = {
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  winPct: number;
  rank: number;
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function computeStandings(teamIds: string[], matchups: StandingsMatchup[], salt = ""): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const id of teamIds) {
    rows.set(id, { teamId: id, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, winPct: 0, rank: 0 });
  }
  // head-to-head record: key "a|b" -> wins of a over b (ties count 0.5)
  const h2h = new Map<string, number>();
  const h2hGames = new Map<string, number>();
  const addH2h = (a: string, b: string, w: number) => {
    h2h.set(`${a}|${b}`, (h2h.get(`${a}|${b}`) ?? 0) + w);
    h2hGames.set(`${a}|${b}`, (h2hGames.get(`${a}|${b}`) ?? 0) + 1);
  };

  for (const m of matchups) {
    if (!m.final || m.isPlayoff) continue;
    const a = rows.get(m.teamAId);
    if (!a) continue;
    a.pointsFor += m.scoreA;
    a.pointsAgainst += m.scoreB;
    const b = m.teamBId ? rows.get(m.teamBId) : undefined;
    if (b) {
      b.pointsFor += m.scoreB;
      b.pointsAgainst += m.scoreA;
    }
    if (m.scoreA > m.scoreB) {
      a.wins++;
      if (b) {
        b.losses++;
        addH2h(a.teamId, b.teamId, 1);
        addH2h(b.teamId, a.teamId, 0);
      }
    } else if (m.scoreA < m.scoreB) {
      a.losses++;
      if (b) {
        b.wins++;
        addH2h(a.teamId, b.teamId, 0);
        addH2h(b.teamId, a.teamId, 1);
      }
    } else {
      a.ties++;
      if (b) {
        b.ties++;
        addH2h(a.teamId, b.teamId, 0.5);
        addH2h(b.teamId, a.teamId, 0.5);
      }
    }
  }

  const list = [...rows.values()];
  for (const r of list) {
    const g = r.wins + r.losses + r.ties;
    r.winPct = g === 0 ? 0 : (r.wins + 0.5 * r.ties) / g;
    r.pointsFor = Math.round(r.pointsFor * 100) / 100;
    r.pointsAgainst = Math.round(r.pointsAgainst * 100) / 100;
  }

  const h2hPct = (id: string, group: StandingRow[]) => {
    let w = 0;
    let g = 0;
    for (const o of group) {
      if (o.teamId === id) continue;
      w += h2h.get(`${id}|${o.teamId}`) ?? 0;
      g += h2hGames.get(`${id}|${o.teamId}`) ?? 0;
    }
    return g === 0 ? 0.5 : w / g;
  };

  // Primary sort by win% then PF; then resolve remaining ties as groups.
  list.sort((x, y) => y.winPct - x.winPct || y.pointsFor - x.pointsFor);
  const out: StandingRow[] = [];
  let i = 0;
  while (i < list.length) {
    let j = i + 1;
    while (j < list.length && list[j].winPct === list[i].winPct && list[j].pointsFor === list[i].pointsFor) j++;
    const group = list.slice(i, j);
    if (group.length > 1) {
      group.sort(
        (x, y) =>
          h2hPct(y.teamId, group) - h2hPct(x.teamId, group) ||
          x.pointsAgainst - y.pointsAgainst ||
          hash(salt + x.teamId) - hash(salt + y.teamId),
      );
    }
    out.push(...group);
    i = j;
  }
  out.forEach((r, idx) => (r.rank = idx + 1));
  return out;
}
