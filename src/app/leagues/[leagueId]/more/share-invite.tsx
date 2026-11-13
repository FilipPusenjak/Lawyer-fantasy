"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/** Invite code + link with share/copy buttons (commissioners). */
export function ShareInvite({ code, url, leagueName }: { code: string; url: string; leagueName: string }) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const absolute = () => {
    try {
      return new URL(url, window.location.href).toString();
    } catch {
      return url;
    }
  };

  async function copy(text: string, what: "code" | "link") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    } catch {
      window.prompt("Copy this:", text);
    }
  }

  async function share() {
    const link = absolute();
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `Join ${leagueName}`,
          text: `Join my Lawyer Fantasy league “${leagueName}” (code ${code}):`,
          url: link,
        });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    await copy(link, "link");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Invite code</p>
          <p className="font-mono text-2xl font-bold tracking-widest">{code}</p>
        </div>
        <Button type="button" variant="ghost" onClick={() => copy(code, "code")}>
          {copied === "code" ? "Copied!" : "Copy"}
        </Button>
      </div>
      <p className="break-all text-xs text-muted">{url}</p>
      <Button type="button" className="w-full" onClick={share}>
        {copied === "link" ? "Link copied!" : "Share invite link"}
      </Button>
    </div>
  );
}
