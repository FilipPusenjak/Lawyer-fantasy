import { describe, expect, it } from "vitest";
import { creditIndex, eventCreditTargets, eventCredits, normalizeEventInput, type EventInput } from "@/server/services/events";
import { parseEventForm, parseReviewOp, targetKind, weekNote } from "@/app/leagues/[leagueId]/commish/events/event-rules";
import { computeLawyerPoints } from "@/lib/scoring";
import { presetScoring, type ScoringSettings } from "@/lib/settings";
import { UserError } from "@/server/action-result";

// Pool: firm F with lawyers A and B; lawyer C (no firm); firm G appears directly.
const lawyers = [
  { id: "F", name: "Firm F", kind: "firm" as const, firmId: null },
  { id: "G", name: "Firm G", kind: "firm" as const, firmId: null },
  { id: "A", name: "Lawyer A", kind: "lawyer" as const, firmId: "F" },
  { id: "B", name: "Lawyer B", kind: "lawyer" as const, firmId: "F" },
  { id: "C", name: "Lawyer C", kind: "lawyer" as const, firmId: null },
];
const appearances = [
  { caseId: "case1", lawyerId: "A", side: "plaintiff" as const },
  { caseId: "case1", lawyerId: "B", side: "plaintiff" as const },
  { caseId: "case1", lawyerId: "F", side: "plaintiff" as const }, // firm also listed directly: still credited once
  { caseId: "case1", lawyerId: "C", side: "defendant" as const },
  { caseId: "case1", lawyerId: "G", side: "defendant" as const },
];
const index = creditIndex(appearances, lawyers);
const scoring: ScoringSettings = presetScoring("half_ppf"); // verdict_win 10, firm x0.5, filing 0.5 capped at 3

const ev = (over: Partial<{ type: string; customPoints: number | null; caseId: string | null; side: "plaintiff" | "defendant" | null; lawyerId: string | null }>) => ({
  type: "verdict_win",
  customPoints: null,
  caseId: "case1",
  side: "plaintiff" as const,
  lawyerId: null,
  ...over,
});

describe("event credit targeting", () => {
  it("credits every lawyer on the side and each firm once", () => {
    const t = eventCreditTargets(ev({}), index);
    expect(t.individuals.sort()).toEqual(["A", "B"]);
    expect(t.firms).toEqual(["F"]);
  });

  it("credits firms that appear directly, and lawyers without a firm", () => {
    const t = eventCreditTargets(ev({ side: "defendant" }), index);
    expect(t.individuals).toEqual(["C"]);
    expect(t.firms).toEqual(["G"]);
  });

  it("lawyer-specific events credit only that lawyer (and their firm)", () => {
    const t = eventCreditTargets(ev({ type: "sanctioned", side: null, lawyerId: "A" }), index);
    expect(t).toEqual({ individuals: ["A"], firms: ["F"] });
  });

  it("returns points under the league's scoring", () => {
    const credits = eventCredits(ev({}), index, scoring);
    expect(credits).toEqual([
      { lawyerId: "A", name: "Lawyer A", kind: "lawyer", points: 20, viaFirm: false },
      { lawyerId: "B", name: "Lawyer B", kind: "lawyer", points: 20, viaFirm: false },
      { lawyerId: "F", name: "Firm F", kind: "firm", points: 10, viaFirm: true },
    ]);
    expect(eventCredits(ev({ type: "custom", customPoints: -3, side: "defendant" }), index, scoring).map((c) => c.points)).toEqual([-3, -1.5]);
  });

  it("caps a filing at the weekly cap and lists 0-point credits", () => {
    const big = { ...scoring, values: { ...scoring.values, filing: 10 } };
    expect(eventCredits(ev({ type: "filing" }), index, big).map((c) => c.points)).toEqual([6, 6, 3]);
    const outcomes = presetScoring("outcomes"); // filing = 0
    expect(eventCredits(ev({ type: "filing" }), index, outcomes).map((c) => c.points)).toEqual([0, 0, 0]);
  });

  it("returns nothing for a side with nobody on it", () => {
    expect(eventCredits(ev({ caseId: "case2" }), index, scoring)).toEqual([]);
  });

  it("matches the scoring engine for a single event", () => {
    for (const e of [ev({}), ev({ side: "defendant", type: "motion_denied" }), ev({ type: "scotus_argument", side: null, lawyerId: "B" })]) {
      const engine = computeLawyerPoints({
        events: [{ id: "e1", occurredOn: "2027-01-05", ...e }],
        appearances,
        lawyers,
        scoring,
        weekOf: () => 1,
        totalWeeks: 1,
      });
      const fromCredits = Object.fromEntries(eventCredits(e, index, scoring).map((c) => [c.lawyerId, c.points]));
      const fromEngine = Object.fromEntries([...engine].map(([id, p]) => [id, p.total]));
      expect(fromCredits).toEqual(fromEngine);
    }
  });
});

