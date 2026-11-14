/**
 * Demo seed data: static name lists plus pure, seeded generators for the demo
 * pool (lawyers, firms, cases, appearances), scoring events, the draft and
 * lineup variety. No DB access, so it is unit tested in
 * tests/unit/seed-data.test.ts; scripts/seed.ts writes the result to the DB.
 *
 * Everything here is FICTIONAL: invented people, firms, companies, courts and
 * cases. Summaries state neutral facts only.
 */
import { chooseAutoPick, openStarterSlots, snakeSlot, type AutoPickCandidate } from "@/lib/draft";
import { autoFillLineup, type RosterPlayer } from "@/lib/lineup";
import {
  sideLabel,
  starterSlots,
  type CaseType,
  type EventType,
  type Position,
  type RosterSettings,
  type Side,
} from "@/lib/settings";
import { addDays, dateToDayNumber, mondayOnOrBefore, weekOfDate, weekStartDate } from "@/lib/time";

// ---------------------------------------------------------------------------
// Accounts, leagues and teams
// ---------------------------------------------------------------------------

export const DEMO_SEED = 20261114;
export const DEMO_PASSWORD = "demo-pass-2026";
export const DEMO_USERNAME_PREFIX = "demo_";
export const DEMO_POOL_NAME = "Demo Pool (fictional)";
export const DEMO_LEAGUE_NAME = "Demo League (mid-season)";
export const PRACTICE_LEAGUE_NAME = "Draft Practice League";
export const PRACTICE_SECONDS_PER_PICK = 30;
/** The demo league is always in this week when the seed runs. */
export const DEMO_CURRENT_WEEK = 7;
/** Weeks with approved scoring events (weeks 1..N). */
export const SCORED_WEEKS = 6;
export const APPROVED_EVENTS_PER_WEEK = 45;

export type DemoUser = { username: string; displayName: string };

export const DEMO_USERS: readonly DemoUser[] = [
  { username: "demo_commish", displayName: "Demo Commissioner" },
  ...Array.from({ length: 9 }, (_, i) => ({ username: `demo_player${i + 1}`, displayName: `Demo Player ${i + 1}` })),
];

/** Team names for the mid-season league, in DEMO_USERS order. */
export const DEMO_TEAM_NAMES: readonly string[] = [
  "Objection Overruled",
  "Hearsay Heroes",
  "The Gavel Gang",
  "Burden of Proof",
  "Leading Questions",
  "Beyond a Reasonable Doubt",
  "Voir Dire Wolves",
  "Res Ipsa Rockets",
  "Sustained!",
  "Cross-Exam Crew",
];

/** Team names for the draft practice league (demo_commish + demo_player1..5). */
export const PRACTICE_TEAM_NAMES: readonly string[] = [
  "Opening Statements",
  "Closing Arguments",
  "The Bailiffs",
  "Amicus Squad",
  "Pro Bono Bunch",
  "Mock Trial Stars",
];

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/** Small deterministic PRNG (mulberry32). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  float(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Can't pick from an empty list");
    return items[Math.floor(this.float() * items.length)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  weighted<T>(options: readonly (readonly [T, number])[]): T {
    const total = options.reduce((s, [, w]) => s + w, 0);
    let r = this.float() * total;
    for (const [value, w] of options) {
      r -= w;
      if (r < 0) return value;
    }
    return options[options.length - 1][0];
  }
}

/** An independent PRNG stream per named section, so changing one section doesn't reshuffle the others. */
export function rngFor(section: string, seed: number = DEMO_SEED): Rng {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < section.length; i++) {
    h ^= section.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return new Rng(h >>> 0);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** The Monday DEMO_CURRENT_WEEK - 1 weeks before this week's Monday, so `today` falls in week 7. */
export function demoSeasonStart(today: string): string {
  return addDays(mondayOnOrBefore(today), -(DEMO_CURRENT_WEEK - 1) * 7);
}

/** A weekday (Mon–Fri) of a season week. `dayOffset` 0 = Monday. */
function weekday(seasonStart: string, week: number, dayOffset: number): string {
  return addDays(weekStartDate(week, seasonStart), dayOffset);
}

// ---------------------------------------------------------------------------
// Static lists (all invented)
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Avery", "Blake", "Camila", "Dario", "Elena", "Farah", "Gideon", "Harper", "Imani", "Jonah",
  "Kiran", "Lena", "Marcus", "Nadia", "Owen", "Priya", "Quentin", "Rosa", "Silas", "Tamsin",
  "Ulric", "Vera", "Wesley", "Ximena", "Yusuf", "Zara", "Adele", "Bruno", "Celeste", "Desmond",
  "Esme", "Felix", "Greta", "Hollis", "Ines", "Jasper", "Kenji", "Lucia", "Malik", "Noor",
  "Orla", "Pavel", "Rhea", "Soren", "Talia", "Uma", "Viktor", "Wren", "Yara", "Zane",
  "Amara", "Bastian", "Corinne", "Dmitri", "Eliza", "Florian", "Giselle", "Hamish", "Isadora", "Joaquin",
] as const;

