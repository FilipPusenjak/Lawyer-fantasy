import { describe, expect, it } from "vitest";
import { firmKey, planFirmImport } from "@/lib/firms";

const row = (position: string, name: string, firm: string | null = null, rank: number | null = null) => ({ position, name, firm, organization: null, rank });

describe("firm names", () => {
  it("one key per firm however it's spelled", () => {
    expect(firmKey("Susman Godfrey L.L.P.")).toBe(firmKey("Susman Godfrey LLP"));
    expect(firmKey("Boies Schiller Flexner")).toBe(firmKey("Boies Schiller Flexner LLP"));
    expect(firmKey("Cravath, Swaine & Moore LLP")).toBe("cravath swaine moore");
    expect(firmKey("Latham & Watkins")).not.toBe(firmKey("Watkins"));
  });

  it("an import creates one firm per key, preferring the pool, then an explicit firm row", () => {
    const plan = planFirmImport(
      ["Boies Schiller Flexner LLP"],
      [
        row("trial", "Davida Brook", "Susman Godfrey L.L.P."),
        row("appellate", "Steven Seigel", "Susman Godfrey LLP"),
        row("firm", "Susman Godfrey LLP", null, 40),
        row("defense", "Matthew Schwartz", "Boies Schiller Flexner"),
        row("firm", "Boies Schiller Flexner"),
      ],
    );
    expect(plan).toEqual([{ key: "susman godfrey", name: "Susman Godfrey LLP", organization: null, rank: 40 }]);
  });
});
