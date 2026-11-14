"use client";

import { useRef } from "react";

/** "Select all" checkbox that ticks every `ids` checkbox in its form. */
export function SelectAll() {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
      <input
        ref={ref}
        type="checkbox"
        className="h-5 w-5 accent-brand"
        onChange={(e) => {
          const form = ref.current?.form;
          form?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="ids"]').forEach((box) => {
            box.checked = e.target.checked;
          });
        }}
      />
      Select all
    </label>
  );
}
