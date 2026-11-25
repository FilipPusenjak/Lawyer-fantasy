import { describe, expect, it } from "vitest";
import type { ClDocket } from "@/server/court/courtlistener";
import { captionKeywords, matchingDockets, pickDocket, RateWindow, scotusDocketFromCase, syncSourceForCase } from "@/server/services/court-sync";

describe("sources", () => {
  it("scotusDocketFromCase", () => {
    expect(scotusDocketFromCase({ caseType: "supreme_court", docketNumber: "25-159" })).toBe("25-159");
    expect(scotusDocketFromCase({ caseType: "supreme_court", docketNumber: " No. 25-00459 " })).toBe("25-459");
    expect(scotusDocketFromCase({ caseType: "supreme_court", docketNumber: null })).toBeNull();
    expect(scotusDocketFromCase({ caseType: "appeal", docketNumber: "26-5028" })).toBeNull();
  });

  it("syncSourceForCase", () => {
    expect(syncSourceForCase({ caseType: "supreme_court", docketNumber: "25-159", courtlistenerDocketId: 7 })).toBe("scotus");
    expect(syncSourceForCase({ caseType: "civil", docketNumber: "1:24-cv-03973", courtlistenerDocketId: 68571705 })).toBe("courtlistener");
    expect(syncSourceForCase({ caseType: "supreme_court", docketNumber: "pending", courtlistenerDocketId: 9 })).toBe("courtlistener");
    expect(syncSourceForCase({ caseType: "civil", docketNumber: "1:24-cv-03973", courtlistenerDocketId: null })).toBeNull();
  });
});

describe("auto-link helpers", () => {
  const docket = (over: Partial<ClDocket>): ClDocket => ({
    docketId: 1,
    caseName: "",
    docketNumber: "",
    court: "",
    courtId: "",
    dateFiled: null,
    dateTerminated: null,
    url: "",
    attorneys: [],
    firms: [],
    parties: [],
    ...over,
  });

  it("captionKeywords skips the government and filler words", () => {
    expect(captionKeywords("United States v. Live Nation Entertainment, Inc.")).toBe("live nation");
    expect(captionKeywords("Federal Trade Commission v. Amazon.com, Inc.")).toBe("amazon");
    expect(captionKeywords("Epic Games, Inc. v. Apple Inc.")).toBe("epic games");
    expect(captionKeywords("In re Google Digital Advertising Antitrust Litigation")).toBe("google digital");
  });

  it("matchingDockets: same number, same court when known, no duplicates", () => {
    const results = [
      docket({ docketId: 1, docketNumber: "1:24-cv-03973", courtId: "nysd" }),
      docket({ docketId: 1, docketNumber: "1:24-cv-03973", courtId: "nysd" }),
      docket({ docketId: 2, docketNumber: "1:24-cv-03973", courtId: "cand" }),
      docket({ docketId: 3, docketNumber: "1:24-cv-03974", courtId: "nysd" }),
    ];
    expect(matchingDockets({ docketNumber: "1:24-cv-03973", court: "S.D.N.Y." }, results).map((d) => d.docketId)).toEqual([1]);
    expect(matchingDockets({ docketNumber: "24-cv-3973", court: "Somewhere" }, results).map((d) => d.docketId)).toEqual([1, 2]);
  });

  it("pickDocket: one docket per defendant → the caption's defendant; duplicates of one case → the earliest; otherwise none", () => {
    const perDefendant = [
      docket({ docketId: 11, caseName: "USA v. Rozier", dateFiled: "2025-07-01" }),
      docket({ docketId: 10, caseName: "United States v. Earnest", dateFiled: "2025-07-01" }),
      docket({ docketId: 12, caseName: "USA v. Laster", dateFiled: "2025-07-01" }),
    ];
    expect(pickDocket("United States v. Earnest et al.", perDefendant)?.docketId).toBe(10);
    const dupes = [
      docket({ docketId: 21, caseName: "In re: Google Digital Advertising Antitrust Litigation", dateFiled: "2021-08-12" }),
      docket({ docketId: 20, caseName: "In re Google Digital Advertising Antitrust Litigation", dateFiled: "2021-08-12" }),
      docket({ docketId: 22, caseName: "In re Google Digital Advertising Antitrust Litigation", dateFiled: "2022-01-03" }),
    ];
    expect(pickDocket("In re Google Digital Advertising Antitrust Litigation", dupes)?.docketId).toBe(20);
    // Two different defendants, neither named in the caption: ambiguous.
    expect(pickDocket("United States v. Chu et al.", [docket({ docketId: 1, caseName: "USA v. Smith" }), docket({ docketId: 2, caseName: "USA v. Jones" })])).toBeNull();
    // Two different names that both fit equally: ambiguous. The same name written two ways: the earliest.
    expect(pickDocket("United States v. Chu et al.", [docket({ docketId: 1, caseName: "USA v. Chu" }), docket({ docketId: 2, caseName: "USA v. Chu, Wei" })])).toBeNull();
    expect(pickDocket("United States v. Chu et al.", [docket({ docketId: 5, caseName: "United States v. Chu", dateFiled: "2025-09-02" }), docket({ docketId: 4, caseName: "USA v. Chu", dateFiled: "2025-09-01" })])?.docketId).toBe(4);
    expect(pickDocket("United States v. Chu et al.", [docket({ docketId: 3, caseName: "USA v. Daniel Chu" })])?.docketId).toBe(3);
    expect(pickDocket("United States v. Chu et al.", [])).toBeNull();
  });
});

describe("RateWindow (5 requests per rolling minute)", () => {
  it("waits only when the next requests wouldn't fit", () => {
    let t = 0;
    const w = new RateWindow(5, () => t);
    expect(w.waitFor(2)).toBe(0);
    w.record(2);
    t = 10_000;
    w.record(2);
    expect(w.waitFor(1)).toBe(0);
    expect(w.waitFor(2)).toBe(51_000); // the requests at t=0 age out at 60 s (+1 s margin)
    t = 61_000;
    expect(w.waitFor(2)).toBe(0);
    expect(w.waitFor(4)).toBe(10_000); // the requests at t=10 s age out at 70 s (+1 s margin)
  });
});
