/**
 * Pure helpers for the league activity log.
 */

export const ACTIVITY_PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

/** Parse a ?page= value into a page number >= 1 (bad input -> 1). */
export function parsePage(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^\d{1,6}$/.test(v.trim())) return 1;
  const n = Number(v.trim());
  if (!Number.isSafeInteger(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}

export function pageOffset(page: number, pageSize = ACTIVITY_PAGE_SIZE): number {
  return (Math.max(1, page) - 1) * pageSize;
}

export const TRANSACTION_LABELS = {
  draft: "Draft",
  add: "Add",
  drop: "Drop",
  waiver_add: "Waiver",
  trade: "Trade",
  commissioner: "Commish",
} as const;
export type TransactionType = keyof typeof TRANSACTION_LABELS;

export function transactionTone(type: TransactionType): "neutral" | "brand" | "accent" | "pos" | "neg" | "warn" {
  switch (type) {
    case "add":
    case "waiver_add":
      return "pos";
    case "drop":
      return "neg";
    case "trade":
      return "accent";
    case "draft":
      return "brand";
    default:
      return "warn";
  }
}
