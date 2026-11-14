import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge, Card, CardTitle, EmptyState, Field, LinkButton, ListRow, Notice, Page, PageHeader, Select } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { isUuid } from "@/lib/format";
import { CASE_TYPE_LABELS, POSITION_SHORT, sideLabel, SIDES } from "@/lib/settings";
import { formatDate } from "@/lib/time";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { listEvents } from "@/server/services/events";
import { approvedEventCount, getPoolCase, listCaseAppearances, listLawyerOptions } from "@/server/services/pool";
import { eventLabel, STATUS_LABELS } from "../../../events/event-rules";
import { addAppearanceAction, deleteCaseAction, removeAppearanceAction, updateCaseAction } from "../../actions";
import { BackLink, CaseFields, Disclosure } from "../../pool-ui";

export const metadata: Metadata = { title: "Case" };

export default async function CaseDetailPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/pool/cases/[caseId]">) {
  const { leagueId, caseId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!isUuid(caseId) || !(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const c = await getPoolCase(db, poolId, caseId);
  if (!c) notFound();
  const [appearances, options, events, approved] = await Promise.all([
    listCaseAppearances(db, caseId),
    listLawyerOptions(db, poolId),
    listEvents(db, poolId, { caseId, limit: 20 }),
    approvedEventCount(db, caseId),
  ]);
  const created = (await searchParams).created === "1";
  const onCase = new Set(appearances.map((a) => a.lawyerId));
  const available = options.filter((o) => !onCase.has(o.id));
  const base = `/leagues/${leagueId}/commish`;

  return (
    <Page className="space-y-4">
      <BackLink href={`${base}/pool/cases`} label="Cases" />
      <PageHeader
        title={c.caption}
        subtitle={[c.court, c.docketNumber, CASE_TYPE_LABELS[c.caseType], c.status === "closed" ? "Closed" : null].filter(Boolean).join(" · ")}
      />
      {created ? <Notice tone="success">Case added. Now add the lawyers and firms on each side.</Notice> : null}
      {c.sourceUrl ? (
        <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
          View public record ↗
        </a>
      ) : null}

      <Card>
        <CardTitle>Lawyers on this case</CardTitle>
        {SIDES.map((side) => {
          const list = appearances.filter((a) => a.side === side);
          return (
            <div key={side} className="mb-3 last:mb-0">
              <p className="text-sm font-semibold text-muted">{sideLabel(c.caseType, side)}</p>
              {list.length === 0 ? (
                <p className="py-2 text-sm text-muted">Nobody yet.</p>
              ) : (
                list.map((a) => (
                  // The form wraps the whole row so an error shows full width under it, not squeezed beside the button.
                  <ActionForm
                    key={a.id}
                    action={removeAppearanceAction.bind(null, leagueId)}
                    className="space-y-2 border-b border-line py-2 last:border-b-0"
                  >
                    <input type="hidden" name="appearanceId" value={a.id} />
                    <div className="flex min-h-11 items-center gap-3">
                      <Badge tone="brand" className="w-12 shrink-0 justify-center">
                        {POSITION_SHORT[a.position]}
                      </Badge>
                      <p className="min-w-0 flex-1 truncate font-semibold">{a.name}</p>
                      <SubmitButton variant="ghost" className="shrink-0" confirm={`Remove ${a.name} from this case?`}>
                        Remove
                      </SubmitButton>
                    </div>
                  </ActionForm>
                ))
              )}
            </div>
          );
        })}
        {approved > 0 && appearances.length > 0 ? (
          <p className="mt-2 text-xs text-muted">This case has approved events, so changing who&apos;s on it changes points in weeks that aren&apos;t finalized.</p>
        ) : null}
      </Card>

      <Card>
        <CardTitle>Add a lawyer or firm</CardTitle>
        {available.length === 0 ? (
          <p className="text-sm text-muted">Everyone in the pool is already on this case.</p>
        ) : (
          <ActionForm action={addAppearanceAction.bind(null, leagueId, caseId)} resetOnSuccess>
            <Field label="Who">
              <Select name="lawyerId" defaultValue="" required>
                <option value="" disabled>
                  Pick a lawyer or firm
                </option>
                <optgroup label="Lawyers">
                  {available
                    .filter((o) => o.kind === "lawyer")
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({POSITION_SHORT[o.position]})
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Firms">
                  {available
                    .filter((o) => o.kind === "firm")
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </optgroup>
              </Select>
            </Field>
            <Field label="Side">
              <Select name="side" defaultValue="" required>
                <option value="" disabled>
                  Pick a side
                </option>
                {SIDES.map((s) => (
                  <option key={s} value={s}>
                    {sideLabel(c.caseType, s)}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton className="w-full">Add to case</SubmitButton>
          </ActionForm>
        )}
      </Card>

      <Card>
        <CardTitle action={<LinkButton href={`${base}/events/new?caseId=${caseId}`} variant="ghost">+ Event</LinkButton>}>Scoring events</CardTitle>
        {events.length === 0 ? (
          <EmptyState title="No events yet">Add one when something happens in this case.</EmptyState>
        ) : (
          events.map((e) => (
            <ListRow key={e.id} href={`${base}/events/${e.id}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{eventLabel(e.type)}</p>
                <p className="truncate text-sm text-muted">
                  {formatDate(e.occurredOn)}
                  {e.side && c ? ` · ${sideLabel(c.caseType, e.side)}` : e.lawyerName ? ` · ${e.lawyerName}` : ""}
                </p>
              </div>
              <Badge tone={e.status === "approved" ? "pos" : e.status === "rejected" ? "neg" : "warn"}>{STATUS_LABELS[e.status]}</Badge>
            </ListRow>
          ))
        )}
      </Card>

      <Disclosure summary="Edit case details">
        <ActionForm action={updateCaseAction.bind(null, leagueId, caseId)}>
          <CaseFields d={c} />
          <SubmitButton className="w-full">Save case</SubmitButton>
        </ActionForm>
      </Disclosure>

      <Card>
        <CardTitle>Delete case</CardTitle>
        {approved > 0 ? (
          <p className="text-sm text-muted">
            This case has approved scoring events, so it can&apos;t be deleted. Mark it closed instead, or move its events back to pending first.
          </p>
        ) : (
          <ActionForm action={deleteCaseAction.bind(null, leagueId, caseId)}>
            <p className="text-sm text-muted">Removes the case, its lawyer list and any pending or rejected events.</p>
            <SubmitButton variant="danger" className="w-full" confirm={`Delete ${c.caption}? This can't be undone.`}>
              Delete case
            </SubmitButton>
          </ActionForm>
        )}
      </Card>
    </Page>
  );
}
