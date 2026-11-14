import { describe, expect, it } from "vitest";
import {
  cleanDocketForSearch,
  courtErrorMessage,
  courtIdFromName,
  courtLabel,
  courtListenerDocketUrl,
  courtStats,
  docketKey,
  firmKey,
  docketTypeCode,
  findPoolMatch,
  guessCaseType,
  guessPosition,
  isCircuitCourt,
  isCourtListenerUrl,
  listWithMore,
  matchNames,
  nameMatches,
  parseCourtInput,
  retryWait,
  scotusDocketUrl,
  syncResultMessage,
  type CourtCaseRow,
} from "@/app/leagues/[leagueId]/commish/court/court-rules";

/** Same shape as CourtListenerError (kept local so the test doesn't depend on the client module). */
class FakeClError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

describe("URLs", () => {
  it("builds the Supreme Court docket and CourtListener docket links", () => {
    expect(scotusDocketUrl("25-159")).toBe("https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/25-159.html");
    expect(courtListenerDocketUrl(68571705)).toBe("https://www.courtlistener.com/docket/68571705/");
  });

  it("only accepts https courtlistener.com URLs", () => {
    expect(isCourtListenerUrl("https://www.courtlistener.com/docket/1/foo-v-bar/")).toBe(true);
    expect(isCourtListenerUrl("https://courtlistener.com/docket/1/")).toBe(true);
    expect(isCourtListenerUrl("http://www.courtlistener.com/docket/1/")).toBe(false);
    expect(isCourtListenerUrl("https://www.courtlistener.com.evil.example/")).toBe(false);
    expect(isCourtListenerUrl("javascript:alert(1)")).toBe(false);
    expect(isCourtListenerUrl("")).toBe(false);
  });
});

