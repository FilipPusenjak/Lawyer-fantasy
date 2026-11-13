"use client";

import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, Notice } from "./ui";
import type { ActionResult } from "@/server/action-result";

/** Pending state of the nearest ActionForm (its submit is dispatched manually, so useFormStatus can miss it). */
const ActionPendingContext = createContext(false);

/** Submit button that shows a pending state. Must be inside a <form>. */
export function SubmitButton({
  children,
  variant = "primary",
  className,
  pendingText,
  confirm,
  ...rest
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
  const { pending: formPending } = useFormStatus();
  const actionPending = useContext(ActionPendingContext);
  const pending = formPending || actionPending;
  return (
    <button
      type="submit"
      className={buttonClass(variant, className)}
      disabled={pending || rest.disabled}
      name={rest.name}
      value={rest.value}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}

/** Shows an ActionResult's message/error. */
export function ActionMessage({ state }: { state: ActionResult<unknown> | null | undefined }) {
  if (!state) return null;
  if (state.ok) return state.message ? <Notice tone="success">{state.message}</Notice> : null;
  return <Notice tone="error">{state.error}</Notice>;
}

type FormAction = (prev: ActionResult<unknown> | null, formData: FormData) => Promise<ActionResult<unknown>>;

/**
 * A <form> wired to a Server Action that returns ActionResult. Shows the
 * result message under the fields.
 *
 * React resets uncontrolled fields after every form action — even one that
 * returns an error — which would wipe what the user typed. So after hydration
 * we dispatch the action ourselves (keeping the fields), and only reset when
 * `resetOnSuccess` is set and the action succeeded. Before hydration the form
 * still posts to the Server Action directly, so it works without JavaScript.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    // Include the clicked button's name/value (e.g. "approve" vs "reject").
    const formData = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(formData));
  }

  return (
    <ActionPendingContext value={isPending}>
      <form ref={ref} action={formAction} onSubmit={onSubmit} className={className ?? "space-y-3"}>
        {children}
        <ActionMessage state={state} />
      </form>
    </ActionPendingContext>
  );
}
