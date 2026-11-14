/**
 * Pure helpers for the lawyer page (unit tested).
 */

export type WeekPoints = { week: number; points: number; isCurrent: boolean };

/** Weeks worth showing: every week with points, plus the current week (if it's in the season). */
export function weeklyPoints(totalWeeks: number, currentWeek: number, pointsFor: (week: number) => number): WeekPoints[] {
  const out: WeekPoints[] = [];
  for (let w = 1; w <= totalWeeks; w++) {
    const points = pointsFor(w);
    const isCurrent = w === currentWeek;
    if (points !== 0 || isCurrent) out.push({ week: w, points, isCurrent });
  }
  return out;
}

/** Bar width in percent for a points value (non-zero values get a visible sliver). */
export function barPercent(points: number, maxAbs: number): number {
  if (points === 0 || maxAbs <= 0) return 0;
  return Math.max(4, Math.round((Math.abs(points) / maxAbs) * 100));
}

export type PointLineLike = { eventId: string; week: number; points: number; viaFirm: boolean };

/** Join scoring lines with event details, newest event first. Lines without details are skipped. */
export function eventRows<L extends PointLineLike, D extends { occurredOn: string }>(
  lines: L[],
  details: Map<string, D>,
): { line: L; event: D }[] {
  const out: { line: L; event: D }[] = [];
  for (const line of lines) {
    const event = details.get(line.eventId);
    if (event) out.push({ line, event });
  }
  return out.sort((a, b) => b.event.occurredOn.localeCompare(a.event.occurredOn) || a.line.eventId.localeCompare(b.line.eventId));
}

/** Only http(s) links are rendered; anything else is dropped. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export type FinalizedWeekCheck = {
  /** Events approved after their week was finalized: their points aren't in that week's saved score. */
  notCounted: Set<string>;
  /** Finalized weeks whose listed events still don't add up to the saved score (e.g. point values changed later), with that score. */
  mismatched: { week: number; points: number }[];
};

const samePoints = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Finalized weeks count the score saved when they were finalized, while the
 * event list is computed live from every approved event. Reconcile the two so
 * the list agrees with the weekly bars and season total: flag events approved
 * after their week was finalized, and report weeks that still differ.
 *
 * @param finalized week → when it was finalized (null if unknown), for every finalized week
 * @param reviewedAt event id → when it was approved
 * @param savedPoints the lawyer's saved score for a finalized week
 */
export function checkFinalizedWeeks(
  lines: PointLineLike[],
  finalized: Map<number, Date | null>,
  reviewedAt: Map<string, Date | null>,
  savedPoints: (week: number) => number,
): FinalizedWeekCheck {
  const notCounted = new Set<string>();
  const mismatched: { week: number; points: number }[] = [];
  for (const [week, finalizedAt] of [...finalized].sort((a, b) => a[0] - b[0])) {
    const weekLines = lines.filter((l) => l.week === week);
    const saved = savedPoints(week);
    let counted = weekLines.reduce((t, l) => t + l.points, 0);
    if (samePoints(counted, saved)) continue;
    if (finalizedAt) {
      for (const l of weekLines) {
        const approved = reviewedAt.get(l.eventId);
        if (approved && approved.getTime() > finalizedAt.getTime()) {
          notCounted.add(l.eventId);
          counted -= l.points;
        }
      }
    }
    if (!samePoints(counted, saved)) mismatched.push({ week, points: saved });
  }
  return { notCounted, mismatched };
}
