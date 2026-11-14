import { describe, expect, it } from "vitest";
import { classifyDocketEntry, sideFromFragment, type ClassifyOptions } from "@/lib/court/classify";
import { partiesFromCaption } from "@/lib/court/text";

const acme: ClassifyOptions = { caseType: "civil", parties: { plaintiff: ["Jane Doe"], defendant: ["Acme Corp."] } };
const liveNation: ClassifyOptions = { caseType: "civil", parties: partiesFromCaption("United States v. Live Nation Entertainment, Inc.") };
const perkins: ClassifyOptions = { caseType: "civil", parties: partiesFromCaption("Perkins Coie LLP v. U.S. Department of Justice") };
const heppner: ClassifyOptions = { caseType: "criminal", parties: partiesFromCaption("United States v. Heppner") };

function cls(text: string, opts: ClassifyOptions = acme) {
  return classifyDocketEntry(text, opts);
}
function expectEvent(text: string, type: string, side: "plaintiff" | "defendant" | null, opts: ClassifyOptions = acme) {
  const c = cls(text, opts);
  expect(c, text).toMatchObject({ skip: false, type, side });
}
function expectSkip(text: string, opts: ClassifyOptions = acme) {
  const c = cls(text, opts);
  expect(c.skip, `${text} → ${JSON.stringify(c)}`).toBe(true);
}

describe("clerical noise is skipped", () => {
  it.each([
    "NOTICE of Appearance by John Smith on behalf of Acme Corp. (Smith, John) (Entered: 01/02/2026)",
    "NOTICE OF APPEARANCE of Andrew M. Gass on behalf of Live Nation Entertainment, Inc.. (Gass, Andrew)",
    "MOTION for Leave to Appear Pro Hac Vice ( Filing fee $ 150, receipt number ANYSDC-123.) by Acme Corp.",
    "ORDER granting 15 Motion for Leave to Appear Pro Hac Vice. Signed by Judge Arun Subramanian on 1/2/2026. (jw)",
    "TRANSCRIPT of Proceedings re: Conference held on 10/1/2026 before Judge X. Court Reporter: Jane Roe.",
    "CERTIFICATE OF SERVICE by Jane Doe re 12 Memorandum in Opposition (Doe, Jane)",
    "SUMMONS Returned Executed by Jane Doe. Acme Corp. served on 1/5/2026, answer due 1/26/2026.",
    "Summons Issued as to Acme Corp. (aa)",
    "CORPORATE DISCLOSURE STATEMENT by Acme Corp. identifying Corporate Parent Holdings Inc. (Smith, John)",
    "RULE 7.1 CORPORATE DISCLOSURE STATEMENT. Document filed by Acme Corp..(Smith, John)",
    "SCHEDULING ORDER: Discovery due by 6/1/2027. Signed by Judge X on 11/2/2026.",
    "Set/Reset Hearings: Status Conference set for 12/3/2026 10:00 AM before Judge X. (abc)",
    "ORDER setting Status Conference for 12/1/2026. Signed by Judge X.",
    "MOTION for Extension of Time to File Response/Reply as to 42 MOTION to Dismiss by Jane Doe. (Doe, Jane)",
    "ORDER granting 50 Motion for Extension of Time to File Answer. Answer due 2/1/2027.",
    "LETTER MOTION to Adjourn Conference addressed to Judge X from Jane Doe dated 11/1/2026. Document filed by Jane Doe..(Doe, Jane)",
    "MEMO ENDORSEMENT on re: 45 LETTER MOTION to Adjourn Conference. ENDORSEMENT: Application GRANTED. (Signed by Judge X on 11/2/2026)",
    "MOTION to Seal Document by Acme Corp. (Smith, John)",
    "MOTION to Withdraw as Attorney by John Smith. (Smith, John)",
    "DECLARATION of John Smith in Support re 42 MOTION to Dismiss. (Attachments: # 1 Exhibit A)(Smith, John)",
    "EXHIBIT re 42 MOTION to Dismiss by Acme Corp. (Smith, John)",
    "Minute Entry for proceedings held before Judge X: Status Conference held on 11/3/2026. (Court Reporter Jane Roe) (abc)",
    "Telephone Status Conference held on 11/3/2026.",
    "Case Reassigned to Judge Jane Roe. Judge John Doe no longer assigned to the case.",
    "NOTICE of Change of Address by John Smith (Smith, John)",
    "[PROPOSED] ORDER granting Motion to Dismiss by Acme Corp.",
    "JOINT STATUS REPORT by Jane Doe, Acme Corp.. (Doe, Jane)",
    "LETTER addressed to Judge X from John Smith dated 11/5/2026 re: discovery. Document filed by Acme Corp..",
    "Arraignment as to Bradley Heppner (1) Count 1-5 held on 11/1/2025. Plea entered by Bradley Heppner: Not Guilty.",
    "NOTICE of Hearing on Motion 42 MOTION to Dismiss: Motion Hearing set for 12/10/2026.",
    "REPORT AND RECOMMENDATIONS re 42 MOTION to Dismiss: recommends that the motion be granted. Objections due in 14 days.",
    "ORDER TO SHOW CAUSE why sanctions should not be imposed for failure to appear. Response due 12/1/2026.",
    "STIPULATION and Proposed Order extending time to respond to the complaint by Acme Corp.",
    "Motion Hearing held on 11/4/2026 re 42 MOTION to Dismiss. Motion taken under advisement.",
    "ORDER denying as moot 30 Motion to Dismiss in light of the amended complaint.",
    "",
  ])("%s", (text) => expectSkip(text));
});

