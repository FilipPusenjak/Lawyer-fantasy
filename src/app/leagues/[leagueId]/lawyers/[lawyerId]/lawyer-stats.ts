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
