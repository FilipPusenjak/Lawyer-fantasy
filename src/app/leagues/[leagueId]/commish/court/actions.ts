"use server";

/**
 * Commissioner court-data actions: sync a case, link/unlink CourtListener
 * dockets, search CourtListener, add a case or lawyer from a search result,
 * auto-link pool cases and test the connection.
 *
 * CourtListener calls only happen here, when the commissioner submits a form
 * (its free quota is shared by the whole app). Errors from the client are
 * mapped to friendly text; raw API errors never reach the browser.
 */
import { revalidatePath } from "next/cache";
import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, type DbOrTx } from "@/db";
import { cases } from "@/db/schema";
import { isUuid, plural } from "@/lib/format";
import { CASE_TYPES, sideLabel, SIDES } from "@/lib/settings";
import { fail, ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { checkConnection, courtListenerConfigured, searchDockets, type ClDocket } from "@/server/court/courtlistener";
import { autoLinkPoolCases, linkCaseToDocket, syncCase, syncSourceForCase } from "@/server/services/court-sync";
import { actionLeagueContext, canManagePool } from "@/server/league-context";
import { addAppearance, createCase, createFirm, createLawyer, getPoolCase, type IndividualPosition } from "@/server/services/pool";
import { CAPTION_MAX, COURT_MAX, DOCKET_MAX, INDIVIDUAL_POSITIONS, NAME_MAX } from "../pool/pool-rules";
import { loadCourtCases } from "./court-data";
import {
  AUTO_LINK_BATCH,
  CONNECT_MESSAGE,
  courtErrorMessage,
  courtLabel,
  courtListenerDocketUrl,
  findPoolMatch,
  isCourtListenerUrl,
  listWithMore,
  parseCourtInput,
  SYNC_COOLDOWN_MS,
  syncResultMessage,
  type CaseSearchData,
  type CourtSearchData,
  type PoolCaseRef,
  type SyncSummary,
} from "./court-rules";

const BAD_REQUEST = "Something was off with that request. Refresh and try again.";
const MAX_DOCKET_ID = 2_147_483_647;

/** Commissioner of this league who may manage its pool. Returns the pool id. */
async function poolAccess(leagueId: string): Promise<string> {
  if (!isUuid(leagueId)) throw new UserError("League not found.");
  const ctx = await actionLeagueContext(leagueId, { commissioner: true });
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) throw new UserError("You can't manage this player pool.");
  return ctx.league.poolId;
}

function requireId(id: string): string {
  if (!isUuid(id)) throw new UserError(BAD_REQUEST);
  return id;
}

function requireConfigured(): void {
  if (!courtListenerConfigured()) throw new UserError(CONNECT_MESSAGE);
}

function str(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

function firstIssue(e: z.ZodError, fallback = BAD_REQUEST): string {
  return e.issues[0]?.message || fallback;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** The pool is shared by every league that uses it, so refresh all league pages. */
function refreshPool(): void {
  revalidatePath("/leagues/[leagueId]", "layout");
}

/**
 * Run a court-data call, turning CourtListener errors (429 etc.) into friendly
 * UserErrors. Unknown errors are logged on the server and replaced with a
 * generic message, so nothing raw (or secret) reaches the client.
 */
async function callCourt<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UserError) throw e;
    const friendly = courtErrorMessage(e);
    if (friendly) throw new UserError(friendly);
    console.error(`Court data: ${what} failed`, e);
    throw new UserError(`${what} didn't work this time. Try again in a few minutes.`);
  }
}

/** Only the documented fields, so nothing extra from the API is sent to the browser. */
function pickDocket(d: ClDocket): ClDocket {
  return {
    docketId: d.docketId,
    caseName: d.caseName,
    docketNumber: d.docketNumber,
    court: d.court,
    courtId: d.courtId,
    dateFiled: d.dateFiled ?? null,
    dateTerminated: d.dateTerminated ?? null,
    url: isCourtListenerUrl(d.url) ? d.url : courtListenerDocketUrl(d.docketId, d.caseName),
    attorneys: (d.attorneys ?? []).slice(0, 60),
    firms: (d.firms ?? []).slice(0, 60),
    parties: (d.parties ?? []).slice(0, 20),
  };
}

/** Throws if another case in the pool is already linked to this docket. */
async function assertDocketFree(tx: DbOrTx, poolId: string, docketId: number, exceptCaseId?: string): Promise<void> {
  const conds: SQL[] = [eq(cases.poolId, poolId), eq(cases.courtlistenerDocketId, docketId)];
  if (exceptCaseId) conds.push(ne(cases.id, exceptCaseId));
  const [hit] = await tx.select({ caption: cases.caption }).from(cases).where(and(...conds)).limit(1);
  if (hit) throw new UserError(`That docket is already linked to ${hit.caption}.`);
}