describe("orders on motions", () => {
  it("credits the moving party named in 'filed by'", () => {
    expectEvent("ORDER granting 42 MOTION to Dismiss filed by Acme Corp. Signed by Judge X on 11/1/2026. (abc)", "motion_granted", "defendant");
    expectEvent("ORDER denying 42 Motion to Compel filed by Jane Doe. (abc)", "motion_denied", "plaintiff");
  });

  it("uses possessives before 'motion'", () => {
    expectEvent("ORDER GRANTING DEFENDANT'S MOTION TO COMPEL ARBITRATION", "motion_granted", "defendant");
    expectEvent("MEMORANDUM OPINION AND ORDER denying Plaintiffs' Motion for Preliminary Injunction.", "motion_denied", "plaintiff");
    expectEvent("ORDER granting the Government's motion in limine to exclude expert testimony.", "motion_granted", "plaintiff", heppner);
    expectEvent("ORDER granting Live Nation's motion to compel production.", "motion_granted", "defendant", liveNation);
  });

  it("ignores parties named as the object of the motion", () => {
    // "Plaintiff's Complaint" is what the motion attacks, not who filed it.
    expectEvent("ORDER granting 42 Motion to Dismiss Plaintiff's Complaint for Failure to State a Claim.", "motion_granted", null);
  });

  it("leaves side null when the mover is unknown", () => {
    expectEvent("ORDER granting 42 Motion to Dismiss. Signed by Judge X.", "motion_granted", null);
    expectEvent("ORDER denying 57 Motion to Stay pending appeal.", "motion_denied", null);
  });

  it("handles passive rulings", () => {
    expectEvent("ORDER: The 42 Motion to Dismiss filed by Acme Corp. is GRANTED. The Clerk is directed to close the case.", "motion_granted", "defendant");
    expectEvent("OPINION AND ORDER: For the reasons stated above, Defendants' motions to dismiss are DENIED.", "motion_denied", "defendant");
  });

  it("dismissal with prejudice on a motion → dismissed_favorable for the mover", () => {
    expectEvent("ORDER granting 42 Motion to Dismiss filed by Acme Corp. The complaint is dismissed with prejudice.", "dismissed_favorable", "defendant");
    expectEvent("ORDER GRANTING DEFENDANTS' MOTION TO DISMISS WITH PREJUDICE", "dismissed_favorable", "defendant");
    expectEvent("ORDER granting 42 Motion to Dismiss filed by Acme Corp. Dismissed without prejudice.", "motion_granted", "defendant");
  });

  it("partial grants are motion_granted", () => {
    const c = cls("ORDER granting in part and denying in part 42 Motion to Dismiss filed by Acme Corp.");
    expect(c).toMatchObject({ skip: false, type: "motion_granted", side: "defendant" });
    if (!c.skip) expect(c.reason).toMatch(/in part/);
  });

  it("summary judgment", () => {
    expectEvent("ORDER granting 88 Motion for Summary Judgment filed by Jane Doe.", "summary_judgment_won", "plaintiff");
    expectEvent("MEMORANDUM AND ORDER granting Defendant's Motion for Summary Judgment. Judgment to follow.", "summary_judgment_won", "defendant");
    expectEvent("ORDER granting 88 Motion for Partial Summary Judgment filed by Jane Doe.", "motion_granted", "plaintiff");
    expectEvent("ORDER denying 88 Motion for Summary Judgment filed by Acme Corp.", "motion_denied", "defendant");
  });

  it("skips a procedural ruling and finds the substantive one in the same order", () => {
    expectEvent("ORDER granting 50 Motion for Extension of Time; denying 42 Motion to Compel filed by Jane Doe.", "motion_denied", "plaintiff");
  });

  it("government dismissing its own counts is not scored; a plaintiff's own dismissal looks like a settlement", () => {
    expectSkip("ORDER granting the Government's motion to dismiss the remaining counts as to Bradley Heppner.", heppner);
    expectEvent("ORDER granting Plaintiff's motion to voluntarily dismiss the action.", "settlement_favorable", null);
    expectEvent("ORDER granting Plaintiff's motion to dismiss Defendant's counterclaims.", "motion_granted", "plaintiff");
  });

  it("minute orders and endorsements", () => {
    expectEvent("MINUTE ORDER: The Court GRANTS 61 Motion to Transfer Venue filed by Acme Corp.", "motion_granted", "defendant");
    expectEvent("Minute Entry for proceedings held before Judge X: Motion Hearing held on 11/4/2026 re 42 MOTION to Dismiss filed by Acme Corp. Motion DENIED for reasons stated on the record.", "motion_denied", "defendant");
  });
});

