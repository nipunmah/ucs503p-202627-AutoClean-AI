import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./ModelsView.css";
import type { ModelsViewProps } from "./contracts";
import type { ColumnKind, ColumnProfile, ProblemType, RecommendationResult } from "../types";
import { errorMessage, getRecommendations, isAbortError } from "../api/client";
import { Badge, Button, Callout, Card, EmptyState, KindBadge, Skeleton, SkeletonBlock, Spinner, Stat } from "../components/ui";
import type { Tone } from "../components/ui";
import { Icon } from "../components/icons";
import AlgoCard from "../components/AlgoCard";
import { fmtInt, fmtNum, fmtPct, KIND_LABELS, plural, PROBLEM_TYPE_LABELS } from "../lib/format";

/* =========================================================================
   Rules mirrored from backend/app/core/pipeline/recommender.py. They are
   only used to EXPLAIN what the backend did (which target it picked and why,
   which scoring signals fired); the scores themselves always come from the
   API. Keep these in sync with recommender.py if its thresholds change.
   ========================================================================= */
const TARGET_NAME_HINTS = ["target", "label", "class", "y", "outcome", "result"] as const;
const CATEGORICAL_TARGET_MIN = 2;
const CATEGORICAL_TARGET_MAX = 20;
const HIGH_CARDINALITY_UNIQUE = 15;
const HIGH_DIM_RATIO = 0.5;
const SMALL_ROWS = 200;
const LARGE_ROWS = 20000;
const HIERARCHICAL_MAX_ROWS = 5000;
const IMBALANCE_RATIO = 4;

/** Numeric targets with this few distinct values are probably encoded class labels. */
const ENCODED_LABEL_MAX_DISTINCT = 10;
const ENCODED_LABEL_MAX_VALUE = 20;
const MAX_CLASS_BARS = 12;
const AUTO = "__auto__";

/* ---------------- helpers ---------------- */

/** recommender._detect_target's name rule: exact match or "<anything>_<hint>". */
function matchedNameHint(name: string): string | null {
  const lower = name.toLowerCase();
  for (const hint of TARGET_NAME_HINTS) {
    if (lower === hint || lower.endsWith(`_${hint}`)) return hint;
  }
  return null;
}

interface TargetCandidate {
  name: string;
  kind: ColumnKind | null;
  /** Lower = more likely; null = not a likely target. */
  priority: number | null;
  reason: string | null;
}

function buildCandidates(profile: ColumnProfile[] | null, columnNames: string[]): TargetCandidate[] {
  if (!profile) return columnNames.map((name) => ({ name, kind: null, priority: null, reason: null }));
  return profile.map((p, i) => {
    const hint = matchedNameHint(p.name);
    if (hint) {
      // Backend checks hints in order, then columns in order.
      return { name: p.name, kind: p.kind, priority: TARGET_NAME_HINTS.indexOf(hint as (typeof TARGET_NAME_HINTS)[number]) * 10_000 + i, reason: `name matches “${hint}”` };
    }
    if (p.kind === "boolean") return { name: p.name, kind: p.kind, priority: 100_000 + i, reason: "yes/no column" };
    if (p.kind === "categorical" && p.unique_count >= CATEGORICAL_TARGET_MIN && p.unique_count <= CATEGORICAL_TARGET_MAX) {
      return { name: p.name, kind: p.kind, priority: 200_000 + i, reason: `${p.unique_count} classes` };
    }
    return { name: p.name, kind: p.kind, priority: null, reason: null };
  });
}

/** Plain-English reason the backend's auto-detect would pick `target` (null if our replica disagrees). */
function autoDetectReason(profile: ColumnProfile[] | null, target: string): string | null {
  if (!profile) return null;
  for (const hint of TARGET_NAME_HINTS) {
    const hit = profile.find((p) => p.name.toLowerCase() === hint || p.name.toLowerCase().endsWith(`_${hint}`));
    if (hit) return hit.name === target ? `its name matches the common target name “${hint}”` : null;
  }
  const bool = profile.find((p) => p.kind === "boolean");
  if (bool) return bool.name === target ? "no column has a target-like name, and it is the first yes/no (boolean) column" : null;
  const cat = profile.find(
    (p) => p.kind === "categorical" && p.unique_count >= CATEGORICAL_TARGET_MIN && p.unique_count <= CATEGORICAL_TARGET_MAX
  );
  if (cat) return cat.name === target ? `no column has a target-like name or is boolean, and it is the first categorical column with ${CATEGORICAL_TARGET_MIN}–${CATEGORICAL_TARGET_MAX} distinct values (${cat.unique_count})` : null;
  return null;
}

interface ClassBalance {
  counts: [string, number][];
  total: number;
  ratio: number | null;
  imbalanced: boolean;
}

