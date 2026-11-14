import { describe, expect, it } from "vitest";
import {
  creditIndex,
  eventMissing,
  isEventComplete,
  normalizeEventInput,
  type ApproveReport,
  type EventInput,
  type PendingGroup,
} from "@/server/services/events";
import {
  appearanceOptions,
  approveResultMessage,
  parseQueueFilter,
  parseReviewChoices,
  parseReviewOp,
  queueCounts,
  queueHref,
} from "@/app/leagues/[leagueId]/commish/events/event-rules";
import { EVENT_TYPES, type Side } from "@/lib/settings";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const CASE1 = "44444444-4444-4444-8444-444444444444";
const CASE2 = "55555555-5555-4555-8555-555555555555";

const target = (over: Partial<{ type: string; caseId: string | null; side: Side | null; lawyerId: string | null; customPoints: number | null }>) => ({
  type: "motion_granted",
  caseId: CASE1,
  side: "plaintiff" as Side | null,
  lawyerId: null as string | null,
  customPoints: null as number | null,
  ...over,
});

describe("event completeness", () => {
  it("side-based suggestions need a side (court engine couldn't infer it)", () => {
    expect(eventMissing(target({}))).toBeNull();
    expect(eventMissing(target({ side: null }))).toBe("side");
    expect(eventMissing(target({ side: null, caseId: null }))).toBe("case");
    expect(isEventComplete(target({ side: null }))).toBe(false);
  });

  it("a stray lawyer doesn't complete a side-based type (approving would ignore the side rules)", () => {
    expect(eventMissing(target({ type: "filing", side: null, lawyerId: A }))).toBe("side");
  });

  it("lawyer-specific suggestions need the lawyer; the case is just context", () => {
    expect(eventMissing(target({ type: "scotus_argument", side: null, lawyerId: A }))).toBeNull();
    expect(eventMissing(target({ type: "scotus_argument", caseId: null, side: null, lawyerId: A }))).toBeNull();
    // "sanctioned" on a case when the docket doesn't say who.
    expect(eventMissing(target({ type: "sanctioned", side: null, lawyerId: null }))).toBe("lawyer");
    // A side doesn't stand in for the lawyer.
    expect(eventMissing(target({ type: "sanctioned", side: "defendant", lawyerId: null }))).toBe("lawyer");
  });

  it("custom needs points and a lawyer or a case side; unknown types need a real type", () => {
    expect(eventMissing(target({ type: "custom", customPoints: null }))).toBe("points");
    expect(eventMissing(target({ type: "custom", customPoints: 3 }))).toBeNull();
    expect(eventMissing(target({ type: "custom", customPoints: 3, side: null }))).toBe("side");
    expect(eventMissing(target({ type: "custom", customPoints: 3, side: null, caseId: null, lawyerId: A }))).toBeNull();
    expect(eventMissing(target({ type: "brief_filed_v2" }))).toBe("type");
    expect(eventMissing(target({ type: "" }))).toBe("type");
  });

  it("agrees with normalizeEventInput for every type and target shape", () => {
    const shapes: Pick<EventInput, "caseId" | "side" | "lawyerId">[] = [
      { caseId: CASE1, side: "plaintiff", lawyerId: null },
      { caseId: CASE1, side: null, lawyerId: null },
      { caseId: CASE1, side: null, lawyerId: A },
      { caseId: null, side: null, lawyerId: A },
      { caseId: null, side: null, lawyerId: null },
    ];
    for (const type of EVENT_TYPES) {
      for (const shape of shapes) {
        const input: EventInput = { type, ...shape, occurredOn: "2027-01-05", summary: "Docket text.", sourceUrl: null, customPoints: type === "custom" ? 2 : null };
        let valid = true;
        try {
          normalizeEventInput(input, { requireSource: false });
        } catch {
          valid = false;
        }
        expect([type, shape, isEventComplete(input)]).toEqual([type, shape, valid]);
      }
    }
  });
});

