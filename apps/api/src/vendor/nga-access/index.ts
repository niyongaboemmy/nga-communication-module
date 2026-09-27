// VENDORED from nga_central_mis/packages/access/src/index.ts -- do not edit.
// Re-sync with: node nga_central_mis/packages/access/sync.mjs <this dir>
// sha256:a5b3d717fd447d32a7040f6a4c427bd2aa5cbab6ab13af9ae99d2be356ff5d69
/**
 * @nga/access -- the shared access-decision core.
 *
 * Pure, dependency-free TypeScript. MIS compiles a user's grants into an
 * AccessSnapshot (per app); every app evaluates it with the functions below,
 * so a decision is identical wherever it is made.
 *
 * Source of truth: nga_central_mis/packages/access/src/index.ts. Consumers
 * vendor an exact copy (see packages/access/README.md) -- never edit a copy.
 */

export const ACCESS_CORE_VERSION = "1.2.0";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type Depth = "summary" | "detail" | "sensitive";
export const DEPTHS: readonly Depth[] = ["summary", "detail", "sensitive"];
const DEPTH_RANK: Record<Depth, number> = { summary: 1, detail: 2, sensitive: 3 };

export type ScopeType =
  | "PLATFORM"
  | "SCHOOL"
  | "PROGRAM"
  | "DEPARTMENT"
  | "GRADE"
  | "CLASS_GROUP"
  | "SUBJECT_CLASS"
  | "MENTEES"
  | "CHILDREN"
  | "SELF";
export const SCOPE_TYPES: readonly ScopeType[] = [
  "PLATFORM",
  "SCHOOL",
  "PROGRAM",
  "DEPARTMENT",
  "GRADE",
  "CLASS_GROUP",
  "SUBJECT_CLASS",
  "MENTEES",
  "CHILDREN",
  "SELF",
];

export type Domain =
  | "ACADEMICS"
  | "CURRICULUM"
  | "ASSESSMENT"
  | "ATTENDANCE"
  | "DISCIPLINE"
  | "WELFARE"
  | "REPORTING"
  | "COMMS"
  | "FINANCE"
  | "PEOPLE"
  | "ACCESS"
  | "SYSTEM";
export const DOMAINS: readonly Domain[] = [
  "ACADEMICS",
  "CURRICULUM",
  "ASSESSMENT",
  "ATTENDANCE",
  "DISCIPLINE",
  "WELFARE",
  "REPORTING",
  "COMMS",
  "FINANCE",
  "PEOPLE",
  "ACCESS",
  "SYSTEM",
];

export const depthRank = (d: Depth | null | undefined): number =>
  d ? DEPTH_RANK[d] : 0;

/** True when `have` is at least as deep as `need` (no `need` = any depth). */
export const depthSatisfies = (
  have: Depth | null | undefined,
  need: Depth | null | undefined,
): boolean => (need ? depthRank(have) >= depthRank(need) : true);

export const maxDepth = (
  a: Depth | null | undefined,
  b: Depth | null | undefined,
): Depth | null => (depthRank(a) >= depthRank(b) ? a ?? null : b ?? null);

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * One grant's node, pre-expanded by MIS to plain id lists so no app needs to
 * know the school hierarchy. Only the lists relevant to the node are present.
 */
export interface ScopeEntry {
  all?: boolean;
  programs?: number[];
  departments?: number[];
  grades?: number[];
  class_groups?: number[];
  subjects?: number[];
  /** [subject_id, class_group_id] */
  pairs?: Array<[number, number]>;
  students?: number[];
  /** the grant holder's own user id (SELF scope) */
  self?: number;
}

/**
 * What a decision is about. Pass what you know; the most specific field wins:
 * student > owner > (subject, class group) > class group > subject > grade >
 * department > program. An empty target asks "does the user hold this
 * capability anywhere?".
 */
export interface Target {
  programId?: number | null;
  departmentId?: number | null;
  gradeId?: number | null;
  classGroupId?: number | null;
  subjectId?: number | null;
  studentId?: number | null;
  /** user who owns/created the record -- matched against SELF */
  ownerId?: number | null;
  /**
   * With classGroupId and no subjectId: "a student/record in this class, in
   * any subject" -- then a subject-in-class scope (subject teacher) for that
   * class also covers it. Use it for student-context checks (a pupil's
   * conduct, excuses, attendance history). Leave it off for whole-class
   * actions (the homeroom register), which only whole-class scopes cover.
   */
  anySubject?: boolean;
}

