import { describe, expect, it } from "vitest";
import { signupSchema } from "@/app/account/rules";
import { snakeSlot } from "@/lib/draft";
import { validateLineup } from "@/lib/lineup";
import { defaultLeagueSettings, EVENT_TYPES, LAWYER_SPECIFIC_EVENTS, rosterSize, starterSlots } from "@/lib/settings";
import { addDays, dayOfWeek, weekOfDate, weekStartDate } from "@/lib/time";
import { normalizeEventInput } from "@/server/services/events";
import {
  APPROVED_EVENTS_PER_WEEK,
  CASE_COUNTS,
  DEMO_CURRENT_WEEK,
  DEMO_PASSWORD,
  DEMO_TEAM_NAMES,
  DEMO_USERNAME_PREFIX,
  DEMO_USERS,
  FIRMS,
  LAWYER_COUNTS,
  MAX_APPEARANCES,
  MIN_APPEARANCES,
  PRACTICE_TEAM_NAMES,
  Rng,
  SCORED_WEEKS,
  SUPREME_COURT,
  demoSeasonStart,
  generateWorld,
  planDraft,
  rngFor,
  variedLineup,
  type DemoWorld,
} from "../../scripts/seed-data";

const TODAY = "2026-11-13"; // a Friday
const SEASON_START = demoSeasonStart(TODAY);
const world: DemoWorld = generateWorld({ seasonStart: SEASON_START, today: TODAY });
const settings = defaultLeagueSettings();

