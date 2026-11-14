"use client";

/**
 * Client pieces of the court-data screens. Search results live in client
 * state (from the Server Action's result), so later mutations that refresh
 * the page never re-run a CourtListener search.
 */
import Link from "next/link";
import { startTransition, useActionState, useState, type FormEvent } from "react";
import { Badge, Button, buttonClass, Card, CardTitle, EmptyState, Field, Input, Notice, Select } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { plural } from "@/lib/format";
import { CASE_TYPE_LABELS, CASE_TYPES, POSITION_LABELS, POSITION_SHORT, sideLabel, SIDES, type CaseType, type Position } from "@/lib/settings";
import { formatDate } from "@/lib/time";
import type { ActionResult } from "@/server/action-result";
import type { ClDocket } from "@/server/court/courtlistener";
import { CAPTION_MAX, DOCKET_MAX, INDIVIDUAL_POSITIONS, NAME_MAX } from "../pool/pool-rules";
import {
  courtLabel,
  guessCaseType,
  guessPosition,
  listWithMore,
  matchNames,
  normName,
  previewNames,
  type CaseSearchData,
  type CourtSearchData,
  type PoolCaseRef,
  type SearchMode,
  type SyncSummary,
} from "./court-rules";

type FormAction<T> = (prev: ActionResult<T> | null, formData: FormData) => Promise<ActionResult<T>>;
/** A bound Server Action that only returns a message (also fits ActionForm). */
type PlainAction = (prev: unknown, formData: FormData) => Promise<ActionResult>;

/**
 * useActionState with a manual submit (like ActionForm), so React doesn't
 * reset the fields after the action and `pending` covers the whole request.
 */
function useFormAction<T>(action: FormAction<T>) {
  const [state, formAction, pending] = useActionState<ActionResult<T> | null, FormData>(action, null);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const formData = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(formData));
  }
  return { state, formAction, pending, onSubmit };
}

function ErrorNotice({ state }: { state: ActionResult<unknown> | null }) {
  return state && !state.ok ? <Notice tone="error">{state.error}</Notice> : null;
}

function day(s: string | null): string | null {
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? formatDate(s.slice(0, 10)) : null;
}

// ---------------------------------------------------------------------------
// Sync now
// ---------------------------------------------------------------------------

