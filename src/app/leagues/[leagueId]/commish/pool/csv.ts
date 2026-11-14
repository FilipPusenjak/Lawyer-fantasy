/**
 * Pure CSV parsing for the commissioner's pool import. No DB access; safe on
 * the client (used for the live preview) and the server (used to import).
 *
 * Formats (header row optional, blank lines ignored, "quoted, fields" OK,
 * tab-separated text pasted from a spreadsheet also works):
 *   lawyers:     name,position,firm,organization,rank
 *   cases:       caption,court,docket_number,case_type,source_url
 *   appearances: lawyer_name,docket_number_or_caption,side
 */
import { CASE_TYPE_LABELS, POSITION_LABELS, type CaseType, type Position, type Side } from "@/lib/settings";
import type { AppearanceImportRow, CaseImportRow, LawyerImportRow } from "@/server/services/pool";

export const MAX_IMPORT_ROWS = 500;
const NAME_MAX = 100;
const ORG_MAX = 200;
const CAPTION_MAX = 200;
const COURT_MAX = 120;
const DOCKET_MAX = 60;
const URL_MAX = 500;

export type CsvRecord = { line: number; cells: string[] };
export type CsvError = { line: number; message: string };
export type CsvParse<T> = { rows: T[]; errors: CsvError[] };
export type ImportKind = "lawyers" | "cases" | "appearances";

// ---------------------------------------------------------------------------
// Low-level CSV
// ---------------------------------------------------------------------------

/** Tab if the first non-blank line has more tabs than commas, else comma. */
export function detectDelimiter(text: string): "," | "\t" {
  const first = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== "") ?? "";
  const tabs = first.split("\t").length - 1;
  const commas = first.split(",").length - 1;
  return tabs > commas ? "\t" : ",";
}

/**
 * Split text into records. Handles quoted fields (with "" escapes, commas and
 * line breaks inside quotes), CRLF/LF/CR line endings and a UTF-8 BOM. Cells
 * are trimmed; blank lines are skipped. `line` is the 1-based line where the
 * record starts.
 */
export function parseCsv(text: string, delimiter: "," | "\t" = detectDelimiter(text)): CsvRecord[] {
  const s = text.replace(/^﻿/, "");
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endCell = () => {
    cells.push(cell.trim());
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c !== "")) out.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n" || (ch === "\r" && s[i + 1] !== "\n")) line++;
        cell += ch === "\r" ? "" : ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      inQuotes = true;
      cell = "";
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
    }
  }
  endRecord();
  return out;
}

