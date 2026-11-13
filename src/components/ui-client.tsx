"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, Notice } from "./ui";
import type { ActionResult } from "@/server/action-result";

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
  const { pending } = useFormStatus();
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
 * result message under the fields and optionally resets on success.
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
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className ?? "space-y-3"}>
      {children}
      <ActionMessage state={state} />
    </form>
  );
}
