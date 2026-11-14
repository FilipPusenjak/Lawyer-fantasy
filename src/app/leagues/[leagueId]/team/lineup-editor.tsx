"use client";

/**
 * Lineup editor for the current editable week. Tap a slot to open a picker of
 * roster players who can play it (from the bench or another slot), then save.
 * Unsaved edits survive roster changes made elsewhere on the page (a drop
 * only removes that lawyer from the edited lineup).
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Card, CardTitle, cx, EmptyState, Points } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { autoFillLineup } from "@/lib/lineup";
import { fmtPoints } from "@/lib/format";
import { POSITION_SHORT, SLOT_LABELS, type Position, type RosterSettings, type SlotType } from "@/lib/settings";
import { PositionBadge, SlotChip } from "../players/player-bits";
import { saveLineupAction } from "./actions";
import { assignSlot, benchOf, eligibleFor, reconcileStarters, sameLineup } from "./lineup-model";

export type EditorRosterPlayer = {
  id: string;
  name: string;
  position: Position;
  preseasonRank: number | null;
  weekPoints: number;
  seasonPoints: number;
};

export function LineupEditor({
  leagueId,
  week,
  roster,
  slots,
  players,
  initial,
}: {
  leagueId: string;
  week: number;
  roster: RosterSettings;
  slots: SlotType[];
  players: EditorRosterPlayer[];
  initial: (string | null)[];
}) {
  const [starters, setStarters] = useState<(string | null)[]>(initial);
  const [open, setOpen] = useState<number | null>(null);

  // New saved lineup or roster from the server (after a save, drop or add):
  // merge it into the edits instead of throwing them away.
  const rosterKey = players.map((p) => p.id).join(",");
  const [synced, setSynced] = useState({ initial, rosterKey });
  if (rosterKey !== synced.rosterKey || !sameLineup(initial, synced.initial)) {
    setSynced({ initial, rosterKey });
    setStarters(reconcileStarters(starters, synced.initial, initial, new Set(players.map((p) => p.id))));
  }

  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const dirty = !sameLineup(starters, initial);
  const bench = benchOf(starters, players);
  const base = `/leagues/${leagueId}`;

  function choose(index: number, playerId: string | null) {
    setStarters((s) => assignSlot(s, slots, players, index, playerId));
    setOpen(null);
  }

  function whereIs(id: string): string {
    const i = starters.indexOf(id);
    return i >= 0 ? `In ${SLOT_LABELS[slots[i]]}` : "Bench";
  }

  return (
    <>
      <Card>
        <CardTitle>Week {week} lineup</CardTitle>
        <ActionForm action={saveLineupAction} className="space-y-3">
          <input type="hidden" name="leagueId" value={leagueId} />
          <input type="hidden" name="week" value={week} />
          <input type="hidden" name="starters" value={JSON.stringify(starters)} />
          <ul>
            {slots.map((slot, i) => {
              const p = starters[i] ? byId.get(starters[i]!) : undefined;
              const isOpen = open === i;
              const options = eligibleFor(slot, players)
                .filter((o) => o.id !== p?.id)
                .sort((a, b) => Number(starters.includes(a.id)) - Number(starters.includes(b.id)) || b.seasonPoints - a.seasonPoints);
              return (
                <li key={i} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex min-h-14 w-full items-center gap-3 py-2 text-left"
                  >
                    <SlotChip slot={slot} />
                    {p ? (
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{p.name}</span>
                        <span className="block text-xs text-muted">
                          {POSITION_SHORT[p.position]} · {fmtPoints(p.seasonPoints)} season pts
                        </span>
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 text-muted">Empty · tap to fill</span>
                    )}
                    {p ? <Points value={p.weekPoints} className="text-lg font-semibold" /> : null}
                    <span aria-hidden className={cx("text-muted transition", isOpen && "rotate-180")}>
                      ▾
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="mb-2 rounded-xl border border-line bg-surface-2 p-1">
                      <p className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                        Pick your {SLOT_LABELS[slot]}
                      </p>
                      {options.length === 0 ? (
                        <p className="px-2 pb-2 text-sm text-muted">
                          Nobody else on your roster can play {SLOT_LABELS[slot]}.{" "}
                          <Link href={`${base}/players`} className="inline-flex min-h-11 items-center font-semibold text-brand">
                            Find one
                          </Link>
                        </p>
                      ) : (
                        options.map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => choose(i, o.id)}
                            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left active:bg-surface"
                          >
                            <PositionBadge position={o.position} />
                            <span className="min-w-0 flex-1 truncate font-medium">{o.name}</span>
                            <span className="shrink-0 text-xs text-muted">{whereIs(o.id)}</span>
                            <Points value={o.weekPoints} className="w-8 shrink-0 text-right" />
                          </button>
                        ))
                      )}
                      {p ? (
                        <button
                          type="button"
                          onClick={() => choose(i, null)}
                          className="flex min-h-11 w-full items-center rounded-lg px-2 text-left text-sm font-semibold text-muted active:bg-surface"
                        >
                          Move {p.name} to the bench
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {dirty ? <p className="text-sm font-semibold text-warn">You have unsaved changes.</p> : null}
          <div className="flex flex-wrap gap-2">
            <SubmitButton className="flex-1" pendingText="Saving…" disabled={!dirty}>
              Save lineup
            </SubmitButton>
            <Button type="button" variant="secondary" onClick={() => setStarters((s) => autoFillLineup(s, roster, players))}>
              Fill empty
            </Button>
            {dirty ? (
              <Button type="button" variant="ghost" onClick={() => setStarters(initial)}>
                Undo
              </Button>
            ) : null}
          </div>
        </ActionForm>
      </Card>

      <Card>
        <CardTitle>Bench ({bench.length})</CardTitle>
        {bench.length === 0 ? (
          <EmptyState title="Nobody on the bench">Everyone on your roster is starting.</EmptyState>
        ) : (
          <>
            <ul>
              {bench.map((p) => (
                <li key={p.id} className="flex min-h-12 items-center gap-3 border-b border-line py-2 last:border-b-0">
                  <PositionBadge position={p.position} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.name}</span>
                    <span className="block text-xs text-muted">{fmtPoints(p.seasonPoints)} season pts</span>
                  </span>
                  <Points value={p.weekPoints} className="text-lg font-semibold text-muted" />
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Tap a lineup slot above to swap a bench player in.</p>
          </>
        )}
      </Card>
    </>
  );
}
