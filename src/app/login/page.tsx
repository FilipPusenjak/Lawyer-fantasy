import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Card, Field, Input, Page, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui-client";
import { getCurrentUser } from "@/server/auth/session";
import { authHref, safeNextPath } from "@/app/account/rules";
import { StickyForm } from "@/app/account/sticky-form";
import { loginAction } from "./actions";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) redirect(next);

  return (
    <>
      <SiteHeader user={null} />
      <Page>
        <PageHeader title="Log in" subtitle="Welcome back! Your lineup missed you." />
        <Card>
          <StickyForm action={loginAction}>
            <input type="hidden" name="next" value={next} />
            <Field label="Username">
              <Input
                name="username"
                required
                maxLength={20}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" required autoComplete="current-password" />
            </Field>
            <SubmitButton className="w-full" pendingText="Logging in…">
              Log in
            </SubmitButton>
          </StickyForm>
        </Card>
        <p className="mt-4 text-center text-sm">
          New here?{" "}
          <Link href={authHref("/signup", next)} className="inline-flex min-h-11 items-center font-semibold text-brand">
            Create an account
          </Link>
        </p>
        <p className="mt-1 text-center text-xs text-muted">Forgot your password? Ask your club admin for help.</p>
      </Page>
    </>
  );
}
