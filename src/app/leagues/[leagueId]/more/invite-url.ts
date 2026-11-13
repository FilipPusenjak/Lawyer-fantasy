import "server-only";
import { headers } from "next/headers";
import { buildJoinUrl } from "@/app/join/join-rules";

/** Absolute /join?code= link for the current host (for sharing invites). */
export async function inviteUrl(code: string): Promise<string> {
  const h = await headers();
  return buildJoinUrl(code, h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));
}
