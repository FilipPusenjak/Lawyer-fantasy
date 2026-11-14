"use client";

import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { buttonClass, Notice } from "@/components/ui";
import type { ActionResult } from "@/server/action-result";

type ReviewAction = (prev: ActionResult<unknown> | null, formData: FormData) => Promise<ActionResult<unknown>>;

/** Pending state of the queue form plus the `op` of the button that started it. */
const ReviewPendingContext = createContext<{ pending: boolean; op: string | null }>({ pending: false, op: null });

const IDS_SELECTOR = 'input[type="checkbox"][name="ids"]';

/**
 * The review queue is one long form (up to 100 cards). Like ActionForm it keeps
 * the ticked boxes after an action, but the result shows in a sticky notice at
 * the top of the list instead of under the last card, and "Approve selected"
 * sits in a bar pinned above the bottom nav so it's always in reach.
 */
export function ReviewQueueForm({ action, ids, children }: { action: ReviewAction; ids: string[]; children: ReactNode }) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [op, setOp] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<ActionResult<unknown> | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  const pendingValue = useMemo(() => ({ pending: isPending, op }), [isPending, op]);

  // Reviewed cards leave the list, so only count ticks that are still on screen.
  const live = new Set(ids);
  const selected = [...ticked].filter((id) => live.has(id)).length;
  const allTicked = ids.length > 0 && selected === ids.length;

  // Success notes clear themselves; errors stay until dismissed or replaced.
  useEffect(() => {
    if (!state?.ok) return;
    const t = window.setTimeout(() => setDismissed(state), 6000);
    return () => window.clearTimeout(t);
  }, [state]);

  function syncTicks() {
    const boxes = ref.current?.querySelectorAll<HTMLInputElement>(`${IDS_SELECTOR}:checked`) ?? [];
    setTicked(new Set(Array.from(boxes, (b) => b.value)));
  }

  function tickAll(on: boolean) {
    ref.current?.querySelectorAll<HTMLInputElement>(IDS_SELECTOR).forEach((b) => {
      b.checked = on;
    });
    syncTicks();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    // Include the clicked button's name/value ("approve:<id>", "reject:<id>", "approve-selected").
    const formData = new FormData(e.currentTarget, submitter);
    setOp(submitter?.value ?? null);
    startTransition(() => formAction(formData));
  }

  const message = state && state !== dismissed ? (state.ok ? state.message : state.error) : null;

  return (
    <ReviewPendingContext value={pendingValue}>
      <form ref={ref} action={formAction} onSubmit={onSubmit} onChange={syncTicks} className="space-y-3">
        {message && state ? (
          <div className="sticky top-16 z-10" role={state.ok ? "status" : "alert"}>
            <div className="relative">
              <Notice tone={state.ok ? "success" : "error"}>
                <p className="pr-8">{message}</p>
              </Notice>
              <button
                type="button"
                onClick={() => setDismissed(state)}
                aria-label="Dismiss"
                className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center text-lg leading-none text-muted"
              >
                ×
              </button>
            </div>
          </div>
        ) : null}
        {children}
        <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 flex items-center justify-between gap-2 rounded-2xl border border-line bg-surface/95 py-1 pl-3 pr-1 backdrop-blur">
          <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
            <input type="checkbox" checked={allTicked} onChange={(e) => tickAll(e.target.checked)} className="h-5 w-5 accent-brand" />
            Select all
          </label>
          <ReviewButton op="approve-selected" variant={selected > 0 ? "primary" : "secondary"} className="shrink-0">
            {selected > 0 ? `Approve ${selected} selected` : "Approve selected"}
          </ReviewButton>
        </div>
      </form>
    </ReviewPendingContext>
  );
}

/** Submit button for the review queue: disabled while any review runs, "Working…" on the one that was clicked. */
export function ReviewButton({
  op,
  children,
  variant = "primary",
  className,
  confirm,
}: {
  op: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  className?: string;
  /** Ask the user to confirm before submitting. */
  confirm?: string;
}) {
  const { pending, op: activeOp } = useContext(ReviewPendingContext);
  return (
    <button
      type="submit"
      name="op"
      value={op}
      disabled={pending}
      className={buttonClass(variant, className)}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending && activeOp === op ? "Working…" : children}
    </button>
  );
}