describe("review queue form ops", () => {
  const form = (v: Record<string, string>) => {
    const f = new FormData();
    for (const [k, val] of Object.entries(v)) f.set(k, val);
    return f;
  };

  it("parses save and reject-case (with the origin filter and page load time)", () => {
    expect(parseReviewOp(form({ op: `save:${A}` }))).toEqual({ ok: true, data: { op: "save", id: A } });
    expect(parseReviewOp(form({ op: `reject-case:${CASE1}`, queueOrigin: "courtlistener", queueLoadedAt: "2026-11-14T10:00:00.000Z" }))).toEqual({
      ok: true,
      data: { op: "reject-case", caseId: CASE1, origin: "courtlistener", before: "2026-11-14T10:00:00.000Z" },
    });
    expect(parseReviewOp(form({ op: `reject-case:${CASE1}`, queueOrigin: "everything", queueLoadedAt: "yesterday-ish" }))).toEqual({
      ok: true,
      data: { op: "reject-case", caseId: CASE1, origin: null, before: null },
    });
    expect(parseReviewOp(form({ op: "reject-case:not-a-case" })).ok).toBe(false);
    expect(parseReviewOp(form({ op: `save:${A}x` })).ok).toBe(false);
  });

  it("reads each card's inline picks, ignoring blanks and junk", () => {
    const f = form({
      [`type:${A}`]: "motion_denied",
      [`side:${A}`]: "defendant",
      [`type:${B}`]: "sanctioned",
      [`lawyer:${B}`]: C,
      [`side:${C}`]: "",
      [`lawyer:${C}`]: "not-a-uuid",
      [`type:${C}`]: "made_up",
      [`side:${CASE2}`]: "plaintiff", // not one of the ids asked about
    });
    const picks = parseReviewChoices(f, [A, B, C]);
    expect(picks.get(A)).toEqual({ type: "motion_denied", side: "defendant" });
    expect(picks.get(B)).toEqual({ type: "sanctioned", lawyerId: C });
    expect(picks.has(C)).toBe(false);
    expect(picks.has(CASE2)).toBe(false);
  });
});

describe("approve result message", () => {
  const report = (r: Partial<ApproveReport>): ApproveReport => ({ approved: [], skipped: [], notPending: [], ...r });

  it("says how many were approved and how many were skipped as incomplete", () => {
    expect(approveResultMessage(report({ approved: [A, B] }))).toEqual({ ok: true, message: "Approved 2 events." });
    expect(approveResultMessage(report({ approved: [A], skipped: [{ id: B, missing: "side" }, { id: C, missing: "lawyer" }] }))).toEqual({
      ok: true,
      message: "Approved 1 event. Skipped 2 events that still need a side, lawyer or type.",
    });
    expect(approveResultMessage(report({ approved: [A], skipped: [{ id: B, missing: "side" }], notPending: [C] }))).toEqual({
      ok: true,
      message: "Approved 1 event. Skipped 1 event that still needs a side, lawyer or type. 1 other was already reviewed.",
    });
  });

  it("blocks a single incomplete approval with a clear instruction", () => {
    expect(approveResultMessage(report({ skipped: [{ id: A, missing: "side" }] }))).toEqual({
      ok: false,
      error: "Pick which side of the case this is for, then approve.",
    });
    expect(approveResultMessage(report({ skipped: [{ id: A, missing: "lawyer" }] }))).toMatchObject({ ok: false, error: expect.stringMatching(/lawyer/) });
    expect(approveResultMessage(report({ skipped: [{ id: A, missing: null, error: "Pick the lawyer this event is about." }] }))).toEqual({
      ok: false,
      error: "Pick the lawyer this event is about.",
    });
  });

  it("fails when nothing could be approved", () => {
    expect(approveResultMessage(report({ skipped: [{ id: A, missing: "side" }, { id: B, missing: "side" }] }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Nothing approved: 2 events still need/),
    });
    expect(approveResultMessage(report({ notPending: [A] }))).toMatchObject({ ok: false, error: expect.stringMatching(/That event was already reviewed/) });
    expect(approveResultMessage(report({ notPending: [A, B] }))).toMatchObject({ ok: false, error: expect.stringMatching(/Those events/) });
  });
});

