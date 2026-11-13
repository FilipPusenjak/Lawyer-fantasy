/** Display helpers shared by client and server. */

export function fmtPoints(n: number | null | undefined): string {
  const v = n ?? 0;
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? r.toFixed(0) : r.toFixed(2).replace(/0$/, "");
}

export function fmtSigned(n: number): string {
  const s = fmtPoints(n);
  return n > 0 ? `+${s}` : s;
}

export function fmtRecord(w: number, l: number, t: number): string {
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