const docketIdSchema = z.coerce.number().int().positive().max(MAX_DOCKET_ID);
const idSchema = z.string().refine(isUuid);

// ---------------------------------------------------------------------------
// Case page: sync, link, unlink, find
// ---------------------------------------------------------------------------

/** "Sync now" on a case page (Supreme Court feed or CourtListener). */
export async function syncCaseAction(leagueId: string, caseId: string): Promise<ActionResult<SyncSummary>> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const c = await getPoolCase(db, poolId, requireId(caseId));
    if (!c) throw new UserError("That case isn't in this pool.");
    if (syncSourceForCase(c) !== "scotus") {
      if (c.courtlistenerDocketId == null) throw new UserError("Link this case to a CourtListener docket first.");
      requireConfigured();
      if (c.syncedAt && Date.now() - c.syncedAt.getTime() < SYNC_COOLDOWN_MS) {
        throw new UserError("This case synced less than a minute ago. CourtListener's free limit is shared by the whole app, so give it a minute.");
      }
    }
    const r = await callCourt("Sync", () => syncCase(db, c.id));
    refreshPool();
    if (r.error && r.newEntries === 0 && r.suggestions === 0) return fail(`Sync didn't finish: ${r.error}`);
    return ok(syncResultMessage(r), { newEntries: r.newEntries, suggestions: r.suggestions, error: r.error ?? null });
  });
}

/** Link a pool case to a CourtListener docket (case page result list and Court data page). */
export async function linkDocketAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const parsed = z.object({ caseId: idSchema, docketId: docketIdSchema }).safeParse({
      caseId: str(formData, "caseId"),
      docketId: str(formData, "docketId"),
    });
    if (!parsed.success) throw new UserError(BAD_REQUEST);
    const { caseId, docketId } = parsed.data;
    const c = await getPoolCase(db, poolId, caseId);
    if (!c) throw new UserError("That case isn't in this pool.");
    if (c.courtlistenerDocketId === docketId) return ok("Already linked.");
    await assertDocketFree(db, poolId, docketId, caseId);
    await callCourt("Linking", () => linkCaseToDocket(db, poolId, caseId, docketId));
    refreshPool();
    return ok("Linked to CourtListener. New filings will show up in the review queue after the next sync.");
  });
}

export async function unlinkDocketAction(leagueId: string, caseId: string): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const c = await getPoolCase(db, poolId, requireId(caseId));
    if (!c) throw new UserError("That case isn't in this pool.");
    if (c.courtlistenerDocketId == null) return ok("This case isn't linked.");
    await callCourt("Unlinking", () => linkCaseToDocket(db, poolId, c.id, null));
    refreshPool();
    return ok("Unlinked from CourtListener.");
  });
}

const caseSearchSchema = z.object({
  docketNumber: z.string().trim().max(DOCKET_MAX, `Docket numbers can be at most ${DOCKET_MAX} characters.`),
  caseName: z.string().trim().max(CAPTION_MAX, `Captions can be at most ${CAPTION_MAX} characters.`),
  court: z.string().trim().max(80, "That court name is too long."),
});

/** "Find on CourtListener" on a case page. One API request. */
export async function findCaseDocketsAction(
  leagueId: string,
  caseId: string,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<CaseSearchData>> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const c = await getPoolCase(db, poolId, requireId(caseId));
    if (!c) throw new UserError("That case isn't in this pool.");
    requireConfigured();
    const parsed = caseSearchSchema.safeParse({
      docketNumber: str(formData, "docketNumber"),
      caseName: str(formData, "caseName"),
      court: str(formData, "court"),
    });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    const { docketNumber, caseName } = parsed.data;
    if (!docketNumber && caseName.length < 3) throw new UserError("Enter a docket number or a few words of the caption.");
    const court = parseCourtInput(parsed.data.court);
    if (!court.ok) throw new UserError(court.error);

    const dockets = (
      await callCourt("The search", () =>
        searchDockets({ docketNumber: docketNumber || undefined, caseName: caseName || undefined, courtId: court.courtId }),
      )
    ).map(pickDocket);
    const ids = dockets.map((d) => d.docketId);
    const linkedRows =
      ids.length === 0
        ? []
        : await db
            .select({ id: cases.id, caption: cases.caption, docketId: cases.courtlistenerDocketId })
            .from(cases)
            .where(and(eq(cases.poolId, poolId), inArray(cases.courtlistenerDocketId, ids)));
    return ok(undefined, {
      results: dockets.map((d) => {
        const l = linkedRows.find((r) => r.docketId === d.docketId);
        return { docket: d, linkedTo: l ? { id: l.id, caption: l.caption } : null };
      }),
      bothFields: !!docketNumber && !!caseName,
    });
  });
}

