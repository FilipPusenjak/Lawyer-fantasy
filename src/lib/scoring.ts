/**
 * Pure scoring engine. Given approved events, case appearances, lawyers and a
 * league's scoring settings, compute each lawyer's points per week.
 *
 * Rules:
 * - An event targets either one specific lawyer (event.lawyerId) or every
 *   lawyer/firm appearing on event.side of event.caseId.
 * - Individual lawyers get the event's full value.
 * - A firm gets value × firmMultiplier ONCE per event if the firm itself is a
 *   target or any targeted lawyer belongs to it (no double counting).
 * - "filing" events are capped per lawyer per week at filingWeeklyCap raw
 *   points (applied before the firm multiplier).
 * - Events outside the season weeks are ignored.
 */
import type { EventType, ScoringSettings, Side, ValuedEventType } from "./settings";

export type ScoringEventInput = {
  id: string;
  type: string;
  customPoints: number | null;
  occurredOn: string; // YYYY-MM-DD
  caseId: string | null;
  side: Side | null;
  lawyerId: string | null;
};

export type AppearanceInput = { caseId: string; lawyerId: string; side: Side };
export type LawyerInput = { id: string; kind: "lawyer" | "firm"; firmId: string | null };

export type PointLine = {
  eventId: string;
  week: number;
  /** Points this event contributed to this lawyer (after multiplier/cap). */
  points: number;
  /** True if this lawyer received the points as a firm (multiplier applied). */
  viaFirm: boolean;
};

export type LawyerPoints = {
  /** week -> points */
  byWeek: Map<number, number>;
  lines: PointLine[];
  total: number;
};

export function eventValue(e: Pick<ScoringEventInput, "type" | "customPoints">, s: ScoringSettings): number {
  if (e.type === "custom") return e.customPoints ?? 0;
  const v = s.values[e.type as ValuedEventType];
  return typeof v === "number" ? v : 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeLawyerPoints(args: {
  events: ScoringEventInput[];
  appearances: AppearanceInput[];
  lawyers: LawyerInput[];
  scoring: ScoringSettings;
  weekOf: (date: string) => number;
  totalWeeks: number;
}): Map<string, LawyerPoints> {
  const { events, appearances, lawyers, scoring, weekOf, totalWeeks } = args;
  const lawyerById = new Map(lawyers.map((l) => [l.id, l]));

  const bySideKey = new Map<string, string[]>();
  for (const a of appearances) {
    const k = `${a.caseId}|${a.side}`;
    const arr = bySideKey.get(k);
    if (arr) arr.push(a.lawyerId);
    else bySideKey.set(k, [a.lawyerId]);
  }

  const result = new Map<string, LawyerPoints>();
  const get = (id: string): LawyerPoints => {
    let r = result.get(id);
    if (!r) {
      r = { byWeek: new Map(), lines: [], total: 0 };
      result.set(id, r);
    }
    return r;
  };

  // Raw filing totals per lawyer-week, for the cap. key = lawyerId|week
  const filingRaw = new Map<string, number>();

  // Sort for deterministic cap application (earliest first).
  const sorted = [...events].sort((a, b) =>
    a.occurredOn === b.occurredOn ? a.id.localeCompare(b.id) : a.occurredOn.localeCompare(b.occurredOn),
  );

  for (const e of sorted) {
    const week = weekOf(e.occurredOn);
    if (week < 1 || week > totalWeeks) continue;
    const value = eventValue(e, scoring);
    if (value === 0) continue;

    let targets: string[];
    if (e.lawyerId) targets = [e.lawyerId];
    else if (e.caseId && e.side) targets = bySideKey.get(`${e.caseId}|${e.side}`) ?? [];
    else targets = [];

    const individuals = new Set<string>();
    const firms = new Set<string>();
    for (const t of targets) {
      const l = lawyerById.get(t);
      if (!l) continue;
      if (l.kind === "firm") firms.add(l.id);
      else {
        individuals.add(l.id);
        if (l.firmId && lawyerById.get(l.firmId)?.kind === "firm") firms.add(l.firmId);
      }
    }

    const credit = (id: string, raw: number, viaFirm: boolean) => {
      let pts = raw;
      if (e.type === ("filing" satisfies EventType)) {
        const key = `${id}|${week}`;
        const used = filingRaw.get(key) ?? 0;
        const cap = scoring.filingWeeklyCap;
        const allowed = Math.max(0, Math.min(raw, cap - used));
        filingRaw.set(key, used + allowed);
        pts = allowed;
      }
      if (viaFirm) pts *= scoring.firmMultiplier;
      pts = round2(pts);
      if (pts === 0) return;
      const r = get(id);
      r.byWeek.set(week, round2((r.byWeek.get(week) ?? 0) + pts));
      r.total = round2(r.total + pts);
      r.lines.push({ eventId: e.id, week, points: pts, viaFirm });
    };

    for (const id of individuals) credit(id, value, false);
    for (const id of firms) credit(id, value, true);
  }

  return result;
}

export function pointsForWeek(points: Map<string, LawyerPoints>, lawyerId: string, week: number): number {
  return points.get(lawyerId)?.byWeek.get(week) ?? 0;
}
