import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyScotusProceeding,
  normalizeScotusDocket,
  parseArgument,
  parseScotusDate,
  parseScotusDocket,
  scotusDocketPageUrl,
  scotusJsonUrl,
} from "@/lib/court/scotus";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/court", name), "utf8").replace(/^﻿/, ""));

describe("docket numbers, dates and URLs", () => {
  it("normalizes docket numbers", () => {
    expect(normalizeScotusDocket("25-159 ")).toBe("25-159");
    expect(normalizeScotusDocket("No. 25-00159")).toBe("25-159");
    expect(normalizeScotusDocket("25a140")).toBe("25A140");
    expect(normalizeScotusDocket("1:24-cv-03973")).toBeNull();
    expect(normalizeScotusDocket("25-0")).toBeNull();
    expect(normalizeScotusDocket(null)).toBeNull();
  });

  it("parses feed dates", () => {
    expect(parseScotusDate("Jun 04 2025")).toBe("2025-06-04");
    expect(parseScotusDate("August 11, 2025")).toBe("2025-08-11");
    expect(parseScotusDate("11/13/2026")).toBe("2026-11-13");
    expect(parseScotusDate("Feb 30 2026")).toBeNull();
    expect(parseScotusDate("soon")).toBeNull();
  });

  it("builds URLs", () => {
    expect(scotusJsonUrl("25-159")).toBe("https://www.supremecourt.gov/RSS/Cases/JSON/25-159.json");
    expect(scotusDocketPageUrl("25-159")).toBe("https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/25-159.html");
  });
});

