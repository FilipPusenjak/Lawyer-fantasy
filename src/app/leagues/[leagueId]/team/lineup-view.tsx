/**
 * Read-only lineup (locked weeks, other teams) and the week switcher.
 */
import Link from "next/link";
import { cx, ListRow, Points } from "@/components/ui";
import { POSITION_SHORT, type Position, type SlotType } from "@/lib/settings";
import { formatShortDate, weekEndDate, weekStartDate } from "@/lib/time";
import { LawyerLink, SlotChip } from "../players/player-bits";

export type LineupViewRow = {
  slot: SlotType;
  lawyer: { id: string; name: string; position: Position } | null;
  points: number;
};

export function LineupView({
  leagueId,
  rows,
  total,
  totalLabel = "Team total",
}: {
  leagueId: string;
  rows: LineupViewRow[];
  total: number;
  totalLabel?: string;
}) {
  return (
    <div>
      {rows.map((r, i) => (
        <ListRow key={i} className="relative">
          <SlotChip slot={r.slot} />
          {r.lawyer ? (
            <div className="min-w-0 flex-1">
              <LawyerLink leagueId={leagueId} id={r.lawyer.id} name={r.lawyer.name} className="block truncate" stretch />
              <p className="text-xs text-muted">{POSITION_SHORT[r.lawyer.position]}</p>
            </div>
          ) : (
            <p className="min-w-0 flex-1 text-muted">Empty</p>
          )}
          <Points value={r.points} className={cx("text-lg font-semibold", !r.lawyer && "text-muted")} />
        </ListRow>
      ))}
      <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
        <span className="font-display text-sm font-semibold uppercase tracking-wide text-muted">{totalLabel}</span>
        <Points value={total} className="text-3xl font-bold" />
      </div>
    </div>
  );
}

export function WeekPicker({
  basePath,
  week,
  min,
  max,
  seasonStart,
}: {
  /** Page path; links add ?week=N. */
  basePath: string;
  week: number;
  min: number;
  max: number;
  seasonStart: string;
}) {
  const arrow = "flex min-h-11 min-w-11 items-center justify-center rounded-xl text-2xl font-bold";
  return (
    <nav className="mb-4 flex items-center gap-1 rounded-2xl border border-line bg-surface p-1" aria-label="Choose week">
      {week > min ? (
        <Link href={`${basePath}?week=${week - 1}`} className={cx(arrow, "text-brand active:bg-surface-2")} aria-label={`Week ${week - 1}`}>
          ‹
        </Link>
      ) : (
        <span className={cx(arrow, "text-line")} aria-hidden>
          ‹
        </span>
      )}
      <div className="min-w-0 flex-1 text-center">
        <p className="font-display text-lg font-bold uppercase leading-tight tracking-wide">Week {week}</p>
        <p className="text-xs text-muted">
          {formatShortDate(weekStartDate(week, seasonStart))} – {formatShortDate(weekEndDate(week, seasonStart))}
        </p>
      </div>
      {week < max ? (
        <Link href={`${basePath}?week=${week + 1}`} className={cx(arrow, "text-brand active:bg-surface-2")} aria-label={`Week ${week + 1}`}>
          ›
        </Link>
      ) : (
        <span className={cx(arrow, "text-line")} aria-hidden>
          ›
        </span>
      )}
    </nav>
  );
}
