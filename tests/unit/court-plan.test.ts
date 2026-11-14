import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseScotusDocket } from "@/lib/court/scotus";
import { planCourtListener, planScotus, suggestionCutoff, type PlanEntry } from "@/lib/court/sync-plan";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/court", name), "utf8"));
const hoffmann = parseScotusDocket(fixture("scotus-25-159.json"));
const now = new Date("2026-11-14T12:00:00Z");

const caseLawyers = [
  { id: "mcnamara", name: "Robert J. McNamara" },
  { id: "hughes", name: "Paul Whitfield Hughes" },
];
const poolLawyers = [
  { id: "jacoby", name: "Zoe A. Jacoby" },
  { id: "sauer", name: "D. John Sauer" },
];

describe("suggestionCutoff", () => {
  it("14 days back on the first sync, 30 later, never before the season start", () => {
    expect(suggestionCutoff(now, true)).toBe("2026-10-31");
    expect(suggestionCutoff(now, false)).toBe("2026-10-15");
    expect(suggestionCutoff(now, false, "2026-11-09")).toBe("2026-11-09");
    expect(suggestionCutoff(now, true, "2026-09-07")).toBe("2026-10-31");
    expect(suggestionCutoff(now, true, null)).toBe("2026-10-31");
  });
});

describe("planScotus", () => {
  const base = {
    docket: "25-159",
    proceedings: hoffmann.proceedings,
    now,
    caseLawyers,
    poolLawyers,
    petitionerTitle: hoffmann.petitionerTitle,
    respondentTitle: hoffmann.respondentTitle,
  };

  it("first sync: only the last 14 days (the argument), cursor past everything", () => {
    const plan = planScotus({ ...base, cursor: null });
    expect(plan.nextCursor).toBe("39");
    expect(plan.newEntries).toBe(39);
    expect(plan.capped).toBe(false);
    expect(plan.events.map((e) => [e.type, e.lawyerId, e.side, e.externalRef])).toEqual([
      ["scotus_argument", "mcnamara", null, "scotus:25-159:38:arg:robert-mcnamara"],
      ["scotus_argument", "hughes", null, "scotus:25-159:38:arg:paul-hughes"],
      ["scotus_argument", "jacoby", null, "scotus:25-159:38:arg:zoe-jacoby"],
    ]);
    const e = plan.events[0];
    expect(e.occurredOn).toBe("2026-11-09");
    expect(e.summary).toMatch(/^Argued\. For petitioners: Robert J\. McNamara/);
    expect(e.summary.length).toBeLessThanOrEqual(300);
    expect(e.sourceUrl).toBe("https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/25-159.html");
  });

  it("re-sync with the cursor at the end creates nothing", () => {
    const plan = planScotus({ ...base, cursor: "39" });
    expect(plan).toMatchObject({ events: [], newEntries: 0, nextCursor: "39" });
  });

  it("incremental: only proceedings after the cursor, briefs credit a side", () => {
    const plan = planScotus({ ...base, cursor: "37", now: new Date("2026-11-10T00:00:00Z") });
    expect(plan.newEntries).toBe(2);
    expect(plan.events.map((e) => e.type)).toEqual(["filing", "scotus_argument", "scotus_argument", "scotus_argument"]);
    expect(plan.events[0]).toMatchObject({ side: "plaintiff", lawyerId: null, externalRef: "scotus:25-159:37", occurredOn: "2026-10-14" });
    expect(plan.events[0].sourceUrl).toMatch(/^https:\/\/www\.supremecourt\.gov\/DocketPDF\//);
  });

  it("before the season starts (league in setup): cursor moves, nothing is suggested", () => {
    const plan = planScotus({ ...base, cursor: null, notBefore: "2027-01-04" });
    expect(plan).toMatchObject({ events: [], newEntries: 39, nextCursor: "39" });
    // Activity on/after the season start is suggested.
    expect(planScotus({ ...base, cursor: null, notBefore: "2026-11-09" }).events).toHaveLength(3);
  });

  it("arguers who aren't in the pool are skipped", () => {
    const plan = planScotus({ ...base, cursor: null, caseLawyers: [], poolLawyers: [] });
    expect(plan.events).toEqual([]);
    expect(plan.nextCursor).toBe("39");
  });

  it("caps suggestions per run and resumes from the first unprocessed proceeding", () => {
    const sept = new Date("2026-09-10T00:00:00Z"); // keeps the August brief inside the 30-day window
    const plan = planScotus({ ...base, cursor: "20", now: sept, maxSuggestions: 2 });
    // 20: petitioners' brief (Aug 13), 31: respondent's brief → cap of 2 reached before 37 (reply).
    expect(plan.events.map((e) => e.externalRef)).toEqual(["scotus:25-159:20", "scotus:25-159:31"]);
    expect(plan.capped).toBe(true);
    expect(plan.nextCursor).toBe("37");
    const next = planScotus({ ...base, cursor: plan.nextCursor, now: sept, maxSuggestions: 2 });
    expect(next.events.map((e) => e.externalRef)).toEqual(["scotus:25-159:37"]);
    expect(next.nextCursor).toBe("38"); // argument (3 lawyers) waits for a run with room
  });

  it("a cursor beyond the list is clamped", () => {
    expect(planScotus({ ...base, cursor: "99" }).nextCursor).toBe("39");
  });
});

describe("planCourtListener", () => {
  const entry = (id: number, dateFiled: string, description: string, dateModified = `${dateFiled}T15:00:00.000000-08:00`): PlanEntry => ({
    entryId: id,
    dateFiled,
    description,
    dateModified,
    url: `https://www.courtlistener.com/docket/123/acme/#entry-${id}`,
  });
  const base = { now, caseType: "civil" as const, caption: "Doe v. Acme Corp." };

  it("classifies entries, skips noise, advances the cursor to the last entry", () => {
    const plan = planCourtListener({
      ...base,
      cursor: "2026-11-01T00:00:00-07:00",
      entries: [
        entry(1, "2026-11-02", "NOTICE of Appearance by John Smith on behalf of Acme Corp. (Smith, John)"),
        entry(2, "2026-11-03", "MOTION to Dismiss for Failure to State a Claim by Acme Corp.. (Smith, John)"),
        entry(3, "2026-11-10", "ORDER granting 2 MOTION to Dismiss filed by Acme Corp. Signed by Judge X. (abc)"),
      ],
    });
    expect(plan.newEntries).toBe(3);
    expect(plan.nextCursor).toBe("2026-11-10T15:00:00.000000-08:00");
    expect(plan.events.map((e) => [e.externalRef, e.type, e.side, e.occurredOn])).toEqual([
      ["cl-entry:2", "filing", "defendant", "2026-11-03"],
      ["cl-entry:3", "motion_granted", "defendant", "2026-11-10"],
    ]);
    expect(plan.events[1].summary).toBe("ORDER granting 2 MOTION to Dismiss filed by Acme Corp. Signed by Judge X.");
    expect(plan.events[1].sourceUrl).toBe("https://www.courtlistener.com/docket/123/acme/#entry-3");
  });

  it("first sync ignores older entries but still moves the cursor past them", () => {
    const plan = planCourtListener({
      ...base,
      cursor: null,
      entries: [
        entry(1, "2026-09-01", "MOTION to Dismiss by Acme Corp.", "2026-11-05T10:00:00Z"),
        entry(2, "2026-11-04", "MOTION to Compel by Plaintiff Jane Doe.", "2026-11-06T10:00:00Z"),
      ],
    });
    expect(plan.events.map((e) => e.externalRef)).toEqual(["cl-entry:2"]);
    expect(plan.nextCursor).toBe("2026-11-06T10:00:00Z");
  });

  it("later syncs ignore stale entries (old documents newly added)", () => {
    const plan = planCourtListener({ ...base, cursor: "2026-11-01T00:00:00Z", entries: [entry(9, "2025-01-15", "MOTION to Dismiss by Acme Corp.", "2026-11-12T00:00:00Z")] });
    expect(plan.events).toEqual([]);
    expect(plan.nextCursor).toBe("2026-11-12T00:00:00Z");
  });

  it("entries before the earliest season start only move the cursor", () => {
    const plan = planCourtListener({
      ...base,
      cursor: "2026-11-01T00:00:00Z",
      notBefore: "2026-11-09",
      entries: [entry(7, "2026-11-03", "MOTION to Compel by Plaintiff Jane Doe."), entry(8, "2026-11-12", "MOTION to Compel by Plaintiff Jane Doe.")],
    });
    expect(plan.events.map((e) => e.externalRef)).toEqual(["cl-entry:8"]);
    expect(plan.newEntries).toBe(2);
  });

  it("verdicts with a winner also suggest the loss for the other side", () => {
    const plan = planCourtListener({ ...base, cursor: "2026-11-01T00:00:00Z", entries: [entry(5, "2026-11-12", "JURY VERDICT in favor of Plaintiff Jane Doe against Defendant Acme Corp.")] });
    expect(plan.events.map((e) => [e.externalRef, e.type, e.side])).toEqual([
      ["cl-entry:5", "verdict_win", "plaintiff"],
      ["cl-entry:5:loss", "verdict_loss", "defendant"],
    ]);
  });

  it("filing attorney hints come from the case's lawyers", () => {
    const plan = planCourtListener({
      ...base,
      cursor: "2026-11-01T00:00:00Z",
      attorneys: { plaintiff: [], defendant: ["John Smith"] },
      entries: [entry(6, "2026-11-12", "BRIEF in support of motion to compel arbitration (Smith, John) (Entered: 11/12/2026)")],
    });
    expect(plan.events[0]).toMatchObject({ type: "filing", side: "defendant" });
  });

  it("caps suggestions and leaves the cursor before the first entry that didn't fit", () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(10 + i, "2026-11-12", "MOTION to Compel by Plaintiff Jane Doe.", `2026-11-12T0${i}:00:00Z`));
    const plan = planCourtListener({ ...base, cursor: "2026-11-01T00:00:00Z", entries, maxSuggestions: 3 });
    expect(plan.events).toHaveLength(3);
    expect(plan.capped).toBe(true);
    expect(plan.newEntries).toBe(3);
    expect(plan.nextCursor).toBe("2026-11-12T02:00:00Z");
  });

  it("no entries: cursor unchanged", () => {
    expect(planCourtListener({ ...base, cursor: null, entries: [] })).toMatchObject({ events: [], nextCursor: null, newEntries: 0 });
  });
});