// ---------------------------------------------------------------------------
// Pool page: auto-link
// ---------------------------------------------------------------------------

/** Captions for case ids (strings that aren't ids are shown as they are). */
async function captionsFor(poolId: string, refs: string[]): Promise<string[]> {
  const ids = refs.filter(isUuid);
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: cases.id, caption: cases.caption })
          .from(cases)
          .where(and(eq(cases.poolId, poolId), inArray(cases.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r.caption]));
  return refs.map((r) => byId.get(r) ?? r);
}

/** "Auto-link next 5": match unlinked federal cases to dockets by docket number. */
export async function autoLinkAction(leagueId: string): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    requireConfigured();
    const r = await callCourt("Auto-link", () => autoLinkPoolCases(db, poolId, { max: AUTO_LINK_BATCH }));
    refreshPool();
    const parts = [r.linked.length > 0 ? `Linked ${plural(r.linked.length, "case")}.` : "No new links."];
    if (r.notFound.length > 0) parts.push(`Not found on CourtListener: ${listWithMore(await captionsFor(poolId, r.notFound))}.`);
    parts.push(r.remaining > 0 ? `${plural(r.remaining, "case")} still to check.` : "Every case has been checked.");
    return ok(parts.join(" "));
  });
}

// ---------------------------------------------------------------------------
// Court data page: search by attorney/firm, add case, add lawyer, test connection
// ---------------------------------------------------------------------------

const courtSearchSchema = z.object({
  mode: z.enum(["attorney", "firm"], { error: "Pick attorney or firm." }),
  name: z
    .string()
    .trim()
    .min(2, "Enter at least two letters of the name.")
    .max(NAME_MAX, `Names can be at most ${NAME_MAX} characters.`),
  court: z.string().trim().max(80, "That court name is too long."),
});

/** Search CourtListener dockets by attorney or firm name. One API request. */
export async function searchCourtAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult<CourtSearchData>> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    requireConfigured();
    const parsed = courtSearchSchema.safeParse({ mode: str(formData, "mode"), name: str(formData, "name"), court: str(formData, "court") });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    const { mode, name } = parsed.data;
    const court = parseCourtInput(parsed.data.court);
    if (!court.ok) throw new UserError(court.error);

    const dockets = (
      await callCourt("The search", () =>
        searchDockets(mode === "attorney" ? { attorney: name, courtId: court.courtId } : { firm: name, courtId: court.courtId }),
      )
    ).map(pickDocket);
    const poolCases = dockets.length === 0 ? [] : await loadCourtCases(db, poolId);
    return ok(undefined, {
      mode,
      name,
      results: dockets.map((d) => ({ docket: d, poolCase: findPoolMatch(d, poolCases) })),
    });
  });
}

const isoDateOrBlank = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]);

const addCaseSchema = z.object({
  docketId: docketIdSchema,
  caseName: z.string().trim().min(1).max(2000),
  docketNumber: z.string().trim().max(200),
  courtId: z.string().trim().max(30),
  courtName: z.string().trim().max(300),
  dateFiled: isoDateOrBlank,
  dateTerminated: isoDateOrBlank,
  url: z.string().trim().max(500),
  caseType: z.enum(CASE_TYPES, { error: "Pick the case type." }),
});

