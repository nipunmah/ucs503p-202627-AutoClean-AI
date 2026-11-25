/**
 * Columns tab: an explorable, filterable column profile with per-column
 * pipeline overrides.
 *
 * Everything this view says the pipeline WILL do is derived from the backend
 * code (backend/app/core/pipeline/cleaning.py, outliers.py, encoding.py,
 * feature_engineering.py, scaling.py) and the column's current profile. The
 * pipeline re-profiles at every step, so the "expected" notes are
 * estimates from today's profile, and say so.
 */
import { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ColumnsViewProps } from "./contracts";
import type { ColumnKind, ColumnProfile, EncodingStrategy, OutlierStrategy, PipelineConfigIn, ScaleMethod } from "../types";
import { Badge, Button, Callout, EmptyState, IconButton, KindBadge, Meter, Skeleton } from "../components/ui";
import type { Tone } from "../components/ui";
import { Icon } from "../components/icons";
import { KIND_LABELS, fmtInt, fmtNum, fmtPct, plural } from "../lib/format";
import "./ColumnsView.css";

/* ======================================================================
   Backend-derived rules
   ====================================================================== */

const KIND_ORDER: ColumnKind[] = ["numeric", "categorical", "boolean", "datetime", "text", "identifier", "empty"];

/** Mirrors chat_assistant._detect_intent keyword lists (priority order matters). */
const CHAT_RECOMMEND_KW = ["algorithm", "model", "train", "predict", "classifier", "regressor", "recommend"];
const CHAT_QUALITY_KW = ["missing", "null", "clean", "quality", "complete", "nan"];
const CHAT_OUTLIER_KW = ["outlier", "anomaly", "extreme", "weird value"];

type ChatIntent = "recommend" | "data_quality" | "outlier" | "summary";

function detectChatIntent(question: string): ChatIntent {
  const q = question.toLowerCase();
  if (CHAT_RECOMMEND_KW.some((k) => q.includes(k))) return "recommend";
  if (CHAT_QUALITY_KW.some((k) => q.includes(k))) return "data_quality";
  if (CHAT_OUTLIER_KW.some((k) => q.includes(k))) return "outlier";
  return "summary";
}

/** Impute strategies cleaning.impute_missing actually honours, per kind (after type coercion). */
type ImputeChoice = "median" | "mean" | "mode" | "ffill_bfill" | "constant" | "skip";

const IMPUTE_OPTIONS: Record<ColumnKind, ImputeChoice[]> = {
  numeric: ["median", "mean", "mode", "ffill_bfill", "skip"],
  datetime: ["ffill_bfill", "mode", "skip"],
  boolean: ["mode", "ffill_bfill", "skip"],
  categorical: ["mode", "ffill_bfill", "constant", "skip"],
  text: ["mode", "ffill_bfill", "constant", "skip"],
  identifier: ["mode", "ffill_bfill", "constant", "skip"],
  // impute_missing always leaves kind "empty" as-is, whatever the strategy.
  empty: [],
};

const IMPUTE_LABELS: Record<ImputeChoice, string> = {
  median: "Median",
  mean: "Mean",
  mode: "Most frequent value (mode)",
  ffill_bfill: "Forward / backward fill",
  constant: "Constant text…",
  skip: "Leave missing",
};

const OUTLIER_OPTIONS: OutlierStrategy[] = ["flag", "clip", "remove", "skip"];
const OUTLIER_LABELS: Record<OutlierStrategy, string> = {
  flag: "Flag (add indicator column)",
  clip: "Clip to IQR fences",
  remove: "Remove rows (drops data)",
  skip: "Skip detection",
};

const ENCODING_OPTIONS: EncodingStrategy[] = ["onehot", "label", "skip"];
const ENCODING_LABELS: Record<EncodingStrategy, string> = {
  onehot: "One-hot (0/1 column per value)",
  label: "Label (integer codes)",
  skip: "Leave as text",
};

const SCALE_LABELS: Record<ScaleMethod, string> = {
  standard: "standardized (z-score)",
  minmax: "min–max scaled to 0–1",
  robust: "robust-scaled (median / IQR)",
  none: "not scaled",
};

function imputeStrategyLabel(s: string): string {
  if (s.startsWith("constant:")) return `constant “${s.slice("constant:".length)}”`;
  if (s in IMPUTE_LABELS) return IMPUTE_LABELS[s as ImputeChoice].toLowerCase();
  return s;
}

/** Global settings that change what happens to a column; memoized so rows only re-render when they change. */
interface PlanCtx {
  rows: number;
  coerce: boolean;
  numericImpute: string;
  categoricalImpute: string;
  datetimeImpute: string;
  outlierDefault: OutlierStrategy;
  encode: boolean;
  oneHotMax: number;
  engineer: boolean;
  scaleMethod: ScaleMethod;
  scaleColumns: string[] | null;
}

function defaultImputeFor(kind: ColumnKind, ctx: PlanCtx): string {
  if (kind === "numeric") return ctx.numericImpute;
  if (kind === "datetime") return ctx.datetimeImpute;
  if (kind === "empty") return "skip";
  return ctx.categoricalImpute;
}

function defaultEncodingFor(card: Cardinality, ctx: PlanCtx): EncodingStrategy {
  return card.k <= ctx.oneHotMax ? "onehot" : "label";
}

interface Cardinality {
  k: number;
  /** Constant fill value that becomes a new category (impute runs before encoding). */
  addedFill: string | null;
}

/** Categories the encoder will see: imputation runs first, so a new constant fill adds one. */
function encodeCardinality(f: ColumnFacts, ctx: PlanCtx, imputeOv: string | undefined): Cardinality {
  const imp = imputeOv ?? defaultImputeFor(f.p.kind, ctx);
  if (imp.startsWith("constant:") && missingAtImpute(f, ctx) > 0) {
    const v = imp.slice("constant:".length);
    if (!f.p.sample_values.includes(v)) return { k: f.p.unique_count + 1, addedFill: v };
  }
  return { k: f.p.unique_count, addedFill: null };
}

/* ======================================================================
   Derived per-column facts
   ====================================================================== */

interface ColumnFacts {
  p: ColumnProfile;
  index: number;
  total: number;
  uniqueRatio: number;
  constant: boolean;
  /** Values type coercion will turn into NaN (estimated from the convertible ratio). */
  coercionFailures: number;
  /** Plain-English issue labels with real numbers. */
  issues: string[];
  hasIssue: boolean;
  nameKey: string;
}

