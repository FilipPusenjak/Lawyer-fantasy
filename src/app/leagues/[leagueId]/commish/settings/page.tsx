import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { db } from "@/db";
import { Badge, Card, CardTitle, Field, Input, Notice, Page, PageHeader, Select } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { rosterSize, starterSlots } from "@/lib/settings";
import { formatDate, formatDateTime } from "@/lib/time";
import { getCommissionerContext } from "@/server/league-context";
import { loadAdminLeague, playoffTeamLimit } from "@/server/services/settings-admin";
import { LEAGUE_STATUS_LABELS } from "@/app/leagues/new/league-rules";
import {
  saveDraftAction,
  saveRosterAction,
  saveScheduleAction,
  saveScoringAction,
  saveTradesAction,
  saveWaiversAction,
} from "./actions";
import { isoToLocalInput, ROSTER_FIELDS, seasonSummary, timezoneOptions, WEEKDAYS } from "./settings-form";
import { DraftClockFields, ScoringFields } from "./settings-fields";

export const metadata: Metadata = { title: "League settings" };

const SECTIONS = [
  { id: "roster", label: "Roster" },
  { id: "scoring", label: "Scoring" },
  { id: "schedule", label: "Schedule" },
  { id: "draft", label: "Draft" },
  { id: "waivers", label: "Waivers" },
  { id: "trades", label: "Trades" },
];

function Section({ id, title, locked, children }: { id: string; title: string; locked?: string | null; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-16">
      <CardTitle action={locked ? <Badge tone="warn">Locked</Badge> : null}>{title}</CardTitle>
      {locked ? (
        <div className="mb-3">
          <Notice tone="warn">{locked}</Notice>
        </div>
      ) : null}
      {children}
    </Card>
  );
}