describe("dismissals and settlements", () => {
  it("court dismissals with prejudice (no motion)", () => {
    expectEvent("ORDER dismissing case with prejudice for failure to prosecute.", "dismissed_favorable", "defendant");
    expectEvent("ORDER dismissing counterclaims with prejudice.", "dismissed_favorable", "plaintiff");
    expectSkip("ORDER dismissing case without prejudice.");
  });

  it.each([
    "STIPULATION of Dismissal with prejudice by Jane Doe, Acme Corp.. (Doe, Jane)",
    "JOINT STIPULATION OF VOLUNTARY DISMISSAL WITH PREJUDICE. Document filed by Jane Doe..",
    "NOTICE of Voluntary Dismissal without prejudice by Jane Doe (Doe, Jane)",
    "NOTICE of Settlement by Acme Corp. (Smith, John)",
    "CONSENT JUDGMENT. Signed by Judge X on 11/1/2026.",
    "ORDER granting 120 Motion for Preliminary Approval of Class Action Settlement.",
    "MOTION for Final Approval of Settlement by Jane Doe. (Doe, Jane)",
    "ORDER OF DISMISSAL: The Court having been advised that the parties have settled, this action is dismissed.",
    "SO ORDERED STIPULATION of dismissal with prejudice. Signed by Judge X.",
    "Minute Entry: Settlement Conference held on 11/2/2026. Case settled.",
    "ORDER dismissing case with prejudice pursuant to the parties' joint stipulation.",
  ])("settlement: %s", (text) => expectEvent(text, "settlement_favorable", null));

  it("settlement conferences and enforcement motions are not settlements", () => {
    expectSkip("Minute Entry: Settlement Conference held on 11/2/2026. No settlement reached.");
    expectEvent("MOTION to Enforce Settlement Agreement by Jane Doe. (Doe, Jane)", "filing", "plaintiff");
  });
});

