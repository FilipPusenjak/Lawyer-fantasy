import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSearchQ,
  checkConnection,
  CourtListenerError,
  courtListenerConfigured,
  docketPageUrl,
  docketUrlFromDocumentUrl,
  fetchDocketEntries,
  getDocket,
  listDocketEntries,
  parseRetryAfter,
  searchDockets,
} from "@/server/court/courtlistener";

const TOKEN = "test-token-abc123";
const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/court", name), "utf8"));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init: init as RequestInit }));

beforeEach(() => {
  vi.stubEnv("COURTLISTENER_TOKEN", TOKEN);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("configuration and auth", () => {
  it("reports whether the token is set", () => {
    expect(courtListenerConfigured()).toBe(true);
    vi.stubEnv("COURTLISTENER_TOKEN", "");
    expect(courtListenerConfigured()).toBe(false);
  });

  it("throws a friendly 401 without calling the API when the token is missing", async () => {
    vi.stubEnv("COURTLISTENER_TOKEN", "");
    const err = await searchDockets({ attorney: "Jane Roe" }).catch((e) => e);
    expect(err).toBeInstanceOf(CourtListenerError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/COURTLISTENER_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends Authorization: Token <key>", async () => {
    fetchMock.mockResolvedValueOnce(json(fixture("cl-docket.json")));
    await getDocket(68571705);
    const { url, init } = calls()[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Token ${TOKEN}`);
    expect(url.href.startsWith("https://www.courtlistener.com/api/rest/v4/dockets/68571705/")).toBe(true);
    expect(url.searchParams.get("fields")).toContain("absolute_url");
  });
});

describe("errors never include the token", () => {
  it("429 carries Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: `Request was throttled for ${TOKEN}. Expected available in 42 seconds.` }, 429, { "Retry-After": "42" }));
    const err = await searchDockets({ firm: "Latham" }).catch((e) => e);
    expect(err).toBeInstanceOf(CourtListenerError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(42);
    expect(err.message).toMatch(/limit/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("400 detail is scrubbed and trimmed", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: `Bad parameter near ${TOKEN}` }, 400));
    const err = await searchDockets({ caseName: "Apple v. Epic" }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toContain("HTTP 400");
    expect(err.message).not.toContain(TOKEN);
  });

  it("401/403 → token rejected; network failure → 503", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "Invalid token." }, 401));
    await expect(searchDockets({ attorney: "X" })).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/rejected/) });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(searchDockets({ attorney: "X" })).rejects.toMatchObject({ status: 503 });
  });

  it("parses Retry-After dates", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("Sat, 14 Nov 2026 12:05:00 GMT", now)).toBe(300);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
});

describe("searchDockets", () => {
  it("builds a fielded, quoted, escaped q", () => {
    expect(buildSearchQ({ attorney: 'Jane "JJ" Roe', courtId: "NYSD" })).toBe('attorney:"Jane \\"JJ\\" Roe" AND court_id:"nysd"');
    expect(buildSearchQ({ caseName: "Apple Inc. v. Epic Games, Inc." })).toBe('caseName:("Apple" AND "Epic" AND "Games")');
    expect(buildSearchQ({ docketNumber: "1:24-cv-03973", firm: "Latham & Watkins LLP" })).toBe('firm:"Latham & Watkins LLP" AND docketNumber:"1:24-cv-03973"');
    expect(buildSearchQ({})).toBe("");
  });

  it("makes one type=d request and maps results to ClDocket", async () => {
    fetchMock.mockResolvedValueOnce(json(fixture("cl-search-dockets.json")));
    const results = await searchDockets({ docketNumber: "1:24-cv-03973", courtId: "nysd" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url } = calls()[0];
    expect(url.pathname).toBe("/api/rest/v4/search/");
    expect(url.searchParams.get("type")).toBe("d");
    expect(url.searchParams.get("q")).toBe('docketNumber:"1:24-cv-03973" AND court_id:"nysd"');
    expect([...url.searchParams.keys()].sort()).toEqual(["q", "type"]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      docketId: 68571705,
      caseName: "United States v. Live Nation Entertainment, Inc.",
      docketNumber: "1:24-cv-03973",
      court: "District Court, S.D. New York",
      courtId: "nysd",
      dateFiled: "2024-05-23",
      dateTerminated: null,
      url: "https://www.courtlistener.com/docket/68571705/united-states-v-live-nation-entertainment-inc/",
      attorneys: ["Andrew M. Gass", "Brian Rabinovitz"],
      firms: ["Latham & Watkins LLP"],
      parties: ["United States of America", "Live Nation Entertainment, Inc.", "Ticketmaster L.L.C."],
      attorneyIds: [101, 202],
      firmIds: [303],
    });
    expect(results[1]).toMatchObject({ caseName: "Live Nation Merchandise v. Doe", attorneys: [], firms: [], parties: [], dateTerminated: "2025-06-30" });
  });

  it("refuses an empty search without spending a request", async () => {
    await expect(searchDockets({ caseName: "  v.  " })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getDocket", () => {
  it("maps the docket and returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(json(fixture("cl-docket.json")));
    expect(await getDocket(68571705)).toEqual({
      docketId: 68571705,
      caseName: "United States v. Live Nation Entertainment, Inc.",
      docketNumber: "1:24-cv-03973",
      court: "S.D.N.Y.",
      courtId: "nysd",
      dateFiled: "2024-05-23",
      dateTerminated: null,
      url: "https://www.courtlistener.com/docket/68571705/united-states-v-live-nation-entertainment-inc/",
      attorneys: [],
      firms: [],
      parties: [],
    });
    fetchMock.mockResolvedValueOnce(json({ detail: "No Docket matches the given query." }, 404));
    expect(await getDocket(1)).toBeNull();
    expect(await getDocket(-5)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("docket entries", () => {
  it("filters by docket and date_modified, follows next up to maxPages, maps entries", async () => {
    fetchMock.mockResolvedValueOnce(json(fixture("cl-docket-entries-page1.json"))).mockResolvedValueOnce(json(fixture("cl-docket-entries-page2.json")));
    const page = await fetchDocketEntries(68571705, { sinceIso: "2026-11-01T00:00:00+00:00", maxPages: 2 });
    expect(page.requests).toBe(2);
    expect(page.hasMore).toBe(true);
    const [first, second] = calls();
    expect(first.url.pathname).toBe("/api/rest/v4/docket-entries/");
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      docket: "68571705",
      order_by: "date_modified",
      omit: "recap_documents__plain_text",
      date_modified__gt: "2026-11-01T00:00:00+00:00",
    });
    // The `next` URL is followed exactly as given.
    expect(second.url.href).toBe(fixture("cl-docket-entries-page1.json").next);
    expect((second.init.headers as Record<string, string>).Authorization).toBe(`Token ${TOKEN}`);

    expect(page.entries.map((e) => [e.entryId, e.entryNumber, e.dateFiled, e.url])).toEqual([
      [400000001, 1601, "2026-11-02", "https://www.courtlistener.com/docket/68571705/united-states-v-live-nation-entertainment-inc/#entry-1601"],
      [400000002, 1602, "2026-11-04", "https://www.courtlistener.com/docket/68571705/united-states-v-live-nation-entertainment-inc/#entry-1602"],
      [400000003, null, "2026-11-09", "https://www.courtlistener.com/docket/68571705/docket/"],
      [400000004, 1603, "2026-11-10", "https://www.courtlistener.com/docket/68571705/docket/#entry-1603"],
    ]);
    expect(page.entries[0].description).toMatch(/^MEMORANDUM OF LAW in Opposition/);
    expect(page.entries[0].dateModified).toBe("2026-11-03T08:00:01.123456-08:00");
    expect(page.entries[2].description).toBe("");
  });

  it("a known docket URL is used for entry links; one page when maxPages is 1", async () => {
    fetchMock.mockResolvedValueOnce(json(fixture("cl-docket-entries-page2.json")));
    const page = await fetchDocketEntries(68571705, { sinceIso: null, maxPages: 1, docketUrl: "https://www.courtlistener.com/docket/68571705/us-v-live-nation/" });
    expect(page.requests).toBe(1);
    expect(calls()[0].url.searchParams.has("date_modified__gt")).toBe(false);
    expect(page.entries[1].url).toBe("https://www.courtlistener.com/docket/68571705/us-v-live-nation/#entry-1603");
    expect(page.entries[1].description).toMatch(/^Minute Entry/);
  });

  it("listDocketEntries (contract) returns just the entries", async () => {
    fetchMock.mockResolvedValueOnce(json({ ...fixture("cl-docket-entries-page2.json"), next: null }));
    const entries = await listDocketEntries(68571705, null);
    expect(entries).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never follows a next URL off the CourtListener API", async () => {
    fetchMock.mockResolvedValueOnce(json({ next: "https://evil.example.com/steal", results: [] }));
    await expect(fetchDocketEntries(1, { maxPages: 2 })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("docket URL helpers", () => {
    expect(docketUrlFromDocumentUrl(5, "/docket/5/12/acme-v-doe/")).toBe("https://www.courtlistener.com/docket/5/acme-v-doe/");
    expect(docketUrlFromDocumentUrl(5, "/docket/5/12/3/acme-v-doe/")).toBe("https://www.courtlistener.com/docket/5/acme-v-doe/");
    expect(docketUrlFromDocumentUrl(5, "/docket/6/12/acme-v-doe/")).toBeNull();
    expect(docketPageUrl(5, "Acme Corp. v. Doe")).toBe("https://www.courtlistener.com/docket/5/acme-corp-v-doe/");
  });
});

describe("checkConnection", () => {
  it("reports remaining main-API quota", async () => {
    fetchMock.mockResolvedValueOnce(json(fixture("cl-api-usage.json")));
    expect(await checkConnection()).toEqual({ ok: true, detail: "Connected. Requests left: 4 of 5 this minute, 47 of 50 this hour, 120 of 125 today." });
    expect(calls()[0].url.pathname).toBe("/api/rest/v4/api-usage/");
  });

  it("not connected / rejected token", async () => {
    vi.stubEnv("COURTLISTENER_TOKEN", "");
    expect(await checkConnection()).toMatchObject({ ok: false, detail: expect.stringMatching(/COURTLISTENER_TOKEN/) });
    vi.stubEnv("COURTLISTENER_TOKEN", TOKEN);
    fetchMock.mockResolvedValueOnce(json({ detail: "Invalid token." }, 401));
    const r = await checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(TOKEN);
  });
});
