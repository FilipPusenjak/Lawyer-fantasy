"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, getCurrentUser } from "@/server/auth/session";
import { changePasswordSchema, displayNameSchema, firstIssue, optionalEmailSchema } from "./rules";

async function signedInUser() {
  const user = await getCurrentUser();
  if (!user) throw new UserError("Please log in again.");
  return user;
}

export async function updateDisplayNameAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const user = await signedInUser();
    const parsed = displayNameSchema.safeParse(formData.get("displayName"));
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    await db.update(users).set({ displayName: parsed.data }).where(eq(users.id, user.id));
    // The display name shows up across the site (headers, league member lists).
    revalidatePath("/", "layout");
    return ok("Display name saved.");
  });
}

export async function updateEmailAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const user = await signedInUser();
    const parsed = optionalEmailSchema.safeParse(formData.get("email"));
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    await db.update(users).set({ email: parsed.data }).where(eq(users.id, user.id));
    revalidatePath("/account");
    return ok(parsed.data ? "Email saved." : "Email removed.");
  });
}

export async function changePasswordAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const user = await signedInUser();
    const parsed = changePasswordSchema.safeParse({
      currentPassword: formData.get("currentPassword"),
      newPassword: formData.get("newPassword"),
      confirmPassword: formData.get("confirmPassword"),
    });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    const { currentPassword, newPassword } = parsed.data;

    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
      throw new UserError("Your current password isn't right.");
    }

    const passwordHash = await hashPassword(newPassword);
    // Sign out every other device, then start a fresh session here.
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
    });
    await createSession(user.id);
    return ok("Password changed. Any other devices were logged out.");
  });
}
