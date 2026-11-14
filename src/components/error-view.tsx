"use client";

import Link from "next/link";
import { useEffect } from "react";
import { buttonClass } from "./ui";

/** Themed fallback shown by error.tsx boundaries. */
export function ErrorView({ error, retry, homeHref = "/" }: { error: unknown; retry: () => void; homeHref?: string }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-28 pt-10 text-center">
      <h1 className="text-xl font-bold">{offline ? "You're offline" : "Something went wrong"}</h1>
      <p className="mt-2 text-sm text-muted">
        {offline
          ? "Check your connection, then try again. Nothing you typed was saved."
          : "That didn't load. Try again, and if it keeps happening tell your commissioner."}
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <button type="button" className={buttonClass("primary")} onClick={() => retry()}>
          Try again
        </button>
        <Link href={homeHref} className={buttonClass("secondary")}>
          Go back
        </Link>
      </div>
    </div>
  );
}