/** Lowercase, dots removed, "_"/"-" as spaces, single spaces. */
export function aliasKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isHeader(cells: string[], words: string[]): boolean {
  const set = new Set(words);
  return cells.filter((c) => set.has(aliasKey(c))).length >= 2;
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

const POSITION_ALIASES: Record<string, Position> = {
  trial: "trial",
  "trial lawyer": "trial",
  "trial attorney": "trial",
  "trial counsel": "trial",
  litigator: "trial",
  trl: "trial",
  appellate: "appellate",
  "appellate lawyer": "appellate",
  "appellate attorney": "appellate",
  "appellate counsel": "appellate",
  appeals: "appellate",
  app: "appellate",
  prosecutor: "prosecutor",
  prosecution: "prosecutor",
  pro: "prosecutor",
  da: "prosecutor",
  ada: "prosecutor",
  "district attorney": "prosecutor",
  "assistant district attorney": "prosecutor",
  "us attorney": "prosecutor",
  "assistant us attorney": "prosecutor",
  ausa: "prosecutor",
  defense: "defense",
  defence: "defense",
  def: "defense",
  "defense attorney": "defense",
  "defense lawyer": "defense",
  "defense counsel": "defense",
  "criminal defense": "defense",
  "public defender": "defense",
  firm: "firm",
  "law firm": "firm",
};

const CASE_TYPE_ALIASES: Record<string, CaseType> = {
  civil: "civil",
  criminal: "criminal",
  crim: "criminal",
  appeal: "appeal",
  appeals: "appeal",
  appellate: "appeal",
  "court of appeals": "appeal",
  "supreme court": "supreme_court",
  "us supreme court": "supreme_court",
  "supreme court of the united states": "supreme_court",
  scotus: "supreme_court",
  other: "other",
};

const SIDE_ALIASES: Record<string, Side> = {
  plaintiff: "plaintiff",
  plaintiffs: "plaintiff",
  p: "plaintiff",
  prosecution: "plaintiff",
  prosecutor: "plaintiff",
  government: "plaintiff",
  state: "plaintiff",
  people: "plaintiff",
  "united states": "plaintiff",
  appellant: "plaintiff",
  appellants: "plaintiff",
  petitioner: "plaintiff",
  petitioners: "plaintiff",
  claimant: "plaintiff",
  defendant: "defendant",
  defendants: "defendant",
  d: "defendant",
  defense: "defendant",
  defence: "defendant",
  appellee: "defendant",
  appellees: "defendant",
  respondent: "defendant",
  respondents: "defendant",
};

export function normalizePosition(raw: string): Position | null {
  return POSITION_ALIASES[aliasKey(raw)] ?? null;
}

/** Blank means "civil". */
export function normalizeCaseType(raw: string): CaseType | null {
  if (raw.trim() === "") return "civil";
  return CASE_TYPE_ALIASES[aliasKey(raw)] ?? null;
}

export function normalizeSide(raw: string): Side | null {
  return SIDE_ALIASES[aliasKey(raw)] ?? null;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Row parsers
// ---------------------------------------------------------------------------

function records(text: string, headerWords: string[], errors: CsvError[]): CsvRecord[] {
  let recs = parseCsv(text);
  if (recs.length > 0 && isHeader(recs[0].cells, headerWords)) recs = recs.slice(1);
  if (recs.length > MAX_IMPORT_ROWS) {
    errors.push({ line: recs[MAX_IMPORT_ROWS].line, message: `Too many rows. Import at most ${MAX_IMPORT_ROWS} at a time.` });
    recs = recs.slice(0, MAX_IMPORT_ROWS);
  }
  return recs;
}

const cell = (r: CsvRecord, i: number) => r.cells[i] ?? "";

const LAWYER_HEADERS = ["name", "lawyer", "lawyer name", "position", "pos", "firm", "law firm", "organization", "org", "rank", "preseason rank"];

export function parseLawyersCsv(text: string): CsvParse<LawyerImportRow> {
  const errors: CsvError[] = [];
  const rows: LawyerImportRow[] = [];
  const seen = new Map<string, number>();
  for (const r of records(text, LAWYER_HEADERS, errors)) {
    const err = (message: string) => errors.push({ line: r.line, message });
    const name = cell(r, 0).replace(/\s+/g, " ");
    const posRaw = cell(r, 1);
    const firm = cell(r, 2).replace(/\s+/g, " ") || null;
    const organization = cell(r, 3) || null;
    const rankRaw = cell(r, 4);
    if (!name) {
      err("Missing the lawyer's name.");
      continue;
    }
    if (name.length > NAME_MAX) {
      err(`Name is longer than ${NAME_MAX} characters.`);
      continue;
    }
    const position = normalizePosition(posRaw);
    if (!position) {
      err(posRaw ? `Unknown position “${posRaw}”. Use trial, appellate, prosecutor, defense or firm.` : `Missing the position for ${name}.`);
      continue;
    }
    if (firm && firm.length > NAME_MAX) {
      err(`Firm name is longer than ${NAME_MAX} characters.`);
      continue;
    }
    if (organization && organization.length > ORG_MAX) {
      err(`Organization is longer than ${ORG_MAX} characters.`);
      continue;
    }
    let rank: number | null = null;
    if (rankRaw) {
      if (!/^\d+$/.test(rankRaw) || Number(rankRaw) < 1 || Number(rankRaw) > 9999) {
        err(`Rank “${rankRaw}” should be a whole number like 1, 2, 3.`);
        continue;
      }
      rank = Number(rankRaw);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      err(`${name} is listed twice (also on line ${seen.get(key)}).`);
      continue;
    }
    seen.set(key, r.line);
    rows.push({ line: r.line, name, position, firm: position === "firm" ? null : firm, organization, rank });
  }
  return { rows, errors };
}

const CASE_HEADERS = ["caption", "case", "case name", "court", "docket", "docket number", "docket no", "case type", "type", "source", "source url", "url", "link"];

export function parseCasesCsv(text: string): CsvParse<CaseImportRow> {
  const errors: CsvError[] = [];
  const rows: CaseImportRow[] = [];
  const seen = new Map<string, number>();
  for (const r of records(text, CASE_HEADERS, errors)) {
    const err = (message: string) => errors.push({ line: r.line, message });
    const caption = cell(r, 0).replace(/\s+/g, " ");
    const court = cell(r, 1).replace(/\s+/g, " ");
    const docketNumber = cell(r, 2) || null;
    const typeRaw = cell(r, 3);
    const sourceUrl = cell(r, 4) || null;
    if (!caption) {
      err("Missing the case caption (e.g. “Doe v. Example Corp.”).");
      continue;
    }
    if (caption.length > CAPTION_MAX) {
      err(`Caption is longer than ${CAPTION_MAX} characters.`);
      continue;
    }
    if (!court) {
      err(`Missing the court for ${caption}.`);
      continue;
    }
    if (court.length > COURT_MAX) {
      err(`Court is longer than ${COURT_MAX} characters.`);
      continue;
    }
    if (docketNumber && docketNumber.length > DOCKET_MAX) {
      err(`Docket number is longer than ${DOCKET_MAX} characters.`);
      continue;
    }
    const caseType = normalizeCaseType(typeRaw);
    if (!caseType) {
      err(`Unknown case type “${typeRaw}”. Use civil, criminal, appeal, supreme court or other.`);
      continue;
    }
    if (sourceUrl && (sourceUrl.length > URL_MAX || !isHttpUrl(sourceUrl))) {
      err("The source link must start with http:// or https://.");
      continue;
    }
    const key = docketNumber ? `d|${court.toLowerCase()}|${docketNumber.toLowerCase()}` : `c|${court.toLowerCase()}|${caption.toLowerCase()}`;
    if (seen.has(key)) {
      err(`This case is listed twice (also on line ${seen.get(key)}).`);
      continue;
    }
    seen.set(key, r.line);
    rows.push({ line: r.line, caption, court, docketNumber, caseType, sourceUrl });
  }
  return { rows, errors };
}

const APPEARANCE_HEADERS = [
  "lawyer",
  "lawyer name",
  "name",
  "case",
  "docket",
  "docket number",
  "caption",
  "docket number or caption",
  "side",
];

export function parseAppearancesCsv(text: string): CsvParse<AppearanceImportRow> {
  const errors: CsvError[] = [];
  const rows: AppearanceImportRow[] = [];
  for (const r of records(text, APPEARANCE_HEADERS, errors)) {
    const err = (message: string) => errors.push({ line: r.line, message });
    const lawyerName = cell(r, 0).replace(/\s+/g, " ");
    const caseRef = cell(r, 1).replace(/\s+/g, " ");
    const sideRaw = cell(r, 2);
    if (!lawyerName) {
      err("Missing the lawyer or firm name.");
      continue;
    }
    if (!caseRef) {
      err(`Missing the docket number or caption for ${lawyerName}.`);
      continue;
    }
    const side = normalizeSide(sideRaw);
    if (!side) {
      err(
        sideRaw
          ? `Unknown side “${sideRaw}”. Use plaintiff/prosecution/appellant/petitioner or defendant/defense/appellee/respondent.`
          : `Missing the side for ${lawyerName}.`,
      );
      continue;
    }
    rows.push({ line: r.line, lawyerName, caseRef, side });
  }
  return { rows, errors };
}

export function parseImport(kind: ImportKind, text: string): CsvParse<LawyerImportRow | CaseImportRow | AppearanceImportRow> {
  if (kind === "lawyers") return parseLawyersCsv(text);
  if (kind === "cases") return parseCasesCsv(text);
  return parseAppearancesCsv(text);
}

/** "Line 3: …; Line 7: … (and 4 more)". */
export function formatCsvErrors(errors: CsvError[], max = 5): string {
  const shown = [...errors].sort((a, b) => a.line - b.line).slice(0, max);
  const text = shown.map((e) => `Line ${e.line}: ${e.message}`).join(" ");
  return errors.length > max ? `${text} (and ${errors.length - max} more)` : text;
}

/** Short label for a parsed row in the preview. */
export function describeImportRow(kind: ImportKind, row: LawyerImportRow | CaseImportRow | AppearanceImportRow): string {
  if (kind === "lawyers") {
    const r = row as LawyerImportRow;
    return [r.name, POSITION_LABELS[r.position], r.firm, r.rank ? `#${r.rank}` : null].filter(Boolean).join(" · ");
  }
  if (kind === "cases") {
    const r = row as CaseImportRow;
    return [r.caption, r.court, r.docketNumber, CASE_TYPE_LABELS[r.caseType]].filter(Boolean).join(" · ");
  }
  const r = row as AppearanceImportRow;
  return `${r.lawyerName} → ${r.caseRef} (${r.side})`;
}

export const IMPORT_FORMATS: Record<ImportKind, { header: string; example: string; help: string[] }> = {
  lawyers: {
    header: "name,position,firm,organization,rank",
    example: [
      "name,position,firm,organization,rank",
      "Avery Example,trial,Example & Partners LLP,,1",
      "Jordan Sample,prosecutor,,\"U.S. Attorney's Office, D. Example\",2",
      "Example & Partners LLP,firm,,,5",
    ].join("\n"),
    help: [
      "position: trial, appellate, prosecutor, defense or firm (also “Trial Lawyer”, “Defense Attorney”, “DA”…).",
      "firm: optional. Firms that aren't in the pool yet are created.",
      "rank: optional preseason rank (1 = best). Names already in the pool are skipped.",
    ],
  },
  cases: {
    header: "caption,court,docket_number,case_type,source_url",
    example: [
      "caption,court,docket_number,case_type,source_url",
      "Doe v. Example Corp.,S.D. Example,1:26-cv-01234,civil,https://example.com/docket/1234",
      "United States v. Sample,D. Example,2:26-cr-00042,criminal,",
    ].join("\n"),
    help: [
      "case_type: civil, criminal, appeal, supreme court or other (blank = civil).",
      "docket_number and source_url are optional. Cases already in the pool are skipped.",
    ],
  },
  appearances: {
    header: "lawyer_name,docket_number_or_caption,side",
    example: [
      "lawyer_name,docket_number_or_caption,side",
      "Avery Example,1:26-cv-01234,plaintiff",
      "Jordan Sample,United States v. Sample,prosecution",
    ].join("\n"),
    help: [
      "lawyer_name must match a lawyer or firm already in the pool.",
      "Use the docket number (best) or the exact caption.",
      "side: plaintiff, prosecution, appellant, petitioner — or defendant, defense, appellee, respondent.",
    ],
  },
};