describe("court ids <-> court names", () => {
  it("labels CourtListener court ids Bluebook-style", () => {
    expect(courtLabel("nysd")).toBe("S.D.N.Y.");
    expect(courtLabel("nyed")).toBe("E.D.N.Y.");
    expect(courtLabel("cand")).toBe("N.D. Cal.");
    expect(courtLabel("cacd")).toBe("C.D. Cal.");
    expect(courtLabel("dcd")).toBe("D.D.C.");
    expect(courtLabel("njd")).toBe("D.N.J.");
    expect(courtLabel("mdd")).toBe("D. Md.");
    expect(courtLabel("mad")).toBe("D. Mass.");
    expect(courtLabel("wvsd")).toBe("S.D. W. Va.");
    expect(courtLabel("okwd")).toBe("W.D. Okla.");
    expect(courtLabel("flsd")).toBe("S.D. Fla.");
    expect(courtLabel("ca2")).toBe("2d Cir.");
    expect(courtLabel("ca4")).toBe("4th Cir.");
    expect(courtLabel("ca1")).toBe("1st Cir.");
    expect(courtLabel("ca11")).toBe("11th Cir.");
    expect(courtLabel("cadc")).toBe("D.C. Cir.");
    expect(courtLabel("cafc")).toBe("Fed. Cir.");
    expect(courtLabel("scotus")).toBe("U.S. Supreme Court");
    expect(courtLabel("ca12")).toBeNull();
    expect(courtLabel("nysb")).toBeNull(); // bankruptcy court: not mapped
    expect(courtLabel("xyz")).toBeNull();
  });

  it("maps the pool's court names (real pool spellings) to CourtListener ids", () => {
    expect(courtIdFromName("N.D. Cal.")).toBe("cand");
    expect(courtIdFromName("W.D. Wash.")).toBe("wawd");
    expect(courtIdFromName("C.D. Cal.")).toBe("cacd");
    expect(courtIdFromName("S.D.N.Y.")).toBe("nysd");
    expect(courtIdFromName("E.D. Tex.")).toBe("txed");
    expect(courtIdFromName("D.N.J.")).toBe("njd");
    expect(courtIdFromName("W.D. Okla.")).toBe("okwd");
    expect(courtIdFromName("S.D. Fla.")).toBe("flsd");
    expect(courtIdFromName("E.D.N.Y.")).toBe("nyed");
    expect(courtIdFromName("N.D. Tex.")).toBe("txnd");
    expect(courtIdFromName("Fed. Cir.")).toBe("cafc");
    expect(courtIdFromName("D.C. Cir.")).toBe("cadc");
    expect(courtIdFromName("D.C. Cir. (en banc)")).toBe("cadc");
    expect(courtIdFromName("4th Cir.")).toBe("ca4");
    expect(courtIdFromName("U.S. Supreme Court")).toBe("scotus");
  });

  it("understands spacing variants, long names and raw ids", () => {
    expect(courtIdFromName("SDNY")).toBe("nysd");
    expect(courtIdFromName("S.D. N.Y.")).toBe("nysd");
    expect(courtIdFromName("D.D.C.")).toBe("dcd");
    expect(courtIdFromName("2nd Cir.")).toBe("ca2");
    expect(courtIdFromName("Second Circuit")).toBe("ca2");
    expect(courtIdFromName("Court of Appeals for the Ninth Circuit")).toBe("ca9");
    expect(courtIdFromName("Federal Circuit")).toBe("cafc");
    expect(courtIdFromName("Southern District of New York")).toBe("nysd");
    expect(courtIdFromName("U.S. District Court for the District of New Jersey")).toBe("njd");
    expect(courtIdFromName("District of Columbia")).toBe("dcd");
    expect(courtIdFromName("District Court, S.D. New York")).toBe("nysd");
    expect(courtIdFromName("District Court, D. New Jersey")).toBe("njd");
    expect(courtIdFromName("nysd")).toBe("nysd");
    expect(courtIdFromName("cadc")).toBe("cadc");
    expect(courtIdFromName("Superior Court of Example County")).toBeNull();
    expect(courtIdFromName("")).toBeNull();
    expect(courtIdFromName(null)).toBeNull();
  });

  it("round-trips every generated label", () => {
    for (const id of ["nysd", "cand", "dcd", "njd", "mdd", "wvnd", "ca3", "ca9", "cadc", "cafc", "scotus", "prd", "gud"]) {
      expect(courtIdFromName(courtLabel(id))).toBe(id);
    }
  });

  it("parses the optional court field of the search forms", () => {
    expect(parseCourtInput("")).toEqual({ ok: true, courtId: undefined });
    expect(parseCourtInput("  S.D.N.Y. ")).toEqual({ ok: true, courtId: "nysd" });
    expect(parseCourtInput("nysb")).toEqual({ ok: true, courtId: "nysb" }); // unknown id passed through
    expect(parseCourtInput("Superior Court of Example County").ok).toBe(false);
  });

  it("recognizes courts of appeals", () => {
    expect(isCircuitCourt("ca2")).toBe(true);
    expect(isCircuitCourt("ca11")).toBe(true);
    expect(isCircuitCourt("cadc")).toBe(true);
    expect(isCircuitCourt("cafc")).toBe(true);
    expect(isCircuitCourt("cand")).toBe(false);
    expect(isCircuitCourt("cacd")).toBe(false);
    expect(isCircuitCourt(null)).toBe(false);
  });
});