function coercionFailuresFor(p: ColumnProfile): number {
  if (p.kind === "numeric" && p.numeric_convertible_ratio < 1) {
    return Math.round((1 - p.numeric_convertible_ratio) * p.non_null_count);
  }
  if (p.kind === "datetime" && p.datetime_convertible_ratio < 1) {
    return Math.round((1 - p.datetime_convertible_ratio) * p.non_null_count);
  }
  return 0;
}

function buildFacts(p: ColumnProfile, index: number): ColumnFacts {
  const total = p.non_null_count + p.null_count;
  const constant = p.kind !== "empty" && p.non_null_count > 0 && p.unique_count === 1;
  const coercionFailures = coercionFailuresFor(p);
  const issues: string[] = [];
  if (p.kind === "empty") issues.push("Every value is missing");
  else if (p.null_count > 0) issues.push(`${fmtInt(p.null_count)} missing (${fmtPct(p.null_ratio)})`);
  if (coercionFailures > 0) {
    issues.push(`≈${fmtInt(coercionFailures)} value(s) won't convert to ${p.kind === "numeric" ? "a number" : "a date"}`);
  }
  if (p.outlier_count > 0) issues.push(`${plural(p.outlier_count, "IQR outlier")}`);
  if (constant) issues.push("Only one distinct value");
  return {
    p,
    index,
    total,
    uniqueRatio: p.non_null_count > 0 ? p.unique_count / p.non_null_count : 0,
    constant,
    coercionFailures,
    issues,
    hasIssue: issues.length > 0,
    nameKey: p.name.toLowerCase(),
  };
}

function missingTone(ratio: number): Tone {
  if (ratio <= 0) return "success";
  if (ratio < 0.05) return "info";
  if (ratio < 0.3) return "warning";
  return "danger";
}

/* ======================================================================
   Plain-English descriptions
   ====================================================================== */

interface Note {
  text: string;
  tone: Tone;
}

/** Missing values the impute step will see: current nulls + values type coercion turns into NaN. */
function missingAtImpute(f: ColumnFacts, ctx: PlanCtx): number {
  return f.p.null_count + (ctx.coerce ? f.coercionFailures : 0);
}

function describeImpute(strategy: string, f: ColumnFacts, ctx: PlanCtx): Note {
  const { p } = f;
  const n = missingAtImpute(f, ctx);
  const nTxt = plural(n, "missing value");
  if (p.kind === "empty") {
    return { text: "Empty columns are never imputed — the backend leaves them as-is and records a warning.", tone: "neutral" };
  }
  if (n === 0) {
    return { text: "No missing values, so the impute step skips this column whatever the strategy.", tone: "neutral" };
  }
  if (strategy === "skip") {
    return { text: `${nTxt} stay missing; the audit trail records a warning.`, tone: "warning" };
  }
  if (strategy === "mean" || strategy === "median") {
    if (p.kind !== "numeric") {
      return {
        text: `“${strategy}” only works on numeric columns — on this ${KIND_LABELS[p.kind].toLowerCase()} column the backend leaves the ${nTxt} as-is and warns.`,
        tone: "warning",
      };
    }
    if (!ctx.coerce) {
      return {
        text: `Type coercion is off. If this column is still stored as text (as freshly uploaded files are), the backend's ${strategy} fails on text and the run errors. Turn type coercion on, or pick mode / forward fill.`,
        tone: "danger",
      };
    }
    const v = p.stats[strategy];
    return {
      text: `Fill ${nTxt} with the ${strategy}${v !== undefined ? ` (currently ${fmtNum(v)})` : ""}. Rows are kept.`,
      tone: "success",
    };
  }
  if (strategy === "mode") {
    return {
      text: `Fill ${nTxt} with the most frequent value (ties go to the first value in sorted order). Rows are kept.`,
      tone: "success",
    };
  }
  if (strategy === "ffill_bfill") {
    return {
      text: `Copy the nearest earlier value into each gap, then the next value back into any leading gaps. Depends on row order. Rows are kept.`,
      tone: "success",
    };
  }
  if (strategy.startsWith("constant:")) {
    const v = strategy.slice("constant:".length);
    return { text: `Fill ${nTxt} with the literal text “${v}”. Rows are kept.`, tone: "success" };
  }
  return { text: `Unrecognised strategy “${strategy}” — the backend leaves missing values as-is and warns.`, tone: "warning" };
}

function describeOutlier(strategy: OutlierStrategy, f: ColumnFacts, ctx: PlanCtx): Note {
  const { p } = f;
  const n = p.outlier_count;
  const fences = "Q1 − 1.5×IQR / Q3 + 1.5×IQR";
  if (strategy === "skip") return { text: "No outlier detection for this column.", tone: "neutral" };
  if (p.non_null_count < 4) {
    return { text: "Fewer than 4 values — the backend can't compute IQR fences, so nothing happens.", tone: "neutral" };
  }
  const nowTxt =
    n > 0
      ? `${plural(n, "value")} currently outside the fences (${fences})`
      : `no values currently outside the fences (${fences}), so likely nothing happens`;
  if (strategy === "flag") {
    return {
      text: `Keeps every value; ${nowTxt}. If any are found at run time it adds a true/false column “${p.name}__is_outlier”${ctx.encode ? " (encoded to 0/1 later)" : ""}.`,
      tone: "success",
    };
  }
  if (strategy === "clip") {
    return {
      text: `Caps extreme values to the fences — ${nowTxt}. Rows are kept but those values change.`,
      tone: "warning",
    };
  }
  // remove
  return {
    text:
      n > 0
        ? `DROPS every row where “${p.name}” is outside the fences — about ${fmtInt(n)} of ${fmtInt(ctx.rows)} rows (${fmtPct(n / Math.max(1, ctx.rows))}) by today's profile. The row-count drop is allowed only because you chose “remove”, and it is recorded in the audit trail.`
        : `Would DROP rows where “${p.name}” is outside the fences (${fences}). None are detected today, but fences are recomputed after imputation.`,
    tone: "danger",
  };
}

