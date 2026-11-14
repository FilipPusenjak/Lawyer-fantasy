"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { ActionMessage } from "@/components/ui-client";
import { Badge, Button, Card, CardTitle, LinkButton, Notice, cx } from "@/components/ui";
import { POSITION_SHORT, type RosterSettings } from "@/lib/settings";
import { plural } from "@/lib/format";
import type { ActionResult } from "@/server/action-result";
import {
  commissionerPickAction,
  makePickAction,
  moveTeamAction,
  pauseDraftAction,
  queueAddAction,
  queueMoveAction,
  queueRemoveAction,
  randomizeOrderAction,
  resumeDraftAction,
  startDraftAction,
  undoLastPickAction,
} from "@/app/leagues/[leagueId]/draft/actions";
import {
  BoardPanel,
  DEFAULT_FILTERS,
  LawyersPanel,
  QueuePanel,
  TeamPanel,
  type LawyerFilters,
  type RowActions,
} from "./draft-panels";
import {
  DRAFT_POLL_MS,
  SETUP_POLL_MS,
  afterDraftCopy,
  connectionForStatus,
  formatClock,
  isTerminalConnection,
  isUnchanged,
  picksUntilMyTurn,
  remainingMs,
  type AfterDraftInfo,
  type DraftLawyer,
  type DraftPollJson,
  type DraftStateJson,
  type DraftTeamInfo,
  type PollConnection,
} from "./model";

import type { ProjectionSummary } from "@/lib/projections";

type Tab = "lawyers" | "queue" | "board" | "team";

const EMPTY_PROJECTIONS: Record<string, ProjectionSummary> = {};

type Props = {
  leagueId: string;
  /** Server-rendered state, including the lawyer pool. */
  initial: DraftStateJson;
  roster: RosterSettings;
  /** Scheduled draft time, already formatted in the league time zone. */
  scheduledLabel: string | null;
  /** Where the season stands, for the card shown once the draft is done. */
  afterDraft: AfterDraftInfo;
  /** Scouting projections by lawyer id (projected points for the upcoming week). */
  projections?: Record<string, ProjectionSummary>;
};

// ---------------------------------------------------------------------------
// Live state: polling + server re-renders
// ---------------------------------------------------------------------------

