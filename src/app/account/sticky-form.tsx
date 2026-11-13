"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { ActionMessage } from "@/components/ui-client";
import type { ActionResult } from "@/server/action-result";

type FormAction = (prev: ActionResult<unknown> | null, formData: FormData) => Promise<ActionResult<unknown>>;

/**
 * Like ActionForm, but keeps what the user typed when the action returns an
 * error. (React resets uncontrolled fields after every form action, which
 * would wipe a whole sign-up form because of one taken username.)
 *
 * Before hydration the form still posts to the Server Action directly, so it
 * works without JavaScript; after hydration we dispatch it ourselves.
 */
export function StickyForm({
  action,
  children,
  className,
  resetOnSuccess,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  /** Clear the fields after a successful submit (e.g. password changes). */
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    // Prevent React's automatic form reset; useFormStatus still sees the
    // pending state because we start a transition in this event.
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form ref={ref} action={formAction} onSubmit={onSubmit} className={className ?? "space-y-3"}>
      {children}
      <ActionMessage state={state} />
    </form>
  );
}