describe("seeded PRNG", () => {
  it("is deterministic per seed and section", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect(Array.from({ length: 5 }, () => a.float())).toEqual(Array.from({ length: 5 }, () => b.float()));
    expect(rngFor("x").float()).toBe(rngFor("x").float());
    expect(rngFor("x").float()).not.toBe(rngFor("y").float());
  });

  it("stays in range", () => {
    const r = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const n = r.int(3, 6);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      expect(["a", "b"]).toContain(r.weighted([["a", 1], ["b", 3]] as const));
    }
    expect(r.shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("demo season dates", () => {
  it("always puts today in week 7, starting on a Monday", () => {
    for (let i = 0; i < 14; i++) {
      const today = addDays("2026-11-09", i);
      const start = demoSeasonStart(today);
      expect(dayOfWeek(start)).toBe(1);
      expect(weekOfDate(today, start)).toBe(DEMO_CURRENT_WEEK);
    }
  });
});

describe("demo accounts and teams", () => {
  it("are otherwise-valid accounts under the reserved demo_ prefix (nobody can sign up as one)", () => {
    expect(DEMO_USERS).toHaveLength(10);
    expect(DEMO_USERS[0]).toEqual({ username: "demo_commish", displayName: "Demo Commissioner" });
    for (const u of DEMO_USERS) {
      expect(u.username.startsWith(DEMO_USERNAME_PREFIX)).toBe(true);
      const form = { ...u, password: DEMO_PASSWORD, confirmPassword: DEMO_PASSWORD, email: "" };
      expect(signupSchema.safeParse(form).success).toBe(false);
      const unprefixed = { ...form, username: u.username.slice(DEMO_USERNAME_PREFIX.length).padEnd(3, "x") };
      expect(signupSchema.safeParse(unprefixed).success).toBe(true);
    }
  });

  it("have valid, distinct team names", () => {
    expect(DEMO_TEAM_NAMES).toHaveLength(DEMO_USERS.length);
    expect(PRACTICE_TEAM_NAMES).toHaveLength(6);
    for (const names of [DEMO_TEAM_NAMES, PRACTICE_TEAM_NAMES]) {
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(n.length >= 2 && n.length <= 40).toBe(true);
    }
  });
});

describe("demo pool", () => {
  const firms = world.lawyers.filter((l) => l.kind === "firm");
  const individuals = world.lawyers.filter((l) => l.kind === "lawyer");

  it("is deterministic and only its dates depend on today", () => {
    expect(generateWorld({ seasonStart: SEASON_START, today: TODAY })).toEqual(world);
    const later = generateWorld({ seasonStart: addDays(SEASON_START, 21), today: addDays(TODAY, 21) });
    expect(later.lawyers).toEqual(world.lawyers);
    expect(later.cases.map((c) => [c.caption, c.appearances])).toEqual(world.cases.map((c) => [c.caption, c.appearances]));
    expect(later.events.map((e) => [e.type, e.caseKey, e.side, e.lawyerKey, e.status])).toEqual(
      world.events.map((e) => [e.type, e.caseKey, e.side, e.lawyerKey, e.status]),
    );
  });

  it("has firms and lawyers with unique names and ranks 1..N", () => {
    expect(firms).toHaveLength(FIRMS.length);
    for (const [position, n] of Object.entries(LAWYER_COUNTS)) {
      expect(individuals.filter((l) => l.position === position)).toHaveLength(n);
    }
    expect(firms.every((f) => f.position === "firm" && f.firmKey === null)).toBe(true);
    expect(new Set(world.lawyers.map((l) => l.name.toLowerCase())).size).toBe(world.lawyers.length);
    expect(world.lawyers.map((l) => l.preseasonRank).sort((a, b) => a - b)).toEqual(world.lawyers.map((_, i) => i + 1));
  });

  it("gives lawyers sensible affiliations", () => {
    for (const l of individuals) {
      if (l.firmKey !== null) {
        expect(world.lawyers[l.firmKey].kind).toBe("firm");
        expect(l.organization).toBe(world.lawyers[l.firmKey].name);
      } else {
        expect(l.organization).toContain("(fictional)");
      }
      if (l.position === "prosecutor") {
        expect(l.firmKey).toBeNull();
        expect(l.organization).toMatch(/Attorney's Office/);
      }
      if (l.position === "defense" && l.firmKey === null) expect(l.organization).toMatch(/Public Defender/);
    }
    expect(individuals.filter((l) => l.firmKey !== null).length).toBeGreaterThan(individuals.length / 2);
    for (const f of firms) expect(individuals.some((l) => l.firmKey === f.key)).toBe(true);
  });

  it("has fictional cases with 2–6 appearances on sensible sides", () => {
    for (const [type, n] of Object.entries(CASE_COUNTS)) expect(world.cases.filter((c) => c.caseType === type)).toHaveLength(n);
    const dockets = new Set<string>();
    for (const c of world.cases) {
      expect(c.court).toContain("(fictional");
      expect(c.sourceUrl).toBe(`https://example.com/demo-docket/${1001 + c.key}`);
      const docketKey = `${c.court}|${c.docketNumber}`;
      expect(dockets.has(docketKey)).toBe(false);
      dockets.add(docketKey);
      expect(c.filedOn < SEASON_START).toBe(true);
      expect(c.appearances.length).toBeGreaterThanOrEqual(MIN_APPEARANCES);
      expect(c.appearances.length).toBeLessThanOrEqual(MAX_APPEARANCES);
      expect(new Set(c.appearances.map((a) => a.lawyerKey)).size).toBe(c.appearances.length);
      expect(c.appearances.some((a) => a.side === "plaintiff")).toBe(true);
      expect(c.appearances.some((a) => a.side === "defendant")).toBe(true);
      for (const a of c.appearances) {
        const l = world.lawyers[a.lawyerKey];
        expect(l.kind).toBe("lawyer");
        if (c.caseType === "civil") expect(l.position).toBe("trial");
        if (c.caseType === "criminal") expect(l.position).toBe(a.side === "plaintiff" ? "prosecutor" : "defense");
        if (c.caseType === "appeal" || c.caseType === "supreme_court") expect(l.position).toBe("appellate");
        if (l.jurisdiction !== null) expect(c.jurisdiction).toBe(l.jurisdiction);
        // No firm on both sides of a case.
        if (l.firmKey !== null) {
          const opposing = c.appearances.filter((o) => o.side !== a.side).map((o) => world.lawyers[o.lawyerKey].firmKey);
          expect(opposing).not.toContain(l.firmKey);
        }
      }
    }
    expect(world.cases.filter((c) => c.caseType === "supreme_court").every((c) => c.court === SUPREME_COURT)).toBe(true);
  });

  it("puts every lawyer on at least one case", () => {
    const appearing = new Set(world.cases.flatMap((c) => c.appearances.map((a) => a.lawyerKey)));
    for (const l of individuals) expect(appearing.has(l.key)).toBe(true);
  });
});

describe("demo scoring events", () => {
  const approved = world.events.filter((e) => e.status === "approved");
  const pending = world.events.filter((e) => e.status === "pending");
  const week = (date: string) => weekOfDate(date, SEASON_START);

  it("has ~20 approved events in each of weeks 1–6", () => {
    expect(approved).toHaveLength(APPROVED_EVENTS_PER_WEEK * SCORED_WEEKS);
    for (let w = 1; w <= SCORED_WEEKS; w++) expect(approved.filter((e) => week(e.occurredOn) === w)).toHaveLength(APPROVED_EVENTS_PER_WEEK);
  });

  it("has pending events in weeks 6 and 7, never in the future", () => {
    expect(pending).toHaveLength(12);
    expect(pending.filter((e) => week(e.occurredOn) === 6)).toHaveLength(6);
    expect(pending.filter((e) => week(e.occurredOn) === 7)).toHaveLength(6);
    for (const e of pending) expect(e.occurredOn <= TODAY).toBe(true);
    // Seeding on the Monday of week 7 still works.
    const monday = weekStartDate(DEMO_CURRENT_WEEK, SEASON_START);
    const early = generateWorld({ seasonStart: SEASON_START, today: monday });
    for (const e of early.events) expect(e.occurredOn <= monday).toBe(true);
  });

  it("uses every event type, with filings and motions most common", () => {
    const types = new Set(approved.map((e) => e.type));
    for (const t of EVENT_TYPES) expect(types.has(t)).toBe(true);
    const n = (t: string) => approved.filter((e) => e.type === t).length;
    expect(n("filing") + n("motion_granted") + n("motion_denied")).toBeGreaterThan(approved.length / 2);
    expect(n("verdict_win")).toBeLessThan(n("filing") / 4);
    expect(n("scotus_argument")).toBeGreaterThanOrEqual(1);
    expect(n("scotus_argument")).toBeLessThanOrEqual(2);
  });

  it("passes the events service's validation and targets sensible lawyers", () => {
    for (const e of world.events) {
      const c = e.caseKey === null ? null : world.cases[e.caseKey];
      const input = normalizeEventInput(
        {
          type: e.type,
          caseId: e.caseKey === null ? null : String(e.caseKey),
          side: e.side,
          lawyerId: e.lawyerKey === null ? null : String(e.lawyerKey),
          occurredOn: e.occurredOn,
          summary: e.summary,
          sourceUrl: e.sourceUrl,
          customPoints: e.customPoints,
        },
        { requireSource: true },
      );
      expect(input.summary).toBe(e.summary);
      expect(e.summary).not.toMatch(/undefined|null/);
      expect(c).not.toBeNull();
      expect(e.sourceUrl.startsWith(`${c!.sourceUrl}#entry-`)).toBe(true);
      if (LAWYER_SPECIFIC_EVENTS.has(e.type)) {
        expect(e.side).toBeNull();
        expect(c!.appearances.some((a) => a.lawyerKey === e.lawyerKey)).toBe(true);
      } else {
        expect(e.lawyerKey).toBeNull();
        expect(e.side).not.toBeNull();
      }
      if (e.type === "scotus_argument") {
        expect(c!.caseType).toBe("supreme_court");
        expect(world.lawyers[e.lawyerKey!].position).toBe("appellate");
      }
      if (e.type === "guilty_plea") expect([c!.caseType, e.side]).toEqual(["criminal", "plaintiff"]);
      if (e.type === "plea_reduced") expect([c!.caseType, e.side]).toEqual(["criminal", "defendant"]);
      if (e.type === "appeal_won" || e.type === "win_reversed") expect(c!.caseType).toBe("appeal");
    }
    const anchors = world.events.map((e) => e.sourceUrl);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("closes resolved cases and adds nothing after the outcome", () => {
    const terminal = new Set(["verdict_win", "settlement_favorable", "dismissed_favorable", "summary_judgment_won", "guilty_plea", "appeal_won"]);
    for (const c of world.cases) {
      const outcome = approved.filter((e) => e.caseKey === c.key && terminal.has(e.type));
      expect(c.status).toBe(outcome.length > 0 ? "closed" : "active");
      if (outcome.length === 0) continue;
      const end = outcome[0].occurredOn;
      for (const e of world.events.filter((x) => x.caseKey === c.key)) {
        expect(e.occurredOn <= end).toBe(true);
        if (e.occurredOn === end) expect(e.status).toBe("approved");
      }
    }
  });
});

describe("planDraft", () => {
  const candidates = world.lawyers.map((l) => ({ id: String(l.key), name: l.name, position: l.position, preseasonRank: l.preseasonRank }));
  const rounds = rosterSize(settings.roster);
  const plan = planDraft({ teamCount: 10, rounds, roster: settings.roster, candidates, rng: rngFor("test-draft") });

  it("makes a full, valid snake draft", () => {
    expect(plan).toHaveLength(10 * rounds);
    expect(new Set(plan.map((p) => p.lawyerId)).size).toBe(plan.length);
    plan.forEach((p, i) => {
      expect(p.overall).toBe(i);
      const slot = snakeSlot(i, 10);
      expect([p.round, p.pickInRound, p.draftPosition]).toEqual([slot.round, slot.pickInRound, slot.draftPosition]);
      if (i > 0) {
        const gap = p.secondsAfterStart - plan[i - 1].secondsAfterStart;
        expect(gap).toBeGreaterThanOrEqual(15);
        expect(gap).toBeLessThanOrEqual(75);
      }
    });
  });

  it("lets every team fill its starting lineup", () => {
    for (let pos = 1; pos <= 10; pos++) {
      const players = plan
        .filter((p) => p.draftPosition === pos)
        .map((p) => ({ id: p.lawyerId, position: world.lawyers[Number(p.lawyerId)].position, preseasonRank: world.lawyers[Number(p.lawyerId)].preseasonRank }));
      expect(players).toHaveLength(rounds);
      const lineup = variedLineup(players, settings.roster, rngFor(`lineup-${pos}`));
      expect(lineup).toHaveLength(starterSlots(settings.roster).length);
      expect(lineup.every((id) => id !== null)).toBe(true);
      expect(validateLineup(lineup, settings.roster, players)).toBeNull();
    }
  });

  it("is deterministic", () => {
    expect(planDraft({ teamCount: 10, rounds, roster: settings.roster, candidates, rng: rngFor("test-draft") })).toEqual(plan);
  });
});
