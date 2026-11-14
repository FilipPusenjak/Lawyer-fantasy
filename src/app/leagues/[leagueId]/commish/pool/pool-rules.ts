/**
 * Pure form parsing for the player-pool forms (lawyer, firm, case, appearance).
 * Pool membership is checked by src/server/services/pool.ts.
 */
import { CASE_TYPES, SIDES, type CaseType, type Side } from "@/lib/settings";
import type { CaseInput, FirmInput, IndividualPosition, LawyerInput } from "@/server/services/pool";

export type FormLike = { get(name: string): FormDataEntryValue | null };
export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const INDIVIDUAL_POSITIONS: IndividualPosition[] = ["trial", "appellate", "prosecutor", "defense"];
export const NAME_MAX = 100;
export const ORG_MAX = 200;
export const CAPTION_MAX = 200;
export const COURT_MAX = 120;
export const DOCKET_MAX = 60;
export const URL_MAX = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(form: FormLike, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function rank(form: FormLike): ParseResult<number | null> {
  const raw = text(form, "preseasonRank");
  if (!raw) return { ok: true, data: null };
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 9999) return { ok: false, error: "Draft rank should be a whole number like 1, 2, 3 (or blank)." };
  return { ok: true, data: Number(raw) };
}

function nameAndOrg(form: FormLike, what: string): ParseResult<{ name: string; organization: string | null }> {
  const name = text(form, "name");
  if (name.length < 2) return { ok: false, error: `Enter the ${what}'s name.` };
  if (name.length > NAME_MAX) return { ok: false, error: `Names can be at most ${NAME_MAX} characters.` };
  const organization = text(form, "organization") || null;
  if (organization && organization.length > ORG_MAX) return { ok: false, error: `Organization can be at most ${ORG_MAX} characters.` };
  return { ok: true, data: { name, organization } };
}

export function parseLawyerForm(form: FormLike): ParseResult<LawyerInput> {
  const base = nameAndOrg(form, "lawyer");
  if (!base.ok) return base;
  const position = text(form, "position");
  if (!(INDIVIDUAL_POSITIONS as string[]).includes(position)) return { ok: false, error: "Pick a position." };
  const firmRaw = text(form, "firmId");
  if (firmRaw && !UUID_RE.test(firmRaw)) return { ok: false, error: "Pick a firm from the list." };
  const r = rank(form);
  if (!r.ok) return r;
  return {
    ok: true,
    data: { ...base.data, position: position as IndividualPosition, firmId: firmRaw || null, preseasonRank: r.data },
  };
}

export function parseFirmForm(form: FormLike): ParseResult<FirmInput> {
  const base = nameAndOrg(form, "firm");
  if (!base.ok) return base;
  const r = rank(form);
  if (!r.ok) return r;
  return { ok: true, data: { ...base.data, preseasonRank: r.data } };
}

export function parseCaseForm(form: FormLike): ParseResult<CaseInput> {
  const caption = text(form, "caption");
  if (caption.length < 3) return { ok: false, error: "Enter the case caption, e.g. “Doe v. Example Corp.”" };
  if (caption.length > CAPTION_MAX) return { ok: false, error: `Captions can be at most ${CAPTION_MAX} characters.` };
  const court = text(form, "court");
  if (court.length < 2) return { ok: false, error: "Enter the court." };
  if (court.length > COURT_MAX) return { ok: false, error: `Court names can be at most ${COURT_MAX} characters.` };
  const docketNumber = text(form, "docketNumber") || null;
  if (docketNumber && docketNumber.length > DOCKET_MAX) return { ok: false, error: `Docket numbers can be at most ${DOCKET_MAX} characters.` };
  const caseType = text(form, "caseType");
  if (!(CASE_TYPES as readonly string[]).includes(caseType)) return { ok: false, error: "Pick the case type." };
  const status = text(form, "status") || "active";
  if (status !== "active" && status !== "closed") return { ok: false, error: "Pick the case status." };
  const filedOn = text(form, "filedOn") || null;
  if (filedOn && !isIsoDate(filedOn)) return { ok: false, error: "Pick a valid filed date (or leave it blank)." };
  const sourceUrl = text(form, "sourceUrl") || null;
  if (sourceUrl && (sourceUrl.length > URL_MAX || !isHttpUrl(sourceUrl))) {
    return { ok: false, error: "The source link must start with http:// or https://." };
  }
  return { ok: true, data: { caption, court, docketNumber, caseType: caseType as CaseType, status, filedOn, sourceUrl } };
}

export function parseAppearanceForm(form: FormLike): ParseResult<{ lawyerId: string; side: Side }> {
  const lawyerId = text(form, "lawyerId");
  if (!UUID_RE.test(lawyerId)) return { ok: false, error: "Pick a lawyer or firm." };
  const side = text(form, "side");
  if (!(SIDES as readonly string[]).includes(side)) return { ok: false, error: "Pick a side." };
  return { ok: true, data: { lawyerId, side: side as Side } };
}

/** Normalize list filters from the URL (?q=&pos=&status=). */
export function listFilters(sp: Record<string, string | string[] | undefined>) {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const q = one("q").slice(0, 100);
  const pos = one("pos");
  const status = one("status");
  return {
    q,
    position: (INDIVIDUAL_POSITIONS as string[]).includes(pos) ? (pos as IndividualPosition) : undefined,
    status: status === "active" || status === "closed" ? (status as "active" | "closed") : undefined,
  };
}
