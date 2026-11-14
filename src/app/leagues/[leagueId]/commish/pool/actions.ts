"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { isUuid, plural } from "@/lib/format";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext, canManagePool } from "@/server/league-context";
import {
  addAppearance,
  createCase,
  createFirm,
  createLawyer,
  deleteCase,
  deleteLawyer,
  importAppearances,
  importCases,
  importLawyers,
  removeAppearance,
  updateCase,
  updateFirm,
  updateLawyer,
} from "@/server/services/pool";
import { formatCsvErrors, parseAppearancesCsv, parseCasesCsv, parseLawyersCsv, type ImportKind } from "./csv";
import { parseAppearanceForm, parseCaseForm, parseFirmForm, parseLawyerForm, type ParseResult } from "./pool-rules";

/** Commissioner of this league who may manage its pool. Returns the pool id. */
async function poolAccess(leagueId: string): Promise<string> {
  if (!isUuid(leagueId)) throw new UserError("League not found.");
  const ctx = await actionLeagueContext(leagueId, { commissioner: true });
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) throw new UserError("You can't manage this player pool.");
  return ctx.league.poolId;
}

function unwrap<T>(r: ParseResult<T>): T {
  if (!r.ok) throw new UserError(r.error);
  return r.data;
}

function requireId(id: string): string {
  if (!isUuid(id)) throw new UserError("Something was off with that request. Refresh and try again.");
  return id;
}

/** The pool is shared by every league that uses it, so refresh all league pages. */
function refreshPool(): void {
  revalidatePath("/leagues/[leagueId]", "layout");
}

const poolPath = (leagueId: string, sub = "") => `/leagues/${leagueId}/commish/pool${sub}`;

// ---------------------------------------------------------------------------
// Lawyers & firms
// ---------------------------------------------------------------------------

export async function createLawyerAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const l = await createLawyer(db, poolId, unwrap(parseLawyerForm(formData)));
    refreshPool();
    return ok(`Added ${l.name}.`);
  });
}

export async function updateLawyerAction(leagueId: string, lawyerId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    await updateLawyer(db, poolId, requireId(lawyerId), unwrap(parseLawyerForm(formData)));
    refreshPool();
    return ok("Saved.");
  });
}

export async function createFirmAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const f = await createFirm(db, poolId, unwrap(parseFirmForm(formData)));
    refreshPool();
    return ok(`Added ${f.name}.`);
  });
}

export async function updateFirmAction(leagueId: string, firmId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    await updateFirm(db, poolId, requireId(firmId), unwrap(parseFirmForm(formData)));
    refreshPool();
    return ok("Saved.");
  });
}

export async function deleteLawyerAction(leagueId: string, lawyerId: string): Promise<ActionResult> {
  const out: { kind: "lawyer" | "firm" } = { kind: "lawyer" };
  const result = await runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const deleted = await deleteLawyer(db, poolId, requireId(lawyerId));
    out.kind = deleted.kind;
    refreshPool();
    return ok();
  });
  if (!result.ok) return result;
  redirect(poolPath(leagueId, out.kind === "firm" ? "/firms" : ""));
}

// ---------------------------------------------------------------------------
// Cases & appearances
// ---------------------------------------------------------------------------

export async function createCaseAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  let caseId = "";
  const result = await runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const c = await createCase(db, poolId, unwrap(parseCaseForm(formData)));
    caseId = c.id;
    refreshPool();
    return ok();
  });
  if (!result.ok) return result;
  // Next step: add the lawyers on each side.
  redirect(poolPath(leagueId, `/cases/${caseId}?created=1`));
}

export async function updateCaseAction(leagueId: string, caseId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    await updateCase(db, poolId, requireId(caseId), unwrap(parseCaseForm(formData)));
    refreshPool();
    return ok("Case saved.");
  });
}

export async function deleteCaseAction(leagueId: string, caseId: string): Promise<ActionResult> {
  const result = await runAction(async () => {
    const poolId = await poolAccess(leagueId);
    await deleteCase(db, poolId, requireId(caseId));
    refreshPool();
    return ok();
  });
  if (!result.ok) return result;
  redirect(poolPath(leagueId, "/cases"));
}

export async function addAppearanceAction(leagueId: string, caseId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const input = unwrap(parseAppearanceForm(formData));
    const { lawyerName } = await addAppearance(db, poolId, { caseId: requireId(caseId), ...input });
    refreshPool();
    return ok(`Added ${lawyerName}.`);
  });
}

export async function removeAppearanceAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const raw = formData.get("appearanceId");
    const { lawyerName } = await removeAppearance(db, poolId, requireId(typeof raw === "string" ? raw : ""));
    refreshPool();
    return ok(`Removed ${lawyerName} from this case.`);
  });
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export async function importCsvAction(leagueId: string, kind: ImportKind, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const poolId = await poolAccess(leagueId);
    const raw = formData.get("csv");
    const text = typeof raw === "string" ? raw : "";
    if (text.length > 500_000) throw new UserError("That's too much text. Import in smaller batches.");

    if (kind === "lawyers") {
      const { rows, errors } = parseLawyersCsv(text);
      if (errors.length) throw new UserError(`Nothing imported. ${formatCsvErrors(errors)}`);
      if (!rows.length) throw new UserError("Paste at least one lawyer row.");
      const r = await importLawyers(db, poolId, rows);
      if (r.problems.length) throw new UserError(`Nothing imported. ${formatCsvErrors(r.problems)}`);
      refreshPool();
      const parts = [`Imported ${plural(r.created, "lawyer")}`];
      if (r.firmsCreated) parts.push(`created ${plural(r.firmsCreated, "firm")}`);
      return ok(`${parts.join(" and ")}.${r.skipped.length ? ` Skipped ${r.skipped.length} already in the pool.` : ""}`);
    }

    if (kind === "cases") {
      const { rows, errors } = parseCasesCsv(text);
      if (errors.length) throw new UserError(`Nothing imported. ${formatCsvErrors(errors)}`);
      if (!rows.length) throw new UserError("Paste at least one case row.");
      const r = await importCases(db, poolId, rows);
      refreshPool();
      return ok(`Imported ${plural(r.created, "case")}.${r.skipped.length ? ` Skipped ${r.skipped.length} already in the pool.` : ""}`);
    }

    if (kind === "appearances") {
      const { rows, errors } = parseAppearancesCsv(text);
      if (errors.length) throw new UserError(`Nothing imported. ${formatCsvErrors(errors)}`);
      if (!rows.length) throw new UserError("Paste at least one appearance row.");
      const r = await importAppearances(db, poolId, rows);
      if (r.problems.length) throw new UserError(`Nothing imported. ${formatCsvErrors(r.problems)}`);
      refreshPool();
      return ok(`Added ${plural(r.created, "appearance")}.${r.skipped ? ` Skipped ${r.skipped} that were already there.` : ""}`);
    }

    throw new UserError("Pick what to import.");
  });
}
