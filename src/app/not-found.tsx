import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { LinkButton, Page } from "@/components/ui";
import { getCurrentUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Not found" };

export default async function NotFound() {
  const user = await getCurrentUser();
  return (
    <>
      <SiteHeader user={user} />
      <Page>
        <div className="rounded-2xl border border-dashed border-line p-8 text-center">
          <p className="text-4xl font-extrabold text-brand">404</p>
          <h1 className="mt-2 text-xl font-bold">Objection! Page not found.</h1>
          <p className="mt-2 text-sm text-muted">
            This page doesn&apos;t exist, or it belongs to a league you&apos;re not in. If someone sent you an invite, ask them for the
            invite code.
          </p>
          <LinkButton href="/" className="mt-5 w-full">
            Go to my leagues
          </LinkButton>
        </div>
      </Page>
    </>
  );
}
