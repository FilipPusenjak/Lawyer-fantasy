"use server";

import { redirect } from "next/navigation";
import { destroySession } from "@/server/auth/session";

/** Log out of this device. Only touches the caller's own session cookie. */
export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/");
}
