import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, CardTitle, Field, Input, Notice, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { getCommissionerContext } from "@/server/league-context";
import { listLeagueMembers, loadAdminLeague, TEAM_NAME_MAX, TEAM_NAME_MIN, type MemberRow } from "@/server/services/settings-admin";
import { PASSWORD_MIN } from "@/app/account/rules";
import { inviteUrl } from "../../more/invite-url";
import { ShareInvite } from "../../more/share-invite";
import { regenerateCodeAction, removeMemberAction, renameTeamAction, setRoleAction, setTempPasswordAction } from "./actions";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: PageProps<"/leagues/[leagueId]/commish/members">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  const [members, admin, url] = await Promise.all([
    listLeagueMembers(db, leagueId),
    loadAdminLeague(db, leagueId),
    inviteUrl(ctx.league.inviteCode),
  ]);
  const canRemove = !admin.locks.removeMembers;
  const commissioners = members.filter((m) => m.role === "commissioner").length;

  return (
    <Page className="space-y-4">
      <Link href={`/leagues/${leagueId}/commish`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
        ‹ Commissioner
      </Link>
      <PageHeader
        title="Members"
        subtitle={`${members.length} of ${admin.settings.maxTeams} teams · ${commissioners} commissioner${commissioners === 1 ? "" : "s"}`}
      />

      <Card>
        <CardTitle>Invite code</CardTitle>
        {ctx.league.status === "setup" ? (
          <ShareInvite code={ctx.league.inviteCode} url={url} leagueName={ctx.league.name} />
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-2xl font-bold tracking-widest">{ctx.league.inviteCode}</p>
            <p className="break-all text-xs text-muted">{url}</p>
            <p className="text-sm text-muted">The draft has started, so new teams can&apos;t join anymore.</p>
          </div>
        )}
        <ActionForm action={regenerateCodeAction.bind(null, leagueId)} className="mt-3 space-y-3">
          <SubmitButton variant="secondary" className="w-full" confirm="Make a new invite code? The old code and link will stop working.">
            Make a new code
          </SubmitButton>
        </ActionForm>
      </Card>

      <Card>
        <CardTitle>Teams & roles</CardTitle>
        <p className="mb-2 text-sm text-muted">
          Co-commissioners can approve scoring events and change settings.
          {canRemove ? " Members can be removed until the draft starts." : " Members can't be removed after the draft starts."}
        </p>
        <div>
          {members.map((m) => (
            <MemberItem
              key={m.userId}
              leagueId={leagueId}
              member={m}
              isMe={m.userId === ctx.user.id}
              canRemove={canRemove}
              isSiteAdmin={ctx.user.isAdmin}
            />
          ))}
        </div>
      </Card>
    </Page>
  );
}

function MemberItem({
  leagueId,
  member: m,
  isMe,
  canRemove,
  isSiteAdmin,
}: {
  leagueId: string;
  member: MemberRow;
  isMe: boolean;
  canRemove: boolean;
  isSiteAdmin: boolean;
}) {
  return (
    <details className="group border-b border-line py-2 last:border-b-0">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{m.teamName ?? "No team"}</p>
          <p className="truncate text-sm text-muted">
            {m.displayName} · @{m.username}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {isMe ? <Badge tone="brand">You</Badge> : null}
          {m.isCreator ? <Badge tone="accent">Creator</Badge> : m.role === "commissioner" ? <Badge tone="accent">Commish</Badge> : null}
        </div>
        <span className="text-muted transition group-open:rotate-90" aria-hidden>
          ›
        </span>
      </summary>

      <div className="space-y-4 pb-2 pt-3">
        {m.teamId ? (
          <ActionForm action={renameTeamAction.bind(null, leagueId)}>
            <input type="hidden" name="teamId" value={m.teamId} />
            <Field label="Team name" hint={`${TEAM_NAME_MIN}–${TEAM_NAME_MAX} characters`}>
              <div className="flex gap-2">
                <Input name="name" defaultValue={m.teamName ?? ""} minLength={TEAM_NAME_MIN} maxLength={TEAM_NAME_MAX} required />
                <SubmitButton variant="secondary">Rename</SubmitButton>
              </div>
            </Field>
          </ActionForm>
        ) : null}

        {m.isCreator ? (
          <p className="text-sm text-muted">The league creator is always a commissioner and can&apos;t be removed.</p>
        ) : (
          <ActionForm action={setRoleAction.bind(null, leagueId)}>
            <input type="hidden" name="userId" value={m.userId} />
            {m.role === "commissioner" ? (
              <>
                <input type="hidden" name="role" value="member" />
                <SubmitButton
                  variant="secondary"
                  className="w-full"
                  disabled={isMe}
                  confirm={`Remove ${m.displayName}'s commissioner powers?`}
                >
                  Remove co-commissioner
                </SubmitButton>
                {isMe ? <p className="text-xs text-muted">Another commissioner has to remove your role.</p> : null}
              </>
            ) : (
              <>
                <input type="hidden" name="role" value="commissioner" />
                <SubmitButton variant="secondary" className="w-full">
                  Make co-commissioner
                </SubmitButton>
              </>
            )}
          </ActionForm>
        )}

        {canRemove && !m.isCreator && !isMe ? (
          <ActionForm action={removeMemberAction.bind(null, leagueId)}>
            <input type="hidden" name="userId" value={m.userId} />
            <SubmitButton
              variant="danger"
              className="w-full"
              confirm={`Remove ${m.displayName} and their team "${m.teamName ?? ""}" from the league?`}
            >
              Remove from league
            </SubmitButton>
          </ActionForm>
        ) : null}

        {isSiteAdmin && !isMe ? (
          <ActionForm action={setTempPasswordAction.bind(null, leagueId)} resetOnSuccess>
            <input type="hidden" name="userId" value={m.userId} />
            <Field label="Set a temporary password" hint="Admin only. Share it in person, never in a group chat. They'll be signed out everywhere.">
              <div className="flex gap-2">
                <Input type="text" name="password" minLength={PASSWORD_MIN} autoComplete="off" autoCapitalize="off" spellCheck={false} required />
                <SubmitButton variant="secondary">Set</SubmitButton>
              </div>
            </Field>
          </ActionForm>
        ) : null}
        {isSiteAdmin && isMe ? <Notice>Change your own password on your account page.</Notice> : null}
      </div>
    </details>
  );
}
