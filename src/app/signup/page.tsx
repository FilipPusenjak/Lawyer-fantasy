import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Card, Field, Input, Page, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui-client";
import { getCurrentUser } from "@/server/auth/session";
import { authHref, DISPLAY_NAME_MAX, PASSWORD_MIN, safeNextPath, USERNAME_MAX } from "@/app/account/rules";
import { StickyForm } from "@/app/account/sticky-form";
import { signupAction } from "./actions";

export const metadata: Metadata = { title: "Sign up" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) redirect(next);

  return (
    <>
      <SiteHeader user={null} />
      <Page>
        <PageHeader title="Create your account" subtitle="It takes about 30 seconds." />
        <Card>
          <StickyForm action={signupAction}>
            <input type="hidden" name="next" value={next} />
            <Field label="Username" hint="3–20 characters: letters, numbers and _. You'll use it to log in.">
              <Input
                name="username"
                required
                minLength={3}
                maxLength={USERNAME_MAX}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Display name" hint="What your league sees, like “Sam R.”">
              <Input name="displayName" required maxLength={DISPLAY_NAME_MAX} autoComplete="nickname" />
            </Field>
            <Field label="Password" hint={`At least ${PASSWORD_MIN} characters.`}>
              <Input name="password" type="password" required minLength={PASSWORD_MIN} autoComplete="new-password" />
            </Field>
            <Field label="Confirm password">
              <Input name="confirmPassword" type="password" required minLength={PASSWORD_MIN} autoComplete="new-password" />
            </Field>
            <Field label="Email (optional)" hint="Only used to help you reset a forgotten password. We never show it to anyone.">
              <Input name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} />
            </Field>
            <SubmitButton className="w-full" pendingText="Creating account…">
              Sign up
            </SubmitButton>
          </StickyForm>
        </Card>
        <p className="mt-4 text-center text-sm">
          Already have an account?{" "}
          <Link href={authHref("/login", next)} className="inline-flex min-h-11 items-center font-semibold text-brand">
            Log in
          </Link>
        </p>
      </Page>
    </>
  );
}