const LAST_NAMES = [
  "Ashgrove", "Bellamy", "Calloway", "Draycott", "Ellsworth", "Fairbank", "Garrow", "Holloway", "Ingleby", "Jessup",
  "Kestrel", "Lockridge", "Marlow", "Northcott", "Oakes", "Pemberton", "Quill", "Ravenscroft", "Stanhope", "Thorne",
  "Underhill", "Vance", "Whitlock", "Yardley", "Zeller", "Abbott", "Brennan", "Castellano", "Delacroix", "Everly",
  "Fontaine", "Greaves", "Hadley", "Ivers", "Jaramillo", "Kowalczyk", "Lindqvist", "Moreau", "Nakashima", "Okonkwo",
  "Petrakis", "Quintero", "Rasmussen", "Sorensen", "Tremaine", "Ulloa", "Valdivia", "Winslow", "Xiong", "Yilmaz",
  "Zamora", "Beaumont", "Dunmore", "Eastbrook", "Gallant", "Hargrove", "Lisowski", "Marchetti", "Pryce", "Sandoval",
] as const;

type FirmFocus = "litigation" | "appellate" | "defense";

export const FIRMS: readonly { name: string; focus: FirmFocus }[] = [
  { name: "Hartwell Kingsley LLP", focus: "litigation" },
  { name: "Brambleton & Finch LLP", focus: "litigation" },
  { name: "Copperfield Ames LLP", focus: "litigation" },
  { name: "Larkspur Legal Group", focus: "litigation" },
  { name: "Meridian Hale LLP", focus: "litigation" },
  { name: "Stonebridge Varga LLP", focus: "litigation" },
  { name: "Wexford Marsh & Pike", focus: "litigation" },
  { name: "Tidewater Barlow LLP", focus: "litigation" },
  { name: "Juniper Lane Partners", focus: "litigation" },
  { name: "Halcyon Appellate Group", focus: "appellate" },
  { name: "Featherstone Appellate LLP", focus: "appellate" },
  { name: "Ridgeway Okafor LLP", focus: "appellate" },
  { name: "Cardinal Point Appeals", focus: "appellate" },
  { name: "Lantern Defense Collective", focus: "defense" },
  { name: "Bishop & Calderon Defense", focus: "defense" },
  { name: "Northlight Criminal Defense", focus: "defense" },
  { name: "Greystone Trial Defense", focus: "defense" },
  { name: "Mosswood & Reyes LLP", focus: "defense" },
];

const FIRM_ORGANIZATION: Record<FirmFocus, string> = {
  litigation: "Litigation firm · Example City (fictional)",
  appellate: "Appellate firm · Example City (fictional)",
  defense: "Criminal defense firm · Example City (fictional)",
};

const APPELLATE_OFFICES = [
  "Office of the Solicitor General of Example State (fictional)",
  "Appellate Advocacy Clinic, Example Law School (fictional)",
] as const;

export type JurisdictionKey = "example" | "sample" | "county";

type Jurisdiction = {
  key: JurisdictionKey;
  trialCourt: string;
  appealsCourt: string;
  prosecutorOffice: string;
  defenderOffice: string;
  sovereign: string;
  federal: boolean;
  division: number;
};

export const JURISDICTIONS: readonly Jurisdiction[] = [
  {
    key: "example",
    trialCourt: "U.S. District Court for the District of Example (fictional)",
    appealsCourt: "U.S. Court of Appeals for the Fourteenth Circuit (fictional)",
    prosecutorOffice: "U.S. Attorney's Office, District of Example (fictional)",
    defenderOffice: "Federal Public Defender, District of Example (fictional)",
    sovereign: "United States",
    federal: true,
    division: 1,
  },
  {
    key: "sample",
    trialCourt: "U.S. District Court for the Northern District of Sample (fictional)",
    appealsCourt: "U.S. Court of Appeals for the Fourteenth Circuit (fictional)",
    prosecutorOffice: "U.S. Attorney's Office, Northern District of Sample (fictional)",
    defenderOffice: "Federal Public Defender, Northern District of Sample (fictional)",
    sovereign: "United States",
    federal: true,
    division: 2,
  },
  {
    key: "county",
    trialCourt: "Example County Superior Court (fictional)",
    appealsCourt: "Example State Court of Appeals (fictional)",
    prosecutorOffice: "Example County District Attorney's Office (fictional)",
    defenderOffice: "Example County Public Defender (fictional)",
    sovereign: "State of Example",
    federal: false,
    division: 0,
  },
];

export const SUPREME_COURT = "Supreme Court of the United States (fictional case)";

const COMPANIES = [
  "Brightwater Logistics, Inc.", "Harrow Manufacturing Co.", "Quillon Software LLC", "Pinecrest Dairy Cooperative",
  "Silverline Rail Corp.", "Marigold Health Systems", "Oakvale Construction LLC", "Bluefin Seafood Co.",
  "Redstone Quarry Corp.", "Lumen Robotics, Inc.", "Cobalt Ridge Energy", "Thimble & Thread Apparel",
  "Starling Air Charter", "Granite Peak Insurance Co.", "Willowbrook Apartments LLC", "Copperleaf Pharmacy",
  "Northwind Shipping Co.", "Fable Street Books", "Kestrel Drone Works", "Maple Hollow Farms",
  "Sunburst Solar LLC", "Ironclad Security Services", "Velvet Bean Coffee Co.", "Juniper Grove Homeowners Association",
  "Paperkite Games, Inc.", "Tallgrass Ranch Co.", "Beacon Hill Clinic", "Driftwood Marina LLC",
  "Saffron Kitchen Group", "Glacier Bottling Co.", "Hummingbird Toys, Inc.", "Orchard Lane Bakery",
  "Trident Telecom", "Moonstone Jewelers", "Westgate Mall Partners", "Cinder Block Studios",
  "Evergreen Waste Management", "Polaris Freight Lines", "Clearwater Pools & Spas", "Example State Water Board",
] as const;

