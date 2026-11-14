"use client";

/**
 * Page-level action results. A message shown inside a row or card is lost
 * when that row moves or disappears after the page refreshes (an accepted
 * trade changes sections, a cancelled claim leaves the list). These pieces
 * keep the latest result in a provider that outlives the rows and show it as
 * a toast above the bottom tabs. Used by the players, lawyer, team, waivers
 * and trades pages.
 */
import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import { buttonClass, Notice } from "@/components/ui";
import type { ActionResult } from "@/server/action-result";

type AnyResult = ActionResult<unknown>;

/** Toast for the latest action result. Hides itself after a while (errors stay longer) and can be dismissed. */
export function ResultToast({ result }: { result: AnyResult | null }) {
  const [dismissed, setDismissed] = useState<AnyResult | null>(null);

  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setDismissed(result), result.ok ? 8000 : 12000);
    return () => clearTimeout(t);
  }, [result]);

  const text = result ? (result.ok ? result.message : result.error) : null;
  if (!result || result === dismissed || !text) return null;
  return (
    <div className="fixed inset-x-0 bottom-20 z-40 px-4" role="status" aria-live="polite">
      <div className="mx-auto max-w-xl shadow-lg">
        <Notice tone={result.ok ? "success" : "error"}>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1">{text}</p>
            <button
              type="button"
              onClick={() => setDismissed(result)}
              className="-my-2 -mr-2 flex min-h-11 min-w-11 items-center justify-center text-lg text-muted"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </Notice>
      </div>
    </div>
  );
}

const ShowResultContext = createContext<((result: AnyResult) => void) | null>(null);

/**
 * Holds the latest result of every ResultForm inside it and shows it as a
 * toast. Put it around the whole page (or at least the list and its empty
 * state) so it stays mounted when rows come and go.
 */
export function ResultToastProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<AnyResult | null>(null);
  return (
    <ShowResultContext value={setResult}>
      {children}
      <ResultToast result={result} />
    </ShowResultContext>
  );
}

type FormAction = (prev: AnyResult | null, formData: FormData) => Promise<AnyResult>;

const FormPendingContext = createContext(false);

/**
 * A <form> wired to a Server Action that returns ActionResult. The result
 * goes to the nearest ResultToastProvider, so it still shows when this form
 * unmounts after the page refreshes. Fields are kept after submitting. Before
 * hydration the form posts to the Server Action directly.
 */
export function ResultForm({ action, children, className }: { action: FormAction; children: ReactNode; className?: string }) {
  const show = useContext(ShowResultContext);
  const [pending, startFormTransition] = useTransition();
  if (!show) throw new Error("ResultForm must be inside <ResultToastProvider>.");
  const notify = show; // narrowed copy for use inside the async closure
  // No-JS fallback: post straight to the Server Action (its result is dropped).
  const fallback: (formData: FormData) => void = action.bind(null, null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    // Include the clicked button's name/value (e.g. "accept" vs "reject").
    const formData = new FormData(e.currentTarget, submitter);
    startFormTransition(async () => {
      const result = await action(null, formData);
      // This form may be gone by now; the provider isn't.
      startTransition(() => notify(result));
    });
  }

  return (
    <FormPendingContext value={pending}>
      <form action={fallback} onSubmit={onSubmit} className={className ?? "space-y-3"}>
        {children}
      </form>
    </FormPendingContext>
  );
}

/** Submit button for a ResultForm: optional confirm prompt and pending text. */
export function ResultSubmit({
  children,
  variant = "primary",
  className,
  pendingText,
  confirm,
  name,
  value,
  disabled,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  className?: string;
  pendingText?: string;
  /** Ask the user to confirm before submitting. */
  confirm?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const pending = useContext(FormPendingContext);
  return (
    <button
      type="submit"
      className={buttonClass(variant, className)}
      disabled={pending || disabled}
      name={name}
      value={value}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}
