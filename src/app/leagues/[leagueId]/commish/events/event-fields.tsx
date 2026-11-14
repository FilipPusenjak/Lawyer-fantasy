"use client";

import { useState } from "react";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { EVENT_LABELS, POSITION_SHORT, sideLabel, SIDES, type CaseType, type Position, type Side } from "@/lib/settings";
import { EVENT_GROUPS, SUMMARY_HINT, SUMMARY_MAX, targetKind } from "./event-rules";

export type CaseOption = { id: string; caption: string; docketNumber: string | null; caseType: CaseType; status: "active" | "closed" };
export type LawyerOption = { id: string; name: string; kind: "lawyer" | "firm"; position: Position };
export type EventDefaults = {
  type: string;
  caseId: string;
  side: string;
  lawyerId: string;
  occurredOn: string;
  summary: string;
  sourceUrl: string;
  customPoints: string;
};

const GENERIC_SIDE: Record<Side, string> = {
  plaintiff: "Plaintiff / Prosecution / Appellant / Petitioner",
  defendant: "Defendant / Defense / Appellee / Respondent",
};

function Check({ name, label, hint }: { name: string; label: string; hint?: string }) {
  return (
    <label className="flex min-h-11 items-start gap-3 py-1">
      <input type="checkbox" name={name} defaultChecked className="mt-0.5 h-5 w-5 shrink-0 accent-brand" />
      <span className="text-sm">
        <span className="font-semibold">{label}</span>
        {hint ? <span className="block text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * Fields for adding/editing a scoring event. Case-based types credit a side of
 * a case; lawyer-specific types credit one lawyer (a case can be attached for
 * context); "custom" can be either.
 */
export function EventFields({
  cases,
  lawyers,
  defaults,
  isNew,
  today,
  requireSource,
}: {
  cases: CaseOption[];
  lawyers: LawyerOption[];
  defaults: EventDefaults;
  isNew: boolean;
  today: string;
  requireSource: boolean;
}) {
  const [type, setType] = useState(defaults.type);
  const [caseId, setCaseId] = useState(defaults.caseId);
  const [target, setTarget] = useState<"side" | "lawyer">(defaults.lawyerId ? "lawyer" : "side");
  const kind = targetKind(type);
  const mode = kind === "either" ? target : kind;
  const caseType = cases.find((c) => c.id === caseId)?.caseType;

  return (
    <>
      <Field label="What happened?">
        <Select name="type" value={type} onChange={(e) => setType(e.target.value)} required>
          <option value="" disabled>
            Pick an event type
          </option>
          {EVENT_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.types.map((t) => (
                <option key={t} value={t}>
                  {EVENT_LABELS[t]}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>

      {kind === "either" ? (
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Who gets the points?</legend>
          {(
            [
              ["side", "Everyone on one side of a case"],
              ["lawyer", "One lawyer or firm"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex min-h-11 items-center gap-3">
              <input
                type="radio"
                name="target"
                value={v}
                checked={target === v}
                onChange={() => setTarget(v)}
                className="h-5 w-5 accent-brand"
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {mode === "lawyer" ? (
        <Field label="Lawyer or firm">
          <Select name="lawyerId" defaultValue={defaults.lawyerId} required>
            <option value="" disabled>
              Pick who this is about
            </option>
            <optgroup label="Lawyers">
              {lawyers
                .filter((l) => l.kind === "lawyer")
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({POSITION_SHORT[l.position]})
                  </option>
                ))}
            </optgroup>
            <optgroup label="Firms">
              {lawyers
                .filter((l) => l.kind === "firm")
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </optgroup>
          </Select>
        </Field>
      ) : null}

      <Field label={mode === "lawyer" ? "Case (optional)" : "Case"} hint={cases.length === 0 ? "Add cases in the player pool first." : undefined}>
        <Select name="caseId" value={caseId} onChange={(e) => setCaseId(e.target.value)} required={mode === "side"}>
          <option value="">{mode === "lawyer" ? "No case" : "Pick a case"}</option>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.caption}
              {c.docketNumber ? ` · ${c.docketNumber}` : ""}
              {c.status === "closed" ? " (closed)" : ""}
            </option>
          ))}
        </Select>
      </Field>

      {mode === "side" ? (
        <Field label="Which side?" hint="Every lawyer and firm on this side of the case gets the points.">
          <Select name="side" defaultValue={defaults.side} required>
            <option value="" disabled>
              Pick a side
            </option>
            {SIDES.map((s) => (
              <option key={s} value={s}>
                {caseType ? sideLabel(caseType, s) : GENERIC_SIDE[s]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Date it happened">
          <Input type="date" name="occurredOn" defaultValue={defaults.occurredOn} max={today} required />
        </Field>
        {type === "custom" ? (
          <Field label="Points" hint="-100 to 100">
            <Input type="number" name="customPoints" step="any" min={-100} max={100} defaultValue={defaults.customPoints} required />
          </Field>
        ) : null}
      </div>

      <Field label="Summary" hint={SUMMARY_HINT}>
        <Textarea name="summary" rows={3} maxLength={SUMMARY_MAX} defaultValue={defaults.summary} required />
      </Field>

      <Field label={requireSource ? "Source link" : "Source link (optional)"} hint="Court docket, court website or news story.">
        <Input type="url" name="sourceUrl" defaultValue={defaults.sourceUrl} placeholder="https://…" required={requireSource} autoComplete="off" />
      </Field>

      {isNew ? (
        <div className="rounded-xl border border-line px-3 py-1">
          {type === "verdict_win" && mode === "side" ? (
            <Check name="alsoRecordLoss" label="Also record a trial verdict loss for the other side" />
          ) : null}
          <Check name="approveNow" label="Approve now" hint="Points count right away. Untick to send it to the review queue." />
        </div>
      ) : null}
    </>
  );
}
