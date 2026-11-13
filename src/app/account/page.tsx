import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { Badge, Button, Card, CardTitle, Field, Input, LinkButton, Page, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui-client";
import { requireUser } from "@/server/auth/session";
import { logoutAction } from "@/app/auth-actions";
import { changePasswordAction, updateDisplayNameAction, updateEmailAction } from "./actions";
import { DISPLAY_NAME_MAX, PASSWORD_MIN } from "./rules";
import { StickyForm } from "./sticky-form";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <>
      <SiteHeader user={user} />
      <Page className="space-y-4">
        <PageHeader
          title="Your account"
          subtitle={
            <>
              Logged in as <span className="font-semibold text-ink">@{user.username}</span>{" "}
              {user.isAdmin ? <Badge tone="accent">Club admin</Badge> : null}
            </>
          }
          action={
            <LinkButton href="/" variant="secondary">
              My leagues
            </LinkButton>
          }
        />

        <Card>
          <CardTitle>Display name</CardTitle>
          <StickyForm action={updateDisplayNameAction}>
            <Field label="Display name" hint="What other players see. Your username can't be changed.">
              <Input name="displayName" required maxLength={DISPLAY_NAME_MAX} defaultValue={user.displayName} autoComplete="nickname" />
            </Field>
            <SubmitButton variant="secondary" pendingText="Saving…">
              Save name
            </SubmitButton>
          </StickyForm>
        </Card>

        <Card>
          <CardTitle>Email</CardTitle>
          <StickyForm action={updateEmailAction}>
            <Field label="Email (optional)" hint="Only used to help you reset a forgotten password. Leave blank to remove it.">
              <Input
                name="email"
                type="email"
                defaultValue={user.email ?? ""}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <SubmitButton variant="secondary" pendingText="Saving…">
              Save email
            </SubmitButton>
          </StickyForm>
        </Card>

        <Card>
          <CardTitle>Change password</CardTitle>
          <StickyForm action={changePasswordAction} resetOnSuccess>
            {/* Hidden username helps password managers update the right entry. */}
            <input type="text" name="username" autoComplete="username" defaultValue={user.username} hidden readOnly />
            <Field label="Current password">
              <Input name="currentPassword" type="password" required autoComplete="current-password" />
            </Field>
            <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`}>
              <Input name="newPassword" type="password" required minLength={PASSWORD_MIN} autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password">
              <Input name="confirmPassword" type="password" required minLength={PASSWORD_MIN} autoComplete="new-password" />
            </Field>
            <SubmitButton variant="secondary" pendingText="Changing…">
              Change password
            </SubmitButton>
          </StickyForm>
        </Card>

        <form action={logoutAction}>
          <Button type="submit" variant="secondary" className="w-full">
            Log out
          </Button>
        </form>
      </Page>
    </>
  );
}