describe("docket numbers", () => {
  it("reads the type code", () => {
    expect(docketTypeCode("1:24-cv-03973")).toBe("cv");
    expect(docketTypeCode("5:24-cr-00314-J")).toBe("cr");
    expect(docketTypeCode("26 Cr. 29 (AT)")).toBe("cr");
    expect(docketTypeCode("18-CR-457 (AMD) (JAM)")).toBe("cr");
    expect(docketTypeCode("1:21-md-03010")).toBe("md");
    expect(docketTypeCode("25-5091")).toBeNull();
    expect(docketTypeCode(null)).toBeNull();
  });

  it("guesses the case type (cv → civil, cr → criminal, circuit → appeal)", () => {
    expect(guessCaseType("1:24-cv-03973", "nysd")).toBe("civil");
    expect(guessCaseType("1:21-md-03010", "nysd")).toBe("civil");
    expect(guessCaseType("1:25-cr-00503", "nysd")).toBe("criminal");
    expect(guessCaseType("1:25-mj-01234", "nysd")).toBe("criminal");
    expect(guessCaseType("25-5091", "cadc")).toBe("appeal");
    expect(guessCaseType("25-1892", "ca4")).toBe("appeal");
    expect(guessCaseType("1:24-cv-01", "ca2")).toBe("appeal"); // the court wins
    expect(guessCaseType("25-159", "scotus")).toBe("supreme_court");
    expect(guessCaseType("1:24-bk-10001", "nysb")).toBe("other");
    expect(guessCaseType("", "nysd")).toBe("civil");
    expect(guessCaseType(null, null)).toBe("civil");
  });

  it("normalizes docket numbers written different ways to the same key", () => {
    expect(docketKey("1:25-cr-00577")).toBe("25-cr-577");
    expect(docketKey("1:25-cr-577")).toBe("25-cr-577");
    expect(docketKey("1:25-cr-00577-KPF")).toBe("25-cr-577");
    expect(docketKey("25 Cr. 577 (AT)")).toBe("25-cr-577");
    expect(docketKey("18-CR-457 (AMD) (JAM)")).toBe("18-cr-457");
    expect(docketKey("1:18-cr-00457")).toBe("18-cr-457");
    expect(docketKey("2:24-CR-456")).toBe("24-cr-456");
    expect(docketKey("1:24-cv-03973")).toBe("24-cv-3973");
    expect(docketKey("25-5091")).toBe("25-5091");
    expect(docketKey("25-05091")).toBe("25-5091");
    expect(docketKey("1:24-cv-03973")).not.toBe(docketKey("1:24-cr-03973"));
    expect(docketKey("")).toBeNull();
    expect(docketKey(null)).toBeNull();
  });

  it("cleans a docket number for the search box (CM/ECF form for district dockets)", () => {
    expect(cleanDocketForSearch("5:24-cr-00314-J")).toBe("5:24-cr-00314");
    expect(cleanDocketForSearch("1:25-cr-00346-KAM")).toBe("1:25-cr-00346");
    expect(cleanDocketForSearch("1:25-cr-20500-DPG")).toBe("1:25-cr-20500");
    expect(cleanDocketForSearch("1:24-cv-03973")).toBe("1:24-cv-03973");
    expect(cleanDocketForSearch("1:25-cr-577")).toBe("1:25-cr-00577");
    expect(cleanDocketForSearch("18-CR-457 (AMD) (JAM)")).toBe("18-cr-00457");
    expect(cleanDocketForSearch("26 Cr. 29 (AT)")).toBe("26-cr-00029");
    expect(cleanDocketForSearch("2:24-CR-456")).toBe("2:24-cr-00456");
    // Appellate / Supreme Court numbers stay as they are; stray judge initials are dropped.
    expect(cleanDocketForSearch("25-5091")).toBe("25-5091");
    expect(cleanDocketForSearch("25-3-YGR")).toBe("25-3");
    expect(cleanDocketForSearch(null)).toBe("");
  });

  it("reads a leading state-court style type code", () => {
    expect(docketTypeCode("CR-26-004399")).toBe("cr");
    expect(guessCaseType("CR-26-004399", null)).toBe("criminal");
  });
});

