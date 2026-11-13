/**
 * Draft room tab panels (client-rendered; imported by draft-room.tsx).
 */
import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, Input, Select, cx } from "@/components/ui";
import { POSITIONS, POSITION_LABELS, POSITION_SHORT, SLOT_LABELS, type Position, type RosterSettings } from "@/lib/settings";
import {
  buildBoard,
  filterAvailable,
  groupByPosition,
  openSlotsFor,
  type DraftLawyer,
  type DraftPickInfo,
  type DraftTeamInfo,
  type OnClock,
} from "./model";

const PAGE_SIZE = 40;

export type RowActions = {
  /** Show a "Draft" button (it's my turn). */
  canDraft: boolean;
  /** Commissioner is picking for the team on the clock. */
  commishPickFor: string | null;
  /** Can add/remove queue entries (I have a team and the draft isn't over). */
  canQueue: boolean;
  busy: boolean;
  onDraft: (l: DraftLawyer) => void;
  onCommishPick: (l: DraftLawyer) => void;
  onQueueAdd: (l: DraftLawyer) => void;
  onQueueRemove: (l: DraftLawyer) => void;
};

function PositionBadge({ position }: { position: Position }) {
  return (
    <Badge tone={position === "firm" ? "accent" : "brand"} className="shrink-0">
      {POSITION_SHORT[position]}
    </Badge>
  );
}

function RankLabel({ rank }: { rank: number | null }) {
  return <span className="w-8 shrink-0 text-xs tabular-nums text-muted">{rank ? `#${rank}` : "–"}</span>;
}

// ---------------------------------------------------------------------------
// Lawyers
// ---------------------------------------------------------------------------

export type LawyerFilters = { query: string; position: Position | "all"; limit: number };
export const DEFAULT_FILTERS: LawyerFilters = { query: "", position: "all", limit: PAGE_SIZE };