function useDraftState(leagueId: string, initial: DraftStateJson) {
  const [state, setState] = useState<DraftStateJson>(initial);
  const [pool, setPool] = useState<DraftLawyer[]>(initial.pool ?? []);
  const [skewMs, setSkewMs] = useState(0);
  const [connection, setConnection] = useState<PollConnection>("ok");

  // A Server Action's revalidatePath re-renders the page with fresh props:
  // adopt them when they're at least as new as what we have.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    if (initial.version >= state.version) {
      setState(initial);
      if (initial.pool) setPool(initial.pool);
    }
  }

  const latest = useRef({ version: initial.version, poolSize: (initial.pool ?? []).length });
  useEffect(() => {
    latest.current = { version: state.version, poolSize: pool.length };
  }, [state.version, pool.length]);

  const refetch = useCallback(async () => {
    const get = async (includePool: boolean): Promise<DraftPollJson | null> => {
      const qs = includePool ? "pool=1" : `since=${latest.current.version}`;
      const sentAt = Date.now();
      let res: Response;
      try {
        res = await fetch(`/api/leagues/${leagueId}/draft?${qs}`, { cache: "no-store" });
      } catch {
        setConnection("retrying");
        return null;
      }
      if (!res.ok) {
        // 401 / 404 are terminal (signed out, or no longer in this league): polling stops.
        setConnection(connectionForStatus(res.status));
        return null;
      }
      let data: DraftPollJson;
      try {
        data = (await res.json()) as DraftPollJson;
      } catch {
        setConnection("retrying");
        return null;
      }
      const skew = Date.parse(data.serverNow) - (sentAt + Date.now()) / 2;
      setConnection("ok");
      setSkewMs((prev) => (Math.abs(prev - skew) > 250 ? skew : prev));
      return data;
    };

    const data = await get(false);
    if (!data || isUnchanged(data) || data.version < latest.current.version) return;
    latest.current.version = data.version;
    setState(data);
    if (data.poolSize !== latest.current.poolSize) {
      const full = await get(true);
      if (full && !isUnchanged(full) && full.pool) {
        latest.current.poolSize = full.pool.length;
        setPool(full.pool);
        setState(full);
      }
    }
  }, [leagueId]);

  // Poll while the draft is upcoming or live; pause when the tab is hidden.
  const { status } = state;
  const stopped = status === "complete" || isTerminalConnection(connection);
  useEffect(() => {
    if (stopped) return;
    const interval = status === "not_started" ? SETUP_POLL_MS : DRAFT_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const tick = async () => {
      try {
        if (!document.hidden) await refetch();
      } catch {
        // keep polling
      } finally {
        if (alive) timer = setTimeout(tick, interval);
      }
    };
    timer = setTimeout(tick, interval);
    const onVisible = () => {
      if (!document.hidden) void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status, stopped, refetch]);

  return { state, pool, skewMs, connection, refetch };
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function Countdown({ deadline, serverNow, skewMs, className }: { deadline: string; serverNow: string; skewMs: number; className?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  // First render (server + hydration) uses the server's own clock.
  const ms = now === null ? Math.max(0, Date.parse(deadline) - Date.parse(serverNow)) : (remainingMs(deadline, now, skewMs) ?? 0);
  return (
    <span className={cx("font-bold tabular-nums", ms < 10_000 && "text-neg", className)} role="timer" aria-live="off">
      {formatClock(ms)}
    </span>
  );
}

function ClockBanner({
  state,
  team,
  mine,
  untilMine,
  skewMs,
}: {
  state: DraftStateJson;
  team: DraftTeamInfo | undefined;
  mine: boolean;
  untilMine: number | null;
  skewMs: number;
}) {
  const clock = state.onClock;
  if (!clock) return null;
  const paused = state.status === "paused";
  return (
    <div
      className={cx(
        "sticky top-14 z-10 -mx-4 mb-3 border-b px-4 py-2 backdrop-blur",
        mine && !paused ? "border-accent bg-accent-soft/95" : "border-line bg-surface/95",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cx("text-xs font-bold uppercase tracking-wide", mine && !paused ? "text-accent" : "text-muted")}>
            {paused ? "Draft paused" : mine ? "You're on the clock!" : "On the clock"}
          </p>
          <p className="truncate text-lg font-bold leading-tight">{team?.name ?? "—"}</p>
          <p className="text-xs text-muted">
            Round {clock.round} · Pick {clock.pickInRound} · #{clock.overall + 1} of {state.totalPicks}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {paused ? (
            <>
              <span className="block text-3xl font-bold tabular-nums text-muted">{formatClock(state.pausedRemainingMs ?? 0)}</span>
              <span className="text-xs text-muted">left when it resumes</span>
            </>
          ) : state.deadline ? (
            <Countdown deadline={state.deadline} serverNow={state.serverNow} skewMs={skewMs} className="block text-4xl" />
          ) : null}
        </div>
      </div>
      {!mine && untilMine !== null && untilMine > 0 ? (
        <p className="mt-1 text-xs text-muted">
          Your next pick is {untilMine === 1 ? "up next" : `in ${untilMine} picks`}.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function TabBar({ tabs, active, onChange }: { tabs: { key: Tab; label: ReactNode }[]; active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="mb-3 flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            "min-h-11 flex-1 whitespace-nowrap rounded-lg px-3 text-center text-sm font-semibold",
            active === t.key ? "bg-surface text-ink shadow-sm" : "text-muted",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function RecentPicks({ state, poolById, teamById }: { state: DraftStateJson; poolById: Map<string, DraftLawyer>; teamById: Map<string, DraftTeamInfo> }) {
  const recent = state.picks.slice(-8).reverse();
  if (recent.length === 0) return null;
  return (
    <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Recent picks">
      {recent.map((p, i) => {
        const l = poolById.get(p.lawyerId);
        return (
          <div
            key={p.overall}
            className={cx("w-40 shrink-0 rounded-xl border px-3 py-2", i === 0 ? "border-brand/40 bg-brand-soft" : "border-line bg-surface")}
          >
            <p className="text-[11px] text-muted">
              #{p.overall + 1} · {p.round}.{String(p.pickInRound).padStart(2, "0")}
              {p.isAuto ? " · auto" : ""}
            </p>
            <p className="truncate text-sm font-semibold">
              {l?.name ?? "Removed lawyer"}
              {l ? <span className="ml-1 text-xs font-semibold text-muted">{POSITION_SHORT[l.position]}</span> : null}
            </p>
            <p className="truncate text-xs text-muted">{teamById.get(p.teamId)?.name}</p>
          </div>
        );
      })}
    </div>
  );
}

/** Action results float above the bottom nav so they're visible while scrolled down the list. */
function Toast({ message, onClose }: { message: ActionResult<unknown> | null; onClose: () => void }) {
  if (!message || (message.ok && !message.message)) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 mx-auto max-w-xl px-4" role="status" aria-live="polite">
      <button type="button" className="pointer-events-auto block w-full rounded-xl text-left shadow-lg" onClick={onClose} title="Tap to dismiss">
        <ActionMessage state={message} />
      </button>
    </div>
  );
}

function ConnectionNotice({ connection, leagueId }: { connection: PollConnection; leagueId: string }) {
  if (connection === "signed_out") {
    return (
      <Notice tone="error">
        You&apos;re signed out, so the draft stopped updating.{" "}
        <Link
          href={`/login?next=${encodeURIComponent(`/leagues/${leagueId}/draft`)}`}
          className="inline-flex min-h-11 items-center font-semibold underline"
        >
          Log in again
        </Link>
      </Notice>
    );
  }
  if (connection === "retrying") return <Notice tone="warn">Connection hiccup. Retrying…</Notice>;
  return null;
}

/** Shown instead of the room once the server says this league isn't available to the viewer any more. */
function RemovedNotice() {
  return (
    <Card className="space-y-3">
      <p className="text-lg font-bold">This draft isn&apos;t available to you</p>
      <p className="text-sm text-muted">
        You&apos;re no longer a member of this league, or it was deleted. Ask the commissioner if you think that&apos;s a mistake.
      </p>
      <LinkButton href="/" className="w-full">
        Back to my leagues
      </LinkButton>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Draft room
// ---------------------------------------------------------------------------

export function DraftRoom({ leagueId, initial, roster, scheduledLabel, afterDraft, projections = EMPTY_PROJECTIONS }: Props) {
  const { state, pool, skewMs, connection, refetch } = useDraftState(leagueId, initial);
  const [message, setMessage] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>(initial.status === "complete" ? "board" : "lawyers");
  const [commishMode, setCommishMode] = useState(false);
  const [filters, setFilters] = useState<LawyerFilters>(DEFAULT_FILTERS);

  const poolById = useMemo(() => new Map(pool.map((l) => [l.id, l])), [pool]);
  const teamById = useMemo(() => new Map(state.teams.map((t) => [t.id, t])), [state.teams]);
  const picked = useMemo(() => new Set(state.picks.map((p) => p.lawyerId)), [state.picks]);
  const queued = useMemo(() => new Set(state.myQueue), [state.myQueue]);

  const myTeam = state.myTeamId ? teamById.get(state.myTeamId) : undefined;
  const live = state.status === "in_progress" || state.status === "paused";
  const onClockTeam = state.onClock ? teamById.get(state.onClock.teamId) : undefined;
  const isMyTurn = state.status === "in_progress" && !!state.onClock && state.onClock.teamId === state.myTeamId;
  const untilMine = live && myTeam ? picksUntilMyTurn(state.currentPick, myTeam.draftPosition, state.teams.length, state.totalPicks) : null;
  const commishPicking = state.isCommissioner && commishMode && live && !!state.onClock && !isMyTurn;
  const lastPick = state.picks.length > 0 ? state.picks[state.picks.length - 1] : null;

  // Get attention when my turn starts.
  useEffect(() => {
    if (!isMyTurn) return;
    try {
      navigator.vibrate?.(200);
    } catch {
      // not supported
    }
    const before = document.title;
    document.title = "Your pick! · Draft room";
    return () => {
      document.title = before;
    };
  }, [isMyTurn]);

  // Success messages fade after a few seconds; errors stay until the next action.
  useEffect(() => {
    if (!message?.ok) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const run = (fn: () => Promise<ActionResult>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    startTransition(async () => {
      let res: ActionResult;
      try {
        res = await fn();
      } catch {
        res = { ok: false, error: "Something went wrong. Try again." };
      }
      setMessage(res.ok && !res.message ? null : res);
      await refetch();
    });
  };

  const rowActions: RowActions = {
    canDraft: isMyTurn,
    commishPickFor: commishPicking ? (onClockTeam?.name ?? null) : null,
    canQueue: !!state.myTeamId && state.status !== "complete",
    busy: pending,
    onDraft: (l) => run(() => makePickAction(leagueId, l.id)),
    onCommishPick: (l) =>
      run(() => commissionerPickAction(leagueId, l.id, state.onClock!.overall), `Draft ${l.name} for ${onClockTeam?.name ?? "this team"}?`),
    onQueueAdd: (l) => run(() => queueAddAction(leagueId, l.id)),
    onQueueRemove: (l) => run(() => queueRemoveAction(leagueId, l.id)),
  };

  const queuePanel = (
    <QueuePanel
      queue={state.myQueue.filter((id) => !picked.has(id))}
      poolById={poolById}
      canDraft={isMyTurn}
      canEdit={state.status !== "complete"}
      busy={pending}
      onDraft={rowActions.onDraft}
      onMove={(l, dir) => run(() => queueMoveAction(leagueId, l.id, dir))}
      onRemove={rowActions.onQueueRemove}
    />
  );
  const lawyersPanel = (
    <LawyersPanel
        pool={pool}
        picked={picked}
        queued={queued}
        actions={rowActions}
        filters={filters}
        onFilters={setFilters}
        projections={projections}
      />
  );
  const toast = <Toast message={message} onClose={() => setMessage(null)} />;
  const boardPanel = (
    <BoardPanel teams={state.teams} picks={state.picks} rounds={state.rounds} poolById={poolById} myTeamId={state.myTeamId} onClock={state.onClock} />
  );
  const teamPanel = (
    <TeamPanel teams={state.teams} picks={state.picks} rounds={state.rounds} poolById={poolById} myTeamId={state.myTeamId} roster={roster} />
  );
  const queueLabel = state.myQueue.length > 0 ? `Queue (${state.myQueue.length})` : "Queue";

  // ----- No access any more (removed from the league) ---------------------
  if (connection === "removed") return <RemovedNotice />;

  // ----- Before the draft -------------------------------------------------
  if (state.status === "not_started") {
    const tabs: { key: Tab; label: ReactNode }[] = [{ key: "lawyers", label: "Lawyers" }];
    if (state.myTeamId) tabs.push({ key: "queue", label: queueLabel });
    const activeTab = tabs.some((t) => t.key === tab) ? tab : "lawyers";
    return (
      <div className="space-y-4">
        <ConnectionNotice connection={connection} leagueId={leagueId} />
        <PreDraft
          state={state}
          scheduledLabel={scheduledLabel}
          busy={pending}
          onMove={(teamId, dir) => run(() => moveTeamAction(leagueId, teamId, dir))}
          onRandomize={() => run(() => randomizeOrderAction(leagueId), "Shuffle the draft order?")}
          onStart={() =>
            run(() => startDraftAction(leagueId), "Start the draft now? The first team goes on the clock right away.")
          }
        />
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Get ready</h2>
          <TabBar tabs={tabs} active={activeTab} onChange={setTab} />
          {activeTab === "queue" ? queuePanel : lawyersPanel}
        </section>
        {toast}
      </div>
    );
  }

  // ----- Draft complete ---------------------------------------------------
  if (state.status === "complete") {
    const tabs: { key: Tab; label: ReactNode }[] = [
      { key: "board", label: "Board" },
      { key: "team", label: "Teams" },
    ];
    const activeTab = tabs.some((t) => t.key === tab) ? tab : "board";
    const copy = afterDraftCopy(afterDraft);
    const seasonOver = afterDraft.phase === "playoffs" || afterDraft.phase === "complete";
    return (
      <div className="space-y-4">
        <ConnectionNotice connection={connection} leagueId={leagueId} />
        <Card>
          <p className="text-lg font-bold">{copy.title}</p>
          <p className="mt-1 text-sm text-muted">{copy.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {seasonOver ? (
              <LinkButton href={`/leagues/${leagueId}/standings`}>
                {afterDraft.phase === "complete" ? "Final standings" : "Standings & bracket"}
              </LinkButton>
            ) : state.myTeamId ? (
              <LinkButton href={`/leagues/${leagueId}/team`}>My Team</LinkButton>
            ) : null}
            <LinkButton href={`/leagues/${leagueId}`} variant="secondary">
              League home
            </LinkButton>
          </div>
        </Card>
        <TabBar tabs={tabs} active={activeTab} onChange={setTab} />
        {activeTab === "team" ? teamPanel : boardPanel}
        {toast}
      </div>
    );
  }

  // ----- Live / paused ----------------------------------------------------
  const tabs: { key: Tab; label: ReactNode }[] = [{ key: "lawyers", label: "Lawyers" }];
  if (state.myTeamId) tabs.push({ key: "queue", label: queueLabel });
  tabs.push({ key: "board", label: "Board" }, { key: "team", label: state.myTeamId ? "My Team" : "Teams" });
  const activeTab = tabs.some((t) => t.key === tab) ? tab : "lawyers";

  return (
    <div>
      <ClockBanner state={state} team={onClockTeam} mine={isMyTurn} untilMine={untilMine} skewMs={skewMs} />
      <div className="space-y-3">
        <ConnectionNotice connection={connection} leagueId={leagueId} />
        {state.status === "paused" && !state.isCommissioner ? (
          <Notice tone="warn">The commissioner paused the draft. Hang tight!</Notice>
        ) : null}
        {isMyTurn ? <Notice tone="info">Pick a lawyer below or from your queue.</Notice> : null}
      </div>
      {toast}
      <div className="mt-3">
        <RecentPicks state={state} poolById={poolById} teamById={teamById} />
      </div>
      <TabBar tabs={tabs} active={activeTab} onChange={setTab} />
      {activeTab === "queue" ? queuePanel : activeTab === "board" ? boardPanel : activeTab === "team" ? teamPanel : lawyersPanel}

      {state.isCommissioner ? (
        <Card className="mt-6">
          <CardTitle>Commissioner tools</CardTitle>
          <div className="grid grid-cols-2 gap-2">
            {state.status === "paused" ? (
              <Button disabled={pending} onClick={() => run(() => resumeDraftAction(leagueId))}>
                Resume draft
              </Button>
            ) : (
              <Button variant="secondary" disabled={pending} onClick={() => run(() => pauseDraftAction(leagueId))}>
                Pause draft
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={pending || !lastPick}
              onClick={() => {
                if (!lastPick) return;
                const who = teamById.get(lastPick.teamId)?.name ?? "that team";
                const what = poolById.get(lastPick.lawyerId)?.name ?? "that lawyer";
                run(() => undoLastPickAction(leagueId, lastPick.overall), `Undo ${who}'s pick of ${what}? They go back on the clock.`);
              }}
            >
              Undo last pick
            </Button>
          </div>
          {!isMyTurn && onClockTeam ? (
            <div className="mt-3">
              <Button
                variant={commishMode ? "primary" : "secondary"}
                className="w-full"
                aria-pressed={commishMode}
                onClick={() => {
                  setCommishMode((m) => !m);
                  setTab("lawyers");
                }}
              >
                {commishMode ? `Picking for ${onClockTeam.name}: tap Pick on a lawyer` : `Make the pick for ${onClockTeam.name}`}
              </Button>
              {commishMode ? (
                <p className="mt-1 text-xs text-muted">Tap the button again to stop picking for other teams.</p>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pre-draft card
// ---------------------------------------------------------------------------

function PreDraft({
  state,
  scheduledLabel,
  busy,
  onMove,
  onRandomize,
  onStart,
}: {
  state: DraftStateJson;
  scheduledLabel: string | null;
  busy: boolean;
  onMove: (teamId: string, dir: "up" | "down") => void;
  onRandomize: () => void;
  onStart: () => void;
}) {
  const n = state.teams.length;
  const needed = state.rounds * n;
  const iconBtn =
    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-ink disabled:opacity-40";
  return (
    <>
      <Card>
        <CardTitle>Draft details</CardTitle>
        <ul className="space-y-1.5 text-sm">
          {scheduledLabel ? (
            <li>
              <span className="text-muted">Scheduled:</span> <span className="font-semibold">{scheduledLabel}</span>
            </li>
          ) : null}
          <li>
            <span className="text-muted">Rounds:</span> <span className="font-semibold">{state.rounds}</span> (one per roster spot)
          </li>
          <li>
            <span className="text-muted">Pick clock:</span> <span className="font-semibold">{state.secondsPerPick} seconds</span>
          </li>
          <li>
            <span className="text-muted">Lawyers in the pool:</span> <span className="font-semibold">{state.poolSize}</span>
          </li>
          <li className="text-muted">
            Snake order: round 1 goes 1 → {Math.max(n, 1)}, round 2 comes back {Math.max(n, 1)} → 1. If your clock runs out,
            we pick for you from your queue, then your open spots, then draft rank.
          </li>
        </ul>
        {state.isCommissioner ? (
          <div className="mt-4 space-y-2">
            {n < 2 ? <Notice tone="warn">You need at least 2 teams to start. Share your invite code!</Notice> : null}
            {n >= 2 && state.poolSize < needed ? (
              <Notice tone="warn">
                This draft needs {needed} lawyers but the pool has {state.poolSize}. Add more in Commissioner → Pool.
              </Notice>
            ) : null}
            <Button className="w-full" disabled={busy || n < 2 || state.poolSize < needed} onClick={onStart}>
              Start draft
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <Notice tone="info">Waiting for the commissioner to start the draft. Build your queue to get ready!</Notice>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle
          action={
            state.isCommissioner && n > 1 ? (
              <Button variant="ghost" className="-my-2 px-3" disabled={busy} onClick={onRandomize}>
                Randomize
              </Button>
            ) : null
          }
        >
          Draft order
        </CardTitle>
        {!state.orderSet && n > 0 ? (
          <p className="mb-2 text-xs text-muted">
            {state.teams.some((t) => t.draftPosition !== null)
              ? "Teams without a spot get a random one after the others when the draft starts."
              : "The order is random unless the commissioner sets it."}
          </p>
        ) : null}
        {n === 0 ? (
          <p className="text-sm text-muted">No teams yet.</p>
        ) : (
          <ol>
            {state.teams.map((t, i) => (
              <li key={t.id} className="flex min-h-12 items-center gap-2 border-b border-line py-1.5 last:border-b-0">
                <span className="w-7 shrink-0 text-center text-sm font-bold tabular-nums text-muted">
                  {t.draftPosition !== null ? i + 1 : "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cx("truncate font-semibold", t.id === state.myTeamId && "text-brand")}>
                    {t.name}
                    {t.id === state.myTeamId ? <Badge tone="brand" className="ml-1.5">You</Badge> : null}
                  </p>
                  <p className="truncate text-xs text-muted">{t.ownerName}</p>
                </div>
                {state.isCommissioner ? (
                  <>
                    <button
                      type="button"
                      className={iconBtn}
                      disabled={busy || i === 0}
                      onClick={() => onMove(t.id, "up")}
                      aria-label={`Move ${t.name} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={iconBtn}
                      disabled={busy || i === n - 1}
                      onClick={() => onMove(t.id, "down")}
                      aria-label={`Move ${t.name} down`}
                    >
                      ↓
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-muted">{plural(n, "team")} · {plural(needed, "pick")} total</p>
      </Card>
    </>
  );
}
