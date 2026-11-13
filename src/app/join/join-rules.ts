/**
 * Pure rules for joining a league by invite code.
 */
import { z } from "zod";
import { normalizeInviteCode } from "@/server/services/league";

const text = z.preprocess((v) => (v == null ? "" : v), z.string());

export const TEAM_NAME_MIN = 2;
export const TEAM_NAME_MAX = 40;

export const inviteCodeSchema = text
  .transform(normalizeInviteCode)
  .pipe(z.string().min(4, "Enter the league's invite code.").max(12, "That invite code is too long."));

export const teamNameSchema = text
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(TEAM_NAME_MIN, `Team names need at least ${TEAM_NAME_MIN} characters.`)
      .max(TEAM_NAME_MAX, `Team names can be at most ${TEAM_NAME_MAX} characters.`),
  );

export const joinSchema = z.object({ code: inviteCodeSchema, teamName: teamNameSchema });

/** Relative join link for an invite code. */
export function joinPath(code: string): string {
  return `/join?code=${encodeURIComponent(normalizeInviteCode(code))}`;
}

/**
 * Absolute join link for sharing, built from the request's host. Falls back to
 * the relative path when the host is unknown or looks malformed.
 */
export function buildJoinUrl(code: string, host: string | null | undefined, proto: string | null | undefined): string {
  const path = joinPath(code);
  const h = (host ?? "").split(",")[0].trim();
  if (!h || !/^[a-z0-9.-]+(:\d+)?$/i.test(h)) return path;
  let p = (proto ?? "").split(",")[0].trim().toLowerCase();
  if (p !== "http" && p !== "https") p = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(h) ? "http" : "https";
  return `${p}://${h}${path}`;
}
