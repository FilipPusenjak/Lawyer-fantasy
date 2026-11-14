"use client";

import Form from "next/form";
import { useEffect, useRef, useState } from "react";
import { Button, cx, Field, Select } from "@/components/ui";

/** Picks the other team; changing it reloads the page with ?with=<teamId>. */
export function TeamPicker({
  action,
  teams,
  value,
}: {
  action: string;
  teams: { id: string; name: string; owner: string }[];
  value: string;
}) {
  return (
    <Form action={action} className="space-y-2">
      <Field label="Trade with">
        <Select name="with" defaultValue={value} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
          <option value="" disabled>
            Pick a team…
          </option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.owner})
            </option>
          ))}
        </Select>
      </Field>
      <noscript>
        <Button type="submit" variant="secondary" className="w-full">
          Show their roster
        </Button>
      </noscript>
    </Form>
  );
}

/**
 * Live "you give / you get" counter and roster sizes after the swap. Listens
 * to change events on the surrounding form's give/get checkboxes. The form is
 * keyed by the other team, so this starts over when the team changes.
 */
export function TradeSummary({
  theirName,
  mySize,
  theirSize,
  maxRoster,
  initialGive,
  initialGet,
}: {
  theirName: string;
  mySize: number;
  theirSize: number;
  maxRoster: number;
  initialGive: number;
  initialGet: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [counts, setCounts] = useState({ give: initialGive, get: initialGet });

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const update = () =>
      setCounts({
        give: form.querySelectorAll('input[name="give"]:checked').length,
        get: form.querySelectorAll('input[name="get"]:checked').length,
      });
    form.addEventListener("change", update);
    return () => form.removeEventListener("change", update);
  }, []);

  const meAfter = mySize - counts.give + counts.get;
  const themAfter = theirSize - counts.get + counts.give;
  const overMe = meAfter > maxRoster;
  const overThem = themAfter > maxRoster;

  return (
    <div ref={ref} role="status" aria-live="polite" className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm">
      <p>
        You give <span className="font-display text-base font-semibold text-brand">{counts.give}</span> · You get{" "}
        <span className="font-display text-base font-semibold text-brand">{counts.get}</span>
      </p>
      <p className="mt-0.5 text-xs text-muted">
        Rosters after the trade: <span className={cx(overMe && "font-semibold text-warn")}>you {meAfter}</span>
        {" · "}
        <span className={cx(overThem && "font-semibold text-warn")}>
          {theirName} {themAfter}
        </span>{" "}
        (max {maxRoster})
      </p>
      {overMe ? <p className="mt-1 text-xs font-semibold text-warn">Give more lawyers or ask for fewer to fit your roster.</p> : null}
      {!overMe && overThem ? (
        <p className="mt-1 text-xs font-semibold text-warn">Their roster would be too full. Ask for more or give fewer.</p>
      ) : null}
    </div>
  );
}