/** "Add case" from a search result: creates the pool case and links it to the docket. */
export async function addCaseFromDocketAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult<PoolCaseRef>> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const parsed = addCaseSchema.safeParse({
      docketId: str(formData, "docketId"),
      caseName: str(formData, "caseName"),
      docketNumber: str(formData, "docketNumber"),
      courtId: str(formData, "courtId"),
      courtName: str(formData, "courtName"),
      dateFiled: str(formData, "dateFiled").slice(0, 10),
      dateTerminated: str(formData, "dateTerminated").slice(0, 10),
      url: str(formData, "url"),
      caseType: str(formData, "caseType"),
    });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    const d = parsed.data;
    const caption = clip(d.caseName, CAPTION_MAX);
    const court = clip((d.courtId && courtLabel(d.courtId)) || d.courtName || d.courtId, COURT_MAX);
    if (caption.length < 3 || court.length < 2) {
      throw new UserError("CourtListener didn't give enough details for this docket. Add the case by hand on the Cases tab.");
    }
    const status = d.dateTerminated ? "closed" : "active";
    const created = await callCourt("Adding the case", () =>
      db.transaction(async (tx) => {
        await assertDocketFree(tx, poolId, d.docketId);
        const c = await createCase(tx, poolId, {
          caption,
          court,
          docketNumber: d.docketNumber ? clip(d.docketNumber, DOCKET_MAX) : null,
          caseType: d.caseType,
          status,
          filedOn: d.dateFiled || null,
          sourceUrl: isCourtListenerUrl(d.url) ? d.url : courtListenerDocketUrl(d.docketId, d.caseName),
        });
        await linkCaseToDocket(tx, poolId, c.id, d.docketId);
        return c;
      }),
    );
    refreshPool();
    return ok(`Added ${created.caption}${status === "closed" ? " as closed (the docket is terminated)" : ""}. Now add its lawyers.`, {
      id: created.id,
      caption: created.caption,
      caseType: created.caseType,
      linkedDocketId: d.docketId,
    });
  });
}

const addLawyerSchema = z.object({
  caseId: idSchema,
  who: z.union([idSchema, z.literal("new-lawyer"), z.literal("new-firm")], { error: "Pick a lawyer or firm." }),
  name: z.string().trim().max(NAME_MAX, `Names can be at most ${NAME_MAX} characters.`),
  position: z.string(),
  firmChoice: z.union([idSchema, z.literal(""), z.literal("new")], { error: "Pick a firm from the list." }),
  newFirmName: z.string().trim().max(NAME_MAX, `Names can be at most ${NAME_MAX} characters.`),
  side: z.enum(SIDES, { error: "Pick a side." }),
});

/** "Add lawyer to this case": an existing pool lawyer/firm, or a new one (optionally with a new firm). */
export async function addLawyerToCaseAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const parsed = addLawyerSchema.safeParse({
      caseId: str(formData, "caseId"),
      who: str(formData, "who"),
      name: str(formData, "name"),
      position: str(formData, "position"),
      firmChoice: str(formData, "firmChoice"),
      newFirmName: str(formData, "newFirmName"),
      side: str(formData, "side"),
    });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    const d = parsed.data;
    const c = await getPoolCase(db, poolId, d.caseId);
    if (!c) throw new UserError("That case isn't in this pool.");
    const name = d.name.replace(/\s+/g, " ");

    const lawyerName = await db.transaction(async (tx) => {
      let lawyerId: string;
      if (d.who === "new-firm") {
        if (name.length < 2) throw new UserError("Enter the firm's name.");
        lawyerId = (await createFirm(tx, poolId, { name, organization: null, preseasonRank: null })).id;
      } else if (d.who === "new-lawyer") {
        if (name.length < 2) throw new UserError("Enter the lawyer's name.");
        if (!(INDIVIDUAL_POSITIONS as string[]).includes(d.position)) throw new UserError("Pick a position.");
        let firmId: string | null = null;
        if (d.firmChoice === "new") {
          const firmName = d.newFirmName.replace(/\s+/g, " ");
          if (firmName.length < 2) throw new UserError("Enter the new firm's name.");
          firmId = (await createFirm(tx, poolId, { name: firmName, organization: null, preseasonRank: null })).id;
        } else if (d.firmChoice) {
          firmId = d.firmChoice;
        }
        lawyerId = (
          await createLawyer(tx, poolId, {
            name,
            position: d.position as IndividualPosition,
            firmId,
            organization: null,
            preseasonRank: null,
          })
        ).id;
      } else {
        lawyerId = d.who;
      }
      return (await addAppearance(tx, poolId, { caseId: c.id, lawyerId, side: d.side })).lawyerName;
    });
    refreshPool();
    return ok(`Added ${lawyerName} to ${c.caption} (${sideLabel(c.caseType, d.side)}).`);
  });
}

/** "Test connection": checks the token via CourtListener's api-usage endpoint (separate throttle). */
export async function testConnectionAction(leagueId: string): Promise<ActionResult> {
  return runAction(async () => {
    await poolAccess(leagueId);
    if (!courtListenerConfigured()) return fail(CONNECT_MESSAGE);
    const r = await callCourt("The connection test", () => checkConnection());
    return r.ok ? ok(r.detail || "Connected to CourtListener.") : fail(r.detail || "CourtListener didn't accept the connection.");
  });
}
