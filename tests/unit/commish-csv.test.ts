import { describe, expect, it } from "vitest";
import {
  detectDelimiter,
  formatCsvErrors,
  MAX_IMPORT_ROWS,
  normalizeCaseType,
  normalizePosition,
  normalizeSide,
  parseAppearancesCsv,
  parseCasesCsv,
  parseCsv,
  parseLawyersCsv,
  IMPORT_FORMATS,
} from "@/app/leagues/[leagueId]/commish/pool/csv";

describe("parseCsv", () => {
  it("splits simple rows and trims cells", () => {
    expect(parseCsv("a, b ,c\n1,2,3")).toEqual([
      { line: 1, cells: ["a", "b", "c"] },
      { line: 2, cells: ["1", "2", "3"] },
    ]);
  });

  it("handles quoted fields with commas, escaped quotes and line breaks", () => {
    const recs = parseCsv('name,org\n"Doe, Jane","The ""Best"" Office"\n"Multi\nLine",x\nlast,row');
    expect(recs).toEqual([
      { line: 1, cells: ["name", "org"] },
      { line: 2, cells: ["Doe, Jane", 'The "Best" Office'] },
      { line: 3, cells: ["Multi\nLine", "x"] },
      { line: 5, cells: ["last", "row"] },
    ]);
  });

  it("skips blank lines (including whitespace and empty-comma lines) but keeps line numbers", () => {
    const recs = parseCsv("a,b\n\n   \n,,\nc,d\n");
    expect(recs.map((r) => r.line)).toEqual([1, 5]);
  });

  it("handles CRLF, lone CR and a BOM", () => {
    expect(parseCsv("﻿a,b\r\nc,d\re,f")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c", "d"] },
      { line: 3, cells: ["e", "f"] },
    ]);
  });

  it("detects tab-separated text pasted from a spreadsheet", () => {
    const text = "Avery Example\ttrial\tExample LLP, Inc.\t\t1";
    expect(detectDelimiter(text)).toBe("\t");
    expect(parseCsv(text)[0].cells).toEqual(["Avery Example", "trial", "Example LLP, Inc.", "", "1"]);
    expect(detectDelimiter("a,b,c")).toBe(",");
  });
});

describe("aliases", () => {
  it("normalizes positions", () => {
    expect(normalizePosition("Trial Lawyer")).toBe("trial");
    expect(normalizePosition("prosecutor")).toBe("prosecutor");
    expect(normalizePosition("Defense Attorney")).toBe("defense");
    expect(normalizePosition("public_defender")).toBe("defense");
    expect(normalizePosition("A.U.S.A.")).toBe("prosecutor");
    expect(normalizePosition("Law Firm")).toBe("firm");
    expect(normalizePosition("APP")).toBe("appellate");
    expect(normalizePosition("judge")).toBeNull();
  });

  it("normalizes case types (blank = civil)", () => {
    expect(normalizeCaseType("")).toBe("civil");
    expect(normalizeCaseType("Criminal")).toBe("criminal");
    expect(normalizeCaseType("Supreme Court")).toBe("supreme_court");
    expect(normalizeCaseType("supreme_court")).toBe("supreme_court");
    expect(normalizeCaseType("SCOTUS")).toBe("supreme_court");
    expect(normalizeCaseType("court of appeals")).toBe("appeal");
    expect(normalizeCaseType("family")).toBeNull();
  });

  it("normalizes sides", () => {
    for (const s of ["plaintiff", "Prosecution", "appellant", "Petitioner", "State", "United States"]) {
      expect(normalizeSide(s)).toBe("plaintiff");
    }
    for (const s of ["defendant", "Defense", "appellee", "Respondent", "defendants"]) {
      expect(normalizeSide(s)).toBe("defendant");
    }
    expect(normalizeSide("neutral")).toBeNull();
  });
});