const has = (list: number[] | undefined, id: number) =>
  Array.isArray(list) && list.includes(id);

const isEmptyTarget = (t?: Target | null) =>
  !t ||
  [
    t.programId,
    t.departmentId,
    t.gradeId,
    t.classGroupId,
    t.subjectId,
    t.studentId,
    t.ownerId,
  ].every((v) => v === undefined || v === null);

/** Does one scope entry cover the target? */
export function entryCovers(entry: ScopeEntry, target?: Target | null): boolean {
  if (entry.all) return true;
  if (isEmptyTarget(target)) return true;
  const t = target as Target;

  if (t.studentId != null) {
    if (has(entry.students, t.studentId)) return true;
    if (entry.self === t.studentId) return true;
    // Otherwise fall through: the caller may also have supplied the student's
    // class group / subject so structural scopes (class teacher, DOS) apply.
  }
  if (t.ownerId != null && entry.self === t.ownerId) return true;

  if (t.subjectId != null && t.classGroupId != null) {
    if (has(entry.class_groups, t.classGroupId)) return true;
    return (entry.pairs ?? []).some(
      ([s, c]) => s === t.subjectId && c === t.classGroupId,
    );
  }
  if (t.classGroupId != null) {
    if (has(entry.class_groups, t.classGroupId)) return true;
    return !!t.anySubject && (entry.pairs ?? []).some(([, c]) => c === t.classGroupId);
  }
  if (t.subjectId != null) {
    if (has(entry.subjects, t.subjectId)) return true;
    return (entry.pairs ?? []).some(([s]) => s === t.subjectId);
  }
  if (t.gradeId != null) return has(entry.grades, t.gradeId);
  if (t.departmentId != null) return has(entry.departments, t.departmentId);
  if (t.programId != null) return has(entry.programs, t.programId);
  return false;
}

/** Union of several entries, for turning into one list/SQL filter. */
export function scopeUnion(entries: ScopeEntry[]): ScopeEntry | null {
  if (entries.length === 0) return null;
  if (entries.some((e) => e.all)) return { all: true };
  const out: Required<Omit<ScopeEntry, "all" | "self">> & { self?: number } = {
    programs: [],
    departments: [],
    grades: [],
    class_groups: [],
    subjects: [],
    pairs: [],
    students: [],
  };
  const pairKeys = new Set<string>();
  for (const e of entries) {
    for (const k of [
      "programs",
      "departments",
      "grades",
      "class_groups",
      "subjects",
      "students",
    ] as const) {
      for (const id of e[k] ?? []) if (!out[k].includes(id)) out[k].push(id);
    }
    for (const [s, c] of e.pairs ?? []) {
      const key = `${s}:${c}`;
      if (!pairKeys.has(key)) {
        pairKeys.add(key);
        out.pairs.push([s, c]);
      }
    }
    if (e.self != null) out.self = e.self;
  }
  const compact: ScopeEntry = {};
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) ? v.length > 0 : v != null) (compact as any)[k] = v;
  }
  return compact;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface CapabilityEntry {
  /** null for WRITE capabilities */
  depth: Depth | null;
  scope: ScopeEntry;
  /** grant ids that produced this entry -- for "why?" */
  via: number[];
}

export interface GrantInfo {
  role: string;
  role_id: number;
  title: string | null;
  scope_type: ScopeType;
  scope_id: number | null;
  scope_id2: number | null;
  valid_until: string | null;
}

export interface AccessSnapshot {
  /** User.access_version at compile time */
  v: number;
  app: string;
  core: string;
  user: {
    id: number;
    persona: string | null;
    school_id: number;
    /**
     * Class groups the user belongs to as a learner this year -- a student's
     * own, a parent's children's. Membership, not access: it lets apps apply
     * relationship rules ("students may message their teachers/classmates").
     */
    class_groups?: number[];
  };
  year: number | null;
  /** capability key (app-local, e.g. "DISCIPLINE_VIEW") -> entries */
  caps: Record<string, CapabilityEntry[]>;
  grants: Record<string, GrantInfo>;
  home: string | null;
  systems: string[];
  generated_at: string;
}

export interface Decision {
  allowed: boolean;
  depth: Depth | null;
  via: number[];
}

