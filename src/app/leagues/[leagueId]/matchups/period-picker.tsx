"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui";

/** Period dropdown: navigates to ?period=N on change. */
export function PeriodPicker({
  basePath,
  value,
  options,
}: {
  basePath: string;
  value: number;
  options: { period: number; label: string }[];
}) {
  const router = useRouter();
  return (
    <Select
      key={value}
      aria-label="Choose a matchup period"
      defaultValue={String(value)}
      onChange={(e) => router.push(`${basePath}?period=${e.target.value}`)}
      className="text-center font-semibold"
    >
      {options.map((o) => (
        <option key={o.period} value={o.period}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
