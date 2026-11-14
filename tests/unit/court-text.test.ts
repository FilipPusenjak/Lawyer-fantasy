import { describe, expect, it } from "vitest";
import { courtIdFromText, courtLabel, docketNumbersMatch, docketSearchTerm, parseDistrictDocket } from "@/lib/court/courts";
import {
  cleanText,
  isGovernmentParty,
  matchLawyerByName,
  mentionsParty,
  normalizeWords,
  partiesFromCaption,
  partyCore,
  personNameKey,
  summarize,
  trailingAttorney,
} from "@/lib/court/text";

describe("text cleanup and summaries", () => {
  it("cleans HTML and whitespace", () => {
    expect(cleanText("Thomas, J., delivered the <a href='x'>opinion</a> &amp; more\n\n")).toBe("Thomas, J., delivered the opinion & more");
    expect(cleanText(null)).toBe("");
  });

  it("summaries drop attachment lists and entry stamps and stay ≤ 300 chars", () => {
    expect(
      summarize("MOTION to Dismiss by Acme Corp.. (Attachments: # 1 Exhibit A (Declaration), # 2 Proposed Order)(Smith, John) (Entered: 11/02/2026)"),
    ).toBe("MOTION to Dismiss by Acme Corp.. (Smith, John)");
    const long = summarize(`ORDER ${"granting the motion and ordering further relief ".repeat(20)}`);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("finds the filing attorney at the end of CM/ECF text", () => {
    expect(trailingAttorney("MOTION to Dismiss . Document filed by Acme Corp..(Gass, Andrew) (Entered: 11/01/2026)")).toBe("Andrew Gass");
    expect(trailingAttorney("ORDER granting motion. Signed by Judge X. (jw) (Entered: 11/01/2026)")).toBeNull();
  });

  it("normalizes words", () => {
    expect(normalizeWords("Défendants' Motion — No. 42")).toBe("defendants motion no 42");
  });
});

describe("names", () => {
  it("personNameKey ignores middle names, initials and suffixes", () => {
    expect(personNameKey("Robert James McNamara")).toBe("robert mcnamara");
    expect(personNameKey("Robert J. McNamara")).toBe("robert mcnamara");
    expect(personNameKey("D. John Sauer")).toBe("john sauer");
    expect(personNameKey("Edwin S. Kneedler, Jr.")).toBe("edwin kneedler");
    expect(personNameKey("Alejandra L. López")).toBe("alejandra lopez");
  });

  it("matchLawyerByName: case lawyers first (exact, then loose), then a unique pool match", () => {
    const onCase = [
      { id: "a", name: "Robert J. McNamara" },
      { id: "b", name: "Jeffrey Ifrah" },
    ];
    const pool = [
      { id: "c", name: "Zoe A. Jacoby" },
      { id: "d", name: "Paul Clement" },
      { id: "e", name: "Paul D. Clement" },
    ];
    expect(matchLawyerByName("Robert James McNamara", onCase, pool)?.id).toBe("a");
    expect(matchLawyerByName("Jeff Ifrah", onCase, pool)?.id).toBe("b"); // loose: same last name + first initial
    expect(matchLawyerByName("Zoe Jacoby", onCase, pool)?.id).toBe("c");
    expect(matchLawyerByName("Paul D. Clement", onCase, pool)).toBeNull(); // ambiguous in the pool
    expect(matchLawyerByName("Kevin K. Russell", onCase, pool)).toBeNull();
    expect(matchLawyerByName("Cher", onCase, pool)).toBeNull();
  });
});

describe("parties", () => {
  it("parses captions", () => {
    expect(partiesFromCaption("United States v. Live Nation Entertainment, Inc.")).toEqual({
      plaintiff: ["United States"],
      defendant: ["Live Nation Entertainment, Inc"],
    });
    expect(partiesFromCaption("United States v. Emmanuel Clase de la Cruz and Luis Leandro Ortiz Ribera").defendant).toEqual([
      "Emmanuel Clase de la Cruz",
      "Luis Leandro Ortiz Ribera",
    ]);
    expect(partiesFromCaption("United States v. BG Dale Biscoe et al.").defendant).toEqual(["BG Dale Biscoe"]);
    expect(partiesFromCaption("In re Google Digital Advertising Antitrust Litigation")).toEqual({ plaintiff: [], defendant: [] });
  });

  it("party cores and mentions", () => {
    expect(partyCore("Live Nation Entertainment, Inc.")).toBe("live nation entertainment");
    expect(partyCore("Ticketmaster L.L.C.")).toBe("ticketmaster");
    expect(mentionsParty("live nation entertainment inc and ticketmaster", "Live Nation Entertainment, Inc.")).toBe(true);
    expect(mentionsParty("live nation", "Live Nation Entertainment, Inc.")).toBe(true);
    expect(mentionsParty("apple inc", "Applebee's")).toBe(false);
  });

  it("government parties", () => {
    expect(isGovernmentParty("United States")).toBe(true);
    expect(isGovernmentParty("U.S. Department of Justice")).toBe(true);
    expect(isGovernmentParty("Federal Trade Commission")).toBe(true);
    expect(isGovernmentParty("State of Texas")).toBe(true);
    expect(isGovernmentParty("Apple Inc.")).toBe(false);
  });
});

describe("courts", () => {
  it.each([
    ["S.D.N.Y.", "nysd"],
    ["E.D.N.Y.", "nyed"],
    ["N.D. Cal.", "cand"],
    ["C.D. Cal.", "cacd"],
    ["W.D. Wash.", "wawd"],
    ["D.N.J.", "njd"],
    ["D.D.C.", "dcd"],
    ["D. Mass.", "mad"],
    ["E.D. Tex.", "txed"],
    ["W.D. Okla.", "okwd"],
    ["S.D. Fla.", "flsd"],
    ["M.D. Fla.", "flmd"],
    ["S.D. W. Va.", "wvsd"],
    ["D.C. Cir.", "cadc"],
    ["D.C. Cir. (en banc)", "cadc"],
    ["Fed. Cir.", "cafc"],
    ["4th Cir.", "ca4"],
    ["11th Cir.", "ca11"],
    ["U.S. Supreme Court", "scotus"],
    ["Southern District of New York", "nysd"],
    ["United States District Court for the Northern District of California", "cand"],
    ["District of New Jersey", "njd"],
    ["District Court, S.D. New York", "nysd"],
    ["United States Court of Appeals for the Ninth Circuit", "ca9"],
    ["Court of Appeals for the District of Columbia Circuit", "cadc"],
  ])("%s → %s", (text, id) => expect(courtIdFromText(text)).toBe(id));

  it("unknown courts", () => {
    expect(courtIdFromText("Superior Court of Los Angeles County")).toBeNull();
    expect(courtIdFromText("")).toBeNull();
  });

  it("labels", () => {
    expect(courtLabel("nysd")).toBe("S.D.N.Y.");
    expect(courtLabel("cand")).toBe("N.D. Cal.");
    expect(courtLabel("dcd")).toBe("D.D.C.");
    expect(courtLabel("mad")).toBe("D. Mass.");
    expect(courtLabel("wvsd")).toBe("S.D. W. Va.");
    expect(courtLabel("ca9")).toBe("9th Cir.");
    expect(courtLabel("ca1")).toBe("1st Cir.");
    expect(courtLabel("cadc")).toBe("D.C. Cir.");
    expect(courtLabel("xyz")).toBeNull();
  });
});

describe("docket numbers", () => {
  it("parses district docket numbers in their many styles", () => {
    expect(parseDistrictDocket("1:24-cv-03973")).toEqual({ office: "1", year: "24", kind: "cv", number: 3973 });
    expect(parseDistrictDocket("5:24-cr-00314-J")).toEqual({ office: "5", year: "24", kind: "cr", number: 314 });
    expect(parseDistrictDocket("18-CR-457 (AMD) (JAM)")).toEqual({ office: null, year: "18", kind: "cr", number: 457 });
    expect(parseDistrictDocket("26 Cr. 29 (AT)")).toEqual({ office: null, year: "26", kind: "cr", number: 29 });
    expect(parseDistrictDocket("1:21-md-03010")).toMatchObject({ kind: "md", number: 3010 });
    expect(parseDistrictDocket("25-3-YGR")).toBeNull();
    expect(parseDistrictDocket("26-5028")).toBeNull();
  });

  it("matches docket numbers", () => {
    expect(docketNumbersMatch("1:24-cv-03973", "1:24-cv-03973")).toBe(true);
    expect(docketNumbersMatch("24-cv-3973", "1:24-cv-03973")).toBe(true);
    expect(docketNumbersMatch("2:24-cv-03973", "1:24-cv-03973")).toBe(false);
    expect(docketNumbersMatch("18-CR-457 (AMD) (JAM)", "1:18-cr-00457")).toBe(true);
    expect(docketNumbersMatch("1:24-cv-03973", "1:24-cr-03973")).toBe(false);
    expect(docketNumbersMatch("26-5028", "26-5028")).toBe(true);
    expect(docketNumbersMatch("26-5028", "26-05028")).toBe(true);
    expect(docketNumbersMatch("26-5028", "25-5028")).toBe(false);
    expect(docketNumbersMatch(null, "26-5028")).toBe(false);
  });

  it("search terms", () => {
    expect(docketSearchTerm("26 Cr. 29 (AT)")).toBe("26-cr-00029");
    expect(docketSearchTerm("1:24-cv-3973")).toBe("1:24-cv-03973");
    expect(docketSearchTerm(" 26-5028 ")).toBe("26-5028");
  });
});
