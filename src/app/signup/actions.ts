"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { hashPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { firstIssue, safeNextPath, signupSchema } from "@/app/account/rules";

const TAKEN = "That username is taken. Try another one.";

export async function signupAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const parsed = signupSchema.safeParse({
      username: formData.get("username"),
      displayName: formData.get("displayName"),
      password: formData.get("password"),
      confirmPassword: formData.get("confirmPassword"),
      email: formData.get("email"),
    });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    const { username, displayName, password, email } = parsed.data;

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) throw new UserError(TAKEN);

    const passwordHash = await hashPassword(password);
    // The unique index settles races between two sign-ups for the same name.
    const [created] = await db
      .insert(users)
      .values({ username, displayName, passwordHash, email })
      .onConflictDoNothing({ target: users.username })
      .returning({ id: users.id });
    if (!created) throw new UserError(TAKEN);

    await createSession(created.id);
    return ok();
  });
  if (!result.ok) return result;
  redirect(safeNextPath(formData.get("next")));
}