interface Characteristics {
  nRows: number;
  nFeatures: number;
  ratio: number;
  hasCategorical: boolean;
  hasHighCardinality: boolean;
  hasOutliers: boolean;
  avgMissing: number;
  balance: ClassBalance | null;
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** dataset_characteristics is untyped JSON; read it defensively. */
function readCharacteristics(raw: Record<string, unknown>): Characteristics {
  let balance: ClassBalance | null = null;
  const cb = raw.class_balance;
  if (isRecord(cb) && isRecord(cb.class_counts)) {
    const counts = Object.entries(cb.class_counts)
      .map(([k, v]) => [k, num(v)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
    if (counts.length > 0) {
      balance = {
        counts,
        total: counts.reduce((s, [, c]) => s + c, 0),
        ratio: typeof cb.majority_minority_ratio === "number" ? cb.majority_minority_ratio : null,
        imbalanced: bool(cb.is_imbalanced),
      };
    }
  }
  return {
    nRows: num(raw.n_rows),
    nFeatures: num(raw.n_features),
    ratio: num(raw.feature_to_row_ratio),
    hasCategorical: bool(raw.has_categorical),
    hasHighCardinality: bool(raw.has_high_cardinality),
    hasOutliers: bool(raw.has_outliers),
    avgMissing: num(raw.avg_missing_ratio),
    balance,
  };
}

const isClassification = (t: ProblemType) => t === "binary_classification" || t === "multiclass_classification";

const Col = ({ children }: { children: ReactNode }) => <span className="md-col">{children}</span>;

/** One-sentence explanation of why the problem type is what it is. */
function problemReason(result: RecommendationResult, targetProfile: ColumnProfile | null, chars: Characteristics): ReactNode {
  const t = result.target_column;
  if (!t) {
    return (
      <>
        No column has a target-like name ({TARGET_NAME_HINTS.join(", ")}), and there is no yes/no column or categorical column with{" "}
        {CATEGORICAL_TARGET_MIN}–{CATEGORICAL_TARGET_MAX} distinct values — so there is nothing obvious to predict, and the recommender
        looks for natural groupings of rows instead. Pick a target above if you have one.
      </>
    );
  }
  const distinct = chars.balance?.counts.length ?? targetProfile?.unique_count;
  switch (result.problem_type) {
    case "binary_classification":
      return targetProfile?.kind === "boolean" ? (
        <>
          <Col>{t}</Col> is a yes/no column, so the model predicts one of two classes.
        </>
      ) : (
        <>
          <Col>{t}</Col> is categorical with exactly 2 distinct values, so the model predicts one of two classes.
        </>
      );
    case "multiclass_classification":
      return (
        <>
          <Col>{t}</Col> is categorical with {distinct !== undefined ? plural(distinct, "distinct value") : "more than 2 distinct values"}{" "}
          (not exactly 2), so the recommender treats it as multiclass: the model predicts one of several classes.
        </>
      );
    case "regression":
      return targetProfile && targetProfile.kind !== "numeric" ? (
        <>
          <Col>{t}</Col> is a {KIND_LABELS[targetProfile.kind].toLowerCase()} column; the recommender treats any target that isn't boolean or
          categorical as regression (predicting a continuous number).
        </>
      ) : (
        <>
          <Col>{t}</Col> is numeric, so the model predicts a continuous value.
        </>
      );
    case "clustering":
      return null;
  }
}

interface Signal {
  id: string;
  label: string;
  rule: string;
  measured: string;
  active: boolean;
  effect: string;
}

/** Which recommender.py scoring rules fired for these characteristics. */
function scoringSignals(problemType: ProblemType, c: Characteristics): Signal[] {
  const highDim = c.ratio > HIGH_DIM_RATIO;
  const mixedParts = [c.hasCategorical && "categorical", c.hasHighCardinality && "high-cardinality", c.hasOutliers && "outliers"].filter(
    Boolean
  ) as string[];
  const mixed = mixedParts.length > 0;
  const small = c.nRows < SMALL_ROWS;
  const large = c.nRows > LARGE_ROWS;
  const rows = `${fmtInt(c.nRows)} rows`;
  const none = "No adjustment";
  // recommender.py applies K-Nearest Neighbors' −0.20 once for `large or high_dim`, not once per rule.
  const knnOnce = problemType !== "regression" && highDim && large ? " (KNN's −0.20 is applied once, not per rule)" : "";

  if (problemType === "clustering") {
    return [
      {
        id: "outliers",
        label: "Outliers in features",
        rule: "any feature has IQR outliers",
        measured: c.hasOutliers ? "yes" : "no",
        active: c.hasOutliers,
        effect: c.hasOutliers ? "DBSCAN +0.15; caveat on K-Means" : none,
      },
      {
        id: "large",
        label: "Many rows",
        rule: `more than ${fmtInt(HIERARCHICAL_MAX_ROWS)} rows`,
        measured: rows,
        active: c.nRows > HIERARCHICAL_MAX_ROWS,
        effect: c.nRows > HIERARCHICAL_MAX_ROWS ? "Hierarchical clustering −0.20" : none,
      },
    ];
  }

  const highDimSignal: Signal = {
    id: "highdim",
    label: "High-dimensional",
    rule: `features ÷ rows above ${HIGH_DIM_RATIO}`,
    measured: fmtNum(c.ratio, 3),
    active: highDim,
    effect: highDim
      ? problemType === "regression"
        ? "Ridge / Lasso +0.20; Random Forest Regressor −0.15"
        : `Logistic Regression +0.10; Random Forest −0.15; K-Nearest Neighbors −0.20${knnOnce}`
      : none,
  };
  const mixedSignal: Signal = {
    id: "mixed",
    label: "Mixed / nonlinear features",
    rule: `categorical, high-cardinality (>${HIGH_CARDINALITY_UNIQUE} values) or outlier features`,
    measured: mixed ? mixedParts.join(", ") : "none",
    active: mixed,
    effect: mixed ? (problemType === "regression" ? "Random Forest Regressor +0.10" : "Random Forest +0.10") : none,
  };
  const smallSignal: Signal = {
    id: "small",
    label: "Small dataset",
    rule: `fewer than ${SMALL_ROWS} rows`,
    measured: rows,
    active: small,
    // recommender.py's boosting rule is an if/else: −0.30 when small, otherwise a +0.10 bonus.
    effect: `${small ? "" : "Not small, so "}${problemType === "regression" ? "Gradient Boosting Regressor" : "Gradient Boosting"} ${small ? "−0.30" : "+0.10"}`,
  };
  const largeSignal: Signal = {
    id: "large",
    label: "Large dataset",
    rule: `more than ${fmtInt(LARGE_ROWS)} rows`,
    measured: rows,
    active: large,
    effect: large
      ? problemType === "regression"
        ? "Support Vector Regression −0.30"
        : `Support Vector Machine −0.30; K-Nearest Neighbors −0.20${knnOnce}`
      : none,
  };

  if (problemType === "regression") {
    return [
      highDimSignal,
      mixedSignal,
      smallSignal,
      largeSignal,
      {
        id: "outliers",
        label: "Outliers in features",
        rule: "any feature has IQR outliers",
        measured: c.hasOutliers ? "yes" : "no",
        active: c.hasOutliers,
        effect: c.hasOutliers ? "Caveat on Linear Regression (no score change)" : none,
      },
    ];
  }
  const imbalanced = c.balance?.imbalanced ?? false;
  return [
    highDimSignal,
    mixedSignal,
    smallSignal,
    largeSignal,
    {
      id: "imbalanced",
      label: "Imbalanced classes",
      rule: `majority ÷ minority class at least ${IMBALANCE_RATIO}:1`,
      measured: c.balance?.ratio != null ? `${fmtNum(c.balance.ratio, 2)}:1` : "–",
      active: imbalanced,
      effect: imbalanced ? "class_weight caveat on Logistic Regression and Random Forest" : none,
    },
    {
      id: "categorical",
      label: "Categorical features",
      rule: "at least one categorical feature",
      measured: c.hasCategorical ? "yes" : "no",
      active: c.hasCategorical,
      effect: c.hasCategorical ? "Naive Bayes +0.10" : none,
    },
  ];
}

interface ChecklistItem {
  id: string;
  text: ReactNode;
  source: "recommender" | "profile";
}

const list = (names: string[]) =>
  names.map((n, i) => (
    <span key={n}>
      {i > 0 && ", "}
      <Col>{n}</Col>
    </span>
  ));

/** Extra checks computed in the browser from the column profile (each states its evidence). */
function profileChecks(profile: ColumnProfile[], target: string | null): ChecklistItem[] {
  const features = profile.filter((p) => p.name !== target);
  const names = new Set(profile.map((p) => p.name));
  const items: ChecklistItem[] = [];
  const ids = features.filter((p) => p.kind === "identifier").map((p) => p.name);
  if (ids.length) {
    items.push({
      id: "identifiers",
      source: "profile",
      text: (
        <>
          Exclude identifier column{ids.length > 1 ? "s" : ""} {list(ids)} from the features — every value is unique, so {ids.length > 1 ? "they carry" : "it carries"} no
          pattern a model can generalise from.
        </>
      ),
    });
  }
  const empty = features.filter((p) => p.kind === "empty").map((p) => p.name);
  if (empty.length) {
    items.push({
      id: "empty",
      source: "profile",
      text: (
        <>
          Drop empty column{empty.length > 1 ? "s" : ""} {list(empty)} — no non-missing values at all.
        </>
      ),
    });
  }
  const text = features.filter((p) => p.kind === "text").map((p) => p.name);
  if (text.length) {
    items.push({
      id: "text",
      source: "profile",
      text: (
        <>
          Free-text column{text.length > 1 ? "s" : ""} {list(text)} {text.length > 1 ? "are" : "is"} left unencoded by the pipeline (it only adds length / word-count
          features) — vectorise or drop {text.length > 1 ? "them" : "it"} before training.
        </>
      ),
    });
  }
  const dates = features.filter((p) => p.kind === "datetime").map((p) => p.name);
  const expanded = dates.filter((d) => names.has(`${d}__year`));
  const raw = dates.filter((d) => !names.has(`${d}__year`));
  if (expanded.length) {
    items.push({
      id: "dates-expanded",
      source: "profile",
      text: (
        <>
          Date column{expanded.length > 1 ? "s" : ""} {list(expanded)} {expanded.length > 1 ? "were" : "was"} already expanded into year / month / day / weekday features — drop
          the original before training, most models can't use raw timestamps.
        </>
      ),
    });
  }
  if (raw.length) {
    items.push({
      id: "dates-raw",
      source: "profile",
      text: (
        <>
          Date column{raw.length > 1 ? "s" : ""} {list(raw)} can't be fed to most models directly — run the pipeline with feature engineering on to
          extract year / month / day / weekday.
        </>
      ),
    });
  }
  return items;
}

interface EncodedAwayTarget {
  name: string;
  indicators: string[];
}

/**
 * Target-like columns of the parent that the cleaning pipeline one-hot encoded away:
 * encoding.py replaces a low-cardinality categorical `col` with `col_<value>` indicator
 * columns and drops the original, so the target can't be picked here any more.
 */
function encodedAwayTargets(columns: string[], parentColumns: string[] | null): EncodedAwayTarget[] {
  if (!parentColumns) return [];
  const own = new Set(columns);
  const inParent = new Set(parentColumns);
  const out: EncodedAwayTarget[] = [];
  for (const col of parentColumns) {
    if (own.has(col) || !matchedNameHint(col)) continue;
    const indicators = columns.filter((c) => c.startsWith(`${col}_`) && !inParent.has(c));
    if (indicators.length > 0) out.push({ name: col, indicators });
  }
  return out;
}

/* ---------------- data fetching ---------------- */

type FetchState =
  | { status: "loading"; data: RecommendationResult | null; error: null }
  | { status: "ready"; data: RecommendationResult; error: null }
  | { status: "error"; data: null; error: string };

/* ---------------- view ---------------- */

export default function ModelsView({ dataset, datasets, profile, loading, onNavigate, onSelectDataset, onAskAssistant }: ModelsViewProps) {
  const selectId = useId();
  const [target, setTarget] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [state, setState] = useState<FetchState>({ status: "loading", data: null, error: null });
  const [autoTarget, setAutoTarget] = useState<string | null | undefined>(undefined);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const cache = useRef(new Map<string, RecommendationResult>());

  const datasetId = dataset.dataset_id;
  // While the workspace is still loading, `profile` may belong to the previously selected dataset.
  const prof = loading ? null : profile;

  useEffect(() => {
    const key = target ?? AUTO;
    const hit = cache.current.get(key);
    if (hit) {
      setState({ status: "ready", data: hit, error: null });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ status: "loading", data: s.data, error: null }));
    getRecommendations(datasetId, target, ctrl.signal)
      .then((res) => {
        cache.current.set(key, res);
        if (ctrl.signal.aborted) return;
        if (target === null) setAutoTarget(res.target_column);
        setState({ status: "ready", data: res, error: null });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || isAbortError(e)) return;
        // Drop the previous result: it was for a different target and would be misleading next to the error.
        setState({ status: "error", data: null, error: errorMessage(e) });
      });
    return () => ctrl.abort();
  }, [datasetId, target, reloadTick]);

