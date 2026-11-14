import { describe, expect, it } from "vitest";
import { authHref, safeNextPath } from "@/app/account/rules";

describe("safeNextPath (review)", () => {
  it("rejects paths that normalize to a protocol-relative URL", () => {
    // new URL() resolves dot segments, so these all come out as "//evil.example",
    // which browsers treat as another host when used in a Location header.
    for (const bad of ["/.//evil.example", "/..//evil.example", "/a/..//evil.example", "/%2e//evil.example", "/./evil.example/..//x"]) {
      const out = safeNextPath(bad);
      expect(out.startsWith("//")).toBe(false);
      expect(out).toBe("/");
    }
  });

  it("still normalizes harmless dot segments", () => {
    expect(safeNextPath("/a/../join?code=ABC123")).toBe("/join?code=ABC123");
  });

  it("authHref never carries a protocol-relative next", () => {
    expect(authHref("/login", "/.//evil.example")).toBe("/login");
  });
});