export const LAWYER_COUNTS: Record<Exclude<Position, "firm">, number> = {
  trial: 52,
  appellate: 30,
  prosecutor: 42,
  defense: 46,
};

export const CASE_COUNTS: Record<"civil" | "criminal" | "appeal" | "supreme_court", number> = {
  civil: 32,
  criminal: 26,
  appeal: 10,
  supreme_court: 2,
};

export const MIN_APPEARANCES = 2;
export const MAX_APPEARANCES = 6;

/** Lawyers ranked this high or better count as "stars" when spreading events over cases. */
const STAR_RANK = 80;
/** Extra event weight per star lawyer on a case. */
const STAR_WEIGHT = 3;

// ---------------------------------------------------------------------------
// World types
// ---------------------------------------------------------------------------

export type WorldLawyer = {
  /** Index in DemoWorld.lawyers. */
  key: number;
  name: string;
  kind: "lawyer" | "firm";
  position: Position;
  /** Key of the firm (a kind "firm" entry) the lawyer belongs to. */
  firmKey: number | null;
  organization: string;
  preseasonRank: number;
  /** Prosecutors and public defenders work in one jurisdiction. */
  jurisdiction: JurisdictionKey | null;
};

export type WorldAppearance = { lawyerKey: number; side: Side };

export type WorldCase = {
  /** Index in DemoWorld.cases. */
  key: number;
  caption: string;
  court: string;
  docketNumber: string;
  caseType: CaseType;
  status: "active" | "closed";
  filedOn: string;
  sourceUrl: string;
  jurisdiction: JurisdictionKey | null;
  appearances: WorldAppearance[];
};

export type WorldEvent = {
  caseKey: number | null;
  side: Side | null;
  lawyerKey: number | null;
  type: EventType;
  customPoints: number | null;
  occurredOn: string;
  summary: string;
  sourceUrl: string;
  status: "approved" | "pending";
};

export type DemoWorld = { lawyers: WorldLawyer[]; cases: WorldCase[]; events: WorldEvent[] };

// ---------------------------------------------------------------------------
// Lawyers and firms
// ---------------------------------------------------------------------------

function nameCombos(): string[] {
  const out: string[] = [];
  for (const f of FIRST_NAMES) for (const l of LAST_NAMES) out.push(`${f} ${l}`);
  return out;
}

function generateLawyers(rng: Rng, names: string[]): WorldLawyer[] {
  const out: WorldLawyer[] = FIRMS.map((f, key) => ({
    key,
    name: f.name,
    kind: "firm",
    position: "firm",
    firmKey: null,
    organization: FIRM_ORGANIZATION[f.focus],
    preseasonRank: 0,
    jurisdiction: null,
  }));
  const firmsOf = (focus: FirmFocus) => FIRMS.flatMap((f, key) => (f.focus === focus ? [key] : []));
  const litigation = firmsOf("litigation");
  const appellate = firmsOf("appellate");
  const defense = firmsOf("defense");
  let n = 0;
  const add = (position: Exclude<Position, "firm">, firmKey: number | null, organization: string, jurisdiction: JurisdictionKey | null) => {
    out.push({
      key: out.length,
      name: names[n++],
      kind: "lawyer",
      position,
      firmKey,
      organization: firmKey === null ? organization : FIRMS[firmKey].name,
      preseasonRank: 0,
      jurisdiction,
    });
  };

  // Trial lawyers: all at litigation firms.
  for (let i = 0; i < LAWYER_COUNTS.trial; i++) add("trial", litigation[i % litigation.length], "", null);
  // Appellate: most at appellate firms, some at litigation firms, a few at public offices.
  for (let i = 0; i < LAWYER_COUNTS.appellate; i++) {
    if (i < 16) add("appellate", appellate[i % appellate.length], "", null);
    else if (i < 26) add("appellate", litigation[(i * 7) % litigation.length], "", null);
    else add("appellate", null, APPELLATE_OFFICES[i % APPELLATE_OFFICES.length], null);
  }
  // Prosecutors: split across the three offices (16 / 14 / 12).
  for (let i = 0; i < LAWYER_COUNTS.prosecutor; i++) {
    const j = i < 16 ? JURISDICTIONS[0] : i < 30 ? JURISDICTIONS[1] : JURISDICTIONS[2];
    add("prosecutor", null, j.prosecutorOffice, j.key);
  }
  // Defense: half at criminal defense firms, half public defenders.
  for (let i = 0; i < LAWYER_COUNTS.defense; i++) {
    if (i % 2 === 0) add("defense", defense[(i / 2) % defense.length], "", null);
    else {
      const j = JURISDICTIONS[Math.floor(i / 2) % JURISDICTIONS.length];
      add("defense", null, j.defenderOffice, j.key);
    }
  }

  // Preseason ranks 1..N over everyone (firms included).
  const ranks = rng.shuffle(out.map((_, i) => i + 1));
  out.forEach((l, i) => (l.preseasonRank = ranks[i]));
  return out;
}

// ---------------------------------------------------------------------------
// Cases and appearances
// ---------------------------------------------------------------------------

/** Hands out keys in shuffled cycles so everyone gets used before anyone repeats. */
class KeyQueue {
  private queue: number[] = [];

