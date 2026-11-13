import { describe, expect, it } from "vitest";
import {
  createLeagueSchema,
  defaultSeasonStart,
  isValidIsoDate,
  LEAGUE_STATUS_LABELS,
  leagueStatusTone,
  pickHomePeriod,
  resolveSeasonStart,
} from "@/app/leagues/new/league-rules";
import { buildJoinUrl, joinPath, joinSchema, teamNameSchema } from "@/app/join/join-rules";
import { ACTIVITY_PAGE_SIZE, pageOffset, parsePage, TRANSACTION_LABELS, transactionTone } from "@/app/leagues/[leagueId]/activity/paging";
import { firstIssue } from "@/app/account/rules";

const TZ = "America/New_York";
const POOL = "3f1c2b8e-6a0e-4c51-9a7e-2d9b8f1e4a10";

describe("season start", () => {
  it("defaults to the next Monday strictly after today", () => {
    // Fri Nov 13 2026, noon in New York
    expect(defaultSeasonStart(new Date("2026-11-13T17:00:00Z"), TZ)).toBe("2026-11-16");
    // Mon Nov 16 2026 -> the following Monday
    expect(defaultSeasonStart(new Date("2026-11-16T15:00:00Z"), TZ)).toBe("2026-11-23");
    // Sun Nov 15 late evening in New York (already Monday in UTC)
    expect(defaultSeasonStart(new Date("2026-11-16T03:00:00Z"), TZ)).toBe("2026-11-16");
  });

  it("snaps to Monday and validates", () => {
    const now = new Date("2026-11-13T17:00:00Z");
    expect(resolveSeasonStart("2026-11-16", now, TZ)).toEqual({ ok: true, date: "2026-11-16", snapped: false });
    expect(resolveSeasonStart("2026-11-18", now, TZ)).toEqual({ ok: true, date: "2026-11-23", snapped: true });
    // This week's Monday is allowed
    expect(resolveSeasonStart("2026-11-09", now, TZ)).toEqual({ ok: true, date: "2026-11-09", snapped: false });
    expect(resolveSeasonStart("2026-11-02", now, TZ).ok).toBe(false);
    expect(resolveSeasonStart("2028-01-03", now, TZ).ok).toBe(false);
    expect(resolveSeasonStart("2026-02-30", now, TZ).ok).toBe(false);
    expect(resolveSeasonStart("soon", now, TZ).ok).toBe(false);
  });

  it("checks real dates", () => {
    expect(isValidIsoDate("2026-11-16")).toBe(true);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-1-1")).toBe(false);
  });
});

describe("create league form", () => {
  const base = { name: " Club  League ", teamName: "Objection!", maxTeams: "10", seasonStart: "2026-11-16", pool: POOL, newPoolName: "" };

  it("parses an existing-pool form", () => {
    expect(createLeagueSchema.parse(base)).toEqual({
      name: "Club League",
      teamName: "Objection!",
      maxTeams: 10,
      seasonStart: "2026-11-16",
      pool: POOL,
      newPoolName: "",
    });
  });

  it("requires a name for a new pool", () => {
    const r = createLeagueSchema.safeParse({ ...base, pool: "new", newPoolName: " " });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toMatch(/new player pool/);
    expect(createLeagueSchema.safeParse({ ...base, pool: "new", newPoolName: "Real cases 2026" }).success).toBe(true);
  });

  it("bounds max teams to 2-12", () => {
    expect(createLeagueSchema.safeParse({ ...base, maxTeams: "1" }).success).toBe(false);
    expect(createLeagueSchema.safeParse({ ...base, maxTeams: "13" }).success).toBe(false);
    expect(createLeagueSchema.safeParse({ ...base, maxTeams: "2.5" }).success).toBe(false);
    expect(createLeagueSchema.safeParse({ ...base, maxTeams: "abc" }).success).toBe(false);
    expect(createLeagueSchema.safeParse({ ...base, maxTeams: "2" }).success).toBe(true);
  });

  it("rejects bad pool ids and blank names", () => {
    expect(createLeagueSchema.safeParse({ ...base, pool: "not-a-uuid" }).success).toBe(false);
    expect(createLeagueSchema.safeParse({ ...base, name: "x" }).success).toBe(false);
    expect(createLeagueSchema.safeParse({ ...base, teamName: "" }).success).toBe(false);
  });
});

