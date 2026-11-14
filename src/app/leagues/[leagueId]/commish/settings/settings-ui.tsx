/**
 * Layout pieces for the settings forms (server-safe, also used by the client
 * scoring fields). Numbers sit in a list of rows, label on the left and a
 * narrow input on the right, so labels never get squeezed on a phone.
 */
import type { ReactNode } from "react";

/** Narrow right-aligned number input for a ValueRow (merged over the kit's w-full). */
export const VALUE_INPUT_CLASS = "w-20 shrink-0 text-right";

export function ValueList({ header, children }: { header?: [string, string]; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line">
      {header ? (
        <div className="flex justify-between gap-3 border-b border-line px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          <span>{header[0]}</span>
          <span>{header[1]}</span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** One label + input row. The label wraps; the input keeps its width. */
export function ValueRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0">
      <span className="min-w-0 flex-1 text-sm">
        {label}
        {hint ? <span className="mt-0.5 block text-xs text-muted">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