describe("normalizeEventInput", () => {
  const base: EventInput = {
    type: "motion_granted",
    caseId: "11111111-1111-4111-8111-111111111111",
    side: "defendant",
    lawyerId: null,
    occurredOn: "2027-01-05",
    summary: "  Court granted   defendant's motion to dismiss. ",
    sourceUrl: "https://example.com/docket/1",
    customPoints: null,
  };

  it("trims the summary and keeps case-based events", () => {
    expect(normalizeEventInput(base, { requireSource: true })).toEqual({ ...base, summary: "Court granted defendant's motion to dismiss." });
  });

  it("requires a source for manual events and rejects non-http links", () => {
    expect(() => normalizeEventInput({ ...base, sourceUrl: null }, { requireSource: true })).toThrow(UserError);
    expect(normalizeEventInput({ ...base, sourceUrl: null }, { requireSource: false }).sourceUrl).toBeNull();
    expect(() => normalizeEventInput({ ...base, sourceUrl: "javascript:alert(1)" }, { requireSource: false })).toThrow(/http/);
  });

  it("lawyer-specific events need a lawyer and drop the side (case kept as context)", () => {
    const lawyerId = "22222222-2222-4222-8222-222222222222";
    expect(() => normalizeEventInput({ ...base, type: "sanctioned" }, { requireSource: true })).toThrow(/lawyer/);
    expect(normalizeEventInput({ ...base, type: "sanctioned", lawyerId }, { requireSource: true })).toMatchObject({
      lawyerId,
      side: null,
      caseId: base.caseId,
    });
  });

  it("case-based events drop a stray lawyer and need a side", () => {
    expect(normalizeEventInput({ ...base, lawyerId: "x" }, { requireSource: true }).lawyerId).toBeNull();
    expect(() => normalizeEventInput({ ...base, side: null }, { requireSource: true })).toThrow(/side/);
    expect(() => normalizeEventInput({ ...base, caseId: null }, { requireSource: true })).toThrow(/case/);
  });

  it("custom events need points within range", () => {
    expect(() => normalizeEventInput({ ...base, type: "custom" }, { requireSource: true })).toThrow(/points/);
    expect(() => normalizeEventInput({ ...base, type: "custom", customPoints: 101 }, { requireSource: true })).toThrow(/between/);
    expect(normalizeEventInput({ ...base, type: "custom", customPoints: 2.555 }, { requireSource: true }).customPoints).toBe(2.56);
    expect(normalizeEventInput({ ...base, customPoints: 7 }, { requireSource: true }).customPoints).toBeNull();
  });

  it("rejects unknown types, bad dates, empty or long summaries", () => {
    expect(() => normalizeEventInput({ ...base, type: "touchdown" as EventInput["type"] }, { requireSource: true })).toThrow(/type/);
    expect(() => normalizeEventInput({ ...base, occurredOn: "2027-02-30" }, { requireSource: true })).toThrow(/date/);
    expect(() => normalizeEventInput({ ...base, summary: "   " }, { requireSource: true })).toThrow(/summary/);
    expect(() => normalizeEventInput({ ...base, summary: "x".repeat(301) }, { requireSource: true })).toThrow(/300/);
  });
});

