/**
 * Court-data Server Actions with auth, DB, CourtListener and the sync service
 * mocked (no network, no database).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { rows: [] as unknown[] };
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) q[m] = () => q;
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(state.rows).then(res, rej);
    return q;
  };
  const db: Record<string, unknown> = { select: () => chain() };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { state, db };
});

vi.mock("@/db", () => ({ db: h.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/league-context", () => ({
  actionLeagueContext: vi.fn(async () => ({ user: { id: "u1", isAdmin: false }, league: { poolId: "pool-1" } })),
  canManagePool: vi.fn(async () => true),
}));
vi.mock("@/server/court/courtlistener", async (orig) => ({
  ...(await orig<typeof import("@/server/court/courtlistener")>()),
  courtListenerConfigured: vi.fn(() => true),
  searchDockets: vi.fn(),
  checkConnection: vi.fn(),
}));
vi.mock("@/server/services/court-sync", () => ({
  syncCase: vi.fn(),
  syncSourceForCase: vi.fn(() => null),
  scotusDocketFromCase: vi.fn(() => null),
  linkCaseToDocket: vi.fn(async () => undefined),
  autoLinkPoolCases: vi.fn(),
}));
vi.mock("@/server/services/pool", () => ({
  getPoolCase: vi.fn(),
  createCase: vi.fn(),
  createFirm: vi.fn(),
  createLawyer: vi.fn(),
  addAppearance: vi.fn(),
}));
vi.mock("@/app/leagues/[leagueId]/commish/court/court-data", () => ({ loadCourtCases: vi.fn(async () => []) }));

import * as cl from "@/server/court/courtlistener";
import * as sync from "@/server/services/court-sync";
import * as pool from "@/server/services/pool";
import { loadCourtCases } from "@/app/leagues/[leagueId]/commish/court/court-data";
import {
  addCaseFromDocketAction,
  addLawyerToCaseAction,
  autoLinkAction,
  findCaseDocketsAction,
  linkDocketAction,
  searchCourtAction,
  syncCaseAction,
  testConnectionAction,
  unlinkDocketAction,
} from "@/app/leagues/[leagueId]/commish/court/actions";
import { CONNECT_MESSAGE } from "@/app/leagues/[leagueId]/commish/court/court-rules";

const LEAGUE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LAWYER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FIRM = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

const docket: cl.ClDocket = {
  docketId: 68571705,
  caseName: "United States v. Live Nation Entertainment, Inc.",
  docketNumber: "1:24-cv-03973",
  court: "District Court, S.D. New York",
  courtId: "nysd",
  dateFiled: "2024-05-23",
  dateTerminated: null,
  url: "https://www.courtlistener.com/docket/68571705/united-states-v-live-nation-entertainment-inc/",
  attorneys: ["Jane Q. Doe"],
  firms: ["Example LLP"],
  parties: ["United States", "Live Nation Entertainment, Inc."],
};

const poolCase = {
  id: CASE,
  poolId: "pool-1",
  caption: "Doe v. Example Corp.",
  court: "S.D.N.Y.",
  docketNumber: "1:24-cv-03973",
  caseType: "civil" as const,
  status: "active" as const,
  filedOn: null,
  sourceUrl: null,
  courtlistenerDocketId: null as number | null,
  syncedAt: null as Date | null,
  syncCursor: null,
  syncError: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rows = [];
  vi.mocked(cl.courtListenerConfigured).mockReturnValue(true);
  vi.mocked(sync.syncSourceForCase).mockReturnValue(null);
  vi.mocked(pool.getPoolCase).mockResolvedValue({ ...poolCase });
});

describe("searchCourtAction", () => {
  it("shows the connect notice and makes no request when the token is missing", async () => {
    vi.mocked(cl.courtListenerConfigured).mockReturnValue(false);
    const r = await searchCourtAction(LEAGUE, null, form({ mode: "attorney", name: "Jane Doe", court: "" }));
    expect(r).toEqual({ ok: false, error: CONNECT_MESSAGE });
    expect(cl.searchDockets).not.toHaveBeenCalled();
  });

  it("searches by attorney with the mapped court id and marks pool matches", async () => {
    vi.mocked(cl.searchDockets).mockResolvedValue([{ ...docket, raw: { secret: "x" } } as cl.ClDocket]);
    vi.mocked(loadCourtCases).mockResolvedValue([
      { id: CASE, caption: "US v. Live Nation", caseType: "civil", status: "active", court: "S.D.N.Y.", docketNumber: "1:24-cv-3973", courtlistenerDocketId: null, syncedAt: null, syncError: null },
    ]);
    const r = await searchCourtAction(LEAGUE, null, form({ mode: "attorney", name: "  Jane Doe ", court: "S.D.N.Y." }));
    expect(cl.searchDockets).toHaveBeenCalledWith({ attorney: "Jane Doe", courtId: "nysd" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.results[0].poolCase).toEqual({ id: CASE, caption: "US v. Live Nation", caseType: "civil", linkedDocketId: null });
    expect(r.data?.results[0].docket).not.toHaveProperty("raw"); // only documented fields go to the browser
  });

  it("searches by firm", async () => {
    vi.mocked(cl.searchDockets).mockResolvedValue([]);
    const r = await searchCourtAction(LEAGUE, null, form({ mode: "firm", name: "Example LLP", court: "" }));
    expect(cl.searchDockets).toHaveBeenCalledWith({ firm: "Example LLP", courtId: undefined });
    expect(r).toEqual({ ok: true, message: undefined, data: { mode: "firm", name: "Example LLP", results: [] } });
  });

  it("turns a 429 into a friendly message with the wait time", async () => {
    vi.mocked(cl.searchDockets).mockRejectedValue(new cl.CourtListenerError("Request was throttled. Token abc123", 429, 300));
    const r = await searchCourtAction(LEAGUE, null, form({ mode: "attorney", name: "Jane Doe", court: "" }));
    expect(r).toEqual({ ok: false, error: "CourtListener's free limit was reached — try again in 5 minutes." });
  });

  it("hides unexpected errors behind a generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(cl.searchDockets).mockRejectedValue(new Error("connect ECONNREFUSED with Token abc123"));
    const r = await searchCourtAction(LEAGUE, null, form({ mode: "attorney", name: "Jane Doe", court: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("abc123");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("validates the form before calling CourtListener", async () => {
    expect((await searchCourtAction(LEAGUE, null, form({ mode: "attorney", name: "J", court: "" }))).ok).toBe(false);
    expect((await searchCourtAction(LEAGUE, null, form({ mode: "judge", name: "Jane Doe", court: "" }))).ok).toBe(false);
    expect((await searchCourtAction(LEAGUE, null, form({ mode: "attorney", name: "Jane Doe", court: "Superior Court of Example" }))).ok).toBe(false);
    expect(cl.searchDockets).not.toHaveBeenCalled();
  });
});

describe("findCaseDocketsAction", () => {
  it("passes the fields through and flags dockets already linked in the pool", async () => {
    vi.mocked(cl.searchDockets).mockResolvedValue([docket]);
    h.state.rows = [{ id: "other", caption: "Other case", docketId: docket.docketId }];
    const r = await findCaseDocketsAction(LEAGUE, CASE, null, form({ docketNumber: "1:24-cv-03973", caseName: "Live Nation", court: "nysd" }));
    expect(cl.searchDockets).toHaveBeenCalledWith({ docketNumber: "1:24-cv-03973", caseName: "Live Nation", courtId: "nysd" });
    expect(r.ok && r.data).toEqual({ results: [{ docket, linkedTo: { id: "other", caption: "Other case" } }], bothFields: true });
  });

  it("needs a docket number or caption words", async () => {
    const r = await findCaseDocketsAction(LEAGUE, CASE, null, form({ docketNumber: "", caseName: "ab", court: "" }));
    expect(r.ok).toBe(false);
    expect(cl.searchDockets).not.toHaveBeenCalled();
  });
});

describe("syncCaseAction", () => {
  it("syncs Supreme Court cases without a CourtListener token", async () => {
    vi.mocked(cl.courtListenerConfigured).mockReturnValue(false);
    vi.mocked(sync.syncSourceForCase).mockReturnValue("scotus");
    vi.mocked(sync.syncCase).mockResolvedValue({ caseId: CASE, caption: "X", source: "scotus", newEntries: 3, suggestions: 2 });
    const r = await syncCaseAction(LEAGUE, CASE);
    expect(r).toEqual({ ok: true, message: "3 new filings, 2 suggestions added.", data: { newEntries: 3, suggestions: 2, error: null } });
  });

  it("requires a linked docket, a token and a short cooldown for CourtListener cases", async () => {
    expect(await syncCaseAction(LEAGUE, CASE)).toMatchObject({ ok: false });
    vi.mocked(pool.getPoolCase).mockResolvedValue({ ...poolCase, courtlistenerDocketId: 5 });
    vi.mocked(cl.courtListenerConfigured).mockReturnValue(false);
    expect(await syncCaseAction(LEAGUE, CASE)).toEqual({ ok: false, error: CONNECT_MESSAGE });
    vi.mocked(cl.courtListenerConfigured).mockReturnValue(true);
    vi.mocked(pool.getPoolCase).mockResolvedValue({ ...poolCase, courtlistenerDocketId: 5, syncedAt: new Date(Date.now() - 5_000) });
    const r = await syncCaseAction(LEAGUE, CASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("less than a minute ago");
    expect(sync.syncCase).not.toHaveBeenCalled();
  });

  it("reports a sync that failed without finding anything", async () => {
    vi.mocked(pool.getPoolCase).mockResolvedValue({ ...poolCase, courtlistenerDocketId: 5 });
    vi.mocked(sync.syncCase).mockResolvedValue({
      caseId: CASE,
      caption: "X",
      source: "courtlistener",
      newEntries: 0,
      suggestions: 0,
      error: "CourtListener's free limit was reached.",
    });
    expect(await syncCaseAction(LEAGUE, CASE)).toEqual({ ok: false, error: "Sync didn't finish: CourtListener's free limit was reached." });
  });
});

describe("linking", () => {
  it("refuses a docket that another pool case already uses", async () => {
    h.state.rows = [{ caption: "Other case" }];
    const r = await linkDocketAction(LEAGUE, null, form({ caseId: CASE, docketId: 42 }));
    expect(r).toEqual({ ok: false, error: "That docket is already linked to Other case." });
    expect(sync.linkCaseToDocket).not.toHaveBeenCalled();
  });

  it("links and unlinks", async () => {
    expect((await linkDocketAction(LEAGUE, null, form({ caseId: CASE, docketId: 42 }))).ok).toBe(true);
    expect(sync.linkCaseToDocket).toHaveBeenLastCalledWith(h.db, "pool-1", CASE, 42);
    vi.mocked(pool.getPoolCase).mockResolvedValue({ ...poolCase, courtlistenerDocketId: 42 });
    expect((await unlinkDocketAction(LEAGUE, CASE)).ok).toBe(true);
    expect(sync.linkCaseToDocket).toHaveBeenLastCalledWith(h.db, "pool-1", CASE, null);
  });

  it("rejects malformed ids", async () => {
    expect((await linkDocketAction(LEAGUE, null, form({ caseId: "nope", docketId: 42 }))).ok).toBe(false);
    expect((await linkDocketAction(LEAGUE, null, form({ caseId: CASE, docketId: "abc" }))).ok).toBe(false);
    expect((await linkDocketAction("not-a-league", null, form({ caseId: CASE, docketId: 42 }))).ok).toBe(false);
  });
});

describe("autoLinkAction", () => {
  it("summarizes linked / not found / remaining with case captions", async () => {
    vi.mocked(sync.autoLinkPoolCases).mockResolvedValue({ linked: [{ caseId: CASE, docketId: 1 }], notFound: [LAWYER], remaining: 4 });
    h.state.rows = [{ id: LAWYER, caption: "Missing v. Case" }];
    const r = await autoLinkAction(LEAGUE);
    expect(sync.autoLinkPoolCases).toHaveBeenCalledWith(h.db, "pool-1", { max: 10 });
    expect(r).toEqual({ ok: true, message: "Linked 1 case. Not found on CourtListener: Missing v. Case. 4 cases still to check.", data: undefined });
  });
});

describe("addCaseFromDocketAction", () => {
  const fields = {
    docketId: docket.docketId,
    caseName: docket.caseName,
    docketNumber: docket.docketNumber,
    courtId: "nysd",
    courtName: docket.court,
    dateFiled: "2024-05-23",
    dateTerminated: "",
    url: docket.url,
    caseType: "civil",
  };

  it("creates the case with the pool's court style and links it", async () => {
    vi.mocked(pool.createCase).mockImplementation(async (_db, _poolId, input) => ({ ...poolCase, ...input, id: CASE }));
    const r = await addCaseFromDocketAction(LEAGUE, null, form(fields));
    expect(pool.createCase).toHaveBeenCalledWith(h.db, "pool-1", {
      caption: docket.caseName,
      court: "S.D.N.Y.",
      docketNumber: "1:24-cv-03973",
      caseType: "civil",
      status: "active",
      filedOn: "2024-05-23",
      sourceUrl: docket.url,
    });
    expect(sync.linkCaseToDocket).toHaveBeenCalledWith(h.db, "pool-1", CASE, docket.docketId);
    expect(r.ok && r.data).toEqual({ id: CASE, caption: docket.caseName, caseType: "civil", linkedDocketId: docket.docketId });
  });

  it("marks terminated dockets closed and never stores a non-CourtListener URL", async () => {
    vi.mocked(pool.createCase).mockImplementation(async (_db, _poolId, input) => ({ ...poolCase, ...input, id: CASE }));
    await addCaseFromDocketAction(LEAGUE, null, form({ ...fields, dateTerminated: "2025-01-02", url: "https://evil.example/x" }));
    expect(vi.mocked(pool.createCase).mock.calls[0][2]).toMatchObject({
      status: "closed",
      sourceUrl: "https://www.courtlistener.com/docket/68571705/",
    });
  });

  it("doesn't add a docket that's already linked", async () => {
    h.state.rows = [{ caption: "Already here" }];
    const r = await addCaseFromDocketAction(LEAGUE, null, form(fields));
    expect(r).toEqual({ ok: false, error: "That docket is already linked to Already here." });
    expect(pool.createCase).not.toHaveBeenCalled();
  });
});

describe("addLawyerToCaseAction", () => {
  it("adds an existing pool lawyer", async () => {
    vi.mocked(pool.addAppearance).mockResolvedValue({ lawyerName: "Jane Doe" });
    const r = await addLawyerToCaseAction(LEAGUE, null, form({ caseId: CASE, who: LAWYER, name: "", position: "", firmChoice: "", newFirmName: "", side: "plaintiff" }));
    expect(pool.addAppearance).toHaveBeenCalledWith(h.db, "pool-1", { caseId: CASE, lawyerId: LAWYER, side: "plaintiff" });
    expect(r).toMatchObject({ ok: true, message: "Added Jane Doe to Doe v. Example Corp. (Plaintiff)." });
  });

  it("creates a new lawyer with a new firm, then adds them", async () => {
    vi.mocked(pool.createFirm).mockResolvedValue({ id: FIRM } as never);
    vi.mocked(pool.createLawyer).mockResolvedValue({ id: LAWYER } as never);
    vi.mocked(pool.addAppearance).mockResolvedValue({ lawyerName: "Jane Q. Doe" });
    const r = await addLawyerToCaseAction(
      LEAGUE,
      null,
      form({ caseId: CASE, who: "new-lawyer", name: " Jane  Q. Doe ", position: "trial", firmChoice: "new", newFirmName: "Example LLP", side: "defendant" }),
    );
    expect(pool.createFirm).toHaveBeenCalledWith(h.db, "pool-1", { name: "Example LLP", organization: null, preseasonRank: null });
    expect(pool.createLawyer).toHaveBeenCalledWith(h.db, "pool-1", {
      name: "Jane Q. Doe",
      position: "trial",
      firmId: FIRM,
      organization: null,
      preseasonRank: null,
    });
    expect(pool.addAppearance).toHaveBeenCalledWith(h.db, "pool-1", { caseId: CASE, lawyerId: LAWYER, side: "defendant" });
    expect(r.ok).toBe(true);
  });

  it("creates a new firm", async () => {
    vi.mocked(pool.createFirm).mockResolvedValue({ id: FIRM } as never);
    vi.mocked(pool.addAppearance).mockResolvedValue({ lawyerName: "Example LLP" });
    await addLawyerToCaseAction(LEAGUE, null, form({ caseId: CASE, who: "new-firm", name: "Example LLP", position: "", firmChoice: "", newFirmName: "", side: "plaintiff" }));
    expect(pool.createFirm).toHaveBeenCalledWith(h.db, "pool-1", { name: "Example LLP", organization: null, preseasonRank: null });
    expect(pool.createLawyer).not.toHaveBeenCalled();
  });

  it("validates side, position and names", async () => {
    const base = { caseId: CASE, who: "new-lawyer", name: "Jane Doe", position: "trial", firmChoice: "", newFirmName: "", side: "plaintiff" };
    expect(await addLawyerToCaseAction(LEAGUE, null, form({ ...base, side: "" }))).toEqual({ ok: false, error: "Pick a side." });
    expect(await addLawyerToCaseAction(LEAGUE, null, form({ ...base, position: "firm" }))).toEqual({ ok: false, error: "Pick a position." });
    expect(await addLawyerToCaseAction(LEAGUE, null, form({ ...base, name: "J" }))).toEqual({ ok: false, error: "Enter the lawyer's name." });
    expect(await addLawyerToCaseAction(LEAGUE, null, form({ ...base, firmChoice: "new" }))).toEqual({ ok: false, error: "Enter the new firm's name." });
    expect(pool.addAppearance).not.toHaveBeenCalled();
  });
});

describe("testConnectionAction", () => {
  it("reports the check result, or the connect notice without a token", async () => {
    vi.mocked(cl.checkConnection).mockResolvedValue({ ok: true, detail: "Connected. 40 of 125 requests used today." });
    expect(await testConnectionAction(LEAGUE)).toMatchObject({ ok: true, message: "Connected. 40 of 125 requests used today." });
    vi.mocked(cl.checkConnection).mockResolvedValue({ ok: false, detail: "Token rejected." });
    expect(await testConnectionAction(LEAGUE)).toEqual({ ok: false, error: "Token rejected." });
    vi.mocked(cl.courtListenerConfigured).mockReturnValue(false);
    expect(await testConnectionAction(LEAGUE)).toEqual({ ok: false, error: CONNECT_MESSAGE });
  });
});
