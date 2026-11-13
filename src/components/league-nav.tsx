"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const ICONS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  team: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0",
  players: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 17-4.35-4.35",
  matchup: "M6 4v16M18 4v16M6 12h12",
  more: "M4 6h16M4 12h16M4 18h16",
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Bottom tab bar for league pages. */
export function LeagueNav({ leagueId }: { leagueId: string }) {
  const pathname = usePathname();
  const base = `/leagues/${leagueId}`;
  const tabs = [
    { key: "home", label: "Home", href: base, match: (p: string) => p === base },
    { key: "team", label: "My Team", href: `${base}/team`, match: (p: string) => p.startsWith(`${base}/team`) },
    { key: "players", label: "Lawyers", href: `${base}/players`, match: (p: string) => p.startsWith(`${base}/players`) || p.startsWith(`${base}/lawyers`) },
    { key: "matchup", label: "Matchup", href: `${base}/matchups`, match: (p: string) => p.startsWith(`${base}/matchups`) },
    {
      key: "more",
      label: "League",
      href: `${base}/more`,
      match: (p: string) =>
        ["/more", "/standings", "/trades", "/draft", "/commish", "/teams", "/waivers", "/activity"].some((s) => p.startsWith(`${base}${s}`)),
    },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-xl">
        {tabs.map((t) => {
          const active = t.match(pathname);
          return (
            <Link
              key={t.key}
              href={t.href}
              className={cx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold", active ? "text-brand" : "text-muted")}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={t.key} />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