/**
 * The single decision function. `minDepth` applies to READ capabilities;
 * the returned depth is the deepest one any covering grant gives.
 */
export function decide(
  snapshot: AccessSnapshot | null | undefined,
  capability: string,
  target?: Target | null,
  minDepth?: Depth | null,
): Decision {
  const entries = snapshot?.caps?.[capability];
  if (!entries || entries.length === 0) {
    return { allowed: false, depth: null, via: [] };
  }
  let depth: Depth | null = null;
  let covered = false;
  const via: number[] = [];
  for (const e of entries) {
    if (!entryCovers(e.scope, target)) continue;
    covered = true;
    depth = maxDepth(depth, e.depth);
    for (const g of e.via) if (!via.includes(g)) via.push(g);
  }
  const allowed = covered && depthSatisfies(depth, minDepth ?? null);
  return { allowed, depth: covered ? depth : null, via: covered ? via : [] };
}

export const can = (
  snapshot: AccessSnapshot | null | undefined,
  capability: string,
  target?: Target | null,
  minDepth?: Depth | null,
): boolean => decide(snapshot, capability, target, minDepth).allowed;

/** Deepest depth the user holds for `capability` at `target`, or null. */
export const depthAt = (
  snapshot: AccessSnapshot | null | undefined,
  capability: string,
  target?: Target | null,
): Depth | null => decide(snapshot, capability, target).depth;

/**
 * Where may the user use `capability` at `minDepth` or deeper? Returns the
 * union of the covering entries -- the input for a list query's WHERE clause.
 * null = nowhere.
 */
export function scopeFor(
  snapshot: AccessSnapshot | null | undefined,
  capability: string,
  minDepth?: Depth | null,
): ScopeEntry | null {
  const entries = (snapshot?.caps?.[capability] ?? []).filter((e) =>
    depthSatisfies(e.depth, minDepth ?? null),
  );
  return scopeUnion(entries.map((e) => e.scope));
}

/** Set of capability keys held anywhere -- for coarse UI gating only. */
export const capabilityKeys = (snapshot: AccessSnapshot | null | undefined) =>
  new Set(Object.keys(snapshot?.caps ?? {}));

// ---------------------------------------------------------------------------
// Aggregates (summary depth)
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_COHORT = 5;

/** Groupings allowed at a depth: summary never goes below class level. */
export const GROUP_BY_BY_DEPTH: Record<Depth, readonly string[]> = {
  summary: ["SCHOOL", "PROGRAM", "GRADE", "CLASS_GROUP", "SUBJECT", "WEEK", "MONTH", "TERM", "CATEGORY"],
  detail: ["SCHOOL", "PROGRAM", "GRADE", "CLASS_GROUP", "SUBJECT", "WEEK", "MONTH", "TERM", "CATEGORY", "STUDENT"],
  sensitive: ["SCHOOL", "PROGRAM", "GRADE", "CLASS_GROUP", "SUBJECT", "WEEK", "MONTH", "TERM", "CATEGORY", "STUDENT"],
};

export const groupByAllowed = (depth: Depth | null, groupBy: string) =>
  !!depth && GROUP_BY_BY_DEPTH[depth].includes(groupBy.toUpperCase());

export interface CohortRow {
  n: number;
  value?: number | null;
  suppressed?: boolean;
  [k: string]: unknown;
}

/** Hide values of groups too small to stay anonymous. */
export function suppressSmallCohorts<T extends CohortRow>(
  rows: T[],
  minCohort = DEFAULT_MIN_COHORT,
): T[] {
  return rows.map((r) =>
    r.n < minCohort ? { ...r, value: null, suppressed: true } : { ...r, suppressed: false },
  );
}