describe("parseScotusDocket (real feed fixtures)", () => {
  it("25-159 Hoffmann v. WBI Energy Transmission", () => {
    const d = parseScotusDocket(fixture("scotus-25-159.json"));
    expect(d.docket).toBe("25-159");
    expect(d.petitionerTitle).toMatch(/^Leonard W. Hoffmann/);
    expect(d.respondentTitle).toBe("WBI Energy Transmission, Inc.");
    expect(d.docketedDate).toBe("2025-08-11");
    expect(d.proceedings).toHaveLength(39);
    expect(d.proceedings[0]).toMatchObject({ index: 0, date: "2025-06-04" });
    expect(d.proceedings[0].links[0].url).toMatch(/^https:\/\/www\.supremecourt\.gov\/DocketPDF\//);
    expect(d.proceedings.every((p) => p.date !== null)).toBe(true);
    expect(d.attorneys.find((a) => a.side === "petitioner" && a.counselOfRecord)?.name).toBe("Robert James McNamara");
    expect(d.attorneys.find((a) => a.side === "respondent")?.organization).toBe("McDermott Will & Schulte LLP");
  });

  it("rejects things that aren't dockets", () => {
    expect(() => parseScotusDocket(null)).toThrow();
    expect(() => parseScotusDocket({ CaseNumber: "x" })).toThrow();
    expect(() => parseScotusDocket({ CaseNumber: "25-159", ProceedingsandOrder: "nope" })).toThrow();
  });

  it("strips HTML from decision text", () => {
    const d = parseScotusDocket({
      CaseNumber: "23-1122 ",
      ProceedingsandOrder: [
        {
          Date: "Jun 27 2025",
          Text: "Adjudged to be AFFIRMED.  Thomas, J., delivered the <a href = 'https://www.supremecourt.gov/opinions/24pdf/23-1122_3e04.pdf'>opinion</a> of the Court.",
        },
      ],
    });
    expect(d.proceedings[0].text).toBe("Adjudged to be AFFIRMED. Thomas, J., delivered the opinion of the Court.");
  });
});

describe("parseArgument", () => {
  it("one lawyer per side, with an amicus grouped under a side (25-159)", () => {
    const d = parseScotusDocket(fixture("scotus-25-159.json"));
    const argued = d.proceedings[38];
    expect(argued.date).toBe("2026-11-09");
    expect(parseArgument(argued.text)).toEqual([
      { name: "Robert J. McNamara", side: "plaintiff", amicus: false, label: "petitioners" },
      { name: "Paul W. Hughes", side: "defendant", amicus: false, label: "respondent" },
      { name: "Zoe A. Jacoby", side: "defendant", amicus: true, label: "respondent" },
    ]);
  });

  it("the SG supporting petitioners (25-170) and a separately labeled amicus", () => {
    const d = parseScotusDocket(fixture("scotus-25-170.json"));
    const arg = parseArgument(d.proceedings[d.proceedings.length - 1].text);
    expect(arg.map((a) => [a.name, a.side, a.amicus])).toEqual([
      ["Kannon K. Shanmugam", "plaintiff", false],
      ["Sarah M. Harris", "plaintiff", true],
      ["Kevin K. Russell", "defendant", false],
    ]);
    const fsc = parseArgument(
      "Argued. For petitioners: Derek L. Shaffer, Washington, D. C.  For United States, as amicus curiae: Brian H. Fletcher, Principal Deputy Solicitor General, Department of Justice, Washington, D. C.  For respondent: Aaron L. Nielson, Solicitor General, Austin, Tex.",
    );
    expect(fsc.map((a) => [a.name, a.side, a.amicus])).toEqual([
      ["Derek L. Shaffer", "plaintiff", false],
      ["Brian H. Fletcher", null, true],
      ["Aaron L. Nielson", "defendant", false],
    ]);
  });

  it("labels naming specific respondents, and suffixes", () => {
    const arg = parseArgument(
      "Argued. For petitioner: Jonathan F. Mitchell, Austin, Tex.  For respondents Anderson, et al.: Jason C. Murray, Denver, Colo.  For respondent Griswold: Shannon W. Stevenson, Solicitor General, Denver, Colo.",
    );
    expect(arg.map((a) => [a.name, a.side])).toEqual([
      ["Jonathan F. Mitchell", "plaintiff"],
      ["Jason C. Murray", "defendant"],
      ["Shannon W. Stevenson", "defendant"],
    ]);
    expect(parseArgument("Argued. For appellant: Edwin S. Kneedler, Jr., Deputy Solicitor General, Washington, D. C.")[0].name).toBe(
      "Edwin S. Kneedler, Jr.",
    );
  });

  it("returns nothing for other entries", () => {
    expect(parseArgument("SET FOR ARGUMENT on Monday, November 9, 2026.")).toEqual([]);
    expect(parseArgument("Argued.")).toEqual([]);
  });
});

describe("classifyScotusProceeding", () => {
  const titles = { petitionerTitle: "Leonard W. Hoffmann, et al., Petitioners", respondentTitle: "WBI Energy Transmission, Inc." };
  const one = (text: string) => {
    const c = classifyScotusProceeding(text, titles);
    if (c.skip) return { skip: true as const, reason: c.reason };
    expect(c.suggestions).toHaveLength(1);
    const s = c.suggestions[0];
    return { type: s.type, side: s.side };
  };

  it("arguments → one scotus_argument per arguing lawyer", () => {
    const c = classifyScotusProceeding("Argued. For petitioner: Joshua I. Hammack, Washington, D. C.  For respondent: Paul D. Clement, Alexandria, Va.");
    expect(c.skip).toBe(false);
    if (!c.skip) {
      expect(c.suggestions.map((s) => (s.kind === "lawyer" ? [s.type, s.lawyerName, s.side] : null))).toEqual([
        ["scotus_argument", "Joshua I. Hammack", "plaintiff"],
        ["scotus_argument", "Paul D. Clement", "defendant"],
      ]);
    }
  });

  it("decisions", () => {
    expect(one("Judgment REVERSED and case REMANDED.")).toEqual({ type: "appeal_won", side: "plaintiff" });
    expect(one("Judgment VACATED, and case REMANDED for further consideration.")).toEqual({ type: "appeal_won", side: "plaintiff" });
    expect(one("Judgment REVERSED.  The mandate shall issue forthwith.  Opinion per curiam.")).toEqual({ type: "appeal_won", side: "plaintiff" });
    expect(one("Adjudged to be AFFIRMED.  Thomas, J., delivered the opinion of the Court.")).toEqual({ type: "appeal_won", side: "defendant" });
    expect(one("Judgment AFFIRMED.")).toEqual({ type: "appeal_won", side: "defendant" });
    expect(one("The judgment is affirmed by an equally divided Court.")).toEqual({ type: "appeal_won", side: "defendant" });
    expect(one("Judgment AFFIRMED in part, REVERSED in part, and case REMANDED.")).toEqual({ type: "appeal_won", side: null });
    expect(one("Petition GRANTED. Judgment VACATED and case REMANDED to the United States Court of Appeals for the Eighth Circuit.")).toEqual({
      type: "appeal_won",
      side: "plaintiff",
    });
    expect(one("Writ of certiorari DISMISSED as improvidently granted.")).toEqual({ type: "appeal_won", side: null });
    expect(one("Petition DENIED.")).toEqual({ type: "appeal_won", side: "defendant" });
  });

  it("briefs by the parties → filing", () => {
    expect(one("Brief of petitioners Leonard W. Hoffmann, et al. filed.")).toEqual({ type: "filing", side: "plaintiff" });
    expect(one("Brief of respondent WBI Energy Transmission, Inc. in opposition filed.")).toEqual({ type: "filing", side: "defendant" });
    expect(one("Brief of respondent WBI Energy Transmission, Inc. filed.  (Distributed)")).toEqual({ type: "filing", side: "defendant" });
    expect(one("Reply of petitioners Leonard W. Hoffmann, et al. filed.  (Distributed)")).toEqual({ type: "filing", side: "plaintiff" });
    expect(one("Supplemental brief of petitioners Leonard W. Hoffmann, et al. filed.  (Distributed)")).toEqual({ type: "filing", side: "plaintiff" });
    expect(one("Brief of the federal respondents in opposition filed.")).toEqual({ type: "filing", side: "defendant" });
    expect(one("Petition for a writ of certiorari filed. (Response due September 10, 2025)")).toEqual({ type: "filing", side: "plaintiff" });
    expect(one("Brief of WBI Energy Transmission, Inc. filed.")).toEqual({ type: "filing", side: "defendant" });
  });

  it.each([
    "Brief amici curiae of State of North Dakota, et al. filed.",
    "Brief amicus curiae of United States filed.  (Distributed)",
    "Motion to extend the time to file a response from September 10, 2025 to October 10, 2025, submitted to The Clerk.",
    "Motion to extend the time to file a response is granted and the time is extended to and including October 10, 2025.",
    "Application (24A1205) granted by Justice Kavanaugh extending the time to file until August 7, 2025.",
    "DISTRIBUTED for Conference of 11/14/2025.",
    "CIRCULATED",
    "Petition GRANTED.",
    "SET FOR ARGUMENT on Monday, November 9, 2026.",
    "Record requested from the United States Court of Appeals for the Eighth Circuit.",
    "Motion of the Solicitor General for leave to participate in oral argument as amicus curiae and for divided argument GRANTED.",
    "Motion to dispense with printing the joint appendix filed by petitioners Leonard W. Hoffmann, et al.",
    "Brief of Cty. Comm'rs of Boulder Cty., et al. not accepted for filing. (To be corrected - August 03, 2026)",
    "Joint appendix filed.  (Statement of costs filed)",
    "Letter of respondent submitted pursuant to Rule 29.6 with amended corporate disclosure statement filed.",
    "Judgment Issued.",
    "Judgment and mandate issued.",
    "The Solicitor General is invited to file a brief in this case expressing the views of the United States.",
    "Brief of Chamber of Commerce of the United States of America filed.",
  ])("skips: %s", (text) => {
    expect(classifyScotusProceeding(text, titles).skip).toBe(true);
  });

  it("over a whole real docket, only party briefs and the argument produce suggestions", () => {
    const d = parseScotusDocket(fixture("scotus-25-459.json"));
    const kept = d.proceedings
      .map((p) => ({ p, c: classifyScotusProceeding(p.text, d) }))
      .filter((x) => !x.c.skip)
      .map((x) => x.p.index);
    // cert petition, brief in opposition, reply, merits briefs, reply, argument
    expect(kept).toEqual([4, 7, 8, 17, 20, 32, 38]);
  });
});