export function SyncNowForm({ action, reviewHref }: { action: FormAction<SyncSummary>; reviewHref: string }) {
  const { state, formAction, pending, onSubmit } = useFormAction(action);
  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-2">
      <Button type="submit" variant="secondary" className="w-full" disabled={pending}>
        {pending ? "Syncing…" : "Sync now"}
      </Button>
      {state?.ok ? (
        <Notice tone="success">
          {state.message}{" "}
          <Link href={reviewHref} className="font-semibold underline">
            Review queue ›
          </Link>
          {state.data?.error ? <span className="mt-1 block text-neg">The sync stopped early: {state.data.error}</span> : null}
        </Notice>
      ) : (
        <ErrorNotice state={state} />
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Docket facts shared by both result lists
// ---------------------------------------------------------------------------

function DocketFacts({ d }: { d: ClDocket }) {
  const dates = [day(d.dateFiled) && `Filed ${day(d.dateFiled)}`, day(d.dateTerminated) && `Terminated ${day(d.dateTerminated)}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="min-w-0">
      <p className="font-semibold leading-snug">{d.caseName || "Untitled docket"}</p>
      <p className="text-sm text-muted">{[courtLabel(d.courtId) ?? d.court, d.docketNumber].filter(Boolean).join(" · ")}</p>
      {dates ? <p className="text-xs text-muted">{dates}</p> : null}
    </div>
  );
}

function NameList({ label, names, max = 3 }: { label: string; names: { name: string; matched: boolean }[]; max?: number }) {
  if (names.length === 0) return null;
  const { shown, more } = previewNames(names, Math.max(max, names.filter((n) => n.matched).length));
  return (
    <p className="text-sm">
      <span className="text-muted">{label}: </span>
      {shown.map((n, i) => (
        <span key={n.name}>
          {i > 0 ? ", " : ""}
          {n.matched ? <mark className="rounded bg-brand-soft px-1 font-semibold text-brand">{n.name}</mark> : n.name}
        </span>
      ))}
      {more > 0 ? <span className="text-muted"> and {more} more</span> : null}
    </p>
  );
}

function ViewOnCourtListener({ d }: { d: ClDocket }) {
  return (
    <a href={d.url} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "px-2")}>
      View on CourtListener ↗
    </a>
  );
}

// ---------------------------------------------------------------------------
// Case page: find this case's docket
// ---------------------------------------------------------------------------

export function CaseDocketSearch({
  caseId,
  action,
  linkAction,
  defaults,
  courtHint,
}: {
  caseId: string;
  action: FormAction<CaseSearchData>;
  linkAction: PlainAction;
  defaults: { docketNumber: string; caseName: string; court: string };
  courtHint: string;
}) {
  const { state, formAction, pending, onSubmit } = useFormAction(action);
  const data = state?.ok ? state.data : undefined;
  return (
    <div className="space-y-3">
      <form action={formAction} onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Docket number">
            <Input name="docketNumber" defaultValue={defaults.docketNumber} maxLength={DOCKET_MAX} autoComplete="off" />
          </Field>
          <Field label="Court" hint={courtHint}>
            <Input name="court" defaultValue={defaults.court} maxLength={80} placeholder="e.g. nysd" autoComplete="off" />
          </Field>
        </div>
        <Field label="Caption words" hint="Results must match every field you fill in.">
          <Input name="caseName" defaultValue={defaults.caseName} maxLength={CAPTION_MAX} autoComplete="off" />
        </Field>
        <Button type="submit" variant="secondary" className="w-full" disabled={pending}>
          {pending ? "Searching…" : "Find on CourtListener"}
        </Button>
        <ErrorNotice state={state} />
      </form>

      {data ? (
        data.results.length === 0 ? (
          <EmptyState title="No dockets found">
            {data.bothFields
              ? "Nothing matched both the docket number and the caption words. Clear one of them and search again."
              : "Check the docket number or try different words."}
          </EmptyState>
        ) : (
          <div>
            <p className="text-sm text-muted">
              {plural(data.results.length, "docket")} found{data.results.length >= 20 ? " (first page — add more details to narrow it down)" : ""}
            </p>
            {data.results.map(({ docket: d, linkedTo }) => (
              <div key={d.docketId} className="space-y-1 border-b border-line py-3 last:border-b-0">
                <DocketFacts d={d} />
                <p className="text-xs text-muted">
                  {d.attorneys.length > 0 ? `Attorneys: ${listWithMore(d.attorneys)}` : "No attorney list on CourtListener."}
                </p>
                {linkedTo ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <ViewOnCourtListener d={d} />
                    <span className="text-xs text-muted">{linkedTo.id === caseId ? "Linked to this case" : `Linked to ${linkedTo.caption}`}</span>
                  </div>
                ) : (
                  <ActionForm action={linkAction} className="space-y-2">
                    <input type="hidden" name="caseId" value={caseId} />
                    <input type="hidden" name="docketId" value={d.docketId} />
                    <div className="flex flex-wrap items-center gap-2">
                      <ViewOnCourtListener d={d} />
                      <SubmitButton variant="secondary" className="flex-1" pendingText="Linking…">
                        Link this docket
                      </SubmitButton>
                    </div>
                  </ActionForm>
                )}
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Court data page: search by attorney / firm
// ---------------------------------------------------------------------------

export type LawyerOption = { id: string; name: string; kind: "lawyer" | "firm"; position: Position };

type ResultActions = {
  addCaseAction: FormAction<PoolCaseRef>;
  linkAction: PlainAction;
  addLawyerAction: PlainAction;
};

export function CourtSearch({
  searchAction,
  lawyers,
  caseBase,
  ...actions
}: ResultActions & {
  searchAction: FormAction<CourtSearchData>;
  lawyers: LawyerOption[];
  /** e.g. /leagues/<id>/commish/pool/cases */
  caseBase: string;
}) {
  const { state, formAction, pending, onSubmit } = useFormAction(searchAction);
  const data = state?.ok ? state.data : undefined;
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Search CourtListener</CardTitle>
        <form action={formAction} onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-[7.5rem_1fr] gap-3">
            <Field label="Search by">
              <Select name="mode" defaultValue="attorney">
                <option value="attorney">Attorney</option>
                <option value="firm">Firm</option>
              </Select>
            </Field>
            <Field label="Name">
              <Input name="name" required minLength={2} maxLength={NAME_MAX} placeholder="e.g. Jane Doe" autoComplete="off" />
            </Field>
          </div>
          <Field label="Court" hint="Optional. A court like “S.D.N.Y.” or a CourtListener id like “nysd”.">
            <Input name="court" maxLength={80} autoComplete="off" />
          </Field>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Searching…" : "Search dockets"}
          </Button>
          <p className="text-xs text-muted">Each search uses one of the app&apos;s ~125 free CourtListener requests for the day.</p>
          <ErrorNotice state={state} />
        </form>
      </Card>

      {data ? (
        data.results.length === 0 ? (
          <EmptyState title="No dockets found">
            CourtListener has no dockets listing {data.mode === "attorney" ? "an attorney" : "a firm"} named “{data.name}”. Check the spelling or try
            just the last name.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {plural(data.results.length, "docket")} with {data.mode === "attorney" ? "attorney" : "firm"} “{data.name}”
              {data.results.length >= 20 ? " (first page — add a court to narrow it down)" : ""}
            </p>
            {data.results.map((r) => (
              <DocketResultCard
                key={`${data.mode}|${data.name}|${r.docket.docketId}`}
                d={r.docket}
                initialPoolCase={r.poolCase}
                mode={data.mode}
                query={data.name}
                lawyers={lawyers}
                caseBase={caseBase}
                {...actions}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function DocketResultCard({
  d,
  initialPoolCase,
  mode,
  query,
  lawyers,
  caseBase,
  addCaseAction,
  linkAction,
  addLawyerAction,
}: ResultActions & {
  d: ClDocket;
  initialPoolCase: PoolCaseRef | null;
  mode: SearchMode;
  query: string;
  lawyers: LawyerOption[];
  caseBase: string;
}) {
  const add = useFormAction(addCaseAction);
  const link = useFormAction(linkAction);
  const [lawyerFormOpen, setLawyerFormOpen] = useState(false);
  const justAdded = add.state?.ok && add.state.data ? add.state.data : null;
  const poolCase = justAdded ?? initialPoolCase;
  const isLinked = !!poolCase && (poolCase.linkedDocketId === d.docketId || !!link.state?.ok);

  const attorneys = matchNames(d.attorneys, mode === "attorney" ? query : "");
  const firms = matchNames(d.firms, mode === "firm" ? query : "");
  const matched = (mode === "attorney" ? attorneys : firms).find((n) => n.matched)?.name ?? query;

  return (
    <Card className="space-y-2">
      <DocketFacts d={d} />
      <NameList label="Attorneys" names={attorneys} />
      <NameList label="Firms" names={firms} />
      {mode === "attorney" && attorneys.length === 0 ? <p className="text-xs text-muted">No attorney list on CourtListener.</p> : null}
      <ViewOnCourtListener d={d} />

      <div className="space-y-3 border-t border-line pt-3">
        {poolCase ? (
          <>
            {justAdded ? <Notice tone="success">{add.state?.ok ? add.state.message : null}</Notice> : null}
            <div className="flex min-h-11 flex-wrap items-center gap-2">
              <Badge tone="pos">{justAdded ? "Added" : "Already in pool"}</Badge>
              <Link href={`${caseBase}/${poolCase.id}`} className="min-w-0 flex-1 truncate text-sm font-semibold text-brand">
                {poolCase.caption} ›
              </Link>
            </div>
            {isLinked ? (
              <p className="text-xs text-muted">Linked to this CourtListener docket.</p>
            ) : poolCase.linkedDocketId != null ? (
              <p className="text-xs text-muted">That pool case is linked to a different CourtListener docket.</p>
            ) : (
              <form action={link.formAction} onSubmit={link.onSubmit} className="space-y-2">
                <input type="hidden" name="caseId" value={poolCase.id} />
                <input type="hidden" name="docketId" value={d.docketId} />
                <Button type="submit" variant="secondary" className="w-full" disabled={link.pending}>
                  {link.pending ? "Linking…" : "Link"}
                </Button>
                <ErrorNotice state={link.state} />
              </form>
            )}
            <details
              className="rounded-xl border border-line"
              open={lawyerFormOpen}
              onToggle={(e) => setLawyerFormOpen(e.currentTarget.open)}
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-semibold text-brand [&::-webkit-details-marker]:hidden">
                Add lawyer to this case
                <span aria-hidden>{lawyerFormOpen ? "−" : "+"}</span>
              </summary>
              {lawyerFormOpen ? (
                <div className="px-3 pb-3">
                  <AddLawyerForm
                    action={addLawyerAction}
                    caseId={poolCase.id}
                    caseType={poolCase.caseType}
                    lawyers={lawyers}
                    mode={mode}
                    matchedName={matched}
                  />
                </div>
              ) : null}
            </details>
          </>
        ) : (
          <form action={add.formAction} onSubmit={add.onSubmit} className="space-y-3">
            <input type="hidden" name="docketId" value={d.docketId} />
            <input type="hidden" name="caseName" value={d.caseName} />
            <input type="hidden" name="docketNumber" value={d.docketNumber} />
            <input type="hidden" name="courtId" value={d.courtId} />
            <input type="hidden" name="courtName" value={d.court} />
            <input type="hidden" name="dateFiled" value={d.dateFiled ?? ""} />
            <input type="hidden" name="dateTerminated" value={d.dateTerminated ?? ""} />
            <input type="hidden" name="url" value={d.url} />
            <div className="flex items-end gap-2">
              <Field label="Case type">
                <Select name="caseType" defaultValue={guessCaseType(d.docketNumber, d.courtId)} className="w-40">
                  {CASE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {CASE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" className="flex-1" disabled={add.pending}>
                {add.pending ? "Adding…" : "Add case"}
              </Button>
            </div>
            <ErrorNotice state={add.state} />
          </form>
        )}
      </div>
    </Card>
  );
}

function AddLawyerForm({
  action,
  caseId,
  caseType,
  lawyers,
  mode,
  matchedName,
}: {
  action: PlainAction;
  caseId: string;
  caseType: CaseType;
  lawyers: LawyerOption[];
  mode: SearchMode;
  /** The attorney/firm name from the search (as written on the docket when it matched). */
  matchedName: string;
}) {
  const { state, formAction, pending, onSubmit } = useFormAction(action);
  const individuals = lawyers.filter((l) => l.kind === "lawyer");
  const firms = lawyers.filter((l) => l.kind === "firm");
  const lawyerName = mode === "attorney" ? matchedName : "";
  const firmName = mode === "firm" ? matchedName : "";
  const existing = (mode === "firm" ? firms : individuals).find((l) => normName(l.name) === normName(matchedName));
  const existingFirm = firmName ? firms.find((f) => normName(f.name) === normName(firmName)) : undefined;
  const [who, setWho] = useState<string>(existing?.id ?? (mode === "firm" ? "new-firm" : "new-lawyer"));
  const [firmChoice, setFirmChoice] = useState<string>(existingFirm?.id ?? (firmName ? "new" : ""));
  const isNew = who === "new-lawyer" || who === "new-firm";

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-3 pt-1">
      <input type="hidden" name="caseId" value={caseId} />
      <Field label="Who">
        <Select name="who" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="new-lawyer">New lawyer…</option>
          <option value="new-firm">New firm…</option>
          {individuals.length > 0 ? (
            <optgroup label="Lawyers in the pool">
              {individuals.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({POSITION_SHORT[l.position]})
                </option>
              ))}
            </optgroup>
          ) : null}
          {firms.length > 0 ? (
            <optgroup label="Firms in the pool">
              {firms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
      </Field>
      {isNew ? (
        <Field label={who === "new-firm" ? "Firm name" : "Lawyer's name"} hint="Check the spelling against the docket.">
          <Input
            key={who}
            name="name"
            defaultValue={who === "new-firm" ? firmName : lawyerName}
            minLength={2}
            maxLength={NAME_MAX}
            autoComplete="off"
            required
          />
        </Field>
      ) : null}
      {who === "new-lawyer" ? (
        <>
          <Field label="Position">
            <Select name="position" defaultValue={guessPosition(caseType)} required>
              <option value="" disabled>
                Pick one
              </option>
              {INDIVIDUAL_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {POSITION_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Firm">
            <Select name="firmChoice" value={firmChoice} onChange={(e) => setFirmChoice(e.target.value)}>
              <option value="">No firm</option>
              <option value="new">New firm…</option>
              {firms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
          {firmChoice === "new" ? (
            <Field label="New firm name">
              <Input name="newFirmName" defaultValue={firmName} minLength={2} maxLength={NAME_MAX} autoComplete="off" required />
            </Field>
          ) : null}
        </>
      ) : null}
      <Field label="Side">
        <Select name="side" defaultValue="" required>
          <option value="" disabled>
            Pick a side
          </option>
          {SIDES.map((s) => (
            <option key={s} value={s}>
              {sideLabel(caseType, s)}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Adding…" : "Add to case"}
      </Button>
      {state?.ok ? <Notice tone="success">{state.message}</Notice> : <ErrorNotice state={state} />}
    </form>
  );
}
