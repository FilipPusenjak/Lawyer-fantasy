/**
 * Shared server-rendered pieces for the player-pool pages: tabs, back link and
 * the field groups used by both the add and edit forms.
 */
import Link from "next/link";
import { Field, Input, Select, Tabs } from "@/components/ui";
import { CASE_TYPE_LABELS, CASE_TYPES, POSITION_LABELS, type CaseType } from "@/lib/settings";
import { CAPTION_MAX, COURT_MAX, DOCKET_MAX, INDIVIDUAL_POSITIONS, NAME_MAX, ORG_MAX, URL_MAX } from "./pool-rules";

export type PoolTab = "lawyers" | "firms" | "cases" | "import";

export function PoolTabs({ leagueId, active }: { leagueId: string; active: PoolTab | null }) {
  const base = `/leagues/${leagueId}/commish/pool`;
  return (
    <Tabs
      items={[
        { href: base, label: "Lawyers", active: active === "lawyers" },
        { href: `${base}/firms`, label: "Firms", active: active === "firms" },
        { href: `${base}/cases`, label: "Cases", active: active === "cases" },
        { href: `${base}/import`, label: "Import", active: active === "import" },
      ]}
    />
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
      ‹ {label}
    </Link>
  );
}

type LawyerDefaults = {
  name?: string;
  position?: string;
  firmId?: string | null;
  organization?: string | null;
  preseasonRank?: number | null;
};

export function LawyerFields({ firms, d = {} }: { firms: { id: string; name: string }[]; d?: LawyerDefaults }) {
  return (
    <>
      <Field label="Name">
        <Input name="name" defaultValue={d.name ?? ""} maxLength={NAME_MAX} autoComplete="off" required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Position">
          <Select name="position" defaultValue={d.position ?? ""} required>
            <option value="" disabled>
              Pick one
            </option>
            {INDIVIDUAL_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {POSITION_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Preseason rank" hint="1 = best. Optional.">
          <Input type="number" name="preseasonRank" min={1} max={9999} step={1} inputMode="numeric" defaultValue={d.preseasonRank ?? ""} />
        </Field>
      </div>
      <Field label="Firm" hint={firms.length === 0 ? "Add firms on the Firms tab first." : "Firms score a share of their lawyers' events."}>
        <Select name="firmId" defaultValue={d.firmId ?? ""}>
          <option value="">No firm</option>
          {firms.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Organization" hint="Neutral affiliation, e.g. “Office of the Public Defender, Example County”. Optional.">
        <Input name="organization" defaultValue={d.organization ?? ""} maxLength={ORG_MAX} autoComplete="off" />
      </Field>
    </>
  );
}

export function FirmFields({ d = {} }: { d?: Omit<LawyerDefaults, "position" | "firmId"> }) {
  return (
    <>
      <Field label="Firm name">
        <Input name="name" defaultValue={d.name ?? ""} maxLength={NAME_MAX} autoComplete="off" required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Preseason rank" hint="1 = best. Optional.">
          <Input type="number" name="preseasonRank" min={1} max={9999} step={1} inputMode="numeric" defaultValue={d.preseasonRank ?? ""} />
        </Field>
        <Field label="Location" hint="Optional">
          <Input name="organization" defaultValue={d.organization ?? ""} maxLength={ORG_MAX} autoComplete="off" />
        </Field>
      </div>
    </>
  );
}

type CaseDefaults = {
  caption?: string;
  court?: string;
  docketNumber?: string | null;
  caseType?: CaseType;
  status?: "active" | "closed";
  filedOn?: string | null;
  sourceUrl?: string | null;
};

export function CaseFields({ d = {} }: { d?: CaseDefaults }) {
  return (
    <>
      <Field label="Caption" hint="As it appears on the docket, e.g. “Doe v. Example Corp.”">
        <Input name="caption" defaultValue={d.caption ?? ""} maxLength={CAPTION_MAX} autoComplete="off" required />
      </Field>
      <Field label="Court">
        <Input name="court" defaultValue={d.court ?? ""} maxLength={COURT_MAX} placeholder="e.g. S.D. Example" autoComplete="off" required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Docket number" hint="Optional">
          <Input name="docketNumber" defaultValue={d.docketNumber ?? ""} maxLength={DOCKET_MAX} autoComplete="off" />
        </Field>
        <Field label="Filed" hint="Optional">
          <Input type="date" name="filedOn" defaultValue={d.filedOn ?? ""} />
        </Field>
        <Field label="Case type">
          <Select name="caseType" defaultValue={d.caseType ?? "civil"}>
            {CASE_TYPES.map((t) => (
              <option key={t} value={t}>
                {CASE_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={d.status ?? "active"}>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
          </Select>
        </Field>
      </div>
      <Field label="Public record link" hint="Court site or docket page. Optional.">
        <Input type="url" name="sourceUrl" defaultValue={d.sourceUrl ?? ""} maxLength={URL_MAX} placeholder="https://…" autoComplete="off" />
      </Field>
    </>
  );
}

/** "<details>" disclosure styled as a card section header (used for "Add …" forms). */
export function Disclosure({ summary, children, open }: { summary: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-2xl border border-line bg-surface" open={open}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 font-display text-sm font-semibold uppercase tracking-wide text-brand [&::-webkit-details-marker]:hidden">
        {summary}
        <span className="text-lg leading-none transition group-open:rotate-45" aria-hidden>
          +
        </span>
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}
