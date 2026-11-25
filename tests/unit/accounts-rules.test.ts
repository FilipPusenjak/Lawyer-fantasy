import { describe, expect, it } from "vitest";
import {
  authHref,
  changePasswordSchema,
  displayNameSchema,
  firstIssue,
  loginSchema,
  normalizeUsername,
  optionalEmailSchema,
  safeNextPath,
  signupSchema,
  usernameSchema,
} from "@/app/account/rules";

describe("usernames", () => {
  it("normalizes to lowercase and trims", () => {
    expect(normalizeUsername("  Sam_R  ")).toBe("sam_r");
    expect(usernameSchema.parse(" MockTrial_23 ")).toBe("mocktrial_23");
  });

  it("enforces length and characters", () => {
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("abc").success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(20)).success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(21)).success).toBe(false);
    expect(usernameSchema.safeParse("sam r").success).toBe(false);
    expect(usernameSchema.safeParse("sam-r").success).toBe(false);
    expect(usernameSchema.safeParse("sam.r").success).toBe(false);
    expect(usernameSchema.safeParse("émile").success).toBe(false);
    expect(usernameSchema.safeParse(null).success).toBe(false);
  });

  it("gives a friendly message", () => {
    const r = usernameSchema.safeParse("no spaces");
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toMatch(/letters, numbers and underscores/);
  });
});

describe("display names", () => {
  it("trims and collapses spaces", () => {
    expect(displayNameSchema.parse("  Sam   R. ")).toBe("Sam R.");
  });
  it("requires 1-40 characters", () => {
    expect(displayNameSchema.safeParse("   ").success).toBe(false);
    expect(displayNameSchema.safeParse("x").success).toBe(true);
    expect(displayNameSchema.safeParse("x".repeat(40)).success).toBe(true);
    expect(displayNameSchema.safeParse("x".repeat(41)).success).toBe(false);
  });
});

describe("email", () => {
  it("blank means no email", () => {
    expect(optionalEmailSchema.parse("")).toBeNull();
    expect(optionalEmailSchema.parse("   ")).toBeNull();
    expect(optionalEmailSchema.parse(null)).toBeNull();
  });
  it("validates format", () => {
    expect(optionalEmailSchema.parse(" sam@example.com ")).toBe("sam@example.com");
    expect(optionalEmailSchema.safeParse("not-an-email").success).toBe(false);
  });
});

describe("signup", () => {
  const base = {
    username: "Sam_R",
    displayName: "Sam R.",
    password: "objection!",
    confirmPassword: "objection!",
    email: "",
  };
  it("accepts a valid form", () => {
    expect(signupSchema.parse(base)).toEqual({
      username: "sam_r",
      displayName: "Sam R.",
      password: "objection!",
      confirmPassword: "objection!",
      email: null,
    });
  });
  it("requires 8+ character passwords", () => {
    const r = signupSchema.safeParse({ ...base, password: "short", confirmPassword: "short" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toMatch(/at least 8/);
  });
  it("requires matching passwords", () => {
    const r = signupSchema.safeParse({ ...base, confirmPassword: "sustained!" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toMatch(/don't match/);
  });
});

describe("login", () => {
  it("normalizes username and requires both fields", () => {
    expect(loginSchema.parse({ username: " Sam_R ", password: "x" }).username).toBe("sam_r");
    expect(loginSchema.safeParse({ username: "", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ username: "sam", password: "" }).success).toBe(false);
  });
});

describe("change password", () => {
  it("requires a different, confirmed new password", () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: "old-pass-1", newPassword: "new-pass-1", confirmPassword: "new-pass-1" }).success,
    ).toBe(true);
    expect(
      changePasswordSchema.safeParse({ currentPassword: "old-pass-1", newPassword: "new-pass-1", confirmPassword: "new-pass-2" }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({ currentPassword: "same-pass-1", newPassword: "same-pass-1", confirmPassword: "same-pass-1" })
        .success,
    ).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "", newPassword: "new-pass-1", confirmPassword: "new-pass-1" }).success).toBe(
      false,
    );
  });
});

describe("safeNextPath", () => {
  it("allows same-site relative paths", () => {
    expect(safeNextPath("/join?code=ABC123")).toBe("/join?code=ABC123");
    expect(safeNextPath("/leagues/123/team")).toBe("/leagues/123/team");
    expect(safeNextPath(["/account", "/x"])).toBe("/account");
  });
  it("rejects anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
      "evil.example",
      "",
      "   ",
      "/" + "a".repeat(600),
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(42)).toBe("/");
  });
  it("never bounces back to login/signup", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/signup?next=/x")).toBe("/");
  });
  it("supports a custom fallback", () => {
    expect(safeNextPath("https://evil.example", "/account")).toBe("/account");
  });
});

describe("authHref", () => {
  it("encodes the next path", () => {
    expect(authHref("/signup", "/join?code=ABC123")).toBe("/signup?next=%2Fjoin%3Fcode%3DABC123");
    expect(authHref("/login", "/")).toBe("/login");
    expect(authHref("/login", "https://evil.example")).toBe("/login");
    expect(authHref("/login")).toBe("/login");
  });
});

describe("reserved usernames", () => {
  it("demo_ is reserved for the dev demo data", () => {
    expect(usernameSchema.safeParse("demo_player1").success).toBe(false);
    expect(usernameSchema.safeParse("Demo_Kid").success).toBe(false);
    expect(usernameSchema.safeParse("demolition").success).toBe(true);
  });
});