describe("review queue filters", () => {
  const groups: PendingGroup[] = [
    { origin: "courtlistener", caseId: CASE1, caseCaption: "Noisy v. Docket", caseDocket: "1:24-cv-1", count: 12, incomplete: 5 },
    { origin: "manual", caseId: CASE1, caseCaption: "Noisy v. Docket", caseDocket: "1:24-cv-1", count: 1, incomplete: 0 },
    { origin: "courtlistener", caseId: CASE2, caseCaption: "Quiet v. Case", caseDocket: null, count: 2, incomplete: 0 },
    { origin: "manual", caseId: null, caseCaption: null, caseDocket: null, count: 3, incomplete: 0 },
    { origin: "ai", caseId: CASE2, caseCaption: "Quiet v. Case", caseDocket: null, count: 1, incomplete: 1 },
  ];

  it("parses ?origin= and ?case= and ignores junk", () => {
    expect(parseQueueFilter({ origin: "courtlistener", case: CASE1 })).toEqual({ origin: "courtlistener", caseId: CASE1 });
    expect(parseQueueFilter({ origin: ["manual", "courtlistener"], case: "nope" })).toEqual({ origin: "manual", caseId: null });
    expect(parseQueueFilter({ origin: "ai" })).toEqual({ origin: null, caseId: null });
    expect(parseQueueFilter({})).toEqual({ origin: null, caseId: null });
  });

  it("builds queue links", () => {
    expect(queueHref("/q", { origin: null, caseId: null })).toBe("/q");
    expect(queueHref("/q", { origin: "courtlistener", caseId: null })).toBe("/q?origin=courtlistener");
    expect(queueHref("/q", { origin: "manual", caseId: CASE1 })).toBe(`/q?origin=manual&case=${CASE1}`);
  });

  it("counts everything when unfiltered", () => {
    const c = queueCounts(groups, { origin: null, caseId: null });
    expect(c.allPending).toBe(19);
    expect(c.origins).toEqual({ all: 19, courtlistener: 14, manual: 4 });
    expect(c.cases.map((x) => [x.caseId, x.count])).toEqual([
      [CASE1, 13],
      [CASE2, 3],
    ]);
    expect([c.originTotal, c.matching, c.incomplete]).toEqual([19, 19, 6]);
  });

  it("origin filter narrows the case list and counts; chips stay per case", () => {
    const c = queueCounts(groups, { origin: "courtlistener", caseId: null });
    expect(c.cases.map((x) => [x.caseId, x.count])).toEqual([
      [CASE1, 12],
      [CASE2, 2],
    ]);
    expect([c.originTotal, c.matching, c.incomplete]).toEqual([14, 14, 5]);
    expect(c.origins).toEqual({ all: 19, courtlistener: 14, manual: 4 });
  });

  it("case filter narrows the chips; the selected case stays listed even with 0 for the origin", () => {
    const c = queueCounts(groups, { origin: "manual", caseId: CASE2 });
    expect(c.origins).toEqual({ all: 3, courtlistener: 2, manual: 0 });
    expect(c.cases.map((x) => [x.caseId, x.count])).toEqual([
      [CASE1, 1],
      [CASE2, 0],
    ]);
    expect([c.originTotal, c.matching, c.incomplete]).toEqual([4, 0, 0]);
    const noisy = queueCounts(groups, { origin: "courtlistener", caseId: CASE1 });
    expect([noisy.matching, noisy.incomplete]).toEqual([12, 5]);
  });
});

describe("appearance options for the lawyer picker", () => {
  const index = creditIndex(
    [
      { caseId: CASE1, lawyerId: "L2", side: "defendant" },
      { caseId: CASE1, lawyerId: "L1", side: "plaintiff" },
      { caseId: CASE1, lawyerId: "F1", side: "plaintiff" },
      { caseId: CASE2, lawyerId: "L3", side: "plaintiff" },
    ],
    [
      { id: "L1", name: "Zed Lawyer", kind: "lawyer", firmId: "F1" },
      { id: "F1", name: "Alpha LLP", kind: "firm", firmId: null },
      { id: "L2", name: "Beth Counsel", kind: "lawyer", firmId: null },
      { id: "L3", name: "Other Case", kind: "lawyer", firmId: null },
    ],
  );

  it("lists both sides of the case, plaintiff side first, by name", () => {
    expect(appearanceOptions(index, CASE1)).toEqual([
      { lawyerId: "F1", name: "Alpha LLP", kind: "firm", side: "plaintiff" },
      { lawyerId: "L1", name: "Zed Lawyer", kind: "lawyer", side: "plaintiff" },
      { lawyerId: "L2", name: "Beth Counsel", kind: "lawyer", side: "defendant" },
    ]);
    expect(appearanceOptions(index, null)).toEqual([]);
    expect(appearanceOptions(index, "unknown")).toEqual([]);
  });
});