function describeEncoding(strategy: EncodingStrategy, f: ColumnFacts, card: Cardinality): Note {
  const k = card.k;
  const fillNote = card.addedFill !== null ? ` (including your fill value “${card.addedFill}”)` : "";
  if (strategy === "onehot") {
    return {
      text: `Replaces “${f.p.name}” with ${plural(k, "0/1 column")}${fillNote} named “${f.p.name}_<value>”.${k > 30 ? " That is a lot of columns — label encoding may be better." : ""}`,
      tone: k > 30 ? "warning" : "success",
    };
  }
  if (strategy === "label") {
    return {
      text: `Replaces each value with an integer code 0…${fmtInt(Math.max(0, k - 1))} in sorted order${fillNote} (any remaining missing values become −1). Implies an order between categories.`,
      tone: "success",
    };
  }
  return { text: "Leaves the values as text — most models can't use a text column directly.", tone: "warning" };
}

/** Why a non-categorical column has no encoding control (encoding.encode_categoricals). */
function encodingNotApplicable(kind: ColumnKind): string {
  switch (kind) {
    case "boolean":
      return "Booleans are always converted to 0/1 — no encoding override applies.";
    case "identifier":
      return "Identifiers are left unencoded (the backend warns rather than dropping them) — overrides are ignored for this kind.";
    case "text":
      return "Free text is left unencoded — overrides are ignored for this kind.";
    case "numeric":
      return "Numeric columns are already model-ready — encoding doesn't touch them.";
    case "datetime":
      return "Dates aren't encoded; feature engineering derives numeric parts instead.";
    default:
      return "Encoding doesn't touch this column.";
  }
}

interface Overrides {
  impute?: string;
  outlier?: OutlierStrategy;
  encoding?: EncodingStrategy;
}

interface PlanStep {
  step: string;
  text: string;
  tone: Tone;
}

