"use client";

import { useParams } from "next/navigation";
import { ErrorView } from "@/components/error-view";

/** Error boundary for league pages; keeps the league header and bottom nav. */
export default function LeagueError({ error, retry }: { error: unknown; retry: () => void }) {
  const params = useParams<{ leagueId: string }>();
  return <ErrorView error={error} retry={retry} homeHref={params?.leagueId ? `/leagues/${params.leagueId}` : "/"} />;
}
