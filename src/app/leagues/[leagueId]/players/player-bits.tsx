/**
 * Small display pieces shared by the team, teams, players, lawyer and waivers
 * pages. No hooks, so they work in server and client components.
 */
import Link from "next/link";
import { Badge, cx } from "@/components/ui";
import { POSITION_SHORT, SLOT_LABELS, type Position, type SlotType } from "@/lib/settings";

export function PositionBadge({ position, className }: { position: Position; className?: string }) {
  return (
    <Badge tone={position === "firm" ? "accent" : "brand"} className={cx("shrink-0", className)}>
      {POSITION_SHORT[position]}
    </Badge>
  );
}

/** Fixed-width lineup slot label, e.g. "FLEX". */
export function SlotChip({ slot }: { slot: SlotType }) {
  return (
    <span className="w-12 shrink-0 rounded-md bg-surface-2 py-1 text-center font-display text-xs font-bold tracking-wide text-muted">
      {SLOT_LABELS[slot]}
    </span>
  );
}

export function lawyerHref(leagueId: string, lawyerId: string): string {
  return `/leagues/${leagueId}/lawyers/${lawyerId}`;
}

/** Lawyer name linking to their page. */
export function LawyerLink({ leagueId, id, name, className }: { leagueId: string; id: string; name: string; className?: string }) {
  return (
    <Link href={lawyerHref(leagueId, id)} className={cx("font-semibold hover:text-brand", className)}>
      {name}
    </Link>
  );
}

/** Status of a lawyer in this league, as a badge. */
export function AvailabilityBadge({
  availability,
  myTeamId,
  waiversUntil,
}: {
  availability: { kind: "rostered"; teamName: string; teamId: string } | { kind: "waivers" } | { kind: "free_agent" };
  myTeamId: string | null;
  /** Pre-formatted end of the waiver period, e.g. "Wed, Nov 18". */
  waiversUntil: string | null;
}) {
  if (availability.kind === "rostered") {
    if (availability.teamId === myTeamId) return <Badge tone="brand">Your team</Badge>;
    return <Badge className="max-w-40 truncate">{availability.teamName}</Badge>;
  }
  if (availability.kind === "waivers") return <Badge tone="warn">{waiversUntil ? `Waivers · ${waiversUntil}` : "Waivers"}</Badge>;
  return <Badge tone="pos">Free agent</Badge>;
}