  const candidates = useMemo(() => buildCandidates(prof, dataset.column_names), [prof, dataset.column_names]);
  const { likely, others } = useMemo(() => {
    const likelyList = candidates.filter((c) => c.priority !== null).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    return { likely: likelyList, others: candidates.filter((c) => c.priority === null) };
  }, [candidates]);

  const result = state.data;
  // While a new target loads, the previous result stays on screen, dimmed, instead of flashing skeletons.
  const stale = state.status === "loading" && result !== null;

  const chars = useMemo(() => (result ? readCharacteristics(result.dataset_characteristics) : null), [result]);
  const profileByName = useMemo(() => new Map((prof ?? []).map((p) => [p.name, p] as const)), [prof]);
  const targetProfile = result?.target_column ? profileByName.get(result.target_column) ?? null : null;

  const ranked = useMemo(() => {
    if (!result) return [];
    const recs = [...result.recommendations].sort((a, b) => b.score - a.score);
    const counts = new Map<number, number>();
    for (const r of recs) counts.set(r.score, (counts.get(r.score) ?? 0) + 1);
    let rank = 0;
    return recs.map((rec, i) => {
      if (i === 0 || rec.score !== recs[i - 1].score) rank = i + 1;
      return { rec, rank, tiedWith: counts.get(rec.score) ?? 1 };
    });
  }, [result]);