/** "PROGRAM:2" / "SUBJECT_CLASS:31/12" / "SCHOOL" -> Target (null if malformed). */
export function parseNode(node: string): { type: ScopeType; target: Target } | null {
  const [rawType, rawIds] = String(node || "").split(":");
  const type = rawType?.toUpperCase() as ScopeType;
  if (!SCOPE_TYPES.includes(type)) return null;
  if (type === "SCHOOL" || type === "PLATFORM") return { type, target: {} };
  const ids = (rawIds ?? "").split("/").map((v) => Number(v));
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  switch (type) {
    case "PROGRAM":
      return { type, target: { programId: ids[0] } };
    case "DEPARTMENT":
      return { type, target: { departmentId: ids[0] } };
    case "GRADE":
      return { type, target: { gradeId: ids[0] } };
    case "CLASS_GROUP":
      return { type, target: { classGroupId: ids[0] } };
    case "SUBJECT_CLASS":
      return ids.length === 2
        ? { type, target: { subjectId: ids[0], classGroupId: ids[1] } }
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Manifests -- what an app can do (the only access code that needs a deploy)
// ---------------------------------------------------------------------------

export interface CapabilityDef {
  label: string;
  domain: Domain;
  kind: "READ" | "WRITE";
  /** READ only: the depths this capability distinguishes */
  depths?: Depth[];
  /** depths (or all, when true) that need justification + expiry to grant */
  restricted?: Depth[] | boolean;
  /** false = only meaningful at SCHOOL/PLATFORM (e.g. managing SSO clients) */
  scopeable?: boolean;
  description?: string;
}

export interface InsightDef {
  label: string;
  capability: string;
  minDepth: Depth;
  levels: ScopeType[];
}

export interface Manifest {
  app: string;
  name: string;
  version?: string;
  capabilities: Record<string, CapabilityDef>;
  insights?: Record<string, InsightDef>;
  /** legacy key -> capability key, while old call sites are migrated */
  aliases?: Record<string, string>;
}

export const defineManifest = <M extends Manifest>(m: M): M => m;

const KEY_RE = /^[A-Z][A-Z0-9_]{1,98}$/;
const APP_RE = /^[a-z][a-z0-9]{1,29}$/;

/** Structural validation -- run in each app's tests and again by MIS on publish. */
export function validateManifest(m: Manifest): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== "object") return ["manifest must be an object"];
  if (!APP_RE.test(m.app ?? "")) errors.push(`app "${m.app}" must match ${APP_RE}`);
  if (!m.name) errors.push("name is required");
  const caps = m.capabilities ?? {};
  if (Object.keys(caps).length === 0) errors.push("at least one capability is required");
  for (const [key, def] of Object.entries(caps)) {
    const at = `capabilities.${key}`;
    if (!KEY_RE.test(key)) errors.push(`${at}: key must match ${KEY_RE}`);
    if (!def.label) errors.push(`${at}: label is required`);
    if (!DOMAINS.includes(def.domain)) errors.push(`${at}: unknown domain "${def.domain}"`);
    if (def.kind !== "READ" && def.kind !== "WRITE") errors.push(`${at}: kind must be READ or WRITE`);
    if (def.kind === "READ") {
      if (!def.depths || def.depths.length === 0) errors.push(`${at}: READ needs depths`);
      for (const d of def.depths ?? []) if (!DEPTHS.includes(d)) errors.push(`${at}: unknown depth "${d}"`);
    }
    if (def.kind === "WRITE" && def.depths && def.depths.length > 0) {
      errors.push(`${at}: WRITE capabilities have no depths`);
    }
    if (Array.isArray(def.restricted)) {
      for (const d of def.restricted) {
        if (!(def.depths ?? []).includes(d)) errors.push(`${at}: restricted depth "${d}" not in depths`);
      }
    }
  }
  for (const [legacy, target] of Object.entries(m.aliases ?? {})) {
    if (!caps[target]) errors.push(`aliases.${legacy}: unknown capability "${target}"`);
    if (caps[legacy]) errors.push(`aliases.${legacy}: alias shadows a real capability`);
  }
  for (const [key, ins] of Object.entries(m.insights ?? {})) {
    const at = `insights.${key}`;
    const cap = caps[ins.capability];
    if (!cap) {
      errors.push(`${at}: unknown capability "${ins.capability}"`);
      continue;
    }
    if (cap.kind !== "READ") errors.push(`${at}: capability must be READ`);
    if (!(cap.depths ?? []).includes(ins.minDepth)) {
      errors.push(`${at}: minDepth "${ins.minDepth}" not supported by ${ins.capability}`);
    }
    for (const l of ins.levels ?? []) if (!SCOPE_TYPES.includes(l)) errors.push(`${at}: unknown level "${l}"`);
  }
  return errors;
}

/** Is a depth restricted for this capability? */
export const isRestricted = (def: Pick<CapabilityDef, "restricted">, depth: Depth | null) =>
  def.restricted === true || (!!depth && Array.isArray(def.restricted) && def.restricted.includes(depth));
