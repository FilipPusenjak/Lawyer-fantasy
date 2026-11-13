import { LinkButton, Page } from "@/components/ui";

/**
 * Rendered inside the league layout (header + bottom tabs stay visible) when a
 * league page calls notFound(), e.g. a team or matchup that doesn't exist.
 */
export default function LeagueNotFound() {
  return (
    <Page>
      <div className="rounded-2xl border border-dashed border-line p-8 text-center">
        <h1 className="text-xl font-bold">We couldn&apos;t find that</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been removed, or the link is wrong. Tap <span className="font-semibold">Home</span> below to get back to your league.
        </p>
        <LinkButton href="/" variant="secondary" className="mt-5 w-full">
          All my leagues
        </LinkButton>
      </div>
    </Page>
  );
}
