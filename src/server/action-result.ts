/** Standard return type for Server Actions used with useActionState. */
export type ActionResult<T = undefined> = { ok: true; message?: string; data?: T } | { ok: false; error: string };

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function ok<T = undefined>(message?: string, data?: T): { ok: true; message?: string; data?: T } {
  return { ok: true, message, data };
}

/** Thrown inside services for user-facing validation errors. */
export class UserError extends Error {}

/** Run an action body, converting UserError into a failed ActionResult. */
export async function runAction<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UserError) return fail(e.message);
    throw e;
  }
}