export function LawyersPanel({
  pool,
  picked,
  queued,
  actions,
  filters,
  onFilters,
}: {
  pool: DraftLawyer[];
  picked: ReadonlySet<string>;
  queued: ReadonlySet<string>;
  actions: RowActions;
  /** Kept by the parent so the search survives tab switches. */
  filters: LawyerFilters;
  onFilters: (f: LawyerFilters) => void;
}) {
  const { query, position, limit } = filters;
  const list = useMemo(() => filterAvailable(pool, picked, { query, position }), [pool, picked, query, position]);
  const shown = list.slice(0, limit);

  return (
    <div>
      <Input
        type="search"
        placeholder="Search lawyers, firms, offices"
        aria-label="Search lawyers"
        value={query}
        onChange={(e) => onFilters({ ...filters, query: e.target.value, limit: PAGE_SIZE })}
      />
      <div className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter by position">
        {(["all", ...POSITIONS] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onFilters({ ...filters, position: p, limit: PAGE_SIZE })}
            aria-pressed={position === p}
            className={cx(
              "min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold",
              position === p ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface text-muted",
            )}
          >
            {p === "all" ? "All" : POSITION_SHORT[p]}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        {list.length} available · sorted by preseason rank
      </p>
      {list.length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No lawyers match">Try a different search or position.</EmptyState>
        </div>
      ) : (
        <ul className="mt-1">
          {shown.map((l) => {
            const isQueued = queued.has(l.id);
            return (
              <li key={l.id} className="flex min-h-14 items-center gap-2 border-b border-line py-2 last:border-b-0">
                <RankLabel rank={l.rank} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold leading-tight">{l.name}</p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    <PositionBadge position={l.position} />
                    <span className="truncate">{l.organization ?? (l.kind === "firm" ? "Law firm" : "")}</span>
                  </p>
                </div>
                {actions.canDraft ? (
                  <Button className="shrink-0 px-3" disabled={actions.busy} onClick={() => actions.onDraft(l)}>
                    Draft
                  </Button>
                ) : actions.commishPickFor ? (
                  <Button className="shrink-0 px-3" disabled={actions.busy} onClick={() => actions.onCommishPick(l)}>
                    Pick
                  </Button>
                ) : null}
                {actions.canQueue ? (
                  isQueued ? (
                    <Button
                      variant="ghost"
                      className="shrink-0 px-2"
                      disabled={actions.busy}
                      onClick={() => actions.onQueueRemove(l)}
                      aria-label={`Remove ${l.name} from queue`}
                    >
                      Queued
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      className="shrink-0 px-2"
                      disabled={actions.busy}
                      onClick={() => actions.onQueueAdd(l)}
                      aria-label={`Add ${l.name} to queue`}
                    >
                      +Queue
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {list.length > shown.length ? (
        <Button variant="secondary" className="mt-3 w-full" onClick={() => onFilters({ ...filters, limit: limit + PAGE_SIZE })}>
          Show more ({list.length - shown.length} left)
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export function QueuePanel({
  queue,
  poolById,
  canDraft,
  canEdit,
  busy,
  onDraft,
  onMove,
  onRemove,
}: {
  queue: string[];
  poolById: Map<string, DraftLawyer>;
  canDraft: boolean;
  canEdit: boolean;
  busy: boolean;
  onDraft: (l: DraftLawyer) => void;
  onMove: (l: DraftLawyer, direction: "up" | "down" | "top") => void;
  onRemove: (l: DraftLawyer) => void;
}) {
  const items = queue.map((id) => poolById.get(id)).filter((l): l is DraftLawyer => !!l);
  if (items.length === 0) {
    return (
      <EmptyState title="Your queue is empty">
        Tap +Queue on lawyers you want. If your clock runs out, we draft the top lawyer in your queue who fills an open
        starting spot.
      </EmptyState>
    );
  }
  const iconBtn =
    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-ink disabled:opacity-40";
  return (
    <div>
      <p className="mb-1 text-xs text-muted">If your clock runs out, we pick from the top of this list.</p>
      <ol>
        {items.map((l, i) => (
          <li key={l.id} className="border-b border-line py-2 last:border-b-0">
            <div className="flex min-h-11 items-center gap-2">
              <span className="w-6 shrink-0 text-sm font-bold tabular-nums text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold leading-tight">{l.name}</p>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                  <PositionBadge position={l.position} />
                  <span className="truncate">{l.rank ? `Rank #${l.rank}` : "Unranked"}</span>
                </p>
              </div>
              {canDraft ? (
                <Button className="shrink-0 px-3" disabled={busy} onClick={() => onDraft(l)}>
                  Draft
                </Button>
              ) : null}
            </div>
            {canEdit ? (
              <div className="mt-1.5 flex items-center justify-end gap-2">
                <button type="button" className={iconBtn} disabled={busy || i === 0} onClick={() => onMove(l, "top")} aria-label={`Move ${l.name} to top`}>
                  ⤒
                </button>
                <button type="button" className={iconBtn} disabled={busy || i === 0} onClick={() => onMove(l, "up")} aria-label={`Move ${l.name} up`}>
                  ↑
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  disabled={busy || i === items.length - 1}
                  onClick={() => onMove(l, "down")}
                  aria-label={`Move ${l.name} down`}
                >
                  ↓
                </button>
                <button type="button" className={cx(iconBtn, "text-neg")} disabled={busy} onClick={() => onRemove(l)} aria-label={`Remove ${l.name}`}>
                  ✕
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export function BoardPanel({
  teams,
  picks,
  rounds,
  poolById,
  myTeamId,
  onClock,
}: {
  teams: DraftTeamInfo[];
  picks: DraftPickInfo[];
  rounds: number;
  poolById: Map<string, DraftLawyer>;
  myTeamId: string | null;
  onClock: OnClock | null;
}) {
  const grid = useMemo(() => buildBoard(teams, picks, rounds), [teams, picks, rounds]);
  if (teams.length === 0) return <EmptyState title="No teams yet" />;
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2">
      <table className="border-separate border-spacing-1 text-left text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-[1] bg-bg px-1 text-muted">Rd</th>
            {teams.map((t) => (
              <th
                key={t.id}
                scope="col"
                className={cx(
                  "w-28 min-w-28 max-w-28 rounded-lg px-2 py-1.5 align-bottom font-semibold",
                  t.id === myTeamId ? "bg-brand text-brand-ink" : "bg-surface-2",
                )}
              >
                <span className="line-clamp-2 break-words">{t.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, r) => (
            <tr key={r}>
              <th scope="row" className="sticky left-0 z-[1] bg-bg px-1 text-center font-semibold text-muted">
                {r + 1}
                <span className="block text-[10px] font-normal">{(r + 1) % 2 === 1 ? "→" : "←"}</span>
              </th>
              {row.map((cell, c) => {
                const team = teams[c];
                const isNow = onClock && onClock.round === r + 1 && onClock.teamId === team.id;
                const lawyer = cell ? poolById.get(cell.lawyerId) : undefined;
                return (
                  <td
                    key={team.id}
                    className={cx(
                      "h-16 w-28 min-w-28 max-w-28 rounded-lg border px-2 py-1 align-top",
                      team.id === myTeamId ? "border-brand/40 bg-brand-soft" : "border-line bg-surface",
                      isNow && "ring-2 ring-accent",
                    )}
                  >
                    {cell ? (
                      <>
                        <span className="block text-[10px] text-muted">
                          {cell.round}.{String(cell.pickInRound).padStart(2, "0")}
                          {cell.isAuto ? " · auto" : ""}
                        </span>
                        <span className="line-clamp-2 font-semibold leading-tight">{lawyer?.name ?? "Removed lawyer"}</span>
                        {lawyer ? <span className="text-[10px] font-semibold text-muted">{POSITION_SHORT[lawyer.position]}</span> : null}
                      </>
                    ) : isNow ? (
                      <span className="font-semibold text-accent">On the clock</span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team (mine by default, or any team)
// ---------------------------------------------------------------------------

export function TeamPanel({
  teams,
  picks,
  rounds,
  poolById,
  myTeamId,
  roster,
}: {
  teams: DraftTeamInfo[];
  picks: DraftPickInfo[];
  rounds: number;
  poolById: Map<string, DraftLawyer>;
  myTeamId: string | null;
  roster: RosterSettings;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const teamId = chosen ?? myTeamId ?? teams[0]?.id ?? null;
  const team = teams.find((t) => t.id === teamId);
  const teamPicks = picks.filter((p) => p.teamId === teamId);
  const roundOf = new Map(teamPicks.map((p) => [p.lawyerId, p.round]));
  const drafted = teamPicks.map((p) => poolById.get(p.lawyerId)).filter((l): l is DraftLawyer => !!l);
  const open = openSlotsFor(drafted, roster);
  const groups = groupByPosition(drafted);
  const isMine = teamId === myTeamId;

  return (
    <div className="space-y-3">
      {teams.length > 1 ? (
        <Select aria-label="Team" value={teamId ?? ""} onChange={(e) => setChosen(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.id === myTeamId ? " (you)" : ""}
            </option>
          ))}
        </Select>
      ) : null}
      <p className="text-sm text-muted">
        {team ? `${team.name} · ` : ""}
        {teamPicks.length} of {rounds} picks made
      </p>
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Open starting spots</p>
        {open.length === 0 ? (
          <p className="text-sm">All starting spots are filled. More picks go to the bench.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {open.map((s, i) => (
              <Badge key={`${s}-${i}`} tone="warn">
                {SLOT_LABELS[s]}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {groups.length === 0 ? (
        <EmptyState title={isMine ? "No picks yet" : "No picks yet for this team"}>
          {isMine ? "Your drafted lawyers show up here, grouped by position." : null}
        </EmptyState>
      ) : (
        groups.map((g) => (
          <div key={g.position}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{POSITION_LABELS[g.position]}</p>
            <ul className="rounded-xl border border-line bg-surface px-3">
              {g.lawyers.map((l) => (
                <li key={l.id} className="flex min-h-12 items-center gap-2 border-b border-line py-2 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold leading-tight">{l.name}</p>
                    {l.organization ? <p className="truncate text-xs text-muted">{l.organization}</p> : null}
                  </div>
                  <span className="shrink-0 text-xs text-muted">Rd {roundOf.get(l.id)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