  constructor(
    private readonly rng: Rng,
    private readonly keys: readonly number[],
  ) {}

  next(skip: (key: number) => boolean): number | null {
    for (let attempt = 0; attempt < 2; attempt++) {
      const idx = this.queue.findIndex((k) => !skip(k));
      if (idx >= 0) return this.queue.splice(idx, 1)[0];
      if (this.keys.length === 0) return null;
      this.queue.push(...this.rng.shuffle(this.keys));
    }
    return null;
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function generateCases(rng: Rng, lawyers: WorldLawyer[], people: string[], seasonStart: string): WorldCase[] {
  const individuals = lawyers.filter((l) => l.kind === "lawyer");
  const keysWhere = (pred: (l: WorldLawyer) => boolean) => individuals.filter(pred).map((l) => l.key);
  const trialQ = new KeyQueue(rng, keysWhere((l) => l.position === "trial"));
  const appellateQ = new KeyQueue(rng, keysWhere((l) => l.position === "appellate"));
  const privateDefenseQ = new KeyQueue(rng, keysWhere((l) => l.position === "defense" && l.jurisdiction === null));
  const prosecutorQ = new Map<JurisdictionKey, KeyQueue>();
  const defenderQ = new Map<JurisdictionKey, KeyQueue>();
  for (const j of JURISDICTIONS) {
    prosecutorQ.set(j.key, new KeyQueue(rng, keysWhere((l) => l.position === "prosecutor" && l.jurisdiction === j.key)));
    defenderQ.set(j.key, new KeyQueue(rng, keysWhere((l) => l.position === "defense" && l.jurisdiction === j.key)));
  }

  const companies = rng.shuffle(COMPANIES.filter((c) => c !== "Example State Water Board"));
  let companyIdx = 0;
  const company = () => companies[companyIdx++ % companies.length];
  let personIdx = 0;
  const person = () => people[personIdx++ % people.length];
  const surname = (full: string) => full.split(" ").slice(1).join(" ");

  const cases: WorldCase[] = [];
  const yy = (date: string) => date.slice(2, 4);
  const seq = () => 1200 + cases.length * 61 + rng.int(0, 40);

  /** Fill one side: `count` lawyers from `draw`, skipping anyone on the case or (for firms) on the other side. */
  const fillSide = (apps: WorldAppearance[], side: Side, count: number, draw: (skip: (k: number) => boolean) => number | null) => {
    const firmsOnOtherSide = new Set(
      apps.filter((a) => a.side !== side).flatMap((a) => (lawyers[a.lawyerKey].firmKey === null ? [] : [lawyers[a.lawyerKey].firmKey!])),
    );
    for (let i = 0; i < count; i++) {
      const k = draw(
        (key) =>
          apps.some((a) => a.lawyerKey === key) ||
          (lawyers[key].firmKey !== null && firmsOnOtherSide.has(lawyers[key].firmKey!)),
      );
      if (k !== null) apps.push({ lawyerKey: k, side });
    }
  };
  const counsel = () => rng.weighted([[1, 15], [2, 45], [3, 40]] as const);

  const addCase = (c: Omit<WorldCase, "key" | "status" | "sourceUrl">) => {
    const key = cases.length;
    cases.push({ ...c, key, status: "active", sourceUrl: `https://example.com/demo-docket/${1001 + key}` });
  };

  // Civil cases in the three trial courts.
  for (let i = 0; i < CASE_COUNTS.civil; i++) {
    const j = JURISDICTIONS[i % JURISDICTIONS.length];
    const filedOn = addDays(seasonStart, -rng.int(20, 540));
    const plaintiff = rng.chance(0.25) ? person() : company();
    const apps: WorldAppearance[] = [];
    fillSide(apps, "plaintiff", counsel(), (skip) => trialQ.next(skip));
    fillSide(apps, "defendant", counsel(), (skip) => trialQ.next(skip));
    addCase({
      caption: `${plaintiff} v. ${company()}`,
      court: j.trialCourt,
      docketNumber: j.federal ? `${j.division}:${yy(filedOn)}-cv-${pad(seq(), 5)}` : `CV-${yy(filedOn)}-${pad(seq(), 6)}`,
      caseType: "civil",
      filedOn,
      jurisdiction: j.key,
      appearances: apps,
    });
  }

  // Criminal cases: prosecutors (same jurisdiction) vs. defense (public defender there or a defense firm).
  for (let i = 0; i < CASE_COUNTS.criminal; i++) {
    const j = JURISDICTIONS[i % JURISDICTIONS.length];
    const filedOn = addDays(seasonStart, -rng.int(20, 400));
    const apps: WorldAppearance[] = [];
    fillSide(apps, "plaintiff", rng.weighted([[1, 40], [2, 45], [3, 15]] as const), (skip) => prosecutorQ.get(j.key)!.next(skip));
    fillSide(apps, "defendant", rng.weighted([[1, 25], [2, 45], [3, 30]] as const), (skip) =>
      rng.chance(0.5) ? (defenderQ.get(j.key)!.next(skip) ?? privateDefenseQ.next(skip)) : (privateDefenseQ.next(skip) ?? defenderQ.get(j.key)!.next(skip)),
    );
    addCase({
      caption: `${j.sovereign} v. ${person()}`,
      court: j.trialCourt,
      docketNumber: j.federal ? `${j.division}:${yy(filedOn)}-cr-${pad(seq(), 5)}` : `CR-${yy(filedOn)}-${pad(seq(), 6)}`,
      caseType: "criminal",
      filedOn,
      jurisdiction: j.key,
      appearances: apps,
    });
  }

  // Appeals: appellate lawyers on both sides.
  for (let i = 0; i < CASE_COUNTS.appeal; i++) {
    const j = i % 2 === 0 ? JURISDICTIONS[i % 4 === 0 ? 0 : 1] : JURISDICTIONS[2];
    const filedOn = addDays(seasonStart, -rng.int(30, 300));
    const apps: WorldAppearance[] = [];
    fillSide(apps, "plaintiff", rng.weighted([[1, 50], [2, 50]] as const), (skip) => appellateQ.next(skip));
    fillSide(apps, "defendant", rng.weighted([[1, 50], [2, 50]] as const), (skip) => appellateQ.next(skip));
    const criminalAppeal = i % 3 === 2;
    addCase({
      caption: criminalAppeal ? `${person()} v. ${j.sovereign}` : `${company()} v. ${company()}`,
      court: j.appealsCourt,
      docketNumber: j.federal ? `${yy(filedOn)}-${pad(seq(), 4)}` : `A-${yy(filedOn)}-${pad(seq(), 4)}`,
      caseType: "appeal",
      filedOn,
      jurisdiction: null,
      appearances: apps,
    });
  }

  // Two U.S. Supreme Court cases.
  for (let i = 0; i < CASE_COUNTS.supreme_court; i++) {
    const filedOn = addDays(seasonStart, -rng.int(120, 400));
    const apps: WorldAppearance[] = [];
    fillSide(apps, "plaintiff", rng.weighted([[1, 40], [2, 60]] as const), (skip) => appellateQ.next(skip));
    fillSide(apps, "defendant", rng.weighted([[1, 40], [2, 60]] as const), (skip) => appellateQ.next(skip));
    addCase({
      caption: i === 0 ? "Cobalt Ridge Energy v. Example State Water Board" : `${surname(person())} v. United States`,
      court: SUPREME_COURT,
      docketNumber: `${yy(filedOn)}-${pad(100 + cases.length * 7 + rng.int(0, 6), 3)}`,
      caseType: "supreme_court",
      filedOn,
      jurisdiction: null,
      appearances: apps,
    });
  }

  ensureCoverage(lawyers, cases);
  return cases;
}

/** Make sure every individual lawyer appears on at least one sensible case. */
function ensureCoverage(lawyers: WorldLawyer[], cases: WorldCase[]): void {
  const appearing = new Set(cases.flatMap((c) => c.appearances.map((a) => a.lawyerKey)));
  for (const l of lawyers) {
    if (l.kind !== "lawyer" || appearing.has(l.key)) continue;
    const types: CaseType[] =
      l.position === "trial" ? ["civil"] : l.position === "appellate" ? ["appeal", "supreme_court"] : ["criminal"];
    const candidates = cases
      .filter((c) => types.includes(c.caseType) && c.appearances.length < MAX_APPEARANCES)
      .filter((c) => l.jurisdiction === null || c.jurisdiction === l.jurisdiction)
      .sort((a, b) => a.appearances.length - b.appearances.length || a.key - b.key);
    let placed = false;
    for (const c of candidates) {
      const sides: Side[] =
        l.position === "prosecutor" ? ["plaintiff"] : l.position === "defense" ? ["defendant"] : ["plaintiff", "defendant"];
      const allowed = sides.filter(
        (s) =>
          l.firmKey === null ||
          !c.appearances.some((a) => a.side !== s && lawyers[a.lawyerKey].firmKey === l.firmKey),
      );
      if (allowed.length === 0) continue;
      const count = (s: Side) => c.appearances.filter((a) => a.side === s).length;
      const side = allowed.sort((a, b) => count(a) - count(b))[0];
      c.appearances.push({ lawyerKey: l.key, side });
      placed = true;
      break;
    }
    if (!placed) throw new Error(`No case has room for ${l.name}`);
  }
}

// ---------------------------------------------------------------------------
// Scoring events
// ---------------------------------------------------------------------------

type CaseGroup = "civil" | "criminal" | "appeal" | "supreme_court";

function caseGroup(c: WorldCase): CaseGroup {
  return c.caseType === "other" ? "civil" : c.caseType;
}

const FILINGS: Record<CaseGroup, readonly string[]> = {
  civil: [
    "a motion for summary judgment",
    "a motion to compel discovery",
    "a brief opposing a pending motion",
    "proposed jury instructions",
    "a pretrial memorandum",
    "a motion in limine",
  ],
  criminal: [
    "a motion in limine",
    "a sentencing memorandum",
    "proposed jury instructions",
    "a response to a pending motion",
    "a witness list",
  ],
  appeal: ["a merits brief", "a reply brief", "a supplemental brief", "a motion to expedite the appeal"],
  supreme_court: ["a merits brief", "a reply brief", "a supplemental brief"],
};

const MOTIONS: Record<CaseGroup, readonly string[]> = {
  civil: [
    "motion to compel discovery",
    "motion in limine",
    "motion for a protective order",
    "motion to exclude an expert witness",
    "motion to dismiss",
  ],
  criminal: ["motion in limine", "motion to continue the trial date", "motion to exclude a witness"],
  appeal: ["motion to expedite the appeal", "motion to supplement the record", "motion for leave to file a supplemental brief"],
  supreme_court: ["motion for leave to file a supplemental brief"],
};

type Outcome =
  | "verdict"
  | "settlement"
  | "dismissal"
  | "summary_judgment"
  | "plea_deal"
  | "guilty_plea"
  | "guilty_verdict"
  | "not_guilty_verdict"
  | "reversed"
  | "affirmed";

/** Cases that wrap up during weeks 1..6, by case type (one outcome per resolved case). */
const OUTCOMES: readonly [CaseType, readonly Outcome[]][] = [
  ["civil", ["verdict", "verdict", "settlement", "settlement", "settlement", "dismissal", "dismissal", "summary_judgment"]],
  ["criminal", ["plea_deal", "plea_deal", "plea_deal", "guilty_plea", "guilty_verdict", "not_guilty_verdict", "dismissal"]],
  ["appeal", ["reversed", "reversed", "affirmed", "affirmed"]],
];

/** Pending (review queue) event types for week 6 and week 7. */
const PENDING_TYPES: readonly [number, readonly EventType[]][] = [
  [6, ["filing", "filing", "motion_granted", "motion_granted", "summary_judgment_won", "guilty_plea"]],
  [7, ["filing", "filing", "motion_granted", "motion_denied", "settlement_favorable", "sanctioned"]],
];

function generateEvents(rng: Rng, lawyers: WorldLawyer[], cases: WorldCase[], seasonStart: string, today: string): WorldEvent[] {
  const events: WorldEvent[] = [];
  const sideName = (c: WorldCase, side: Side) => sideLabel(c.caseType, side).toLowerCase();
  const push = (
    c: WorldCase,
    e: Pick<WorldEvent, "type" | "occurredOn" | "summary"> & Partial<Pick<WorldEvent, "side" | "lawyerKey" | "customPoints" | "status">>,
  ) => {
    events.push({
      caseKey: c.key,
      side: e.lawyerKey === undefined || e.lawyerKey === null ? (e.side ?? null) : null,
      lawyerKey: e.lawyerKey ?? null,
      type: e.type,
      customPoints: e.customPoints ?? null,
      occurredOn: e.occurredOn,
      summary: e.summary,
      sourceUrl: c.sourceUrl, // docket entry anchors are added once events are in date order
      status: e.status ?? "approved",
    });
  };
  /** Neutral summary for a filing or a ruling on a motion. */
  const routineSummary = (c: WorldCase, type: EventType, side: Side) =>
    type === "filing"
      ? `The ${sideName(c, side)} filed ${rng.pick(FILINGS[caseGroup(c)])}.`
      : `The court ${type === "motion_granted" ? "granted" : "denied"} the ${sideName(c, side)}'s ${rng.pick(MOTIONS[caseGroup(c)])}.`;
  const randomWeekday = (week: number) => weekday(seasonStart, week, rng.int(0, 4));
  const otherSideOf = (s: Side): Side => (s === "plaintiff" ? "defendant" : "plaintiff");

  const top = new Set(lawyers.filter((l) => l.preseasonRank <= STAR_RANK).map((l) => l.key));
  const stars = (c: WorldCase, side?: Side) => c.appearances.filter((a) => (!side || a.side === side) && top.has(a.lawyerKey)).length;
  /** Good news tends to land on the side with more highly ranked lawyers, bad news on the other. */
  const sideFor = (c: WorldCase, good: boolean): Side => {
    const p = 1 + stars(c, "plaintiff");
    const d = 1 + stars(c, "defendant");
    return rng.weighted([
      ["plaintiff", good ? p : d],
      ["defendant", good ? d : p],
    ] as const);
  };

  // 1. Case outcomes (each resolved case closes on its outcome date).
  const resolvedOn = new Map<number, string>();
  for (const [caseType, outcomes] of OUTCOMES) {
    const chosen = rng.shuffle(cases.filter((c) => c.caseType === caseType)).slice(0, outcomes.length);
    chosen.forEach((c, i) => {
      const date = randomWeekday(rng.int(1, SCORED_WEEKS));
      resolvedOn.set(c.key, date);
      c.status = "closed";
      const criminal = c.caseType === "criminal";
      switch (outcomes[i]) {
        case "verdict": {
          const winner = sideFor(c, true);
          push(c, { type: "verdict_win", side: winner, occurredOn: date, summary: `The jury returned a verdict for the ${sideName(c, winner)}.` });
          push(c, {
            type: "verdict_loss",
            side: otherSideOf(winner),
            occurredOn: date,
            summary: `The jury returned a verdict against the ${sideName(c, otherSideOf(winner))}.`,
          });
          break;
        }
        case "settlement":
          push(c, { type: "settlement_favorable", side: "plaintiff", occurredOn: date, summary: "The parties announced a settlement resolving the case." });
          break;
        case "dismissal":
          push(c, {
            type: "dismissed_favorable",
            side: "defendant",
            occurredOn: date,
            summary: criminal ? "The court dismissed the charges against the defendant." : "The court dismissed the claims against the defendant.",
          });
          break;
        case "summary_judgment": {
          const side = sideFor(c, true);
          push(c, { type: "summary_judgment_won", side, occurredOn: date, summary: `The court granted summary judgment for the ${sideName(c, side)}.` });
          break;
        }
        case "plea_deal":
          push(c, { type: "guilty_plea", side: "plaintiff", occurredOn: date, summary: "The defendant pleaded guilty under a plea agreement." });
          push(c, { type: "plea_reduced", side: "defendant", occurredOn: date, summary: "The plea agreement reduced the charge to a lesser offense." });
          break;
        case "guilty_plea":
          push(c, { type: "guilty_plea", side: "plaintiff", occurredOn: date, summary: "The defendant pleaded guilty to the charge." });
          break;
        case "guilty_verdict":
          push(c, { type: "verdict_win", side: "plaintiff", occurredOn: date, summary: "The jury returned a guilty verdict." });
          push(c, { type: "verdict_loss", side: "defendant", occurredOn: date, summary: "The jury returned a guilty verdict." });
          break;
        case "not_guilty_verdict":
          push(c, { type: "verdict_win", side: "defendant", occurredOn: date, summary: "The jury returned a not-guilty verdict." });
          push(c, { type: "verdict_loss", side: "plaintiff", occurredOn: date, summary: "The jury returned a not-guilty verdict." });
          break;
        case "reversed":
          push(c, { type: "appeal_won", side: "plaintiff", occurredOn: date, summary: "The court of appeals reversed the judgment below." });
          push(c, { type: "win_reversed", side: "defendant", occurredOn: date, summary: "The judgment for the appellee was reversed on appeal." });
          break;
        case "affirmed":
          push(c, { type: "appeal_won", side: "defendant", occurredOn: date, summary: "The court of appeals affirmed the judgment below." });
          break;
      }
    });
  }

  const openOn = (c: WorldCase, date: string) => {
    const r = resolvedOn.get(c.key);
    return r === undefined || date < r;
  };
  // Busier dockets for higher-ranked lawyers, so drafted lawyers (and fantasy scores) see more action.
  const caseWeight = (c: WorldCase) => {
    const base = c.caseType === "supreme_court" ? 0.4 : c.caseType === "appeal" ? 0.8 : 1;
    return base * (1 + STAR_WEIGHT * stars(c));
  };
  const pickCase = (date: string, pred: (c: WorldCase) => boolean = () => true): WorldCase => {
    const options = cases.filter((c) => openOn(c, date) && pred(c)).map((c) => [c, caseWeight(c)] as const);
    if (options.length === 0) throw new Error(`No open case on ${date}`);
    return rng.weighted(options);
  };
  const lawyerOn = (c: WorldCase, side: Side | null, position?: Position): number => {
    const options = c.appearances.filter((a) => (side === null || a.side === side) && (!position || lawyers[a.lawyerKey].position === position));
    return rng.pick(options).lawyerKey;
  };

  // 2. One-off events: Supreme Court arguments, a sanction, a custom event.
  const scotus = cases.filter((c) => c.caseType === "supreme_court");
  scotus.forEach((c, i) => {
    const side: Side = i % 2 === 0 ? "plaintiff" : "defendant";
    push(c, {
      type: "scotus_argument",
      lawyerKey: lawyerOn(c, side),
      occurredOn: weekday(seasonStart, i % 2 === 0 ? 2 : 5, 1),
      summary: `Argued for the ${sideName(c, side)} before the U.S. Supreme Court.`,
    });
  });
  {
    const date = randomWeekday(3);
    const c = pickCase(date, (x) => x.caseType === "civil");
    push(c, {
      type: "sanctioned",
      lawyerKey: lawyerOn(c, null, "trial"),
      occurredOn: date,
      summary: "The court ordered counsel to pay a monetary sanction for a discovery violation.",
    });
  }
  {
    const date = randomWeekday(4);
    const c = pickCase(date, (x) => x.caseType === "civil");
    push(c, {
      type: "custom",
      side: "plaintiff",
      customPoints: 3,
      occurredOn: date,
      summary: `The court appointed the ${sideName(c, "plaintiff")}'s counsel as interim lead counsel for related cases.`,
    });
  }

  // 3. Fill each week up to the target with filings and motions.
  for (let week = 1; week <= SCORED_WEEKS; week++) {
    let count = events.filter((e) => weekOfDate(e.occurredOn, seasonStart) === week).length;
    while (count < APPROVED_EVENTS_PER_WEEK) {
      const date = randomWeekday(week);
      const c = pickCase(date);
      const group = caseGroup(c);
      const type: EventType =
        group === "supreme_court" ? "filing" : rng.weighted([["filing", 45], ["motion_granted", 38], ["motion_denied", 17]] as const);
      const side = sideFor(c, type !== "motion_denied");
      push(c, { type, side, occurredOn: date, summary: routineSummary(c, type, side) });
      count++;
    }
  }

  // 4. Pending events for the commissioner's review queue (never dated after today).
  const daysIntoWeek7 = dateToDayNumber(today) - dateToDayNumber(weekStartDate(DEMO_CURRENT_WEEK, seasonStart));
  for (const [week, types] of PENDING_TYPES) {
    for (const type of types) {
      const offset = rng.int(0, 4);
      const date = weekday(seasonStart, week, week === DEMO_CURRENT_WEEK ? Math.min(offset, Math.max(0, daysIntoWeek7)) : offset);
      const pending = { status: "pending" as const, occurredOn: date };
      if (type === "summary_judgment_won" || type === "settlement_favorable" || type === "sanctioned") {
        const c = pickCase(date, (x) => x.caseType === "civil" && !resolvedOn.has(x.key));
        if (type === "sanctioned") {
          push(c, { ...pending, type, lawyerKey: lawyerOn(c, null, "trial"), summary: "The court ordered counsel to pay opposing costs for a missed filing deadline." });
        } else if (type === "settlement_favorable") {
          push(c, { ...pending, type, side: "plaintiff", summary: "The parties announced a settlement resolving the case." });
        } else {
          push(c, { ...pending, type, side: "plaintiff", summary: `The court granted summary judgment for the ${sideName(c, "plaintiff")}.` });
        }
      } else if (type === "guilty_plea") {
        const c = pickCase(date, (x) => x.caseType === "criminal" && !resolvedOn.has(x.key));
        push(c, { ...pending, type, side: "plaintiff", summary: "The defendant pleaded guilty under a plea agreement." });
      } else {
        const c = pickCase(date, (x) => x.caseType !== "supreme_court" && !resolvedOn.has(x.key));
        const side: Side = rng.chance(0.5) ? "plaintiff" : "defendant";
        push(c, { ...pending, type, side, summary: routineSummary(c, type, side) });
      }
    }
  }

  // Date order, numbering each case's docket entries chronologically.
  const entry = new Map<number, number>();
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.occurredOn.localeCompare(b.e.occurredOn) || a.i - b.i)
    .map(({ e }) => {
      const n = (entry.get(e.caseKey!) ?? 0) + 1;
      entry.set(e.caseKey!, n);
      return { ...e, sourceUrl: `${e.sourceUrl}#entry-${n}` };
    });
}

/**
 * The whole fictional "legal world" for the demo pool. Deterministic for a
 * given seed; only the dates move with `seasonStart` / `today`.
 */
export function generateWorld(opts: { seasonStart: string; today: string; seed?: number }): DemoWorld {
  const seed = opts.seed ?? DEMO_SEED;
  const individualCount = Object.values(LAWYER_COUNTS).reduce((s, n) => s + n, 0);
  const names = rngFor("names", seed).shuffle(nameCombos());
  const lawyers = generateLawyers(rngFor("lawyers", seed), names.slice(0, individualCount));
  const people = names.slice(individualCount, individualCount + 80);
  const cases = generateCases(rngFor("cases", seed), lawyers, people, opts.seasonStart);
  const events = generateEvents(rngFor("events", seed), lawyers, cases, opts.seasonStart, opts.today);
  return { lawyers, cases, events };
}

// ---------------------------------------------------------------------------
// Draft and lineups
// ---------------------------------------------------------------------------

export type PlannedPick = {
  overall: number;
  round: number;
  pickInRound: number;
  /** 1-based draft slot of the team making the pick. */
  draftPosition: number;
  lawyerId: string;
  isAuto: boolean;
  /** When the pick was made, in seconds after the draft started (always inside the pick clock). */
  secondsAfterStart: number;
};

/**
 * Plan a full snake draft. Each team drafts from its own "board" (preseason
 * ranks with seeded noise) using the same chooseAutoPick rules as the live
 * draft, plus the occasional best-available "value" pick while there's room.
 */
export function planDraft(args: {
  teamCount: number;
  rounds: number;
  roster: RosterSettings;
  candidates: AutoPickCandidate[];
  rng: Rng;
  /** Picks are made 15..maxSecondsPerPick seconds apart. */
  maxSecondsPerPick?: number;
}): PlannedPick[] {
  const { teamCount, rounds, roster, candidates, rng } = args;
  const maxSeconds = Math.max(15, args.maxSecondsPerPick ?? 75);
  const fallbackRank = candidates.length + 1;
  const boards = Array.from({ length: teamCount }, () =>
    candidates
      .map((c) => {
        const rank = c.preseasonRank ?? fallbackRank;
        return { id: c.id, score: rank + (rng.float() * 2 - 1) * (3 + rank * 0.12) };
      })
      .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
      .map((x) => x.id),
  );
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const drafted = new Set<string>();
  const positions: Position[][] = Array.from({ length: teamCount }, () => []);
  const picks: PlannedPick[] = [];
  let seconds = 0;
  for (let overall = 0; overall < teamCount * rounds; overall++) {
    const slot = snakeSlot(overall, teamCount);
    const t = slot.draftPosition - 1;
    const available = candidates.filter((c) => !drafted.has(c.id));
    const remaining = rounds - positions[t].length;
    let choice: AutoPickCandidate | null = null;
    if (remaining > openStarterSlots(positions[t], roster).length + 1 && rng.chance(0.15)) {
      const id = boards[t].find((x) => !drafted.has(x));
      choice = id ? byId.get(id)! : null;
    }
    choice ??= chooseAutoPick({ available, queue: boards[t], draftedPositions: positions[t], roster });
    if (!choice) throw new Error("The pool ran out of lawyers to draft.");
    drafted.add(choice.id);
    positions[t].push(choice.position);
    seconds += rng.int(15, maxSeconds);
    picks.push({
      overall,
      round: slot.round,
      pickInRound: slot.pickInRound,
      draftPosition: slot.draftPosition,
      lawyerId: choice.id,
      isAuto: rng.chance(0.06),
      secondsAfterStart: seconds,
    });
  }
  return picks;
}

/** A full lineup that leans on preseason rank but with some seeded variety. */
export function variedLineup(players: RosterPlayer[], roster: RosterSettings, rng: Rng, jitter = 40): (string | null)[] {
  const jittered = players.map((p) => ({ ...p, preseasonRank: (p.preseasonRank ?? 999) + rng.float() * jitter }));
  return autoFillLineup(new Array<string | null>(starterSlots(roster).length).fill(null), roster, jittered);
}