function tzShort(timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

export default async function SettingsPage({ params }: PageProps<"/leagues/[leagueId]/commish/settings">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  const admin = await loadAdminLeague(db, leagueId);
  const { settings, locks, teamCount } = admin;
  const tz = settings.schedule.timezone;
  const status = ctx.league.status;
  const summary = seasonSummary(settings.schedule, ctx.league.seasonStart);
  const playoffLimit = playoffTeamLimit(locks, settings.maxTeams, teamCount);
  const draftLockedMsg = "Locked because the draft has started.";

  return (
    <Page className="space-y-4">
      <Link href={`/leagues/${leagueId}/commish`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
        ‹ Commissioner
      </Link>
      <PageHeader title="League settings" subtitle={`${ctx.league.name} · ${LEAGUE_STATUS_LABELS[status]}`} />

      <nav aria-label="Sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-line bg-surface px-4 text-sm font-semibold text-muted"
          >
            {s.label}
          </a>
        ))}
      </nav>

      {/* Roster */}
      <Section id="roster" title="Roster spots" locked={locks.roster ? draftLockedMsg : null}>
        <ActionForm action={saveRosterAction.bind(null, leagueId)}>
          <div className="grid grid-cols-2 gap-3">
            {ROSTER_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <Input
                  type="number"
                  name={`roster_${f.key}`}
                  min={0}
                  max={f.max}
                  step={1}
                  inputMode="numeric"
                  defaultValue={settings.roster[f.key]}
                  disabled={locks.roster}
                  required
                />
              </Field>
            ))}
            <Field label="Max teams" hint={teamCount > 0 ? `${teamCount} joined so far` : undefined}>
              <Input
                type="number"
                name="maxTeams"
                min={Math.max(2, teamCount)}
                max={12}
                step={1}
                inputMode="numeric"
                defaultValue={settings.maxTeams}
                disabled={locks.roster}
                required
              />
            </Field>
          </div>
          <p className="text-sm text-muted">
            {starterSlots(settings.roster).length} starters + {settings.roster.bench} bench = {rosterSize(settings.roster)} per team, so the draft
            has {rosterSize(settings.roster)} rounds.
          </p>
          {locks.roster ? null : <SubmitButton className="w-full">Save roster</SubmitButton>}
        </ActionForm>
      </Section>

      {/* Scoring */}
      <Section id="scoring" title="Scoring">
        <ActionForm action={saveScoringAction.bind(null, leagueId)}>
          <Notice>Changes re-score every week that isn&apos;t finalized yet. Finalized weeks keep their scores.</Notice>
          <ScoringFields initial={settings.scoring} />
          <SubmitButton className="w-full">Save scoring</SubmitButton>
        </ActionForm>
      </Section>

      {/* Schedule */}
      <Section id="schedule" title="Schedule">
        <ActionForm action={saveScheduleAction.bind(null, leagueId)}>
          {locks.scheduleShape ? (
            <Notice>
              The season start, time zone and matchup lengths are locked once the draft starts, because the schedule is built from them.
              {locks.playoffTeams ? " Playoff teams are locked too, since the playoffs are set." : null}
            </Notice>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Season starts" hint={locks.seasonStart ? "Locked" : "Must be a Monday"}>
              <Input type="date" name="seasonStart" defaultValue={ctx.league.seasonStart} disabled={locks.seasonStart} required />
            </Field>
            <Field label="Lineups lock at" hint="Every Monday, league time">
              <Input type="time" name="lockTime" defaultValue={settings.schedule.lockTime} required />
            </Field>
          </div>
          <Field label="Time zone" hint={locks.scheduleShape ? "Locked" : "Weeks, lineup locks and waivers use this time zone."}>
            <Select name="timezone" defaultValue={tz} disabled={locks.scheduleShape}>
              {timezoneOptions(tz).map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Weeks per matchup" hint={locks.scheduleShape ? "Locked" : "1 to 4"}>
              <Input
                type="number"
                name="matchupWeeks"
                min={1}
                max={4}
                step={1}
                inputMode="numeric"
                defaultValue={settings.schedule.matchupWeeks}
                disabled={locks.scheduleShape}
                required
              />
            </Field>
            <Field label="Regular-season matchups" hint={locks.scheduleShape ? "Locked" : "1 to 30"}>
              <Input
                type="number"
                name="regularSeasonMatchups"
                min={1}
                max={30}
                step={1}
                inputMode="numeric"
                defaultValue={settings.schedule.regularSeasonMatchups}
                disabled={locks.scheduleShape}
                required
              />
            </Field>
            <Field label="Playoff teams" hint={locks.playoffTeams ? "Locked: playoffs are set" : `0 = no playoffs, or 2 to ${playoffLimit}`}>
              <Input
                type="number"
                name="playoffTeams"
                min={0}
                max={playoffLimit}
                step={1}
                inputMode="numeric"
                defaultValue={settings.schedule.playoffTeams}
                disabled={locks.playoffTeams}
                required
              />
            </Field>
            <Field label="Weeks per playoff round" hint={locks.scheduleShape ? "Locked" : "1 to 4"}>
              <Input
                type="number"
                name="playoffRoundWeeks"
                min={1}
                max={4}
                step={1}
                inputMode="numeric"
                defaultValue={settings.schedule.playoffRoundWeeks}
                disabled={locks.scheduleShape}
                required
              />
            </Field>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
            <p>
              <span className="font-semibold">{summary.totalWeeks} weeks:</span> {summary.regularWeeks} regular season
              {summary.playoffRounds > 0
                ? ` + ${summary.playoffRounds} playoff round${summary.playoffRounds === 1 ? "" : "s"} (${summary.playoffWeeks} weeks)`
                : ", no playoffs"}
              .
            </p>
            <p className="text-muted">
              {formatDate(ctx.league.seasonStart)} – {formatDate(summary.endDate)}
            </p>
          </div>
          {!locks.playoffTeams && settings.schedule.playoffTeams > teamCount && teamCount > 0 && status !== "setup" ? (
            <Notice tone="warn">There are more playoff spots than teams. Lower the number of playoff teams.</Notice>
          ) : null}
          <SubmitButton className="w-full">Save schedule</SubmitButton>
        </ActionForm>
      </Section>

      {/* Draft */}
      <Section id="draft" title="Draft" locked={locks.draft ? draftLockedMsg : null}>
        <ActionForm action={saveDraftAction.bind(null, leagueId)}>
          <DraftClockFields secondsPerPick={settings.draft.secondsPerPick} disabled={locks.draft} />
          <Field label="Draft day (optional)" hint={`League time (${tzShort(tz)}). Shown to everyone in the draft room; you still press Start.`}>
            <Input type="datetime-local" name="scheduledAt" defaultValue={isoToLocalInput(settings.draft.scheduledAt, tz)} disabled={locks.draft} />
          </Field>
          {settings.draft.scheduledAt ? (
            <p className="text-sm text-muted">Scheduled for {formatDateTime(new Date(settings.draft.scheduledAt), tz)}.</p>
          ) : null}
          {locks.draft ? null : <SubmitButton className="w-full">Save draft settings</SubmitButton>}
        </ActionForm>
      </Section>

      {/* Waivers */}
      <Section id="waivers" title="Waivers">
        <ActionForm action={saveWaiversAction.bind(null, leagueId)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Process day">
              <Select name="processDay" defaultValue={String(settings.waivers.processDay)}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Time" hint="League time">
              <Input type="time" name="processTime" defaultValue={settings.waivers.processTime} required />
            </Field>
          </div>
          {ctx.league.nextWaiverRunAt && (status === "in_season" || status === "playoffs") ? (
            <p className="text-sm text-muted">Next run: {formatDateTime(ctx.league.nextWaiverRunAt, tz)}.</p>
          ) : (
            <p className="text-sm text-muted">Waivers start running once the season begins.</p>
          )}
          <SubmitButton className="w-full">Save waivers</SubmitButton>
        </ActionForm>
      </Section>

      {/* Trades */}
      <Section id="trades" title="Trades">
        <ActionForm action={saveTradesAction.bind(null, leagueId)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Review window (hours)" hint="Time to veto accepted trades. 0 = instant.">
              <Input
                type="number"
                name="reviewHours"
                min={0}
                max={168}
                step={1}
                inputMode="numeric"
                defaultValue={settings.trades.reviewHours}
                required
              />
            </Field>
            <Field label="Trade deadline week" hint={`1 to ${summary.totalWeeks}. Blank = no deadline.`}>
              <Input
                type="number"
                name="deadlineWeek"
                min={1}
                max={summary.totalWeeks}
                step={1}
                inputMode="numeric"
                defaultValue={settings.trades.deadlineWeek ?? ""}
                placeholder="None"
              />
            </Field>
          </div>
          <SubmitButton className="w-full">Save trades</SubmitButton>
        </ActionForm>
      </Section>
    </Page>
  );
}