  const signals = useMemo(() => (result && chars ? scoringSignals(result.problem_type, chars) : []), [result, chars]);

  const checklist = useMemo<ChecklistItem[]>(() => {
    if (!result) return [];
    const fromBackend: ChecklistItem[] = result.preprocessing_notes.map((n, i) => ({ id: `note-${i}-${n}`, text: n, source: "recommender" }));
    return [...fromBackend, ...(prof ? profileChecks(prof, result.target_column) : [])];
  }, [result, prof]);

  const parent = useMemo(
    () => (dataset.parent_id ? datasets.find((d) => d.dataset_id === dataset.parent_id) ?? null : null),
    [dataset.parent_id, datasets]
  );
  const encodedAway = useMemo(
    () => encodedAwayTargets(dataset.column_names, parent?.column_names ?? null),
    [dataset.column_names, parent]
  );

  const askWhy = useCallback(
    (algorithm: string) => onAskAssistant(`Why is ${algorithm} recommended for this dataset?`),
    [onAskAssistant]
  );

  const toggleChecked = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onTargetChange = (value: string) => setTarget(value === AUTO ? null : value);
  const retry = () => setReloadTick((t) => t + 1);

  /* ---------------- target picker ---------------- */
  const optionLabel = (c: TargetCandidate) =>
    `${c.name}${c.kind ? ` · ${KIND_LABELS[c.kind]}` : ""}${c.reason ? ` · ${c.reason}` : ""}`;