describe("event form", () => {
  const caseId = "11111111-1111-4111-8111-111111111111";
  const lawyerId = "22222222-2222-4222-8222-222222222222";
  const form = (v: Record<string, string>) => {
    const f = new FormData();
    for (const [k, val] of Object.entries(v)) f.set(k, val);
    return f;
  };
  const base = { caseId, side: "plaintiff", occurredOn: "2027-01-05", summary: "Jury returned a verdict for the plaintiff.", sourceUrl: "https://example.com/x" };

  it("knows what each type targets", () => {
    expect(targetKind("verdict_win")).toBe("side");
    expect(targetKind("sanctioned")).toBe("lawyer");
    expect(targetKind("custom")).toBe("either");
  });

  it("parses a verdict win with the paired loss and approve-now checkboxes", () => {
    const r = parseEventForm(form({ ...base, type: "verdict_win", approveNow: "on", alsoRecordLoss: "on" }), { requireSource: true });
    expect(r).toEqual({
      ok: true,
      data: {
        input: { type: "verdict_win", caseId, side: "plaintiff", lawyerId: null, occurredOn: "2027-01-05", summary: base.summary, sourceUrl: base.sourceUrl, customPoints: null },
        approveNow: true,
        alsoRecordLoss: true,
      },
    });
    const off = parseEventForm(form({ ...base, type: "verdict_win" }), { requireSource: true });
    expect(off.ok && [off.data.approveNow, off.data.alsoRecordLoss]).toEqual([false, false]);
  });

  it("only pairs a loss for verdict wins", () => {
    const r = parseEventForm(form({ ...base, type: "motion_granted", alsoRecordLoss: "on" }), { requireSource: true });
    expect(r.ok && r.data.alsoRecordLoss).toBe(false);
  });

  it("uses the lawyer for lawyer-specific and custom-lawyer events", () => {
    const s = parseEventForm(form({ ...base, type: "scotus_argument", lawyerId, caseId: "" }), { requireSource: true });
    expect(s.ok && s.data.input).toMatchObject({ lawyerId, side: null, caseId: null });
    const c = parseEventForm(form({ ...base, type: "custom", target: "lawyer", lawyerId, customPoints: "4" }), { requireSource: true });
    expect(c.ok && c.data.input).toMatchObject({ lawyerId, side: null, customPoints: 4 });
    const cs = parseEventForm(form({ ...base, type: "custom", target: "side", lawyerId, customPoints: "-1.5" }), { requireSource: true });
    expect(cs.ok && cs.data.input).toMatchObject({ lawyerId: null, side: "plaintiff", customPoints: -1.5 });
  });

  it("explains what's missing", () => {
    expect(parseEventForm(form({ ...base, type: "" }), { requireSource: true })).toMatchObject({ ok: false, error: expect.stringMatching(/type/) });
    expect(parseEventForm(form({ ...base, type: "sanctioned" }), { requireSource: true })).toMatchObject({ ok: false, error: expect.stringMatching(/lawyer/) });
    expect(parseEventForm(form({ ...base, type: "filing", side: "" }), { requireSource: true })).toMatchObject({ ok: false, error: expect.stringMatching(/side/) });
    expect(parseEventForm(form({ ...base, type: "filing", sourceUrl: "" }), { requireSource: true })).toMatchObject({ ok: false, error: expect.stringMatching(/link/) });
    expect(parseEventForm(form({ ...base, type: "filing", sourceUrl: "" }), { requireSource: false }).ok).toBe(true);
    expect(parseEventForm(form({ ...base, type: "custom", customPoints: "" }), { requireSource: true })).toMatchObject({ ok: false, error: expect.stringMatching(/points/) });
    expect(parseEventForm(form({ ...base, type: "filing", caseId: "not-a-uuid" }), { requireSource: true }).ok).toBe(false);
  });
});

describe("review form", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";

  it("parses bulk approve, single approve and reject", () => {
    const f = new FormData();
    f.set("op", "approve-selected");
    f.append("ids", a);
    f.append("ids", b);
    f.append("ids", a);
    f.append("ids", "junk");
    expect(parseReviewOp(f)).toEqual({ ok: true, data: { op: "approve", ids: [a, b] } });

    const one = new FormData();
    one.set("op", `approve:${a}`);
    expect(parseReviewOp(one)).toEqual({ ok: true, data: { op: "approve", ids: [a] } });
    one.set("op", `reject:${b}`);
    expect(parseReviewOp(one)).toEqual({ ok: true, data: { op: "reject", id: b } });
  });

  it("asks for a selection and rejects junk", () => {
    const f = new FormData();
    f.set("op", "approve-selected");
    expect(parseReviewOp(f)).toMatchObject({ ok: false, error: expect.stringMatching(/Tick/) });
    f.set("op", "delete:everything");
    expect(parseReviewOp(f).ok).toBe(false);
  });
});

describe("weekNote", () => {
  it("warns about finalized weeks and events outside the season", () => {
    const fin = new Set([3]);
    expect(weekNote(3, 24, fin)).toMatchObject({ tone: "warn", text: expect.stringMatching(/week 3 is reopened/) });
    expect(weekNote(0, 24, fin)?.text).toMatch(/Before/);
    expect(weekNote(25, 24, fin)?.text).toMatch(/After/);
    expect(weekNote(4, 24, fin)).toBeNull();
  });
});