describe("findPoolMatch", () => {
  const pool = [
    { id: "a", caption: "United States v. Live Nation", caseType: "civil" as const, court: "S.D.N.Y.", docketNumber: "1:24-cv-03973", courtlistenerDocketId: null },
    { id: "b", caption: "United States v. Chu", caseType: "criminal" as const, court: "S.D.N.Y.", docketNumber: "1:25-cr-577", courtlistenerDocketId: null },
    { id: "c", caption: "Linked case", caseType: "civil" as const, court: "N.D. Cal.", docketNumber: "4:20-cv-05640", courtlistenerDocketId: 777 },
    { id: "d", caption: "Odd court", caseType: "civil" as const, court: "Example Court", docketNumber: "1:22-cv-00001", courtlistenerDocketId: null },
  ];

  it("prefers the case already linked to the docket", () => {
    expect(findPoolMatch({ docketId: 777, docketNumber: "9:99-cv-99999", courtId: "cand" }, pool)).toEqual({
      id: "c",
      caption: "Linked case",
      caseType: "civil",
      linkedDocketId: 777,
    });
  });

  it("matches the docket number in the same court", () => {
    expect(findPoolMatch({ docketId: 1, docketNumber: "1:25-cr-00577", courtId: "nysd" }, pool)?.id).toBe("b");
    expect(findPoolMatch({ docketId: 1, docketNumber: "1:24-cv-03973", courtId: "nysd" }, pool)?.linkedDocketId).toBeNull();
  });

  it("doesn't match the same number in a different court", () => {
    expect(findPoolMatch({ docketId: 1, docketNumber: "1:25-cr-00577", courtId: "nyed" }, pool)).toBeNull();
  });

  it("matches by number alone when the pool court can't be mapped", () => {
    expect(findPoolMatch({ docketId: 1, docketNumber: "1:22-cv-00001", courtId: "txed" }, pool)?.id).toBe("d");
  });

  it("returns null for an unknown docket", () => {
    expect(findPoolMatch({ docketId: 2, docketNumber: "1:26-cv-00042", courtId: "nysd" }, pool)).toBeNull();
    expect(findPoolMatch({ docketId: 2, docketNumber: "", courtId: "nysd" }, pool)).toBeNull();
  });
});

