"use client";

/**
 * Add / claim / drop controls. All of them submit through one MoveProvider
 * so the result message survives the row changing or disappearing after the
 * page refreshes (e.g. an added lawyer leaves the "Available" list). The
 * message shows as a small toast above the bottom tabs.
 */
import { createContext, startTransition, useActionState, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, cx, Notice, Select } from "@/components/ui";
import { POSITION_SHORT, type Position } from "@/lib/settings";
import type { ActionResult } from "@/server/action-result";
import { rosterMoveAction } from "./actions";

export type DropOption = { id: string; name: string; position: Position };

type MoveContextValue = {
  leagueId: string;
  dropOptions: DropOption[];
  rosterFull: boolean;
  pending: boolean;
  submit: (formData: FormData) => void;
};

const MoveContext = createContext<MoveContextValue | null>(null);

function useMove(): MoveContextValue {
  const ctx = useContext(MoveContext);
  if (!ctx) throw new Error("Move controls must be inside <MoveProvider>.");
  return ctx;
}

export function MoveProvider({
  leagueId,
  dropOptions,
  rosterFull,
  children,
}: {
  leagueId: string;
  /** My roster, for the "drop someone" picker. */
  dropOptions: DropOption[];
  rosterFull: boolean;
  children: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(rosterMoveAction, null);
  const [dismissed, setDismissed] = useState<ActionResult | null>(null);

  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => setDismissed(state), state.ok ? 6000 : 10000);
    return () => clearTimeout(t);
  }, [state]);

  const submit = (formData: FormData) => startTransition(() => dispatch(formData));
  const text = state ? (state.ok ? state.message : state.error) : null;
  const visible = state !== null && state !== dismissed && !!text;

  return (
    <MoveContext value={{ leagueId, dropOptions, rosterFull, pending, submit }}>
      {children}
      {visible ? (
        <div className="fixed inset-x-0 bottom-20 z-40 px-4" role="status" aria-live="polite">
          <div className="mx-auto max-w-xl shadow-lg">
            <Notice tone={state.ok ? "success" : "error"}>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1">{text}</p>
                <button
                  type="button"
                  onClick={() => setDismissed(state)}
                  className="-my-2 -mr-2 flex min-h-11 min-w-11 items-center justify-center text-lg text-muted"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            </Notice>
          </div>
        </div>
      ) : null}
    </MoveContext>
  );
}

function HiddenFields({ leagueId, op, lawyerId }: { leagueId: string; op: "add" | "claim" | "drop"; lawyerId: string }) {
  return (
    <>
      <input type="hidden" name="leagueId" value={leagueId} />
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="lawyerId" value={lawyerId} />
    </>
  );
}

/**
 * "Add" (free agent) or "Claim" (on waivers) button. Tapping it opens a small
 * confirm panel with an optional drop picker (required when the roster is
 * full). Put it inside a `flex flex-wrap` row: the panel wraps to its own line.
 */
export function AddClaimButton({ lawyerId, lawyerName, mode }: { lawyerId: string; lawyerName: string; mode: "add" | "claim" }) {
  const ctx = useMove();
  const [open, setOpen] = useState(false);
  const needsDrop = ctx.rosterFull;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    ctx.submit(new FormData(e.currentTarget));
  }

  return (
    <>
      <Button
        type="button"
        variant={open ? "secondary" : "primary"}
        className="relative z-10 shrink-0 px-3"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Close" : `${mode === "add" ? "Add" : "Claim"} ${lawyerName}`}
      >
        {open ? "Close" : mode === "add" ? "Add" : "Claim"}
      </Button>
      {open ? (
        <form onSubmit={onSubmit} className="relative z-10 basis-full space-y-2 rounded-xl border border-line bg-surface-2 p-3">
          <HiddenFields leagueId={ctx.leagueId} op={mode} lawyerId={lawyerId} />
          <p className="text-sm">
            {mode === "add" ? (
              <>
                Add <span className="font-semibold">{lawyerName}</span> to your team right now?
              </>
            ) : (
              <>
                Claim <span className="font-semibold">{lawyerName}</span>? Claims are decided when waivers run, in waiver priority order.
              </>
            )}
          </p>
          {ctx.dropOptions.length > 0 ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">
                {needsDrop ? "Your roster is full. Who should go?" : mode === "add" ? "Drop someone? (optional)" : "Drop someone if you win? (optional)"}
              </span>
              <Select name="dropLawyerId" required={needsDrop} defaultValue="">
                <option value="" disabled={needsDrop}>
                  {needsDrop ? "Pick a lawyer to drop" : "Nobody, I have room"}
                </option>
                {ctx.dropOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({POSITION_SHORT[o.position]})
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <Button type="submit" className="w-full" disabled={ctx.pending}>
            {ctx.pending ? "Working…" : mode === "add" ? "Add to my team" : "Put in claim"}
          </Button>
        </form>
      ) : null}
    </>
  );
}

/** Drop button with a confirm prompt that says where the lawyer goes. */
export function DropButton({
  lawyerId,
  lawyerName,
  toWaivers,
  className,
}: {
  lawyerId: string;
  lawyerName: string;
  toWaivers: boolean;
  className?: string;
}) {
  const ctx = useMove();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const where = toWaivers
      ? "They'll go on waivers until the next waiver run."
      : "You added them less than a day ago, so they go straight back to free agency.";
    if (!window.confirm(`Drop ${lawyerName}? ${where}`)) return;
    ctx.submit(new FormData(e.currentTarget));
  }

  return (
    <form onSubmit={onSubmit} className={cx("relative z-10 shrink-0", className)}>
      <HiddenFields leagueId={ctx.leagueId} op="drop" lawyerId={lawyerId} />
      <Button type="submit" variant="secondary" className="px-3" disabled={ctx.pending} aria-label={`Drop ${lawyerName}`}>
        Drop
      </Button>
    </form>
  );
}
