import { describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// results.ts imports DB services; closeOutSeason only uses the tx it's given.
vi.mock("@/db", () => ({ db: {} }));

import type { DbOrTx } from "@/db";
import { closeOutSeason, SEASON_ENDED_TRADE_REASON } from "@/server/services/results";

type Update = { table: string; set: Record<string, unknown>; where: { sql: string; params: unknown[] } };

/** A tx that records `update(table).set(values).where(cond)` calls instead of running them. */
function recordingTx(): { tx: DbOrTx; updates: Update[] } {
  const dialect = new PgDialect();
  const updates: Update[] = [];
  const tx = {
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Record<string, unknown>) => ({
        where: async (cond: SQL) => {
          updates.push({ table: getTableName(table), set, where: dialect.sqlToQuery(cond) });
        },
      }),
    }),
  };
  return { tx: tx as unknown as DbOrTx, updates };
}

describe("closeOutSeason", () => {
  it("fails open trades and loses pending waiver claims for that league only", async () => {
    const { tx, updates } = recordingTx();
    const now = new Date("2026-12-01T12:00:00Z");
    await closeOutSeason(tx, "league-1", now);

    expect(updates.map((u) => u.table)).toEqual(["trades", "waiver_claims"]);

    const [trade, claim] = updates;
    expect(trade.set).toEqual({ status: "failed", failReason: SEASON_ENDED_TRADE_REASON, resolvedAt: now });
    expect(trade.where.sql).toMatch(/"league_id" = \$1 and "trades"\."status" in \(\$2, \$3\)/);
    expect(trade.where.params).toEqual(["league-1", "proposed", "accepted"]);

    expect(claim.set).toEqual({ status: "lost", processedAt: now });
    expect(claim.where.sql).toMatch(/"league_id" = \$1 and "waiver_claims"\."status" = \$2/);
    expect(claim.where.params).toEqual(["league-1", "pending"]);
  });
});