describe("names", () => {
  it("matches every word of the query as a word prefix", () => {
    expect(nameMatches("Jane A. Doe", "Jane Doe")).toBe(true);
    expect(nameMatches("Doe, Jane", "jane doe")).toBe(true);
    expect(nameMatches("Kirkland & Ellis LLP", "Kirkland & Ellis")).toBe(true);
    expect(nameMatches("Kirkland & Ellis LLP", "kirk")).toBe(true);
    expect(nameMatches("José Núñez", "jose nunez")).toBe(true);
    expect(nameMatches("John Doe", "Jane Doe")).toBe(false);
    expect(nameMatches("John Doe", "")).toBe(false);
  });

  it("puts matched names first and drops duplicates", () => {
    expect(matchNames(["Alan Smith", "Jane Doe", "Bea Jones", "jane  doe"], "doe")).toEqual([
      { name: "Jane Doe", matched: true },
      { name: "Alan Smith", matched: false },
      { name: "Bea Jones", matched: false },
    ]);
    expect(matchNames(["A", "B"], "")).toEqual([
      { name: "A", matched: false },
      { name: "B", matched: false },
    ]);
  });

  it("compares firm names without punctuation, “and” or entity suffixes", () => {
    expect(firmKey("Cravath, Swaine & Moore LLP")).toBe("cravath swaine moore");
    expect(firmKey("Cravath, Swaine and Moore")).toBe("cravath swaine moore");
    expect(firmKey("Ifrah Law PLLC")).toBe("ifrah law");
    expect(firmKey("Smith & Jones, P.C.")).toBe("smith jones");
    expect(firmKey("Wachtell, Lipton, Rosen & Katz")).toBe("wachtell lipton rosen katz");
    expect(firmKey("LLP")).toBe("llp"); // never empties the name
    expect(firmKey("Kirkland & Ellis LLP")).not.toBe(firmKey("Kirkland & Partners LLP"));
  });

  it("previews long lists", () => {
    expect(listWithMore(["A", "B"])).toBe("A, B");
    expect(listWithMore(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });

  it("guesses a new lawyer's position from the case", () => {
    expect(guessPosition("appeal")).toBe("appellate");
    expect(guessPosition("supreme_court")).toBe("appellate");
    expect(guessPosition("civil")).toBe("trial");
    expect(guessPosition("criminal")).toBe("");
    expect(guessPosition("criminal", "plaintiff")).toBe("prosecutor");
    expect(guessPosition("criminal", "defendant")).toBe("defense");
  });
});

describe("messages", () => {
  it("explains CourtListener's rate limit with the wait time", () => {
    expect(courtErrorMessage(new FakeClError("Too many", 429, 120))).toBe("CourtListener's free limit was reached — try again in 2 minutes.");
    expect(courtErrorMessage(new FakeClError("Too many", 429, 30))).toBe("CourtListener's free limit was reached — try again in 1 minute.");
    expect(courtErrorMessage(new FakeClError("Too many", 429, 4 * 3600))).toBe("CourtListener's free limit was reached — try again in about 4 hours.");
    expect(courtErrorMessage(new FakeClError("Too many", 429))).toBe("CourtListener's free limit was reached — try again later.");
  });

  it("never echoes the raw error text", () => {
    const secret = "Token abc123 was rejected";
    for (const status of [400, 401, 403, 404, 418, 500, 501, 503]) {
      const msg = courtErrorMessage(new FakeClError(secret, status));
      expect(msg).toBeTruthy();
      expect(msg).not.toContain("abc123");
    }
    expect(courtErrorMessage(new FakeClError(secret, 401))).toContain("COURTLISTENER_TOKEN");
  });

  it("ignores errors that aren't from the CourtListener client", () => {
    expect(courtErrorMessage(new Error("boom"))).toBeNull();
    expect(courtErrorMessage("boom")).toBeNull();
    expect(courtErrorMessage(null)).toBeNull();
  });

  it("formats waits and sync results", () => {
    expect(retryWait(undefined)).toBeNull();
    expect(retryWait(0)).toBeNull();
    expect(retryWait(61)).toBe("in 2 minutes");
    expect(syncResultMessage({ newEntries: 3, suggestions: 2 })).toBe("3 new filings, 2 suggestions added.");
    expect(syncResultMessage({ newEntries: 1, suggestions: 1 })).toBe("1 new filing, 1 suggestion added.");
    expect(syncResultMessage({ newEntries: 0, suggestions: 0 })).toBe("0 new filings, 0 suggestions added.");
  });
});

describe("courtStats", () => {
  const at = (iso: string) => new Date(iso);
  const row = (over: Partial<CourtCaseRow>): CourtCaseRow => ({
    id: "x",
    caption: "Case",
    caseType: "civil",
    status: "active",
    court: "S.D.N.Y.",
    docketNumber: null,
    courtlistenerDocketId: null,
    syncedAt: null,
    syncError: null,
    ...over,
  });
  const rows = [
    row({ id: "s1", caseType: "supreme_court", docketNumber: "25-159", syncedAt: at("2026-11-13T09:17:00Z") }),
    row({ id: "s2", caseType: "supreme_court", docketNumber: "No. 25 159" }),
    row({ id: "l1", courtlistenerDocketId: 1, syncedAt: at("2026-11-14T09:17:00Z"), syncError: "CourtListener's free limit was reached." }),
    row({ id: "l2", courtlistenerDocketId: 2, status: "closed", syncedAt: at("2026-11-14T10:00:00Z"), syncError: "old" }),
    row({ id: "u1" }),
    row({ id: "u2", caseType: "criminal" }),
    row({ id: "u3", status: "closed" }),
  ];
  const source = (c: CourtCaseRow) =>
    c.caseType === "supreme_court" && /^\d{2}-\d+$/.test(c.docketNumber ?? "") ? ("scotus" as const) : c.courtlistenerDocketId ? ("courtlistener" as const) : null;

  it("counts active cases by source and collects errors", () => {
    const s = courtStats(rows, source);
    expect(s.scotusTracked).toBe(1);
    expect(s.scotusNeedsDocket).toBe(1);
    expect(s.linked).toBe(1);
    expect(s.unlinked).toBe(2);
    expect(s.errors.map((e) => e.id)).toEqual(["l1"]);
    // Last sync looks at every case, closed included.
    expect(s.lastSyncedAt?.toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });

  it("handles an empty pool", () => {
    expect(courtStats([], source)).toEqual({ scotusTracked: 0, scotusNeedsDocket: 0, linked: 0, unlinked: 0, lastSyncedAt: null, errors: [] });
  });
});
