/**
 * Pure account rules shared by sign up, log in and the account page.
 * No DB or request access here so it can be unit tested.
 */
import { z } from "zod";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const DISPLAY_NAME_MAX = 40;
export const PASSWORD_MIN = 8;
/** Generous cap so nobody can make us hash a megabyte. */
export const PASSWORD_MAX = 200;

/** Usernames are case-insensitive: always compare and store them lowercase. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

const text = z.preprocess((v) => (v == null ? "" : v), z.string());

export const usernameSchema = text.transform(normalizeUsername).pipe(
  z
    .string()
    .min(USERNAME_MIN, `Usernames need at least ${USERNAME_MIN} characters.`)
    .max(USERNAME_MAX, `Usernames can be at most ${USERNAME_MAX} characters.`)
    .regex(/^[a-z0-9_]+$/, "Usernames can only use letters, numbers and underscores (_)."),
);

export const displayNameSchema = text
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Enter a display name.").max(DISPLAY_NAME_MAX, `Display names can be at most ${DISPLAY_NAME_MAX} characters.`));

export const passwordSchema = text.pipe(
  z
    .string()
    .min(PASSWORD_MIN, `Passwords need at least ${PASSWORD_MIN} characters.`)
    .max(PASSWORD_MAX, `Passwords can be at most ${PASSWORD_MAX} characters.`),
);

/** Optional email: blank means "no email" (null). */
export const optionalEmailSchema = text
  .transform((s) => s.trim())
  .pipe(
    z.union([
      z.literal("").transform(() => null),
      z.email("That doesn't look like an email address.").max(254, "That email address is too long."),
    ]),
  );

export const signupSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
    confirmPassword: text,
    email: optionalEmailSchema,
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "The two passwords don't match.",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  username: text.transform(normalizeUsername).pipe(z.string().min(1).max(100)),
  password: text.pipe(z.string().min(1).max(PASSWORD_MAX)),
});

export const changePasswordSchema = z
  .object({
    currentPassword: text.pipe(z.string().min(1, "Enter your current password.")),
    newPassword: passwordSchema,
    confirmPassword: text,
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "The two new passwords don't match.",
    path: ["confirmPassword"],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: "Pick a new password that's different from your current one.",
    path: ["newPassword"],
  });

/** First human-readable message from a zod error. */
export function firstIssue(error: z.ZodError, fallback = "Please check the form and try again."): string {
  return error.issues[0]?.message || fallback;
}

/** Pages users should never be sent "back" to after logging in. */
const AUTH_PATHS = new Set(["/login", "/signup"]);

/**
 * Sanitize a post-login redirect target. Only same-site relative paths are
 * allowed (e.g. "/join?code=ABC123"); anything else falls back to "/".
 */
export function safeNextPath(raw: unknown, fallback = "/"): string {
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (s.length === 0 || s.length > 512) return fallback;
  if (!s.startsWith("/") || s.startsWith("//")) return fallback;
  // Backslashes and control characters can trick browsers into other hosts.
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return fallback;
  let url: URL;
  try {
    url = new URL(s, "http://lf.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://lf.invalid") return fallback;
  // Dot segments are resolved by URL, so "/.//evil.example" comes out as
  // "//evil.example": a protocol-relative URL that browsers send off-site.
  if (url.pathname.startsWith("//")) return fallback;
  if (AUTH_PATHS.has(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Link to /login or /signup that brings the user back to `next` afterwards. */
export function authHref(base: "/login" | "/signup", next?: string | null): string {
  const target = safeNextPath(next);
  return target === "/" ? base : `${base}?next=${encodeURIComponent(target)}`;
}
