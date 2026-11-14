"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui";
import { queueHref, type QueueCaseCount, type QueueOrigin } from "./event-rules";

/** Case dropdown for the review queue: navigates to ?case=<id> (keeping the origin filter). */
export function CaseFilter({
  base,
  origin,
  value,
  cases,
  total,
}: {
  base: string;
  origin: QueueOrigin | null;
  value: string | null;
  cases: QueueCaseCount[];
  /** Pending events across all cases for the current origin filter. */
  total: number;
}) {
  const router = useRouter();
  return (
    <Select
      key={value ?? ""}
      aria-label="Filter by case"
      defaultValue={value ?? ""}
      onChange={(e) => router.push(queueHref(base, { origin, caseId: e.target.value || null }))}
    >
      <option value="">All cases ({total})</option>
      {cases.map((c) => (
        <option key={c.caseId} value={c.caseId}>
          {c.caption}
          {c.docket ? ` · ${c.docket}` : ""} ({c.count})
        </option>
      ))}
    </Select>
  );
}