describe("parseLawyersCsv", () => {
  it("parses with or without a header row", () => {
    const body = 'Avery Example,Trial Lawyer,Example & Partners LLP,,1\nJordan Sample,prosecutor,,"U.S. Attorney\'s Office, D. Example",2';
    for (const text of [body, `name,position,firm,organization,rank\n${body}`]) {
      const { rows, errors } = parseLawyersCsv(text);
      expect(errors).toEqual([]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ name: "Avery Example", position: "trial", firm: "Example & Partners LLP", organization: null, rank: 1 });
      expect(rows[1]).toMatchObject({ name: "Jordan Sample", position: "prosecutor", firm: null, organization: "U.S. Attorney's Office, D. Example", rank: 2 });
    }
  });

  it("accepts firm rows and ignores their firm column", () => {
    const { rows } = parseLawyersCsv("Example LLP,law firm,Other LLP");
    expect(rows[0]).toMatchObject({ name: "Example LLP", position: "firm", firm: null });
  });

  it("reports bad positions, ranks, missing names and duplicates with line numbers", () => {
    const { rows, errors } = parseLawyersCsv(
      ["name,position", "A Person,judge", "", "B Person,trial,,,first", ",trial", "C Person,trial", "c person,defense", "D Person"].join("\n"),
    );
    expect(rows.map((r) => r.name)).toEqual(["C Person"]);
    expect(errors.map((e) => e.line)).toEqual([2, 4, 5, 7, 8]);
    expect(errors[0].message).toMatch(/Unknown position “judge”/);
    expect(errors[1].message).toMatch(/Rank/);
    expect(errors[3].message).toMatch(/twice.*line 6/);
    expect(errors[4].message).toMatch(/Missing the position/);
  });

  it("caps the number of rows", () => {
    const text = Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, i) => `Lawyer ${i},trial`).join("\n");
    const { rows, errors } = parseLawyersCsv(text);
    expect(rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Too many rows/);
  });

  it("parses the documented example cleanly", () => {
    expect(parseLawyersCsv(IMPORT_FORMATS.lawyers.example).errors).toEqual([]);
    expect(parseCasesCsv(IMPORT_FORMATS.cases.example).errors).toEqual([]);
    expect(parseAppearancesCsv(IMPORT_FORMATS.appearances.example).errors).toEqual([]);
  });
});

describe("parseCasesCsv", () => {
  it("parses cases with optional docket, type and source", () => {
    const { rows, errors } = parseCasesCsv(
      [
        "caption,court,docket_number,case_type,source_url",
        "Doe v. Example Corp.,S.D. Example,1:26-cv-01234,civil,https://example.com/d/1",
        '"United States v. Sample, et al.",D. Example,,Criminal,',
        "In re Example,Example Sup. Ct.,,,",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, caption: "Doe v. Example Corp.", court: "S.D. Example", docketNumber: "1:26-cv-01234", caseType: "civil", sourceUrl: "https://example.com/d/1" },
      { line: 3, caption: "United States v. Sample, et al.", court: "D. Example", docketNumber: null, caseType: "criminal", sourceUrl: null },
      { line: 4, caption: "In re Example", court: "Example Sup. Ct.", docketNumber: null, caseType: "civil", sourceUrl: null },
    ]);
  });

  it("rejects missing court, bad types, non-http links and duplicate dockets", () => {
    const { rows, errors } = parseCasesCsv(
      [
        "A v. B,,1",
        "C v. D,Court,2,family",
        "E v. F,Court,3,civil,javascript:alert(1)",
        "G v. H,Court,4",
        "G v. H again,court,4",
      ].join("\n"),
    );
    expect(rows.map((r) => r.caption)).toEqual(["G v. H"]);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3, 5]);
    expect(errors[2].message).toMatch(/http/);
  });
});

describe("parseAppearancesCsv", () => {
  it("parses lawyer, case reference and side aliases", () => {
    const { rows, errors } = parseAppearancesCsv(
      ["lawyer_name,docket_number_or_caption,side", "Avery Example,1:26-cv-01234,Plaintiff", "Jordan Sample,United States v. Sample,prosecution", "Example LLP,1:26-cv-01234,Appellee"].join(
        "\n",
      ),
    );
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.lawyerName, r.caseRef, r.side])).toEqual([
      ["Avery Example", "1:26-cv-01234", "plaintiff"],
      ["Jordan Sample", "United States v. Sample", "plaintiff"],
      ["Example LLP", "1:26-cv-01234", "defendant"],
    ]);
  });

  it("reports unknown sides and missing cells", () => {
    const { rows, errors } = parseAppearancesCsv("A,1,judge\nB,,plaintiff\nC,2");
    expect(rows).toEqual([]);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3]);
  });
});

describe("formatCsvErrors", () => {
  it("lists the first few errors in line order and counts the rest", () => {
    const errors = [5, 1, 3, 9, 7, 2].map((line) => ({ line, message: `bad ${line}.` }));
    expect(formatCsvErrors(errors, 3)).toBe("Line 1: bad 1. Line 2: bad 2. Line 3: bad 3. (and 3 more)");
    expect(formatCsvErrors(errors.slice(0, 1))).toBe("Line 5: bad 5.");
  });
});