  const picker = (
    <div className="md-target">
      <label className="field-label" htmlFor={selectId}>
        Target column
      </label>
      <div className="md-target-row">
        <select
          id={selectId}
          className="input md-select"
          value={target ?? AUTO}
          onChange={(e) => onTargetChange(e.target.value)}
          aria-describedby={`${selectId}-hint`}
        >
          <option value={AUTO}>{autoTarget === undefined ? "Auto-detect" : `Auto-detect (${autoTarget ?? "none → clustering"})`}</option>
          {likely.length > 0 && (
            <optgroup label="Likely targets">
              {likely.map((c) => (
                <option key={c.name} value={c.name}>
                  {optionLabel(c)}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label={likely.length > 0 ? "Other columns" : "Columns"}>
              {others.map((c) => (
                <option key={c.name} value={c.name}>
                  {optionLabel(c)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {state.status === "loading" && <Spinner size={16} />}
      </div>
      <p className="md-target-hint faint" id={`${selectId}-hint`}>
        Auto-detect looks for a column named {TARGET_NAME_HINTS.map((h) => `“${h}”`).join(", ")} (or ending in “_label” etc.), then the first
        yes/no column, then the first categorical column with {CATEGORICAL_TARGET_MIN}–{CATEGORICAL_TARGET_MAX} values.
      </p>
    </div>
  );

  /* ---------------- render ---------------- */
  return (
    <div className="md-view stack">
      <header className="md-head">
        <div className="md-head-text">
          <h2 className="md-title">
            <Icon name="brain" size={20} /> Model recommendations
          </h2>
          <p className="md-sub muted">
            A rule-based scorer ranks a fixed list of scikit-learn algorithms using this dataset's column profile. Each card lists the
            recommender's reasons and caveats, and every scoring rule is shown under “How the scores were adjusted”. Nothing is trained here.
          </p>
        </div>
        {picker}
      </header>

      {!dataset.parent_id && (
        <Callout
          tone="info"
          icon="wand"
          title="Not produced by a cleaning run"
          action={
            <Button size="sm" variant="primary" icon="wand" onClick={() => onNavigate("clean")}>
              Clean first
            </Button>
          }
        >
          This dataset has no parent, so it is an upload or a combine result rather than the output of the cleaning pipeline. Models need
          complete, encoded, scaled inputs: these recommendations are a good first look, but run the cleaning pipeline before training. It
          creates a new dataset and leaves this one untouched.
        </Callout>
      )}

      {parent &&
        encodedAway.map((t) => (
          <Callout
            key={t.name}
            tone="warning"
            title={`“${t.name}” was one-hot encoded during cleaning`}
            action={
              <Button size="sm" icon="arrowRight" onClick={() => onSelectDataset(parent.dataset_id)} title={`Open ${parent.name}`}>
                Use original dataset
              </Button>
            }
          >
            Encoding replaced the parent's target-like column with {plural(t.indicators.length, "indicator column")} (
            {list(t.indicators.slice(0, 3))}
            {t.indicators.length > 3 ? ", …" : ""}) and dropped the original, so it can't be the target here, and those indicators would
            leak the answer if used as features. Open the original dataset to get recommendations for it.
          </Callout>
        ))}

      {state.status === "error" && (
        <Callout
          tone="danger"
          title="Couldn't get recommendations"
          action={
            <div className="row">
              {target !== null && (
                <Button size="sm" variant="ghost" onClick={() => setTarget(null)}>
                  Use auto-detect
                </Button>
              )}
              <Button size="sm" icon="refresh" onClick={retry}>
                Retry
              </Button>
            </div>
          }
        >
          {state.error}
        </Callout>
      )}

      {!result || !chars ? (
        state.status === "error" ? null : <LoadingSkeleton />
      ) : (
        <div className={`md-content stack${stale ? " md-stale" : ""}`} aria-busy={stale || undefined}>
          {/* ---------- problem banner ---------- */}
          <ProblemBanner
            result={result}
            chars={chars}
            targetProfile={targetProfile}
            autoReason={result.target_auto_detected && result.target_column ? autoDetectReason(prof, result.target_column) : null}
            parentHasTarget={!!parent && !!result.target_column && parent.column_names.includes(result.target_column)}
            parentName={parent?.name ?? null}
            onOpenParent={parent ? () => onSelectDataset(parent.dataset_id) : null}
            onAsk={() => onAskAssistant("Which algorithm should I train on this data?")}
          />

          {/* ---------- characteristics ---------- */}
          <section aria-labelledby={`${selectId}-chars`} className="md-section">
            <h3 className="md-section-title" id={`${selectId}-chars`}>
              Dataset characteristics
            </h3>
            <div className="grid-stats">
              <Stat label="Rows" value={fmtInt(chars.nRows)} icon="table" hint={chars.nRows < SMALL_ROWS ? `Small (< ${SMALL_ROWS})` : chars.nRows > LARGE_ROWS ? `Large (> ${fmtInt(LARGE_ROWS)})` : `${SMALL_ROWS}–${fmtInt(LARGE_ROWS)} rows`} tone={chars.nRows < SMALL_ROWS ? "warning" : "neutral"} />
              <Stat label="Features" value={fmtInt(chars.nFeatures)} icon="columns" hint={result.target_column ? "All columns except the target" : "All columns (no target)"} />
              <Stat
                label="Features ÷ rows"
                value={fmtNum(chars.ratio, 3)}
                icon="layers"
                tone={chars.ratio > HIGH_DIM_RATIO ? "warning" : "neutral"}
                hint={chars.ratio > HIGH_DIM_RATIO ? `Above ${HIGH_DIM_RATIO}: overfitting risk` : `At or below ${HIGH_DIM_RATIO}: fine`}
              />
              <Stat
                label="Avg. missing"
                value={fmtPct(chars.avgMissing)}
                icon="alert"
                tone={chars.avgMissing > 0 ? "warning" : "success"}
                hint={chars.avgMissing > 0 ? "Impute before training" : "No gaps in features"}
              />
            </div>
            <ul className="md-flags" aria-label="Feature flags">
              <Flag on={chars.hasCategorical} label="Categorical features" detail="text categories need encoding" />
              <Flag on={chars.hasHighCardinality} label="High cardinality" detail={`a categorical/ID column with > ${HIGH_CARDINALITY_UNIQUE} distinct values`} />
              <Flag on={chars.hasOutliers} label="Outliers" detail="IQR rule (1.5 × IQR) on numeric features" />
            </ul>
          </section>

          {/* ---------- ranked algorithms ---------- */}
          <section aria-labelledby={`${selectId}-algos`} className="md-section">
            <div className="md-section-head">
              <h3 className="md-section-title" id={`${selectId}-algos`}>
                Ranked algorithms
              </h3>
              <span className="faint md-section-note">
                {plural(ranked.length, "candidate")} for {PROBLEM_TYPE_LABELS[result.problem_type].toLowerCase()}
                {target !== null && target !== autoTarget && " · “Ask why” answers use the auto-detected target, not the one picked here"}
              </span>
            </div>
            {ranked.length === 0 ? (
              <EmptyState icon="brain" title="No candidates">
                The recommender returned no algorithms for this problem type.
              </EmptyState>
            ) : (
              <ol className="md-cards">
                {ranked.map(({ rec, rank, tiedWith }, i) => (
                  <li key={rec.algorithm} className={rank === 1 ? "md-cards-best" : undefined}>
                    <AlgoCard rec={rec} rank={rank} tiedWith={tiedWith} index={i} onAskWhy={askWhy} />
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* ---------- class balance + checklist ---------- */}
          <div className="grid-2">
            {isClassification(result.problem_type) && (
              <ClassBalanceCard balance={chars.balance} target={result.target_column} />
            )}
            <Card
              title="Before you train"
              subtitle="Tick items off as you handle them"
              icon="checkCircle"
              className="md-checklist-card"
            >
              {checklist.length === 0 ? (
                <Callout tone="success" title="Nothing flagged">
                  No missing values, imbalance, high-cardinality, identifier, free-text or raw date issues were found in the features.
                </Callout>
              ) : (
                <ul className="md-checklist">
                  {checklist.map((item) => {
                    const id = `${selectId}-chk-${item.id}`;
                    const done = checked.has(item.id);
                    return (
                      <li key={item.id} className={`md-check${done ? " md-check-done" : ""}`}>
                        <input id={id} type="checkbox" checked={done} onChange={() => toggleChecked(item.id)} />
                        <label htmlFor={id}>
                          <span className="md-check-text">{item.text}</span>
                          <span className="md-check-source faint">
                            {item.source === "recommender" ? "From the recommender" : "From the column profile"}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          {/* ---------- scoring signals ---------- */}
          {signals.length > 0 && (
            <details className="md-signals card">
              <summary className="md-signals-summary">
                <Icon name="chevronRight" size={16} className="md-signals-chevron" />
                <span className="md-signals-title">How the scores were adjusted</span>
                <span className="faint md-signals-count">
                  {signals.filter((s) => s.active).length} of {signals.length} rules fired
                </span>
              </summary>
              <p className="muted md-signals-intro">
                Each algorithm starts from a fixed base score for {PROBLEM_TYPE_LABELS[result.problem_type].toLowerCase()} and is nudged by these
                rules (from the backend's recommender). Scores are clamped to 0–100%.
              </p>
              <div className="table-wrap">
                <table className="data-table md-signals-table">
                  <thead>
                    <tr>
                      <th scope="col">Rule</th>
                      <th scope="col">Fires when</th>
                      <th scope="col">This dataset</th>
                      <th scope="col">Effect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.map((s) => (
                      <tr key={s.id} className={s.active ? "md-signal-on" : undefined}>
                        <td>
                          <span className="md-signal-label">
                            <Badge tone={s.active ? "accent" : "neutral"}>{s.active ? "fired" : "off"}</Badge>
                            {s.label}
                          </span>
                        </td>
                        <td className="muted">{s.rule}</td>
                        <td className="mono">{s.measured}</td>
                        <td className={s.effect === "No adjustment" ? "faint" : undefined}>{s.effect}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- sub-components ---------------- */

function Flag({ on, label, detail }: { on: boolean; label: string; detail: string }) {
  return (
    <li className={`md-flag${on ? " md-flag-on" : ""}`} title={detail}>
      <Icon name={on ? "check" : "x"} size={13} />
      <span>
        {label}
        <span className="sr-only">: {on ? "yes" : "no"}</span>
      </span>
      <span className="md-flag-detail faint">{detail}</span>
    </li>
  );
}

function ProblemBanner({
  result,
  chars,
  targetProfile,
  autoReason,
  parentHasTarget,
  parentName,
  onOpenParent,
  onAsk,
}: {
  result: RecommendationResult;
  chars: Characteristics;
  targetProfile: ColumnProfile | null;
  autoReason: string | null;
  parentHasTarget: boolean;
  parentName: string | null;
  onOpenParent: (() => void) | null;
  onAsk: () => void;
}) {
  const t = result.target_column;
  const distinct = chars.balance?.counts.length ?? targetProfile?.unique_count ?? null;
  // Encoded labels are small whole numbers (0/1 from boolean_to_int, 0..k-1 from label encoding).
  const classKeys = chars.balance?.counts.map(([k]) => Number(k)) ?? [];
  const looksEncoded =
    result.problem_type === "regression" &&
    t !== null &&
    targetProfile?.kind === "numeric" &&
    distinct !== null &&
    distinct <= ENCODED_LABEL_MAX_DISTINCT &&
    classKeys.length === distinct &&
    classKeys.every((v) => Number.isInteger(v) && v >= 0 && v <= ENCODED_LABEL_MAX_VALUE);
  const oddKind = result.problem_type === "regression" && targetProfile !== null && targetProfile.kind !== "numeric";
  // recommender._classify_problem calls any categorical that isn't 2-valued "multiclass", even a single-valued one.
  const singleClass = isClassification(result.problem_type) && t !== null && distinct !== null && distinct < 2;
  const tone: Tone = result.problem_type === "clustering" ? "info" : "accent";

  return (
    <section className={`md-banner md-banner-${tone}`} aria-label="Problem type">
      <div className="md-banner-icon" aria-hidden="true">
        <Icon name={result.problem_type === "clustering" ? "layers" : "target"} size={22} />
      </div>
      <div className="md-banner-body">
        <div className="md-banner-kicker faint">Problem type</div>
        <h3 className="md-banner-title">{PROBLEM_TYPE_LABELS[result.problem_type]}</h3>
        <div className="md-banner-target">
          {t ? (
            <>
              <span className="muted">Target</span> <Col>{t}</Col>
              {targetProfile && <KindBadge kind={targetProfile.kind} />}
              {result.target_auto_detected ? <Badge tone="info">auto-detected</Badge> : <Badge>chosen by you</Badge>}
            </>
          ) : (
            <span className="muted">No target column</span>
          )}
        </div>
        <p className="md-banner-why">
          {problemReason(result, targetProfile, chars)}
          {autoReason && (
            <>
              {" "}
              It was auto-detected because {autoReason}.
            </>
          )}
        </p>
        {looksEncoded && (
          <Callout
            tone="warning"
            title="This target looks like an encoded class label"
            action={
              onOpenParent && parentHasTarget ? (
                <Button size="sm" icon="arrowRight" onClick={onOpenParent} title={parentName ? `Open ${parentName}` : undefined}>
                  Use original dataset
                </Button>
              ) : undefined
            }
          >
            <Col>{t}</Col> is numeric but holds only {fmtInt(distinct)} small whole-number value{distinct === 1 ? "" : "s"}
            {chars.balance ? ` (${chars.balance.counts.map(([k]) => k).slice(0, 6).join(", ")}${chars.balance.counts.length > 6 ? ", …" : ""})` : ""}. The
            recommender treats every numeric target as regression, so a classifier may suit it better.
            {onOpenParent && parentHasTarget ? " The parent dataset has this column as it was before cleaning — open it to compare." : ""}
          </Callout>
        )}
        {oddKind && !looksEncoded && targetProfile && (
          <Callout tone="warning" title={`A ${KIND_LABELS[targetProfile.kind].toLowerCase()} column is an unusual target`}>
            These scores assume a continuous numeric target. Pick a different column if that isn't what you mean to predict.
          </Callout>
        )}
        {singleClass && (
          <Callout tone="warning" title="Only one class to predict">
            <Col>{t}</Col> has {distinct === 0 ? "no non-missing values" : "a single distinct value"}, so a classifier has nothing to tell
            apart. Pick a different target or check this column for data problems.
          </Callout>
        )}
      </div>
      <div className="md-banner-action">
        <Button size="sm" icon="chat" onClick={onAsk}>
          Ask the assistant
        </Button>
      </div>
    </section>
  );
}

function ClassBalanceCard({ balance, target }: { balance: ClassBalance | null; target: string | null }) {
  const headingId = useId();
  if (!balance) {
    return (
      <Card title="Class balance" icon="target">
        <p className="muted">Not available — the target needs at least two non-missing classes.</p>
      </Card>
    );
  }
  const shown = balance.counts.slice(0, MAX_CLASS_BARS);
  const hidden = balance.counts.slice(MAX_CLASS_BARS);
  const hiddenRows = hidden.reduce((s, [, c]) => s + c, 0);
  const max = shown[0]?.[1] ?? 1;
  const ratioText = balance.ratio != null ? `${fmtNum(balance.ratio, 2)}:1` : null;

  return (
    <Card
      title={<span id={headingId}>Class balance</span>}
      subtitle={target ? `${plural(balance.counts.length, "class", "classes")} in ${target} · ${plural(balance.total, "labelled row")}` : undefined}
      icon="target"
    >
      <ul className="md-bars" aria-labelledby={headingId}>
        {shown.map(([label, count]) => {
          const share = balance.total ? count / balance.total : 0;
          return (
            <li key={label} className="md-bar-row" title={`${label}: ${fmtInt(count)} rows (${fmtPct(share)})`}>
              <span className="md-bar-label mono" title={label}>
                {label}
              </span>
              <span className="md-bar-track" aria-hidden="true">
                <span className="md-bar-fill" style={{ width: `${Math.max(2, (count / max) * 100)}%` }} />
              </span>
              <span className="md-bar-value num">
                {fmtInt(count)} <span className="faint">({fmtPct(share)})</span>
              </span>
            </li>
          );
        })}
      </ul>
      {hidden.length > 0 && (
        <p className="faint md-bars-more">
          + {plural(hidden.length, "smaller class", "smaller classes")} ({plural(hiddenRows, "row")})
        </p>
      )}
      <div className="md-balance-note">
        {balance.imbalanced ? (
          <Callout tone="warning" title={`Imbalanced: ${ratioText ?? "large"} majority to minority`}>
            At {IMBALANCE_RATIO}:1 or more, a model can score well by mostly predicting the majority class. Use class_weight="balanced",
            resampling or SMOTE, and judge with F1 / balanced accuracy rather than plain accuracy.
          </Callout>
        ) : (
          <p className="muted md-balance-ok">
            <Icon name="checkCircle" size={14} /> Balanced enough{ratioText ? ` — largest to smallest class is ${ratioText}` : ""}, below the{" "}
            {IMBALANCE_RATIO}:1 imbalance threshold.
          </p>
        )}
      </div>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading recommendations">
      <div className="md-banner md-banner-skeleton">
        <Skeleton width={44} height={44} radius={12} />
        <div className="md-banner-body">
          <Skeleton width={90} height={11} />
          <Skeleton width="45%" height={22} />
          <Skeleton width="80%" height={13} />
        </div>
      </div>
      <div className="grid-stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat">
            <Skeleton width="50%" height={11} />
            <Skeleton width="40%" height={24} />
          </div>
        ))}
      </div>
      <div className="md-cards md-cards-skeleton">
        {[0, 1, 2].map((i) => (
          <div key={i} className="md-card">
            <SkeletonBlock lines={5} />
          </div>
        ))}
      </div>
    </div>
  );
}