/** Expected per-step treatment of this column under the current config. */
function planFor(f: ColumnFacts, ctx: PlanCtx, ov: Overrides): PlanStep[] {
  const { p } = f;
  const out: PlanStep[] = [];

  // 1. coerce_types
  if (ctx.coerce) {
    if (p.kind === "numeric" || p.kind === "datetime") {
      const to = p.kind === "numeric" ? "numbers" : "dates";
      out.push({
        step: "Type coercion",
        text:
          f.coercionFailures > 0
            ? `Converted to ${to}; ≈${fmtInt(f.coercionFailures)} value(s) that don't parse become missing (not dropped).`
            : `Converted to ${to}.`,
        tone: f.coercionFailures > 0 ? "warning" : "neutral",
      });
    } else if (p.kind === "boolean") {
      out.push({ step: "Type coercion", text: "Mapped to true / false (yes/no, y/n, t/f, 1/0).", tone: "neutral" });
    }
  }

  // 2. impute_missing
  const imp = ov.impute ?? defaultImputeFor(p.kind, ctx);
  if (p.kind === "empty" || missingAtImpute(f, ctx) > 0) {
    const d = describeImpute(imp, f, ctx);
    out.push({ step: "Missing values", text: d.text, tone: d.tone });
  }

  // 4. handle_outliers (numeric only)
  if (p.kind === "numeric") {
    const s = ov.outlier ?? ctx.outlierDefault;
    if (s !== "skip" && p.non_null_count >= 4 && (p.outlier_count > 0 || s === "remove")) {
      const d = describeOutlier(s, f, ctx);
      out.push({ step: "Outliers", text: d.text, tone: d.tone });
    }
  }

  // 5. encode_categoricals
  let encodedAs: EncodingStrategy | "bool" | null = null;
  if (ctx.encode) {
    if (p.kind === "boolean") {
      encodedAs = "bool";
      out.push({ step: "Encoding", text: "Converted to 0/1.", tone: "neutral" });
    } else if (p.kind === "categorical") {
      const card = encodeCardinality(f, ctx, ov.impute);
      const s = ov.encoding ?? defaultEncodingFor(card, ctx);
      encodedAs = s;
      const d = describeEncoding(s, f, card);
      out.push({ step: "Encoding", text: d.text, tone: d.tone === "success" ? "neutral" : d.tone });
    } else if (p.kind === "identifier" || p.kind === "text") {
      out.push({ step: "Encoding", text: "Left unencoded; the audit trail records a warning.", tone: "neutral" });
    }
  }

  // 6. engineer_features
  if (ctx.engineer) {
    if (p.kind === "datetime") {
      out.push({
        step: "Features",
        text: `Adds “${p.name}__year”, “__month”, “__day” and “__weekday”; the date column itself is kept.`,
        tone: "neutral",
      });
    } else if (p.kind === "text") {
      out.push({ step: "Features", text: `Adds “${p.name}__length” and “${p.name}__word_count”.`, tone: "neutral" });
    }
  }

  // 7. scale_features (numeric kind at scaling time, binary 0/1 columns excluded)
  if (ctx.scaleMethod !== "none") {
    const how = SCALE_LABELS[ctx.scaleMethod];
    if (ctx.scaleColumns !== null) {
      if (ctx.scaleColumns.includes(p.name)) out.push({ step: "Scaling", text: `${cap(how)} (listed in scale columns).`, tone: "neutral" });
    } else if (p.kind === "numeric") {
      const binary = p.stats.min === 0 && p.stats.max === 1 && p.unique_count <= 2;
      out.push({
        step: "Scaling",
        text: binary ? "Skipped — 0/1 indicator columns are excluded from scaling." : `${cap(how)}.`,
        tone: "neutral",
      });
    } else if (encodedAs === "label" && p.unique_count > 2) {
      out.push({ step: "Scaling", text: `The integer codes are numeric, so they are ${how} too.`, tone: "neutral" });
    } else if (p.kind === "datetime" && ctx.engineer) {
      out.push({ step: "Scaling", text: `The derived date-part columns are ${how}.`, tone: "neutral" });
    } else if (p.kind === "text" && ctx.engineer) {
      out.push({ step: "Scaling", text: `The derived length / word-count columns are ${how}.`, tone: "neutral" });
    }
  }
  return out;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Observations with their numeric reasons. */
function insightsFor(f: ColumnFacts, ctx: PlanCtx): Note[] {
  const { p } = f;
  const out: Note[] = [];
  if (p.kind === "empty") {
    out.push({ text: `All ${fmtInt(f.total)} values are missing — this column carries no information.`, tone: "danger" });
    return out;
  }
  if (p.null_count > 0) {
    out.push({
      text: `${fmtPct(p.null_ratio)} missing (${fmtInt(p.null_count)} of ${fmtInt(f.total)} rows).${p.null_ratio >= 0.5 ? " More than half the values would be imputed — consider whether this column is worth keeping." : ""}`,
      tone: missingTone(p.null_ratio),
    });
  }
  if (f.coercionFailures > 0) {
    const ratio = p.kind === "numeric" ? p.numeric_convertible_ratio : p.datetime_convertible_ratio;
    out.push({
      text: `${fmtPct(ratio)} of values parse as ${p.kind === "numeric" ? "numbers" : "dates"}; ≈${fmtInt(f.coercionFailures)} don't and ${ctx.coerce ? "will become missing during type coercion" : "would become missing if type coercion were on"}.`,
      tone: "warning",
    });
  }
  if (f.constant) {
    out.push({ text: `Only one distinct value (“${p.sample_values[0] ?? ""}”) — it can't help a model tell rows apart.`, tone: "warning" });
  }
  if (p.kind === "identifier") {
    out.push({
      text: `Every value is unique (${fmtInt(p.unique_count)} of ${fmtInt(p.non_null_count)}) — looks like an ID. Exclude it before training.`,
      tone: "info",
    });
  }
  if (p.kind === "numeric") {
    const { mean, median, std } = p.stats;
    if (mean !== undefined && median !== undefined && std !== undefined && std > 0) {
      // Pearson's second skewness coefficient: 3 × (mean − median) / std.
      const skew = (3 * (mean - median)) / std;
      if (Math.abs(skew) >= 1) {
        out.push({
          text: `${skew > 0 ? "Right" : "Left"}-skewed: mean ${fmtNum(mean)} vs median ${fmtNum(median)} (Pearson skew ${fmtNum(skew, 2)}). Median imputation and robust scaling are less affected by the tail.`,
          tone: "info",
        });
      }
    }
    if (p.outlier_count > 0) {
      out.push({
        text: `${plural(p.outlier_count, "value")} (${fmtPct(p.outlier_count / Math.max(1, f.total))}) fall outside the IQR fences.`,
        tone: "warning",
      });
    }
  }
  if (p.kind === "categorical") {
    out.push({
      text: `${plural(p.unique_count, "category", "categories")} — ${p.unique_count <= ctx.oneHotMax ? "within" : "above"} the one-hot limit of ${fmtInt(ctx.oneHotMax)}, so the default is ${p.unique_count <= ctx.oneHotMax ? "one-hot" : "label"} encoding.`,
      tone: "neutral",
    });
  }
  return out;
}

/** A question the rule-based chat assistant answers well for this column's situation. */
function assistantQuestionFor(f: ColumnFacts): string {
  const { p } = f;
  const pick = (withName: string, generic: string, intent: ChatIntent) =>
    detectChatIntent(withName) === intent ? withName : generic;
  if (p.outlier_count > 0) {
    return pick(`Which columns have outliers? I'm looking at '${p.name}'.`, "Which columns have outliers?", "outlier");
  }
  if (p.null_count > 0 || p.kind === "empty" || f.coercionFailures > 0) {
    return pick(
      `How much is missing in '${p.name}' compared with the other columns?`,
      "How much data is missing, and which column is worst?",
      "data_quality",
    );
  }
  return "Which model should I train on this dataset?";
}

/* ======================================================================
   Config helpers
   ====================================================================== */

type OverrideKey = "impute_overrides" | "outlier_overrides" | "encoding_overrides";

function withOverride(config: PipelineConfigIn, key: OverrideKey, col: string, value: string | null): PipelineConfigIn {
  const next: Record<string, string> = { ...config[key] };
  if (value === null) delete next[col];
  else next[col] = value;
  return { ...config, [key]: next } as PipelineConfigIn;
}

type SortKey = "order" | "name" | "missing" | "unique" | "outliers";
const SORT_LABELS: Record<SortKey, string> = {
  order: "Dataset order",
  name: "Name",
  missing: "Missing %",
  unique: "Unique values",
  outliers: "Outliers",
};

/* ======================================================================
   View
   ====================================================================== */

export default function ColumnsView({ dataset, profile, loading, config, onConfigChange, onNavigate, onAskAssistant }: ColumnsViewProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [kindFilter, setKindFilter] = useState<ColumnKind | "all">("all");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("order");
  const [sortDesc, setSortDesc] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [undo, setUndo] = useState<PipelineConfigIn | null>(null);
  const searchId = useId();
  const sortId = useId();

  // Latest config/callback in a ref so per-row callbacks stay stable (rows are memoized).
  const latest = useRef({ config, onConfigChange });
  useEffect(() => {
    latest.current = { config, onConfigChange };
  });

  const facts = useMemo(() => (profile ?? []).map(buildFacts), [profile]);
  const columnSet = useMemo(() => new Set(facts.map((f) => f.p.name)), [facts]);

  const ctx: PlanCtx = useMemo(
    () => ({
      rows: dataset.rows,
      coerce: config.coerce_types,
      numericImpute: config.numeric_impute_strategy,
      categoricalImpute: config.categorical_impute_strategy,
      datetimeImpute: config.datetime_impute_strategy,
      outlierDefault: config.outlier_default_strategy,
      encode: config.encode,
      oneHotMax: config.one_hot_max_cardinality,
      engineer: config.engineer_features,
      scaleMethod: config.scale_method,
      scaleColumns: config.scale_columns,
    }),
    [
      dataset.rows,
      config.coerce_types,
      config.numeric_impute_strategy,
      config.categorical_impute_strategy,
      config.datetime_impute_strategy,
      config.outlier_default_strategy,
      config.encode,
      config.one_hot_max_cardinality,
      config.engineer_features,
      config.scale_method,
      config.scale_columns,
    ],
  );

  const kindCounts = useMemo(() => {
    const m = new Map<ColumnKind, number>();
    for (const f of facts) m.set(f.p.kind, (m.get(f.p.kind) ?? 0) + 1);
    return KIND_ORDER.filter((k) => m.has(k)).map((k) => ({ kind: k, count: m.get(k) ?? 0 }));
  }, [facts]);

  const issueCount = useMemo(() => facts.filter((f) => f.hasIssue).length, [facts]);

  const overriddenCols = useMemo(() => {
    const s = new Set<string>();
    for (const rec of [config.impute_overrides, config.outlier_overrides, config.encoding_overrides]) {
      for (const k of Object.keys(rec)) if (columnSet.has(k)) s.add(k);
    }
    return s;
  }, [config.impute_overrides, config.outlier_overrides, config.encoding_overrides, columnSet]);

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const list = facts.filter(
      (f) =>
        (kindFilter === "all" || f.p.kind === kindFilter) &&
        (!issuesOnly || f.hasIssue) &&
        (q === "" || f.nameKey.includes(q)),
    );
    if (sortKey === "order") return sortDesc ? list.reverse() : list;
    const dir = sortDesc ? -1 : 1;
    const val = (f: ColumnFacts): number =>
      sortKey === "missing" ? f.p.null_ratio : sortKey === "unique" ? f.p.unique_count : f.p.outlier_count;
    return list.sort((a, b) => {
      const c =
        sortKey === "name"
          ? a.p.name.localeCompare(b.p.name, undefined, { numeric: true, sensitivity: "base" })
          : val(a) - val(b);
      return c !== 0 ? c * dir : a.index - b.index;
    });
  }, [facts, deferredQuery, kindFilter, issuesOnly, sortKey, sortDesc]);

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const setOverride = useCallback((key: OverrideKey, col: string, value: string | null) => {
    const { config: c, onConfigChange: change } = latest.current;
    setUndo(null);
    change(withOverride(c, key, col, value));
  }, []);

  const clearAll = () => {
    const strip = <V,>(rec: Record<string, V>) => Object.fromEntries(Object.entries(rec).filter(([k]) => !columnSet.has(k)));
    setUndo(config);
    onConfigChange({
      ...config,
      impute_overrides: strip(config.impute_overrides),
      outlier_overrides: strip(config.outlier_overrides),
      encoding_overrides: strip(config.encoding_overrides),
    });
  };

  const changeSort = (k: SortKey) => {
    setSortKey(k);
    // Name / order read naturally ascending; metrics are most useful worst-first.
    setSortDesc(k === "missing" || k === "unique" || k === "outliers");
  };

  const resetFilters = () => {
    setQuery("");
    setKindFilter("all");
    setIssuesOnly(false);
  };

  if (loading && !profile) return <ColumnsSkeleton />;
  if (!profile || profile.length === 0) {
    return (
      <EmptyState icon="columns" title="No column profile">
        {profile ? "This dataset has no columns." : "The profile for this dataset isn't available yet."}
      </EmptyState>
    );
  }

  const filtersActive = query !== "" || kindFilter !== "all" || issuesOnly;
  const allExpanded = visible.length > 0 && visible.every((f) => expanded.has(f.p.name));

  return (
    <div className="col-view stack">
      <header className="col-head">
        <div>
          <h2 className="col-title">Columns</h2>
          <p className="col-sub muted">
            {plural(facts.length, "column")} · {plural(dataset.rows, "row")} ·{" "}
            {issueCount > 0 ? (
              <span className="col-sub-warn">{plural(issueCount, "column")} with issues</span>
            ) : (
              <span className="col-sub-ok">no issues found</span>
            )}
          </p>
        </div>
      </header>

      {overriddenCols.size > 0 ? (
        <Callout
          tone="accent"
          icon="sliders"
          title={`${plural(overriddenCols.size, "column has", "columns have")} overrides — they apply when you run the pipeline`}
          action={
            <div className="row">
              <Button size="sm" variant="ghost" icon="trash" onClick={clearAll}>
                Clear all overrides
              </Button>
              <Button size="sm" variant="primary" iconRight="arrowRight" onClick={() => onNavigate("clean")}>
                Go to Clean
              </Button>
            </div>
          }
        >
          {[...overriddenCols].slice(0, 6).join(", ")}
          {overriddenCols.size > 6 ? ` and ${overriddenCols.size - 6} more` : ""}
        </Callout>
      ) : undo ? (
        <Callout
          tone="neutral"
          title="Overrides cleared"
          action={
            <Button
              size="sm"
              icon="history"
              onClick={() => {
                // Restore only the override maps, keeping any other settings changed since.
                onConfigChange({
                  ...config,
                  impute_overrides: undo.impute_overrides,
                  outlier_overrides: undo.outlier_overrides,
                  encoding_overrides: undo.encoding_overrides,
                });
                setUndo(null);
              }}
            >
              Undo
            </Button>
          }
        />
      ) : null}

      <div className="col-toolbar" role="search" aria-label="Filter columns">
        <div className="col-search">
          <Icon name="search" size={14} className="col-search-icon" />
          <label htmlFor={searchId} className="sr-only">
            Search columns by name
          </label>
          <input
            id={searchId}
            className="input input-sm"
            type="search"
            placeholder="Search columns…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>

        <div className="col-chips" role="group" aria-label="Filter by kind">
          <button
            type="button"
            className={`col-chip${kindFilter === "all" ? " col-chip-on" : ""}`}
            aria-pressed={kindFilter === "all"}
            onClick={() => setKindFilter("all")}
          >
            All <span className="col-chip-count">{facts.length}</span>
          </button>
          {kindCounts.map(({ kind, count }) => (
            <button
              key={kind}
              type="button"
              className={`col-chip col-chip-kind kind-${kind}${kindFilter === kind ? " col-chip-on" : ""}`}
              aria-pressed={kindFilter === kind}
              onClick={() => setKindFilter(kindFilter === kind ? "all" : kind)}
            >
              {KIND_LABELS[kind]} <span className="col-chip-count">{count}</span>
            </button>
          ))}
          <button
            type="button"
            className={`col-chip col-chip-issues${issuesOnly ? " col-chip-on" : ""}`}
            aria-pressed={issuesOnly}
            onClick={() => setIssuesOnly((v) => !v)}
            title="Missing values, outliers, unparseable values, empty or constant columns"
          >
            <Icon name="alert" size={12} /> Issues only <span className="col-chip-count">{issueCount}</span>
          </button>
        </div>

        <div className="col-sort">
          <label htmlFor={sortId} className="col-sort-label faint">
            Sort
          </label>
          <select id={sortId} className="input input-sm" value={sortKey} onChange={(e) => changeSort(e.target.value as SortKey)}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
          <IconButton
            icon="chevronDown"
            size={30}
            label={sortDesc ? "Sorted descending — switch to ascending" : "Sorted ascending — switch to descending"}
            className={`col-dir${sortDesc ? "" : " col-dir-asc"}`}
            onClick={() => setSortDesc((v) => !v)}
          />
        </div>
      </div>

      <div className="col-resultbar">
        <span className="muted" aria-live="polite">
          {visible.length === facts.length
            ? `Showing all ${plural(facts.length, "column")}`
            : `Showing ${fmtInt(visible.length)} of ${plural(facts.length, "column")}`}
        </span>
        <span className="row">
          {filtersActive && (
            <Button size="sm" variant="ghost" icon="x" onClick={resetFilters}>
              Reset filters
            </Button>
          )}
          {visible.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={allExpanded ? "chevronRight" : "chevronDown"}
              onClick={() => setExpanded(allExpanded ? new Set() : new Set(visible.map((f) => f.p.name)))}
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </Button>
          )}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon="search"
          title="No columns match"
          action={
            <Button size="sm" icon="x" onClick={resetFilters}>
              Reset filters
            </Button>
          }
        >
          {issuesOnly && issueCount === 0 ? "No column has missing values, outliers, or other issues." : "Try a different search or kind filter."}
        </EmptyState>
      ) : (
        <div className="col-list-wrap">
          <div className="col-grid col-list-head" aria-hidden="true">
            <span />
            <span>Column</span>
            <span>Missing</span>
            <span className="num">Unique</span>
            <span className="num">Outliers</span>
            <span title="min … max, with ◆ median, ● mean and a ±1 std band">
              Range <span className="col-head-legend">◆ median ● mean</span>
            </span>
            <span>Samples</span>
          </div>
          <ul className="col-list" aria-label="Columns">
            {visible.map((f) => (
              <ColumnRow
                key={f.p.name}
                f={f}
                ctx={ctx}
                expanded={expanded.has(f.p.name)}
                imputeOv={config.impute_overrides[f.p.name]}
                outlierOv={config.outlier_overrides[f.p.name]}
                encodingOv={config.encoding_overrides[f.p.name]}
                onToggle={toggle}
                onSetOverride={setOverride}
                onAskAssistant={onAskAssistant}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ======================================================================
   Row
   ====================================================================== */

interface RowProps {
  f: ColumnFacts;
  ctx: PlanCtx;
  expanded: boolean;
  imputeOv: string | undefined;
  outlierOv: OutlierStrategy | undefined;
  encodingOv: EncodingStrategy | undefined;
  onToggle: (name: string) => void;
  onSetOverride: (key: OverrideKey, col: string, value: string | null) => void;
  onAskAssistant: (q: string) => void;
}

const ColumnRow = memo(function ColumnRow({
  f,
  ctx,
  expanded,
  imputeOv,
  outlierOv,
  encodingOv,
  onToggle,
  onSetOverride,
  onAskAssistant,
}: RowProps) {
  const { p } = f;
  const detailId = useId();
  const overrideList = [
    imputeOv !== undefined && `missing values: ${imputeStrategyLabel(imputeOv)}`,
    outlierOv !== undefined && `outliers: ${outlierOv}`,
    encodingOv !== undefined && `encoding: ${encodingOv}`,
  ].filter(Boolean) as string[];
  const samples = p.sample_values.join(", ");

  return (
    <li className={`col-item${expanded ? " col-item-open" : ""}${outlierOv === "remove" ? " col-item-danger" : ""}`}>
      <button
        type="button"
        className="col-grid col-summary"
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        aria-label={`${p.name}, ${KIND_LABELS[p.kind]}: ${f.issues.length > 0 ? f.issues.join("; ") : "no issues"}${
          overrideList.length > 0 ? `; ${plural(overrideList.length, "override")}` : ""
        }`}
        onClick={() => onToggle(p.name)}
      >
        <span className="col-chev" aria-hidden="true">
          <Icon name="chevronRight" size={14} />
        </span>

        <span className="col-name-cell">
          <span className="col-name" title={p.name}>
            {p.name}
          </span>
          <span className="col-name-meta">
            <KindBadge kind={p.kind} />
            {overrideList.length > 0 && (
              <Badge tone={outlierOv === "remove" ? "danger" : "accent"} title={`Overrides — ${overrideList.join("; ")}`}>
                <Icon name="sliders" size={11} />
                {overrideList.length === 1 ? "override" : `${overrideList.length} overrides`}
              </Badge>
            )}
          </span>
        </span>

        <span className="col-missing" title={`${fmtInt(p.null_count)} of ${fmtInt(f.total)} values missing`}>
          <span className="col-mlabel">
            <span className="col-metric-label">Missing</span>
            <strong className={p.null_count > 0 ? `col-tone-${missingTone(p.null_ratio)}` : "faint"}>{fmtPct(p.null_ratio)}</strong>
            {p.null_count > 0 && <span className="faint"> · {fmtInt(p.null_count)}</span>}
          </span>
          <Meter value={p.null_ratio} tone={missingTone(p.null_ratio)} height={4} label={`${p.name} missing ${fmtPct(p.null_ratio)}`} />
        </span>

        <span className="col-unique num" title={`${fmtInt(p.unique_count)} distinct of ${fmtInt(p.non_null_count)} non-missing values`}>
          <span className="col-metric-label">Unique</span>
          <span>{fmtInt(p.unique_count)}</span>
          <span className="col-subnum faint">{fmtPct(f.uniqueRatio, 0)}</span>
        </span>

        <span className="col-outliers num">
          <span className="col-metric-label">Outliers</span>
          {p.kind === "numeric" ? (
            p.outlier_count > 0 ? (
              <Badge tone="warning" title={`${p.outlier_count} value(s) outside Q1 − 1.5×IQR / Q3 + 1.5×IQR`}>
                {fmtInt(p.outlier_count)}
              </Badge>
            ) : (
              <span className="faint">0</span>
            )
          ) : (
            <span className="faint" title="Outlier detection only runs on numeric columns">
              –
            </span>
          )}
        </span>

        <span className={`col-range-cell${p.kind === "numeric" ? "" : " col-range-none"}`}>{p.kind === "numeric" ? <RangeTrack stats={p.stats} /> : <span className="faint">–</span>}</span>

        <span className="col-samples faint" title={samples}>
          {samples || "–"}
        </span>
      </button>

      {expanded && (
        <ColumnDetail
          id={detailId}
          f={f}
          ctx={ctx}
          imputeOv={imputeOv}
          outlierOv={outlierOv}
          encodingOv={encodingOv}
          onSetOverride={onSetOverride}
          onAskAssistant={onAskAssistant}
        />
      )}
    </li>
  );
});

/** min..max track with median (◆) and mean (●) markers and a ±1 std band. */
function RangeTrack({ stats }: { stats: Record<string, number> }) {
  const { min, max, mean, median, std } = stats;
  if (min === undefined || max === undefined) return <span className="faint">–</span>;
  const span = max - min;
  const pos = (v: number | undefined) => (v === undefined || span <= 0 ? 50 : Math.max(0, Math.min(100, ((v - min) / span) * 100)));
  const bandL = std !== undefined && mean !== undefined ? pos(mean - std) : null;
  const bandR = std !== undefined && mean !== undefined ? pos(mean + std) : null;
  const title = `min ${fmtNum(min)} · median ${fmtNum(median)} · mean ${fmtNum(mean)} · max ${fmtNum(max)}${std !== undefined ? ` · std ${fmtNum(std)}` : ""}`;
  return (
    <span className="col-range" title={title} role="img" aria-label={title}>
      <span className="col-range-num faint">{fmtNum(min, 2)}</span>
      <span className="col-track">
        {span > 0 && bandL !== null && bandR !== null && (
          <span className="col-band" style={{ left: `${bandL}%`, width: `${Math.max(0, bandR - bandL)}%` }} />
        )}
        {median !== undefined && <span className="col-mark col-mark-median" style={{ left: `${pos(median)}%` }} />}
        {mean !== undefined && <span className="col-mark col-mark-mean" style={{ left: `${pos(mean)}%` }} />}
      </span>
      <span className="col-range-num faint">{fmtNum(max, 2)}</span>
    </span>
  );
}

/* ======================================================================
   Detail panel
   ====================================================================== */

const STAT_ORDER = ["min", "median", "mean", "max", "std"];

function ColumnDetail({
  id,
  f,
  ctx,
  imputeOv,
  outlierOv,
  encodingOv,
  onSetOverride,
  onAskAssistant,
}: Omit<RowProps, "expanded" | "onToggle"> & { id: string }) {
  const { p } = f;
  const insights = useMemo(() => insightsFor(f, ctx), [f, ctx]);
  const plan = useMemo(() => planFor(f, ctx, { impute: imputeOv, outlier: outlierOv, encoding: encodingOv }), [f, ctx, imputeOv, outlierOv, encodingOv]);
  const question = useMemo(() => assistantQuestionFor(f), [f]);
  const statKeys = useMemo(
    () => [...STAT_ORDER.filter((k) => k in p.stats), ...Object.keys(p.stats).filter((k) => !STAT_ORDER.includes(k)).sort()],
    [p.stats],
  );

  return (
    <div id={id} className="col-detail" role="region" aria-label={`Details for ${p.name}`}>
      <div className="col-detail-grid">
        <section className="col-section">
          <h4 className="col-section-title">Profile</h4>
          <dl className="col-stats">
            <StatItem k="Rows" v={fmtInt(f.total)} />
            <StatItem k="Non-missing" v={fmtInt(p.non_null_count)} />
            <StatItem k="Missing" v={`${fmtInt(p.null_count)} (${fmtPct(p.null_ratio)})`} />
            <StatItem k="Unique" v={`${fmtInt(p.unique_count)} (${fmtPct(f.uniqueRatio)})`} />
            <StatItem k="Parses as number" v={fmtPct(p.numeric_convertible_ratio)} />
            <StatItem k="Parses as date" v={fmtPct(p.datetime_convertible_ratio)} />
            {p.kind === "numeric" && <StatItem k="IQR outliers" v={fmtInt(p.outlier_count)} />}
            {statKeys.map((k) => (
              <StatItem key={k} k={k} v={fmtNum(p.stats[k])} mono />
            ))}
          </dl>

          <h4 className="col-section-title">Sample values</h4>
          {p.sample_values.length > 0 ? (
            <div className="col-sample-chips">
              {p.sample_values.map((s, i) => (
                <code key={i} className="col-sample" title={s}>
                  {s}
                </code>
              ))}
            </div>
          ) : (
            <p className="faint col-small">No non-missing values.</p>
          )}
          <p className="faint col-small">Up to the first 5 distinct non-missing values.</p>

          {insights.length > 0 && (
            <>
              <h4 className="col-section-title">What we noticed</h4>
              <ul className="col-notes">
                {insights.map((n, i) => (
                  <li key={i} className={`col-note col-note-${n.tone}`}>
                    {n.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="col-section">
          <h4 className="col-section-title">Overrides for this column</h4>
          <ImputeControl f={f} ctx={ctx} value={imputeOv} onSet={(v) => onSetOverride("impute_overrides", p.name, v)} />
          <OutlierControl f={f} ctx={ctx} value={outlierOv} onSet={(v) => onSetOverride("outlier_overrides", p.name, v)} />
          <EncodingControl f={f} ctx={ctx} value={encodingOv} imputeOv={imputeOv} onSet={(v) => onSetOverride("encoding_overrides", p.name, v)} />

          <h4 className="col-section-title">Expected in the next run</h4>
          {plan.length > 0 ? (
            <ol className="col-plan">
              {plan.map((s, i) => (
                <li key={i} className={`col-plan-step col-note-${s.tone}`}>
                  <span className="col-plan-name">{s.step}</span>
                  <span>{s.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted col-small">No pipeline step changes this column with the current settings.</p>
          )}
          <p className="faint col-small">
            Estimated from today's profile and settings. The pipeline re-profiles at every step, so exact counts can differ slightly.
          </p>

          <div className="col-ask">
            <Button size="sm" icon="chat" onClick={() => onAskAssistant(question)}>
              Ask assistant about this column
            </Button>
            <span className="faint col-small">
              Sends “{question}” — the assistant is rule-based and answers from this dataset's profile.
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatItem({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="col-stat">
      <dt className="faint">{k}</dt>
      <dd className={mono ? "mono" : undefined}>{v}</dd>
    </div>
  );
}

function ControlNote({ note }: { note: Note }) {
  return <p className={`col-control-note col-note-${note.tone}`}>{note.text}</p>;
}

function NotApplicable({ label, text, stale, onClear }: { label: string; text: string; stale?: string; onClear: () => void }) {
  return (
    <div className="col-control">
      <div className="col-control-label">{label}</div>
      <p className="muted col-small">{text}</p>
      {stale !== undefined && (
        <div className="col-stale">
          <Badge tone="warning">Ignored override: {stale}</Badge>
          <Button size="sm" variant="ghost" icon="x" onClick={onClear}>
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

function ImputeControl({ f, ctx, value, onSet }: { f: ColumnFacts; ctx: PlanCtx; value: string | undefined; onSet: (v: string | null) => void }) {
  const id = useId();
  const constId = useId();
  const { p } = f;
  const options = IMPUTE_OPTIONS[p.kind];
  const missing = missingAtImpute(f, ctx);
  const def = defaultImputeFor(p.kind, ctx);

  if (options.length === 0) {
    return (
      <NotApplicable
        label="Missing values"
        text="Empty columns are never imputed — the backend leaves them as-is and warns."
        stale={value}
        onClear={() => onSet(null)}
      />
    );
  }

  const isConstant = value?.startsWith("constant:") ?? false;
  const constValue = isConstant && value ? value.slice("constant:".length) : "";
  const selectValue = isConstant ? "constant" : value ?? "";
  const known = value === undefined || isConstant || (options as string[]).includes(value);
  const effective = value ?? def;
  const disabled = missing === 0 && value === undefined;
  const commitConstant = (raw: string) => {
    const v = raw.trim();
    // An empty fill isn't meaningful; keep the previous value instead.
    if (v && v !== constValue) onSet(`constant:${v}`);
  };

  return (
    <div className="col-control">
      <label className="col-control-label" htmlFor={id}>
        Missing values
        <span className="faint"> · {missing > 0 ? `${plural(missing, "value")} to fill` : "none to fill"}</span>
      </label>
      <select
        id={id}
        className="input input-sm"
        value={selectValue}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onSet(null);
          else if (v === "constant") onSet(`constant:${constValue || "Unknown"}`);
          else onSet(v);
        }}
      >
        <option value="">Inherit default ({imputeStrategyLabel(def)})</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {IMPUTE_LABELS[o]}
          </option>
        ))}
        {!known && value !== undefined && <option value={value}>{value} (not applicable to this kind)</option>}
      </select>
      {isConstant && (
        <div className="col-const">
          <label htmlFor={constId} className="faint col-small">
            Fill text
          </label>
          <input
            key={constValue}
            id={constId}
            className="input input-sm"
            defaultValue={constValue}
            maxLength={100}
            onBlur={(e) => commitConstant(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitConstant(e.currentTarget.value);
            }}
            aria-describedby={`${constId}-hint`}
          />
          <span id={`${constId}-hint`} className="faint col-small">
            Saved on Enter or when you leave the field. Empty text isn't saved.
          </span>
        </div>
      )}
      <ControlNote
        note={disabled ? { text: "No missing values, so an override would have no effect.", tone: "neutral" } : describeImpute(effective, f, ctx)}
      />
    </div>
  );
}

function OutlierControl({
  f,
  ctx,
  value,
  onSet,
}: {
  f: ColumnFacts;
  ctx: PlanCtx;
  value: OutlierStrategy | undefined;
  onSet: (v: string | null) => void;
}) {
  const id = useId();
  const { p } = f;
  if (p.kind !== "numeric") {
    return (
      <NotApplicable
        label="Outliers"
        text="Outlier detection (IQR) only runs on numeric columns."
        stale={value}
        onClear={() => onSet(null)}
      />
    );
  }
  const effective = value ?? ctx.outlierDefault;
  return (
    <div className="col-control">
      <label className="col-control-label" htmlFor={id}>
        Outliers
        <span className="faint"> · {p.outlier_count > 0 ? `${plural(p.outlier_count, "outlier")} detected` : "none detected"}</span>
      </label>
      <select id={id} className={`input input-sm${effective === "remove" ? " col-select-danger" : ""}`} value={value ?? ""} onChange={(e) => onSet(e.target.value || null)}>
        <option value="">Inherit default ({OUTLIER_LABELS[ctx.outlierDefault].toLowerCase()})</option>
        {OUTLIER_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {OUTLIER_LABELS[o]}
          </option>
        ))}
      </select>
      <ControlNote note={describeOutlier(effective, f, ctx)} />
    </div>
  );
}

function EncodingControl({
  f,
  ctx,
  value,
  imputeOv,
  onSet,
}: {
  f: ColumnFacts;
  ctx: PlanCtx;
  value: EncodingStrategy | undefined;
  imputeOv: string | undefined;
  onSet: (v: string | null) => void;
}) {
  const id = useId();
  const { p } = f;
  if (p.kind !== "categorical") {
    return <NotApplicable label="Encoding" text={encodingNotApplicable(p.kind)} stale={value} onClear={() => onSet(null)} />;
  }
  const card = encodeCardinality(f, ctx, imputeOv);
  const def = defaultEncodingFor(card, ctx);
  const effective = value ?? def;
  return (
    <div className="col-control">
      <label className="col-control-label" htmlFor={id}>
        Encoding
        <span className="faint">
          {" "}
          · {plural(card.k, "category", "categories")}
          {card.addedFill !== null ? " incl. fill value" : ""}, one-hot limit {fmtInt(ctx.oneHotMax)}
        </span>
      </label>
      <select id={id} className="input input-sm" value={value ?? ""} disabled={!ctx.encode && value === undefined} onChange={(e) => onSet(e.target.value || null)}>
        <option value="">
          Inherit default ({def === "onehot" ? "one-hot" : "label"} — {fmtInt(card.k)} {card.k <= ctx.oneHotMax ? "≤" : ">"} {fmtInt(ctx.oneHotMax)})
        </option>
        {ENCODING_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {ENCODING_LABELS[o]}
          </option>
        ))}
      </select>
      <ControlNote
        note={
          ctx.encode
            ? describeEncoding(effective, f, card)
            : { text: "Encoding is turned off in the pipeline settings, so this column stays as text.", tone: "neutral" }
        }
      />
    </div>
  );
}

/* ======================================================================
   Loading skeleton
   ====================================================================== */

function ColumnsSkeleton() {
  return (
    <div className="col-view stack" aria-busy="true" aria-label="Loading column profile">
      <div className="col-head">
        <div className="stack col-skel-head">
          <Skeleton width={140} height={22} />
          <Skeleton width={260} height={13} />
        </div>
      </div>
      <div className="col-toolbar">
        <Skeleton width={220} height={30} radius={7} />
        <Skeleton width={320} height={26} radius={999} />
      </div>
      <div className="col-list-wrap">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="col-grid col-skel-row">
            <Skeleton width={12} height={12} />
            <Skeleton width={`${60 + ((i * 13) % 30)}%`} />
            <Skeleton width="80%" height={10} />
            <Skeleton width="50%" />
            <Skeleton width="40%" />
            <Skeleton width="90%" height={8} />
            <Skeleton width="70%" />
          </div>
        ))}
      </div>
    </div>
  );
}
