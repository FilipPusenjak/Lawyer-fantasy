import Link from "next/link";

/** Top bar for pages outside a league: app name + account (or log in) link. */
export function SiteHeader({ user }: { user: { displayName: string } | null }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4">
        <Link href="/" className="inline-flex min-h-12 items-center gap-2 font-bold text-brand">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" />
          </svg>
          Lawyer Fantasy
        </Link>
        {user ? (
          <Link
            href="/account"
            className="inline-flex min-h-11 max-w-[50%] items-center gap-1.5 truncate rounded-xl px-2 text-sm font-semibold text-ink hover:bg-surface-2"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="truncate">{user.displayName}</span>
          </Link>
        ) : (
          <Link href="/login" className="inline-flex min-h-11 items-center rounded-xl px-2 text-sm font-semibold text-brand hover:bg-brand-soft">
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
