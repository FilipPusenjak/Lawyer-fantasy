"use client";

import { useState } from "react";
import { Field, Select } from "@/components/ui";
import { EVENT_LABELS, sideLabel, SIDES, type CaseType, type Side } from "@/lib/settings";
import type { EventMissing } from "@/server/services/events";
import { choiceField, eventLabel, INLINE_TYPE_GROUPS, isEventType, targetKind, type AppearanceOption } from "./event-rules";
import { ReviewButton } from "./review-form";

const GENERIC_SIDE: Record<Side, string> = { plaintiff: "Plaintiff side", defendant: "Defendant side" };

/**
 * Inline picks on a review-queue card: change a suggestion's type, and pick
 * the side or lawyer it's missing. The selects belong to the queue form
 * (names from `choiceField`), so "Approve" / "Approve selected" save the picks
 * and approve in one go; "Save" stores them without approving so the points
 * preview updates.
 */
export function ReviewChoices({
  eventId,
  type,
  side,
  lawyerId,
  caseId,
  caseType,
  missing,
  appearances,
  allowTypeChange,
}: {
  eventId: string;
  /** Current (suggested) type; may be unknown to this version. */
  type: string;
  side: Side | null;
  lawyerId: string | null;
  caseId: string | null;
  caseType: CaseType | null;
  /** What the event still needs as saved (server's view). */
  missing: EventMissing | null;
  /** Lawyers/firms on the event's case, both sides. */
  appearances: AppearanceOption[];
  allowTypeChange: boolean;
}) {
  const savedType = isEventType(type) ? type : "";
  const [t, setT] = useState<string>(savedType);
  const [s, setS] = useState<string>(side ?? "");
  const [l, setL] = useState<string>(lawyerId ?? "");

  const savedKind = savedType ? targetKind(savedType) : null;
  const kind = t ? targetKind(t) : null;
  // Only ask for what the (possibly changed) type needs and the event doesn't have yet.
  const needSide = kind === "side" && (side === null || savedKind !== "side");
  const needLawyer = kind === "lawyer" && (lawyerId === null || savedKind !== "lawyer");

  let todo: string | null = null;
  if (!kind) todo = "Pick an event type to approve this.";
  else if (needSide && !caseId) todo = "This isn't linked to a case. Use Edit to pick one.";
  else if (needSide && !s) todo = "Pick a side to approve this.";
  else if (needLawyer && appearances.length === 0) todo = "Nobody is listed on this case yet. Add lawyers to the case, or use Edit.";
  else if (needLawyer && !l) todo = "Pick who this is about to approve it.";
  else if (kind === "either" && t === savedType && missing) todo = "Use Edit to finish this custom event.";

  const dirty = t !== savedType || (needSide && s !== (side ?? "")) || (needLawyer && l !== (lawyerId ?? ""));
  if (!allowTypeChange && !needSide && !needLawyer && !todo) return null;

  const sideName = (v: Side) => (caseType ? sideLabel(caseType, v) : GENERIC_SIDE[v]);

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
      {allowTypeChange ? (
        <Field label={savedType ? "Event type (suggested)" : "Event type"}>
          <Select name={choiceField.type(eventId)} value={t} onChange={(e) => setT(e.target.value)}>
            <option value="" disabled>
              {savedType ? "Pick an event type" : `Pick a type (suggested: ${eventLabel(type)})`}
            </option>
            {INLINE_TYPE_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.types.map((v) => (
                  <option key={v} value={v}>
                    {EVENT_LABELS[v]}
                  </option>
                ))}
              </optgroup>
            ))}
            {savedType === "custom" ? <option value="custom">{EVENT_LABELS.custom}</option> : null}
          </Select>
        </Field>
      ) : null}

      {needSide && caseId ? (
        <Field label="Which side gets the points?">
          <Select name={choiceField.side(eventId)} value={s} onChange={(e) => setS(e.target.value)}>
            <option value="" disabled>
              Pick a side
            </option>
            {SIDES.map((v) => (
              <option key={v} value={v}>
                {sideName(v)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {needLawyer && appearances.length > 0 ? (
        <Field label="Who is this about?">
          <Select name={choiceField.lawyer(eventId)} value={l} onChange={(e) => setL(e.target.value)}>
            <option value="" disabled>
              Pick a lawyer or firm on this case
            </option>
            {SIDES.map((v) => {
              const people = appearances.filter((a) => a.side === v);
              return people.length > 0 ? (
                <optgroup key={v} label={sideName(v)}>
                  {people.map((a) => (
                    <option key={a.lawyerId} value={a.lawyerId}>
                      {a.name}
                      {a.kind === "firm" ? " (firm)" : ""}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </Select>
        </Field>
      ) : null}

      {todo ? (
        <p className="text-xs font-semibold text-warn">{todo}</p>
      ) : dirty ? (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted">Approve saves this too. Save first to preview the points.</p>
          <ReviewButton op={`save:${eventId}`} variant="secondary" className="shrink-0">
            Save
          </ReviewButton>
        </div>
      ) : null}
    </div>
  );
}
