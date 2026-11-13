"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { loginSchema, safeNextPath } from "@/app/account/rules";

const BAD_LOGIN = "That username and password don't match. Try again.";

// When the username doesn't exist we still run one password check so the
// response time doesn't reveal which usernames are taken.
let dummyHash: Promise<string> | null = null;
async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("lawyer-fantasy-not-a-real-password");
  await verifyPassword(password, await dummyHash);
}

export async function loginAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const parsed = loginSchema.safeParse({
      username: formData.get("username"),
      password: formData.get("password"),
    });
    if (!parsed.success) throw new UserError("Enter your username and password.");
    const { username, password } = parsed.data;

    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!user) {
      await burnPasswordCheck(password);
      throw new UserError(BAD_LOGIN);
    }
    if (!(await verifyPassword(password, user.passwordHash))) throw new UserError(BAD_LOGIN);

    await createSession(user.id);
    return ok();
  });
  if (!result.ok) return result;
  redirect(safeNextPath(formData.get("next")));
}