describe("status labels", () => {
  it("covers every league status", () => {
    expect(Object.keys(LEAGUE_STATUS_LABELS).sort()).toEqual(["complete", "drafting", "in_season", "playoffs", "setup"]);
    expect(leagueStatusTone("drafting")).toBe("warn");
    expect(leagueStatusTone("complete")).toBe("neutral");
  });
});

describe("pickHomePeriod", () => {
  const periods = [
    { period: 1, weekStart: 1, weekEnd: 2 },
    { period: 1, weekStart: 1, weekEnd: 2 },
    { period: 2, weekStart: 3, weekEnd: 4 },
    { period: 3, weekStart: 5, weekEnd: 6 },
  ];
  it("finds the period containing the week", () => {
    expect(pickHomePeriod(periods, 1)).toBe(1);
    expect(pickHomePeriod(periods, 4)).toBe(2);
    expect(pickHomePeriod(periods, 5)).toBe(3);
  });
  it("uses period 1 before the season", () => {
    expect(pickHomePeriod(periods, 0)).toBe(1);
    expect(pickHomePeriod(periods, -3)).toBe(1);
  });
  it("uses the latest finished period after the schedule", () => {
    expect(pickHomePeriod(periods, 9)).toBe(3);
  });
  it("handles a gap before playoffs are generated", () => {
    const withPlayoffs = [...periods, { period: 5, weekStart: 9, weekEnd: 10 }];
    expect(pickHomePeriod(withPlayoffs, 7)).toBe(3);
    expect(pickHomePeriod(withPlayoffs, 10)).toBe(5);
  });
  it("is null without a schedule", () => {
    expect(pickHomePeriod([], 3)).toBeNull();
  });
});

describe("join rules", () => {
  it("normalizes invite codes and team names", () => {
    expect(joinSchema.parse({ code: " abc-123 ", teamName: "  The   Objectors " })).toEqual({ code: "ABC123", teamName: "The Objectors" });
    expect(joinSchema.safeParse({ code: "", teamName: "Team" }).success).toBe(false);
    expect(teamNameSchema.safeParse("x").success).toBe(false);
    expect(teamNameSchema.safeParse("x".repeat(41)).success).toBe(false);
  });

  it("builds join links", () => {
    expect(joinPath("abc123")).toBe("/join?code=ABC123");
    expect(buildJoinUrl("ABC123", "lawyer-fantasy.example", "https")).toBe("https://lawyer-fantasy.example/join?code=ABC123");
    expect(buildJoinUrl("ABC123", "localhost:3000", null)).toBe("http://localhost:3000/join?code=ABC123");
    expect(buildJoinUrl("ABC123", "app.example, proxy.example", "https,http")).toBe("https://app.example/join?code=ABC123");
    expect(buildJoinUrl("ABC123", null, "https")).toBe("/join?code=ABC123");
    expect(buildJoinUrl("ABC123", "evil.example/path", "https")).toBe("/join?code=ABC123");
    expect(buildJoinUrl("ABC123", "app.example", "javascript")).toBe("https://app.example/join?code=ABC123");
  });
});

describe("activity paging", () => {
  it("parses ?page=", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("")).toBe(1);
    expect(parsePage("3")).toBe(3);
    expect(parsePage(["4", "5"])).toBe(4);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-2")).toBe(1);
    expect(parsePage("2.5")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("999999")).toBe(10_000);
  });
  it("computes offsets", () => {
    expect(pageOffset(1)).toBe(0);
    expect(pageOffset(3)).toBe(2 * ACTIVITY_PAGE_SIZE);
    expect(pageOffset(0)).toBe(0);
  });
  it("labels every transaction type", () => {
    expect(Object.keys(TRANSACTION_LABELS).sort()).toEqual(["add", "commissioner", "draft", "drop", "trade", "waiver_add"]);
    expect(transactionTone("drop")).toBe("neg");
  });
});
