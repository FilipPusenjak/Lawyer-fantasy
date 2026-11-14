"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui";
import { describeImportRow, formatCsvErrors, parseImport, type ImportKind } from "../csv";

/**
 * CSV textarea with a live preview (row count, first rows, parse errors) using
 * the same parser the server runs. Clears itself when the form resets.
 */
export function CsvImportFields({ kind, placeholder }: { kind: ImportKind; placeholder: string }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const parsed = useMemo(() => (text.trim() ? parseImport(kind, text) : null), [kind, text]);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onReset = () => setText("");
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  return (
    <div className="space-y-2">
      <Textarea
        ref={ref}
        name="csv"
        rows={7}
        defaultValue=""
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="font-mono"
        aria-label={`${kind} CSV`}
        required
      />
      {parsed ? (
        <div className="rounded-xl bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
          <p className={parsed.errors.length ? "font-semibold text-neg" : "font-semibold text-pos"}>
            {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} ready
            {parsed.errors.length ? ` · ${parsed.errors.length} to fix` : ""}
          </p>
          {parsed.errors.length ? <p className="mt-1 text-neg">{formatCsvErrors(parsed.errors, 4)}</p> : null}
          {parsed.rows.length ? (
            <ul className="mt-1 space-y-0.5 text-muted">
              {parsed.rows.slice(0, 3).map((r) => (
                <li key={r.line} className="truncate">
                  {describeImportRow(kind, r)}
                </li>
              ))}
              {parsed.rows.length > 3 ? <li>…and {parsed.rows.length - 3} more</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
