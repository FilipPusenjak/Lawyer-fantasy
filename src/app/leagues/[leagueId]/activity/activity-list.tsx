import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { teams, transactions } from "@/db/schema";
import { Badge, ListRow } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { TRANSACTION_LABELS, transactionTone, type TransactionType } from "./paging";

export type ActivityItem = {
  id: string;
  type: TransactionType;
  description: string;
  createdAt: Date;
  teamName: string | null;
};

/** A league's transaction log, newest first. */
export async function loadActivity(leagueId: string, limit: number, offset = 0): Promise<ActivityItem[]> {
  return db
    .select({
      id: transactions.id,
      type: transactions.type,
      description: transactions.description,
      createdAt: transactions.createdAt,
      teamName: teams.name,
    })
    .from(transactions)
    .leftJoin(teams, eq(teams.id, transactions.teamId))
    .where(eq(transactions.leagueId, leagueId))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(limit)
    .offset(offset);
}

export function ActivityList({ items, timeZone }: { items: ActivityItem[]; timeZone: string }) {
  return (
    <div>
      {items.map((t) => (
        <ListRow key={t.id} className="items-start">
          <Badge tone={transactionTone(t.type)} className="mt-0.5 w-16 shrink-0 justify-center">
            {TRANSACTION_LABELS[t.type]}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm">{t.description}</p>
            <p className="mt-0.5 text-xs text-muted">
              {t.teamName ? <span className="font-medium">{t.teamName} · </span> : null}
              {formatDateTime(t.createdAt, timeZone)}
            </p>
          </div>
        </ListRow>
      ))}
    </div>
  );
}