describe("verdicts", () => {
  it("criminal verdicts", () => {
    expectEvent("JURY VERDICT as to Bradley Heppner (1) Guilty on Count 1-5.", "verdict_win", "plaintiff", heppner);
    expectEvent("JURY VERDICT as to Bradley Heppner (1) Not Guilty on Counts 1-3.", "verdict_win", "defendant", heppner);
    expectEvent("JURY VERDICT as to Bradley Heppner (1) Guilty on Count 1; Not Guilty on Count 2.", "filing", null, heppner);
  });

  it("civil verdicts need an explicit winner", () => {
    expectEvent("JURY VERDICT in favor of Plaintiff Jane Doe against Defendant Acme Corp. in the amount of $1,000,000.", "verdict_win", "plaintiff");
    expectEvent("JURY VERDICT for Defendant.", "verdict_win", "defendant");
    expectEvent("JURY VERDICT in favor of Acme Corp.", "verdict_win", "defendant");
    const c = cls("JURY VERDICT. (Attachments: # 1 Verdict Form)");
    expect(c).toMatchObject({ skip: false, type: "filing", side: null });
    if (!c.skip) expect(c.reason).toMatch(/doesn't say who won/);
  });

  it("minute entries only count when a verdict was actually returned", () => {
    expectEvent("Minute Entry for Jury Trial (Day 6) held on 11/4/2026. Jury verdict reached: Guilty as to all counts.", "verdict_win", "plaintiff", heppner);
    expectSkip("Minute Entry for Jury Trial (Day 4) held on 11/3/2026. Jury deliberations to continue; verdict expected tomorrow.", heppner);
  });
});

describe("pleas", () => {
  it.each([
    "PLEA AGREEMENT as to Bradley Heppner (Attachments: # 1 Rider)",
    "Minute Entry for Change of Plea Hearing as to Bradley Heppner held on 11/2/2026. Plea entered: Guilty as to Count 1.",
    "Minute Entry for proceedings held before Judge X: Change of Plea Hearing held on 11/2/2026. Defendant pleads guilty to Count 2.",
  ])("guilty plea: %s", (text) => expectEvent(text, "guilty_plea", "plaintiff", heppner));

  it("scheduled plea hearings and plea withdrawals are not guilty pleas", () => {
    expectSkip("ORDER setting Change of Plea Hearing as to Bradley Heppner for 12/1/2026.", heppner);
    expectEvent("MOTION to Withdraw Guilty Plea by Bradley Heppner. (Shapiro, Alexandra)", "filing", "defendant", heppner);
  });
});

describe("sanctions", () => {
  it("granting or imposing sanctions → sanctioned with no side (commissioner picks the lawyer)", () => {
    expectEvent("ORDER granting 77 Motion for Sanctions filed by Acme Corp.", "sanctioned", null);
    expectEvent("ORDER imposing sanctions on plaintiff's counsel in the amount of $5,000.", "sanctioned", null);
  });
  it("denying sanctions → motion_denied for the mover", () => {
    expectEvent("ORDER denying 77 Motion for Sanctions filed by Acme Corp.", "motion_denied", "defendant");
  });
  it("a motion for sanctions is a filing", () => {
    expectEvent("MOTION for Sanctions by Defendant Acme Corp. (Smith, John)", "filing", "defendant");
  });
});

describe("judgments", () => {
  it("typed judgments with a winner", () => {
    expectEvent("CLERK'S JUDGMENT: Pursuant to the Order granting summary judgment, judgment is entered in favor of Defendant Acme Corp.", "summary_judgment_won", "defendant");
    expectEvent("JUDGMENT on the jury verdict in favor of Plaintiff Jane Doe against Defendant Acme Corp.", "verdict_win", "plaintiff");
  });
  it("generic judgments ask the commissioner", () => {
    expectEvent("JUDGMENT in favor of Defendant against Plaintiff. Signed by Judge X.", "filing", null);
  });
  it("criminal judgments (sentences) are skipped", () => {
    expectSkip("JUDGMENT as to Bradley Heppner (1), Count(s) 1, Imprisonment 60 months; Supervised release 3 years.", heppner);
  });
});

describe("substantive filings", () => {
  it("motions with the filer's side", () => {
    expectEvent("MOTION to Dismiss for Failure to State a Claim by Acme Corp.. (Attachments: # 1 Proposed Order)(Smith, John) (Entered: 11/02/2026)", "filing", "defendant");
    expectEvent("MOTION to Compel Discovery by Plaintiff Jane Doe. Responses due by 11/20/2026. (Doe, Jane)", "filing", "plaintiff");
    expectEvent("MOTION in Limine to Exclude Testimony by USA as to Bradley Heppner. (Fine, Abraham)", "filing", "plaintiff", heppner);
    expectEvent("MOTION to Suppress by Bradley Heppner. (Shapiro, Alexandra)", "filing", "defendant", heppner);
  });

  it("SDNY 'Document filed by' format", () => {
    expectEvent("MOTION to Dismiss . Document filed by Live Nation Entertainment, Inc..(Gass, Andrew) (Entered: 11/01/2026)", "filing", "defendant", liveNation);
    expectEvent("MEMORANDUM OF LAW in Opposition re: 123 MOTION to Dismiss . . Document filed by United States of America..(Rabinovitz, Brian)", "filing", "plaintiff", liveNation);
  });

  it("responses: the last 'filed by' is the filer", () => {
    expectEvent("RESPONSE in Opposition re 42 MOTION to Dismiss filed by Acme Corp. filed by Jane Doe. (Doe, Jane)", "filing", "plaintiff");
    expectEvent("REPLY to Response to Motion re 42 MOTION to Dismiss filed by Acme Corp.. (Smith, John)", "filing", "defendant");
  });

  it("the government as a defendant (civil suit against an agency)", () => {
    expectEvent("MOTION for Summary Judgment by U.S. DEPARTMENT OF JUSTICE. (Shumate, Brett)", "filing", "defendant", perkins);
    expectEvent("Cross MOTION for Summary Judgment by USA. (Shumate, Brett)", "filing", "defendant", perkins);
    expectEvent("MOTION for Summary Judgment by PERKINS COIE LLP. (Attachments: # 1 Memorandum)", "filing", "plaintiff", perkins);
  });

  it("falls back to the filing attorney when the text doesn't name the filer", () => {
    const opts: ClassifyOptions = { ...acme, attorneys: { plaintiff: ["Jane Q. Doe"], defendant: ["John A. Smith", "Smith & Jones LLP"] } };
    expectEvent("BRIEF in support of motion to compel arbitration (Smith, John) (Entered: 11/02/2026)", "filing", "defendant", opts);
    expectEvent("MEMORANDUM in Support re 42 Motion (Roe, Richard)", "filing", null, opts);
  });

  it("joint and unattributed filings leave side null", () => {
    expectEvent("JOINT MOTION to Approve Class Notice by Jane Doe, Acme Corp.. (Doe, Jane)", "filing", null);
    expectEvent("MOTION for Preliminary Injunction (Attachments: # 1 Exhibit A)", "filing", null);
  });

  it("non-parties and amici don't get a side", () => {
    expectEvent("MOTION to Quash Subpoena by Non-Party Google LLC. (Lee, Ann)", "filing", null);
  });

  it("pleadings and appeals", () => {
    expectEvent("NOTICE OF APPEAL by Acme Corp. Filing fee $ 605. (Smith, John)", "filing", "defendant");
    expectEvent("AMENDED COMPLAINT against Acme Corp. filed by Jane Doe. (Doe, Jane)", "filing", "plaintiff");
    expectEvent("SUPERSEDING INDICTMENT as to Bradley Heppner (1) count(s) 1-6.", "filing", "plaintiff", heppner);
  });

  it("appellate case roles", () => {
    const appeal: ClassifyOptions = { caseType: "appeal", parties: partiesFromCaption("New York Times Co. v. U.S. Department of Defense") };
    expectEvent("BRIEF for Appellant New York Times Co. filed. (Attachments: # 1 Addendum)", "filing", null, appeal); // no "by"/"filed by" filer fragment
    expectEvent("RESPONSE BRIEF filed by Appellee U.S. Department of Defense.", "filing", "defendant", appeal);
    expectEvent("REPLY BRIEF filed by Plaintiff-Appellant New York Times Co.", "filing", "plaintiff", appeal);
  });
});

describe("sideFromFragment", () => {
  it("role words, counter-roles and conflicts", () => {
    expect(sideFromFragment("Defendant Acme Corp.")).toBe("defendant");
    expect(sideFromFragment("Plaintiffs Jane Doe and John Roe")).toBe("plaintiff");
    expect(sideFromFragment("Counter-Defendant Jane Doe")).toBe("plaintiff");
    expect(sideFromFragment("Defendant/Counterclaimant Acme Corp.")).toBe("defendant");
    expect(sideFromFragment("Plaintiff and Defendants")).toBeNull();
    expect(sideFromFragment("Petitioner John Roe")).toBe("plaintiff");
    expect(sideFromFragment("Respondent Warden Smith")).toBe("defendant");
    expect(sideFromFragment("Third-Party Defendant Beta LLC")).toBeNull();
    expect(sideFromFragment("Amicus Curiae Chamber of Commerce")).toBeNull();
  });

  it("government words follow the caption, else the prosecution in criminal cases", () => {
    expect(sideFromFragment("the United States", liveNation)).toBe("plaintiff");
    expect(sideFromFragment("USA", perkins)).toBe("defendant");
    expect(sideFromFragment("the Government", heppner)).toBe("plaintiff");
    expect(sideFromFragment("the Government", acme)).toBeNull();
  });

  it("party names from the caption", () => {
    expect(sideFromFragment("Live Nation Entertainment, Inc. and Ticketmaster L.L.C.", liveNation)).toBe("defendant");
    expect(sideFromFragment("Bradley Heppner", heppner)).toBe("defendant");
    expect(sideFromFragment("Someone Else", acme)).toBeNull();
  });
});
