/**
 * Results tab: the audit trail of a pipeline output, made readable.
 *
 * Everything shown here is read straight from the backend's AuditTrail /
 * StepReport JSON (see backend/app/core/audit.py and core/pipeline/*.py) or
 * computed from it; nothing is inferred by a model. Step `details` are typed
 * as Record<string, unknown>, so every renderer validates shapes with type
 * guards and falls back to a formatted JSON block for anything unexpected.
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ResultsViewProps } from "./contracts";
import type {
  AuditTrail,
  ColumnKind,
  ColumnProfile,
  DatasetSummary,
  PreviewResult,
  StepExplanation,
  StepReport,
} from "../types";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  KindBadge,
  Skeleton,
  SkeletonBlock,
  Stat,
} from "../components/ui";
import type { Tone } from "../components/ui";
import { Icon } from "../components/icons";
import type { IconName } from "../components/icons";
import { cellText, fmtInt, fmtMs, fmtNum, plural, stepLabel } from "../lib/format";
import { downloadUrl, errorMessage, getAuditTrail, isAbortError } from "../api/client";
import "./ResultsView.css";

/* =========================================================================
   Type guards & small helpers
   ========================================================================= */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && !Number.isNaN(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const strArr = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(isStr) ? (v as string[]) : null;
const recArr = (v: unknown): Rec[] | null => (Array.isArray(v) && v.every(isRec) ? (v as Rec[]) : null);
const numArr = (v: unknown): number[] | null => (Array.isArray(v) && v.every(isNum) ? (v as number[]) : null);

const KINDS: ReadonlySet<string> = new Set(["numeric", "boolean", "datetime", "categorical", "text", "identifier", "empty"]);
const isKind = (v: unknown): v is ColumnKind => isStr(v) && KINDS.has(v);

function signed(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "−"}${fmtInt(Math.abs(n))}`;
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** "2023-01-05T00:00:00.000" -> "2023-01-05" (preview JSON is ISO-formatted). */
function displayCell(v: unknown): string | null {
  const t = cellText(v);
  if (t === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z?$/.exec(t);
  return m ? m[1] : t;
}

function safeFileBase(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "dataset";
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const STEP_ICONS: Record<string, IconName> = {
  coerce_types: "sliders",
  impute_missing: "wand",
  handle_duplicates: "copy",
  handle_outliers: "target",
  encode_categoricals: "columns",
  engineer_features: "sparkles",
  scale_features: "gauge",
  combine_datasets: "merge",
  augment_with_synthetic: "flask",
  generate_synthetic: "flask",
};

/** Why a step was allowed to remove rows (mirrors orchestrator._assert_row_invariant). */
const REMOVAL_REASON: Record<string, string> = {
  handle_duplicates: "Duplicate removal (dedupe) was explicitly enabled.",
  handle_outliers: "An outlier strategy of “remove” was explicitly configured.",
};

/* =========================================================================
   Async loading helper (ignores stale results after unmount)
   ========================================================================= */

type Async<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: string };

function useLoaded<T>(id: string | null, load: (id: string) => Promise<T>): [Async<T>, () => void] {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Async<T>>(id ? { status: "loading" } : { status: "idle" });
  useEffect(() => {
    if (!id) return;
    let alive = true;
    load(id).then(
      (data) => {
        if (alive) setState({ status: "ok", data });
      },
      (e: unknown) => {
        if (alive && !isAbortError(e)) setState({ status: "error", error: errorMessage(e) });
      }
    );
    return () => {
      alive = false;
    };
  }, [id, load, nonce]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setNonce((n) => n + 1);
  }, []);
  return [state, retry];
}

/* =========================================================================
   Small local components
   ========================================================================= */

function CopyButton({ text, label = "Copy", size = "sm" }: { text: string | (() => string); label?: string; size?: "sm" | "md" }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(typeof text === "function" ? text() : text);
    setState(ok ? "ok" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2200);
  };
  return (
    <>
      <Button size={size} variant="ghost" icon={state === "ok" ? "check" : "copy"} onClick={onClick}>
        {state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : label}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === "ok" ? "Copied to clipboard" : state === "fail" ? "Clipboard unavailable — select the text and copy it manually." : ""}
      </span>
    </>
  );
}

function JsonBlock({ value, title = "Raw details" }: { value: unknown; title?: string }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? String(value), [value]);
  return (
    <div className="rs-json">
      <div className="rs-json-head">
        <span className="rs-sub-title">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="rs-json-pre mono" tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}

function Chips({ items, tone = "neutral", max = 40, mono = true }: { items: string[]; tone?: "neutral" | "added" | "removed"; max?: number; mono?: boolean }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return <span className="faint">none</span>;
  const shown = all ? items : items.slice(0, max);
  return (
    <span className="rs-chips">
      {shown.map((c, i) => (
        <span key={`${c}-${i}`} className={`rs-chip rs-chip-${tone}${mono ? " mono" : ""}`}>
          {c}
        </span>
      ))}
      {items.length > max && (
        <button type="button" className="rs-chip rs-chip-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `+${fmtInt(items.length - max)} more`}
        </button>
      )}
    </span>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return <div className="rs-sub-title">{children}</div>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="rs-note">{children}</p>;
}

function DetailTable({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="table-wrap rs-dtable">
      <table className="data-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* =========================================================================
   Per-step detail renderers
   Each returns the node + the detail keys it consumed; anything left over is
   shown as raw JSON so nothing the backend reported is ever hidden.
   ========================================================================= */

interface Rendered {
  node: ReactNode;
  used: string[];
}

const IMPUTE_LABELS: Record<string, string> = {
  median: "Median",
  mean: "Mean",
  mode: "Most frequent",
  ffill_bfill: "Forward / backward fill",
};

function renderCoerce(d: Rec): Rendered | null {
  const conv = recArr(d.conversions);
  if (!conv) return null;
  const failedTotal = conv.reduce((n, c) => n + (isNum(c.failed_count) ? c.failed_count : 0), 0);
  return {
    used: ["conversions"],
    node: (
      <>
        {conv.length === 0 ? (
          <Note>No column was inferred as numeric, boolean or date/time, so there was nothing to convert.</Note>
        ) : (
          <DetailTable head={["Column", "Converted to", <span className="num" key="f">Failed values</span>]}>
            {conv.map((c, i) => {
              const failed = isNum(c.failed_count) ? c.failed_count : null;
              return (
                <tr key={i}>
                  <td className="mono">{isStr(c.column) ? c.column : "?"}</td>
                  <td>{isKind(c.to) ? <KindBadge kind={c.to} /> : String(c.to ?? "–")}</td>
                  <td className={`num${failed ? " rs-text-warning" : " faint"}`}>{failed === null ? "–" : fmtInt(failed)}</td>
                </tr>
              );
            })}
          </DetailTable>
        )}
        <Note>
          {failedTotal > 0
            ? `${plural(failedTotal, "value")} could not be converted and became missing (not dropped); the Missing values step fills them unless its strategy for that column is “skip”.`
            : "Columns not listed were categorical, text, identifier or empty and kept their original values."}
        </Note>
      </>
    ),
  };
}

function renderImpute(d: Rec): Rendered | null {
  const imp = recArr(d.imputations);
  if (!imp) return null;
  return {
    used: ["imputations"],
    node: (
      <>
        {imp.length === 0 ? (
          <Note>No column had missing values, so nothing was filled.</Note>
        ) : (
          <DetailTable head={["Column", "Strategy", <span className="num" key="n">Filled</span>, "Fill value"]}>
            {imp.map((c, i) => {
              const strat = isStr(c.strategy) ? c.strategy : "?";
              const label = strat.startsWith("constant:") ? "Constant" : IMPUTE_LABELS[strat] ?? humanize(strat);
              return (
                <tr key={i}>
                  <td className="mono">{isStr(c.column) ? c.column : "?"}</td>
                  <td>{label}</td>
                  <td className="num">{isNum(c.filled_count) ? fmtInt(c.filled_count) : "–"}</td>
                  <td className="mono rs-cell-clip" title={isStr(c.fill_value) ? c.fill_value : undefined}>
                    {isStr(c.fill_value) ? c.fill_value : "–"}
                  </td>
                </tr>
              );
            })}
          </DetailTable>
        )}
        <Note>Only columns whose gaps were filled are listed; a column left as-is (strategy “skip”, or a strategy that doesn’t apply to its kind) is reported as a warning instead. Rows are never dropped for having a gap.</Note>
      </>
    ),
  };
}

function renderDuplicates(d: Rec, step: StepReport): Rendered | null {
  if (!isNum(d.duplicate_count_found)) return null;
  const found = d.duplicate_count_found;
  const removed = isNum(d.rows_removed) ? d.rows_removed : 0;
  const idx = numArr(d.duplicate_indices) ?? [];
  return {
    used: ["duplicate_count_found", "duplicate_indices", "rows_removed"],
    node: (
      <>
        <div className="rs-kv">
          <div>
            <span className="rs-kv-k">Duplicates found</span>
            <span className="rs-kv-v">{fmtInt(found)}</span>
          </div>
          <div>
            <span className="rs-kv-k">Rows removed</span>
            <span className={`rs-kv-v${removed ? " rs-text-warning" : ""}`}>{fmtInt(removed)}</span>
          </div>
          <div>
            <span className="rs-kv-k">Rows</span>
            <span className="rs-kv-v">
              {fmtInt(step.rows_before)} → {fmtInt(step.rows_after)}
            </span>
          </div>
        </div>
        {found === 0 ? (
          <Note>No duplicate rows were found.</Note>
        ) : removed > 0 ? (
          <Note>Removed because duplicate removal was explicitly enabled. The first occurrence of each row was kept, and row positions were renumbered afterwards.</Note>
        ) : (
          <Note>Duplicates were detected but kept, because duplicate removal was not enabled.</Note>
        )}
        {idx.length > 0 && (
          <div className="stack rs-gap-sm">
            <SubTitle>
              Duplicate row positions (0-based, before removal){found > idx.length ? ` — first ${fmtInt(idx.length)} of ${fmtInt(found)}` : ""}
            </SubTitle>
            <Chips items={idx.map(String)} max={30} />
          </div>
        )}
      </>
    ),
  };
}

function renderOutliers(d: Rec): Rendered | null {
  const cols = recArr(d.columns);
  if (!cols) return null;
  const removed = isNum(d.rows_removed) ? d.rows_removed : 0;
  return {
    used: ["columns", "rows_removed"],
    node: (
      <>
        {cols.length === 0 ? (
          <Note>No outliers were found in any numeric column, so nothing was flagged, clipped or removed.</Note>
        ) : (
          <DetailTable
            head={["Column", "Action", <span className="num" key="o">Outliers</span>, <span className="num" key="l">Lower bound</span>, <span className="num" key="u">Upper bound</span>, "Result"]}
          >
            {cols.map((c, i) => {
              const strat = isStr(c.strategy) ? c.strategy : "?";
              let result: ReactNode = <span className="faint">–</span>;
              if (isStr(c.flag_column)) result = <span className="rs-chip rs-chip-added mono">{c.flag_column}</span>;
              else if (isNum(c.clipped_count)) result = `${plural(c.clipped_count, "value")} clipped to bounds`;
              else if (isNum(c.marked_for_removal)) result = <span className="rs-text-warning">{plural(c.marked_for_removal, "row")} marked for removal</span>;
              return (
                <tr key={i}>
                  <td className="mono">{isStr(c.column) ? c.column : "?"}</td>
                  <td>
                    <Badge tone={strat === "remove" ? "warning" : strat === "clip" ? "info" : "neutral"}>{humanize(strat)}</Badge>
                  </td>
                  <td className="num">{isNum(c.outlier_count) ? fmtInt(c.outlier_count) : "–"}</td>
                  <td className="num mono">{isNum(c.lower_bound) ? fmtNum(c.lower_bound) : "–"}</td>
                  <td className="num mono">{isNum(c.upper_bound) ? fmtNum(c.upper_bound) : "–"}</td>
                  <td>{result}</td>
                </tr>
              );
            })}
          </DetailTable>
        )}
        {removed > 0 && (
          <Callout tone="warning" title={`${plural(removed, "row")} removed`}>
            Rows containing an outlier in any column set to “remove” were dropped (a row counts once even if several columns flag it).
          </Callout>
        )}
        <Note>
          Bounds are Q1 − 1.5 × IQR and Q3 + 1.5 × IQR. Numeric columns with no outliers, fewer than 4 values, a zero IQR or
          the “skip” strategy are not listed.
        </Note>
      </>
    ),
  };
}

function renderEncoding(d: Rec): Rendered | null {
  const cols = recArr(d.columns);
  if (!cols) return null;
  return {
    used: ["columns"],
    node: (
      <>
        {cols.length === 0 ? (
          <Note>No boolean or categorical columns needed encoding.</Note>
        ) : (
          <DetailTable head={["Column", "Encoding", <span className="num" key="c">Categories</span>, "Result"]}>
            {cols.map((c, i) => {
              const strat = isStr(c.strategy) ? c.strategy : "?";
              const newCols = strArr(c.new_columns);
              const mapping = isRec(c.mapping_sample) ? Object.entries(c.mapping_sample) : null;
              let label = humanize(strat);
              let result: ReactNode = <span className="faint">–</span>;
              if (strat === "onehot") {
                label = "One-hot";
                result = newCols ? <Chips items={newCols} tone="added" max={12} /> : result;
              } else if (strat === "label") {
                label = "Label (integer codes)";
                result = mapping ? (
                  <span className="stack rs-gap-sm">
                    <Chips items={mapping.map(([k, v]) => `${k} → ${String(v)}`)} max={8} />
                    {isNum(c.cardinality) && c.cardinality > mapping.length && (
                      <span className="faint">
                        Mapping sample: first {fmtInt(mapping.length)} of {fmtInt(c.cardinality)} categories
                      </span>
                    )}
                  </span>
                ) : (
                  result
                );
              } else if (strat === "boolean_to_int") {
                label = "Boolean → 0/1";
                result = <span className="muted">true → 1, false → 0 (in place)</span>;
              }
              return (
                <tr key={i}>
                  <td className="mono">{isStr(c.column) ? c.column : "?"}</td>
                  <td>{label}</td>
                  <td className="num">{isNum(c.cardinality) ? fmtInt(c.cardinality) : <span className="faint">–</span>}</td>
                  <td>{result}</td>
                </tr>
              );
            })}
          </DetailTable>
        )}
        <Note>
          One-hot replaces the original column with one 0/1 column per category; label encoding keeps the column and swaps
          values for sorted integer codes. Identifier and free-text columns are left unencoded (never dropped).
        </Note>
      </>
    ),
  };
}

const PART_LABELS: Record<string, string> = {
  year: "year",
  month: "month",
  day: "day of month",
  weekday: "weekday (0 = Monday)",
  length: "character count",
  word_count: "word count",
};

function renderFeatures(d: Rec): Rendered | null {
  const added = strArr(d.added_columns);
  if (!added) return null;
  const groups = new Map<string, string[]>();
  for (const c of added) {
    const at = c.lastIndexOf("__");
    const src = at > 0 ? c.slice(0, at) : "(other)";
    const list = groups.get(src) ?? [];
    list.push(c);
    groups.set(src, list);
  }
  return {
    used: ["added_columns"],
    node:
      added.length === 0 ? (
        <Note>No datetime or text columns were found, so no features were added.</Note>
      ) : (
        <>
          <DetailTable head={["Source column", "New columns"]}>
            {[...groups].map(([src, list]) => (
              <tr key={src}>
                <td className="mono">{src}</td>
                <td>
                  <Chips items={list} tone="added" max={12} />
                </td>
              </tr>
            ))}
          </DetailTable>
          <Note>
            Features are purely additive — existing columns and rows are untouched. Parts:{" "}
            {[...new Set(added.map((c) => (c.lastIndexOf("__") > 0 ? c.slice(c.lastIndexOf("__") + 2) : c)))]
              .map((p) => PART_LABELS[p] ?? p)
              .join(", ")}
            .
          </Note>
        </>
      ),
  };
}

const PARAM_LABELS: Record<string, string> = {
  mean: "Mean",
  scale: "Scale",
  data_min: "Min",
  data_max: "Max",
  center: "Center (median)",
};

const SCALE_FORMULA: Record<string, string> = {
  standard: "(x − mean) ÷ scale, where scale is the standard deviation",
  minmax: "(x − min) ÷ (max − min), mapping values to 0…1",
  robust: "(x − median) ÷ IQR, which is less sensitive to outliers",
};

function renderScaling(d: Rec): Rendered | null {
  if (!isStr(d.method)) return null;
  const method = d.method;
  if (method === "none") {
    return { used: ["method"], node: <Note>Scaling was turned off (method “none”); numeric values were left as they were.</Note> };
  }
  const cols = recArr(d.columns) ?? [];
  const paramKeys = [...new Set(cols.flatMap((c) => (isRec(c.params) ? Object.keys(c.params) : [])))];
  const scaleLabel = method === "robust" ? "Scale (IQR)" : method === "standard" ? "Scale (std)" : "Scale";
  return {
    used: ["method", "columns"],
    node: (
      <>
        <div className="rs-kv">
          <div>
            <span className="rs-kv-k">Method</span>
            <span className="rs-kv-v">{humanize(method)}</span>
          </div>
          <div>
            <span className="rs-kv-k">Columns scaled</span>
            <span className="rs-kv-v">{fmtInt(cols.length)}</span>
          </div>
        </div>
        {SCALE_FORMULA[method] && <Note>Each value becomes {SCALE_FORMULA[method]}. Parameters are recorded so the transform can be reversed.</Note>}
        {cols.length > 0 && (
          <DetailTable
            head={[
              "Column",
              <span className="num" key="fr">Fit rows</span>,
              ...paramKeys.map((k) => (
                <span className="num" key={k}>
                  {k === "scale" ? scaleLabel : PARAM_LABELS[k] ?? humanize(k)}
                </span>
              )),
            ]}
          >
            {cols.map((c, i) => {
              const params = isRec(c.params) ? c.params : {};
              return (
                <tr key={i}>
                  <td className="mono">{isStr(c.column) ? c.column : "?"}</td>
                  <td className="num">{isNum(c.fit_rows) ? fmtInt(c.fit_rows) : "–"}</td>
                  {paramKeys.map((k) => (
                    <td key={k} className="num mono">
                      {isNum(params[k]) ? fmtNum(params[k] as number, 4) : "–"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </DetailTable>
        )}
        <Note>Binary 0/1 columns (one-hot output, outlier flags, booleans) are excluded from scaling on purpose.</Note>
      </>
    ),
  };
}

function renderCombine(d: Rec): Rendered | null {
  const sources = recArr(d.sources);
  if (!isStr(d.mode) && !sources) return null;
  const union = strArr(d.union_columns);
  const joinOn = strArr(d.join_on);
  return {
    used: ["mode", "sources", "union_columns", "total_rows_expected", "total_rows_produced", "join_on", "how", "note"],
    node: (
      <>
        <div className="rs-kv">
          {isStr(d.mode) && (
            <div>
              <span className="rs-kv-k">Mode</span>
              <span className="rs-kv-v">{d.mode === "concat" ? "Stack rows (concat)" : d.mode === "merge" ? "Join (merge)" : d.mode}</span>
            </div>
          )}
          {isStr(d.how) && (
            <div>
              <span className="rs-kv-k">Join type</span>
              <span className="rs-kv-v">{d.how}</span>
            </div>
          )}
          {isNum(d.total_rows_expected) && (
            <div>
              <span className="rs-kv-k">Rows expected</span>
              <span className="rs-kv-v">{fmtInt(d.total_rows_expected)}</span>
            </div>
          )}
          {isNum(d.total_rows_produced) && (
            <div>
              <span className="rs-kv-k">Rows produced</span>
              <span className="rs-kv-v">{fmtInt(d.total_rows_produced)}</span>
            </div>
          )}
        </div>
        {isStr(d.note) && <Note>{d.note}</Note>}
        {sources && sources.length > 0 && (
          <DetailTable head={["Source", <span className="num" key="r">Rows</span>, <span className="num" key="c">Columns</span>]}>
            {sources.map((s, i) => (
              <tr key={i}>
                <td>{isStr(s.name) ? s.name : `Source ${i + 1}`}</td>
                <td className="num">{isNum(s.rows) ? fmtInt(s.rows) : "–"}</td>
                <td className="num">{strArr(s.columns)?.length ?? "–"}</td>
              </tr>
            ))}
          </DetailTable>
        )}
        {joinOn && (
          <div className="stack rs-gap-sm">
            <SubTitle>Join key(s)</SubTitle>
            <Chips items={joinOn} />
          </div>
        )}
        {union && (
          <div className="stack rs-gap-sm">
            <SubTitle>Combined schema ({fmtInt(union.length)} columns)</SubTitle>
            <Chips items={union} max={24} />
          </div>
        )}
      </>
    ),
  };
}

function renderSynthetic(d: Rec): Rendered | null {
  const cols = recArr(d.columns);
  if (!cols && !isNum(d.n_rows)) return null;
  return {
    used: ["synthetic_rows_added", "n_rows", "columns", "seed"],
    node: (
      <>
        <div className="rs-kv">
          {isNum(d.synthetic_rows_added) && (
            <div>
              <span className="rs-kv-k">Rows added</span>
              <span className="rs-kv-v">{fmtInt(d.synthetic_rows_added)}</span>
            </div>
          )}
          {isNum(d.n_rows) && (
            <div>
              <span className="rs-kv-k">Rows generated</span>
              <span className="rs-kv-v">{fmtInt(d.n_rows)}</span>
            </div>
          )}
          <div>
            <span className="rs-kv-k">Seed</span>
            <span className="rs-kv-v">{d.seed === null || d.seed === undefined ? "random" : String(d.seed)}</span>
          </div>
        </div>
        {cols && cols.length > 0 && (
          <DetailTable head={["Column", "Sampling method"]}>
            {cols.map((c, i) => (
              <tr key={i}>
                <td className="mono">{isStr(c.column) ? c.column : "?"}</td>
                <td>{isStr(c.method) ? humanize(c.method) : "–"}</td>
              </tr>
            ))}
          </DetailTable>
        )}
      </>
    ),
  };
}

function renderDetails(step: StepReport): ReactNode {
  const d: Rec = isRec(step.details) ? step.details : {};
  let rendered: Rendered | null = null;
  try {
    switch (step.step_name) {
      case "coerce_types":
        rendered = renderCoerce(d);
        break;
      case "impute_missing":
        rendered = renderImpute(d);
        break;
      case "handle_duplicates":
        rendered = renderDuplicates(d, step);
        break;
      case "handle_outliers":
        rendered = renderOutliers(d);
        break;
      case "encode_categoricals":
        rendered = renderEncoding(d);
        break;
      case "engineer_features":
        rendered = renderFeatures(d);
        break;
      case "scale_features":
        rendered = renderScaling(d);
        break;
      case "combine_datasets":
        rendered = renderCombine(d);
        break;
      case "augment_with_synthetic":
      case "generate_synthetic":
        rendered = renderSynthetic(d);
        break;
    }
  } catch {
    rendered = null;
  }
  if (!rendered) {
    return Object.keys(d).length === 0 ? <Note>This step reported no extra details.</Note> : <JsonBlock value={d} />;
  }
  const used = new Set(rendered.used);
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !used.has(k)));
  return (
    <>
      {rendered.node}
      {Object.keys(rest).length > 0 && <JsonBlock value={rest} title="Additional details" />}
    </>
  );
}

/* =========================================================================
   Derived summary (memoized once per audit)
   ========================================================================= */

interface Stage {
  label: string;
  rows: number;
  columns: number;
  nulls: number;
}

interface RowEvent {
  step: string;
  delta: number;
}

interface Summary {
  before: { rows: number; columns: number; nulls: number };
  after: { rows: number; columns: number; nulls: number };
  removals: RowEvent[];
  additions: RowEvent[];
  rowsAligned: boolean;
  durationMs: number;
  warningCount: number;
  warningSteps: number;
  stages: Stage[];
}

function summarize(audit: AuditTrail): Summary {
  const steps = audit.steps;
  const last = steps[steps.length - 1];
  const before = { ...audit.original };
  const after = last ? { rows: last.rows_after, columns: last.columns_after, nulls: last.nulls_after } : before;
  const removals: RowEvent[] = [];
  const additions: RowEvent[] = [];
  let durationMs = 0;
  let warningCount = 0;
  let warningSteps = 0;
  const stages: Stage[] = [{ label: "Original", ...before }];
  for (const s of steps) {
    if (s.rows_changed < 0) removals.push({ step: s.step_name, delta: s.rows_changed });
    if (s.rows_changed > 0) additions.push({ step: s.step_name, delta: s.rows_changed });
    durationMs += isNum(s.duration_ms) ? s.duration_ms : 0;
    warningCount += s.warnings.length;
    if (s.warnings.length) warningSteps += 1;
    stages.push({ label: stepLabel(s.step_name), rows: s.rows_after, columns: s.columns_after, nulls: s.nulls_after });
  }
  return {
    before,
    after,
    removals,
    additions,
    rowsAligned: removals.length === 0 && additions.length === 0,
    durationMs,
    warningCount,
    warningSteps,
    stages,
  };
}

/** What the audit says happened to each column, keyed by column name. */
interface Lineage {
  /** column -> how it was created */
  origin: Map<string, string>;
  /** removed column -> why */
  removedBy: Map<string, string>;
  /** column -> list of in-place actions */
  actions: Map<string, string[]>;
}

function buildLineage(audit: AuditTrail): Lineage {
  const origin = new Map<string, string>();
  const removedBy = new Map<string, string>();
  const actions = new Map<string, string[]>();
  const act = (col: unknown, text: string) => {
    if (!isStr(col)) return;
    const list = actions.get(col) ?? [];
    list.push(text);
    actions.set(col, list);
  };
  for (const s of audit.steps) {
    const d: Rec = isRec(s.details) ? s.details : {};
    switch (s.step_name) {
      case "coerce_types":
        for (const c of recArr(d.conversions) ?? []) act(c.column, `converted to ${isStr(c.to) ? c.to : "?"}`);
        break;
      case "impute_missing":
        for (const c of recArr(d.imputations) ?? [])
          if (isNum(c.filled_count) && c.filled_count > 0) act(c.column, `${fmtInt(c.filled_count)} filled`);
        break;
      case "handle_outliers":
        for (const c of recArr(d.columns) ?? []) {
          if (isStr(c.flag_column)) origin.set(c.flag_column, `Outlier flag for ${String(c.column)}`);
          if (isNum(c.clipped_count)) act(c.column, `${fmtInt(c.clipped_count)} clipped`);
          if (isStr(c.flag_column)) act(c.column, `${plural(isNum(c.outlier_count) ? c.outlier_count : 0, "outlier")} flagged`);
          if (isNum(c.marked_for_removal)) act(c.column, `${plural(c.marked_for_removal, "outlier row")} removed`);
        }
        break;
      case "encode_categoricals":
        for (const c of recArr(d.columns) ?? []) {
          const newCols = strArr(c.new_columns);
          if (c.strategy === "onehot" && isStr(c.column)) {
            removedBy.set(c.column, `One-hot encoded into ${plural(newCols?.length ?? 0, "column")}`);
            for (const n of newCols ?? []) origin.set(n, `One-hot of ${c.column}`);
          } else if (c.strategy === "label") act(c.column, "label-encoded");
          else if (c.strategy === "boolean_to_int") act(c.column, "bool → 0/1");
        }
        break;
      case "engineer_features":
        for (const n of strArr(d.added_columns) ?? []) {
          const at = n.lastIndexOf("__");
          origin.set(n, at > 0 ? `Derived from ${n.slice(0, at)}` : "Derived feature");
        }
        break;
      case "scale_features":
        for (const c of recArr(d.columns) ?? []) act(c.column, `scaled (${isStr(d.method) ? d.method : "?"})`);
        break;
    }
  }
  return { origin, removedBy, actions };
}

/* =========================================================================
   Row/column/null flow — three small multiples sharing one x axis
   ========================================================================= */

const FLOW_METRICS: { key: "rows" | "columns" | "nulls"; label: string }[] = [
  { key: "rows", label: "Rows" },
  { key: "columns", label: "Columns" },
  { key: "nulls", label: "Missing values" },
];

const VB_W = 300;
const VB_H = 84;
const PAD_X = 10;
const PAD_T = 14;
const PAD_B = 10;

const FlowChart = memo(function FlowChart({ stages, onPick }: { stages: Stage[]; onPick: (stepIndex: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = stages.length;
  const x = (i: number) => (n <= 1 ? VB_W / 2 : PAD_X + (i * (VB_W - 2 * PAD_X)) / (n - 1));
  const colW = n <= 1 ? VB_W : (VB_W - 2 * PAD_X) / (n - 1);
  const active = hover === null ? null : stages[hover];

  return (
    <div className="rs-flow" onMouseLeave={() => setHover(null)}>
      <div className="rs-flow-grid">
        {FLOW_METRICS.map(({ key, label }) => {
          const vals = stages.map((s) => s[key]);
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          const flat = min === max;
          const y = (v: number) => (flat ? (PAD_T + VB_H - PAD_B) / 2 : PAD_T + ((max - v) / (max - min)) * (VB_H - PAD_T - PAD_B));
          const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          const first = vals[0];
          const last = vals[vals.length - 1];
          return (
            <figure key={key} className="rs-flow-chart">
              <figcaption className="rs-flow-cap">
                <span>{label}</span>
                <span className="rs-flow-cap-val">
                  {fmtInt(first)} <span className="faint">→</span> <strong>{fmtInt(last)}</strong>
                </span>
              </figcaption>
              <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="rs-flow-svg" aria-hidden="true">
                <line x1={PAD_X} x2={VB_W - PAD_X} y1={VB_H - PAD_B + 4} y2={VB_H - PAD_B + 4} className="rs-flow-base" />
                {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={4} y2={VB_H - PAD_B + 4} className="rs-flow-cross" />}
                <path d={path} className="rs-flow-line" />
                {vals.map((v, i) => {
                  const changed = i > 0 && v !== vals[i - 1];
                  return (
                    <circle
                      key={i}
                      cx={x(i)}
                      cy={y(v)}
                      r={hover === i ? 4.5 : changed ? 3.5 : 2.5}
                      className={`rs-flow-dot${changed ? " changed" : ""}`}
                    />
                  );
                })}
                {stages.map((_, i) => (
                  <rect
                    key={i}
                    x={x(i) - colW / 2}
                    y={0}
                    width={colW}
                    height={VB_H}
                    className="rs-flow-hit"
                    onMouseEnter={() => setHover(i)}
                    onClick={() => i > 0 && onPick(i - 1)}
                  />
                ))}
              </svg>
            </figure>
          );
        })}
      </div>
      <div className="rs-flow-tip" aria-hidden="true">
        {active ? (
          <>
            <strong>{active.label}</strong>
            <span>{plural(active.rows, "row")}</span>
            <span>{plural(active.columns, "column")}</span>
            <span>{plural(active.nulls, "missing value")}</span>
            {hover !== null && hover > 0 && <span className="faint">click to open step</span>}
          </>
        ) : (
          <span className="faint">Hover a point to see counts after each step · highlighted points mark a change</span>
        )}
      </div>
      <table className="sr-only">
        <caption>Rows, columns and missing values after each pipeline step</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Rows</th>
            <th scope="col">Columns</th>
            <th scope="col">Missing values</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s, i) => (
            <tr key={i}>
              <th scope="row">{s.label}</th>
              <td>{s.rows}</td>
              <td>{s.columns}</td>
              <td>{s.nulls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/* =========================================================================
   Step timeline
   ========================================================================= */

function DeltaChip({ label, before, after, invert = false }: { label: string; before: number; after: number; invert?: boolean }) {
  const delta = after - before;
  // For rows a decrease is the notable event; for nulls a decrease is good.
  const tone = delta === 0 ? "same" : invert ? (delta < 0 ? "good" : "bad") : delta < 0 ? "bad" : "info";
  return (
    <span className={`rs-delta rs-delta-${tone}`} title={`${label}: ${fmtInt(before)} → ${fmtInt(after)}`}>
      <span className="rs-delta-k">{label}</span>
      {delta === 0 ? (
        <span>{fmtInt(after)}</span>
      ) : (
        <span>
          {fmtInt(before)} → {fmtInt(after)} <span className="rs-delta-d">({signed(delta)})</span>
        </span>
      )}
    </span>
  );
}

/** One-line, count-based summary of what a step did (read from its details). */
interface Headline {
  text: string;
  /** false when the step had nothing to do */
  active: boolean;
}

const h = (text: string, active = true): Headline => ({ text, active });

function stepHeadline(step: StepReport): Headline | null {
  const d: Rec = isRec(step.details) ? step.details : {};
  try {
    switch (step.step_name) {
      case "coerce_types": {
        const c = recArr(d.conversions);
        return c ? (c.length ? h(`${plural(c.length, "column")} converted`) : h("nothing to convert", false)) : null;
      }
      case "impute_missing": {
        const c = recArr(d.imputations);
        if (!c) return null;
        const filled = c.reduce((n, x) => n + (isNum(x.filled_count) ? x.filled_count : 0), 0);
        return c.length ? h(`${plural(filled, "value")} filled in ${plural(c.length, "column")}`) : h("nothing missing", false);
      }
      case "handle_duplicates": {
        if (!isNum(d.duplicate_count_found)) return null;
        const found = d.duplicate_count_found;
        if (found === 0) return h("no duplicates", false);
        return h(`${plural(found, "duplicate")} found · ${isNum(d.rows_removed) && d.rows_removed > 0 ? "removed" : "kept"}`);
      }
      case "handle_outliers": {
        const c = recArr(d.columns);
        if (!c) return null;
        if (c.length === 0) return h("no outliers", false);
        const total = c.reduce((n, x) => n + (isNum(x.outlier_count) ? x.outlier_count : 0), 0);
        return h(`${plural(total, "outlier")} in ${plural(c.length, "column")}`);
      }
      case "encode_categoricals": {
        const c = recArr(d.columns);
        return c ? (c.length ? h(`${plural(c.length, "column")} encoded`) : h("nothing to encode", false)) : null;
      }
      case "engineer_features": {
        const a = strArr(d.added_columns);
        return a ? (a.length ? h(`${plural(a.length, "feature")} added`) : h("no features added", false)) : null;
      }
      case "scale_features": {
        if (d.method === "none") return h("skipped", false);
        const c = recArr(d.columns);
        return c && isStr(d.method) ? h(`${plural(c.length, "column")} scaled (${d.method})`, c.length > 0) : null;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}


function explanationExtra(step: StepReport, explanation: string | undefined): string | null {
  if (!explanation) return null;
  const e = explanation.trim();
  const desc = step.description.trim();
  if (e === desc) return null;
  // The rule-based advisor prefixes the description; show only what it adds.
  const extra = (e.startsWith(desc) ? e.slice(desc.length) : e)
    .replace(/(Rows|Columns) changed by [+-]?\d+\.?/g, "")
    .replace(/\d+ warning\(s\) raised\.?/g, "")
    .trim();
  return extra.length > 0 ? extra : null;
}

const WARN_PREVIEW = 3;

/** Warnings are always visible, but a long list (e.g. one per text column) is capped until expanded. */
function StepWarnings({ warnings }: { warnings: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? warnings : warnings.slice(0, WARN_PREVIEW);
  return (
    <div className="rs-step-warnings">
      {shown.map((w, i) => (
        <Callout key={i} tone="warning">
          {w}
        </Callout>
      ))}
      {warnings.length > WARN_PREVIEW && (
        <div>
          <Button size="sm" variant="ghost" icon={all ? "chevronRight" : "chevronDown"} onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer warnings" : `Show ${plural(warnings.length - WARN_PREVIEW, "more warning")}`}
          </Button>
        </div>
      )}
    </div>
  );
}

const StepItem = memo(function StepItem({
  step,
  index,
  open,
  onToggle,
  explanation,
}: {
  step: StepReport;
  index: number;
  open: boolean;
  onToggle: (index: number) => void;
  explanation: string | null;
}) {
  const bodyId = useId();
  const changedRows = step.rows_changed !== 0;
  const headline = useMemo(() => stepHeadline(step), [step]);
  const changedSomething =
    changedRows || step.columns_changed !== 0 || step.nulls_after !== step.nulls_before || headline?.active === true;
  const tone = step.rows_changed < 0 ? "warning" : step.warnings.length > 0 ? "warning-soft" : changedSomething ? "accent" : "idle";
  return (
    <li className={`rs-step rs-step-${tone}${open ? " open" : ""}`} id={`rs-step-${index}`}>
      <span className="rs-step-marker" aria-hidden="true">
        <Icon name={STEP_ICONS[step.step_name] ?? "layers"} size={15} />
      </span>
      <div className="rs-step-card">
        <h4 className="rs-step-h">
          <button
            type="button"
            className="rs-step-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => onToggle(index)}
            data-step-toggle={index}
          >
            <span className="rs-step-titles">
              <span className="rs-step-title">
                <span className="rs-step-num">{index + 1}</span>
                {stepLabel(step.step_name)}
                {step.rows_changed < 0 && <Badge tone="warning">{plural(-step.rows_changed, "row")} removed</Badge>}
                {step.rows_changed > 0 && <Badge tone="info">{plural(step.rows_changed, "row")} added</Badge>}
                {headline ? (
                  <span className="rs-step-noop">{headline.text}</span>
                ) : (
                  !changedSomething && step.warnings.length === 0 && <span className="rs-step-noop">no count changes</span>
                )}
              </span>
              <span className="rs-step-desc">{step.description}</span>
            </span>
            <span className="rs-step-side">
              <span className="rs-step-ms">{fmtMs(step.duration_ms)}</span>
              <Icon name="chevronDown" size={16} className="rs-step-chev" />
            </span>
          </button>
        </h4>
        <div className="rs-step-deltas">
          <DeltaChip label="Rows" before={step.rows_before} after={step.rows_after} />
          <DeltaChip label="Cols" before={step.columns_before} after={step.columns_after} />
          <DeltaChip label="Missing" before={step.nulls_before} after={step.nulls_after} invert />
          {step.warnings.length > 0 && (
            <span className="rs-delta rs-delta-bad">
              <Icon name="alert" size={12} /> {plural(step.warnings.length, "warning")}
            </span>
          )}
        </div>
        {explanation && <p className="rs-step-expl">{explanation}</p>}
        {step.warnings.length > 0 && <StepWarnings warnings={step.warnings} />}
        <div id={bodyId} className="rs-step-body" hidden={!open}>
          {open && renderDetails(step)}
        </div>
      </div>
    </li>
  );
});

/* =========================================================================
   Column changes + before/after inspector
   ========================================================================= */

type ColFilter = "changed" | "all" | "added" | "removed";

interface ColRow {
  name: string;
  status: "added" | "removed" | "kept";
  before: ColumnKind | null;
  after: ColumnKind | null;
  note: string[];
}

function ColumnChanges({
  parentCols,
  currentCols,
  parentProfile,
  currentProfile,
  lineage,
  profilesLoading,
  profileError,
  onRetry,
}: {
  parentCols: string[];
  currentCols: string[];
  parentProfile: ColumnProfile[] | null;
  currentProfile: ColumnProfile[] | null;
  lineage: Lineage;
  profilesLoading: boolean;
  profileError: string | null;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState<ColFilter>("changed");

  const rows = useMemo<ColRow[]>(() => {
    const pk = new Map(parentProfile?.map((p) => [p.name, p.kind]) ?? []);
    const ck = new Map(currentProfile?.map((p) => [p.name, p.kind]) ?? []);
    const parentSet = new Set(parentCols);
    const currentSet = new Set(currentCols);
    const out: ColRow[] = [];
    for (const c of currentCols) {
      const kept = parentSet.has(c);
      out.push({
        name: c,
        status: kept ? "kept" : "added",
        before: kept ? pk.get(c) ?? null : null,
        after: ck.get(c) ?? null,
        note: kept ? lineage.actions.get(c) ?? [] : [lineage.origin.get(c) ?? "Added by the pipeline"],
      });
    }
    for (const c of parentCols) {
      if (currentSet.has(c)) continue;
      out.push({ name: c, status: "removed", before: pk.get(c) ?? null, after: null, note: [lineage.removedBy.get(c) ?? "Not present in the output"] });
    }
    return out;
  }, [parentCols, currentCols, parentProfile, currentProfile, lineage]);

  const counts = useMemo(() => {
    let added = 0;
    let removed = 0;
    let kindChanged = 0;
    let touched = 0;
    let changed = 0;
    for (const r of rows) {
      if (r.status === "added") added++;
      else if (r.status === "removed") removed++;
      else {
        const kind = !!r.before && !!r.after && r.before !== r.after;
        if (kind) kindChanged++;
        if (r.note.length > 0) touched++;
        if (kind || r.note.length > 0) changed++;
      }
    }
    return { added, removed, kindChanged, touched, changed: changed + added + removed, kept: rows.length - added - removed };
  }, [rows]);

  const visible = useMemo(() => {
    switch (filter) {
      case "added":
        return rows.filter((r) => r.status === "added");
      case "removed":
        return rows.filter((r) => r.status === "removed");
      case "changed":
        return rows.filter((r) => r.status !== "kept" || r.note.length > 0 || (r.before && r.after && r.before !== r.after));
      default:
        return rows;
    }
  }, [rows, filter]);

  const filters: { value: ColFilter; label: string }[] = [
    { value: "changed", label: `Changed (${counts.changed})` },
    { value: "added", label: `Added (${counts.added})` },
    { value: "removed", label: `Removed (${counts.removed})` },
    { value: "all", label: `All (${rows.length})` },
  ];

  return (
    <Card
      title="Column changes"
      subtitle={`${plural(parentCols.length, "column")} in the source → ${plural(currentCols.length, "column")} now`}
      icon="columns"
    >
      <div className="rs-colsum">
        <span className="rs-chip rs-chip-added">+{fmtInt(counts.added)} added</span>
        <span className="rs-chip rs-chip-removed">−{fmtInt(counts.removed)} removed</span>
        <span className="rs-chip">{fmtInt(counts.kept)} kept</span>
        <span className="rs-chip">{fmtInt(counts.touched)} kept &amp; transformed</span>
        {counts.kindChanged > 0 && <span className="rs-chip rs-chip-info">{fmtInt(counts.kindChanged)} kind changes</span>}
      </div>
      <div className="rs-colfilter" role="radiogroup" aria-label="Filter columns">
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={filter === f.value}
            className={`rs-filter-btn${filter === f.value ? " active" : ""}`}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {profileError && (
        <Callout tone="warning" title="Column kinds unavailable" action={<Button size="sm" onClick={onRetry}>Retry</Button>}>
          {profileError} Column names below come from the dataset list.
        </Callout>
      )}
      {visible.length === 0 ? (
        <p className="rs-note">No columns match this filter.</p>
      ) : (
        <div className="table-wrap rs-coltable">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">Status</th>
                <th scope="col">Kind (before → after)</th>
                <th scope="col">What happened</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={`${r.status}-${r.name}`}>
                  <td className="mono rs-cell-clip" title={r.name}>
                    {r.name}
                  </td>
                  <td>
                    <span className={`rs-chip rs-chip-${r.status === "kept" ? "neutral" : r.status}`}>{r.status}</span>
                  </td>
                  <td>
                    {profilesLoading ? (
                      <Skeleton width={120} height={16} />
                    ) : (
                      <span className="rs-kinds">
                        {r.before ? <KindBadge kind={r.before} /> : <span className="faint">—</span>}
                        <span className="faint" aria-label="becomes">→</span>
                        {r.after ? <KindBadge kind={r.after} /> : <span className="faint">—</span>}
                      </span>
                    )}
                  </td>
                  <td className="muted">{r.note.length ? r.note.join(" · ") : <span className="faint">unchanged</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const STAT_KEYS = ["min", "max", "mean", "median", "std"] as const;

/** Floating-point noise like -4.4e-16 (the mean after standard scaling) reads as 0. */
const fmtStat = (n: number) => fmtNum(Math.abs(n) < 1e-9 ? 0 : n, 4);

function Inspector({
  columns,
  defaultColumn,
  parentProfile,
  currentProfile,
  parentPreview,
  currentPreview,
  aligned,
  rowNote,
  lineage,
  statsLoading,
}: {
  statsLoading: boolean;
  columns: string[];
  defaultColumn: string;
  parentProfile: ColumnProfile[] | null;
  currentProfile: ColumnProfile[] | null;
  parentPreview: Async<PreviewResult>;
  currentPreview: Async<PreviewResult>;
  aligned: boolean;
  rowNote: string;
  lineage: Lineage;
}) {
  const selectId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const col = picked !== null && columns.includes(picked) ? picked : defaultColumn;
  const before = useMemo(() => parentProfile?.find((p) => p.name === col) ?? null, [parentProfile, col]);
  const after = useMemo(() => currentProfile?.find((p) => p.name === col) ?? null, [currentProfile, col]);
  const LIMIT = 10;
  const values = (pv: Async<PreviewResult>) =>
    pv.status === "ok" ? pv.data.rows.slice(0, LIMIT).map((r) => displayCell(r[col])) : null;
  const bVals = values(parentPreview);
  const aVals = values(currentPreview);
  const actions = lineage.actions.get(col) ?? [];

  const statRow = (label: string, b: ReactNode, a: ReactNode, changed: boolean) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td className="num mono">{b}</td>
      <td className={`num mono${changed ? " rs-changed" : ""}`}>{a}</td>
    </tr>
  );

  return (
    <Card title="Before / after inspector" subtitle="Compare one column in the source dataset and in this output" icon="search">
      <div className="rs-insp-bar">
        <label htmlFor={selectId} className="rs-sub-title">
          Column
        </label>
        <select id={selectId} className="input input-sm rs-insp-select" value={col} onChange={(e) => setPicked(e.target.value)}>
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {actions.length > 0 ? <Chips items={actions} mono={false} /> : <span className="faint">not transformed by any step</span>}
      </div>

      <div className="table-wrap">
        <table className="data-table rs-insp-stats">
          <thead>
            <tr>
              <th scope="col">Statistic</th>
              <th scope="col" className="num">Before</th>
              <th scope="col" className="num">After</th>
            </tr>
          </thead>
          <tbody>
            {!before && !after ? (
              <tr>
                <td colSpan={3}>
                  {statsLoading ? (
                    <Skeleton width="60%" />
                  ) : (
                    <span className="faint">Column statistics are unavailable (the profiles couldn’t be loaded).</span>
                  )}
                </td>
              </tr>
            ) : (
              <>
                {statRow(
                  "Kind",
                  before ? <KindBadge kind={before.kind} /> : "–",
                  after ? <KindBadge kind={after.kind} /> : "–",
                  !!before && !!after && before.kind !== after.kind
                )}
                {statRow("Missing", fmtInt(before?.null_count), fmtInt(after?.null_count), before?.null_count !== after?.null_count)}
                {statRow("Unique", fmtInt(before?.unique_count), fmtInt(after?.unique_count), before?.unique_count !== after?.unique_count)}
                {STAT_KEYS.filter((k) => isNum(before?.stats[k]) || isNum(after?.stats[k])).map((k) => {
                  const b = before?.stats[k];
                  const a = after?.stats[k];
                  return statRow(
                    humanize(k === "std" ? "std dev" : k),
                    isNum(b) ? fmtStat(b) : "–",
                    isNum(a) ? fmtStat(a) : "–",
                    isNum(a) && isNum(b) ? Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b)) : a !== b
                  );
                })}
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="rs-insp-vals-head">
        <SubTitle>First {LIMIT} values</SubTitle>
        {aligned ? (
          <Badge tone="success">Row-aligned</Badge>
        ) : (
          <Badge tone="warning" title={rowNote}>
            Not row-aligned
          </Badge>
        )}
      </div>
      {!aligned && <Note>{rowNote} Values in the same position may belong to different records.</Note>}
      {parentPreview.status === "error" || currentPreview.status === "error" ? (
        <Callout tone="warning">
          Couldn’t load preview rows: {parentPreview.status === "error" ? parentPreview.error : currentPreview.status === "error" ? currentPreview.error : ""}
        </Callout>
      ) : !bVals || !aVals ? (
        <SkeletonBlock lines={4} />
      ) : (
        <div className="table-wrap">
          <table className="data-table rs-insp-vals">
            <thead>
              <tr>
                <th scope="col" className="num">#</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.max(bVals.length, aVals.length) }, (_, i) => {
                const b = bVals[i];
                const a = aVals[i];
                const filled = aligned && (b === null || b === undefined) && a !== null && a !== undefined;
                const changed = aligned && !filled && b !== a;
                return (
                  <tr key={i}>
                    <td className="num faint">{i}</td>
                    <td className="mono rs-cell-clip">{i >= bVals.length ? <span className="faint">—</span> : b === null ? <span className="rs-null">null</span> : b}</td>
                    <td className={`mono rs-cell-clip${filled ? " rs-filled" : changed ? " rs-changed" : ""}`}>
                      {i >= aVals.length ? <span className="faint">—</span> : a === null ? <span className="rs-null">null</span> : a}
                      {filled && <span className="rs-tag">filled</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* =========================================================================
   No-audit state
   ========================================================================= */

function NoAudit({
  dataset,
  datasets,
  onNavigate,
  onSelectDataset,
}: Pick<ResultsViewProps, "dataset" | "datasets" | "onNavigate" | "onSelectDataset">) {
  const children = useMemo(() => datasets.filter((d) => d.parent_id === dataset.dataset_id), [datasets, dataset.dataset_id]);
  const parent = useMemo(
    () => (dataset.parent_id ? datasets.find((d) => d.dataset_id === dataset.parent_id) ?? null : null),
    [datasets, dataset.parent_id]
  );
  const [isPipeline, setIsPipeline] = useState<Record<string, boolean>>({});
  const childKey = children.map((c) => c.dataset_id).join(",");

  // Only pipeline runs store an audit trail, so a 200 here means "cleaned output".
  useEffect(() => {
    if (!childKey) return;
    const ctrl = new AbortController();
    const ids = childKey.split(",").slice(0, 20);
    for (const id of ids) {
      getAuditTrail(id, ctrl.signal).then(
        (a) => setIsPipeline((prev) => ({ ...prev, [id]: a !== null })),
        () => undefined
      );
    }
    return () => ctrl.abort();
  }, [childKey]);

  const sorted = useMemo(
    () => [...children].sort((a, b) => Number(isPipeline[b.dataset_id] ?? false) - Number(isPipeline[a.dataset_id] ?? false)),
    [children, isPipeline]
  );

  return (
    <div className="rs-root">
      <Card>
        <EmptyState
          icon="history"
          title="This dataset isn't a pipeline output"
          action={
            <div className="row rs-center">
              <Button variant="primary" icon="wand" onClick={() => onNavigate("clean")}>
                Clean this dataset
              </Button>
              {parent && (
                <Button icon="arrowRight" onClick={() => onSelectDataset(parent.dataset_id)}>
                  Open source: {parent.name}
                </Button>
              )}
            </div>
          }
        >
          {parent
            ? `It was derived from “${parent.name}” without running the cleaning pipeline (for example synthetic rows), so there is no step-by-step audit trail.`
            : "Audit trails are recorded for every cleaning run. Run the pipeline on this dataset to see exactly what changed, step by step."}
        </EmptyState>
      </Card>

      {dataset.warnings.length > 0 && (
        <Card title="Warnings recorded for this dataset" icon="alert">
          <div className="stack rs-gap-sm">
            {dataset.warnings.map((w, i) => (
              <Callout key={i} tone="warning">
                {w}
              </Callout>
            ))}
          </div>
        </Card>
      )}

      {sorted.length > 0 && (
        <Card title="Derived from this dataset" subtitle="Cleaned outputs have an audit trail you can open here" icon="layers">
          <ul className="rs-children">
            {sorted.map((c: DatasetSummary) => {
              const p = isPipeline[c.dataset_id];
              return (
                <li key={c.dataset_id}>
                  <button type="button" className="rs-child" onClick={() => onSelectDataset(c.dataset_id)}>
                    <Icon name={p ? "checkCircle" : "database"} size={16} className={p ? "rs-text-success" : "faint"} />
                    <span className="rs-child-name">{c.name}</span>
                    <span className="rs-child-meta">
                      {fmtInt(c.rows)} × {fmtInt(c.columns)}
                    </span>
                    {p === true && <Badge tone="success">Cleaned · has audit</Badge>}
                    {p === false && <Badge>Other derivation</Badge>}
                    <Icon name="chevronRight" size={16} className="faint" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* =========================================================================
   Loading skeleton
   ========================================================================= */

function ResultsSkeleton() {
  return (
    <div className="rs-root" aria-busy="true" aria-label="Loading audit trail">
      <div className="card rs-hero">
        <Skeleton width="40%" height={22} />
        <Skeleton width="65%" height={14} />
        <Skeleton width={220} height={30} radius={999} />
      </div>
      <div className="grid-stats">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="stat">
            <Skeleton width="50%" height={12} />
            <Skeleton width="70%" height={24} />
          </div>
        ))}
      </div>
      <Card>
        <SkeletonBlock lines={6} />
      </Card>
    </div>
  );
}

/* =========================================================================
   Main view
   ========================================================================= */

export default function ResultsView({
  dataset,
  datasets,
  onNavigate,
  onSelectDataset,
  audit,
  auditLoading,
  explanations,
  loadProfile,
  loadPreview,
}: ResultsViewProps) {
  if (auditLoading) return <ResultsSkeleton />;
  if (!audit) return <NoAudit dataset={dataset} datasets={datasets} onNavigate={onNavigate} onSelectDataset={onSelectDataset} />;
  return (
    <AuditResults
      dataset={dataset}
      datasets={datasets}
      onNavigate={onNavigate}
      onSelectDataset={onSelectDataset}
      audit={audit}
      explanations={explanations}
      loadProfile={loadProfile}
      loadPreview={loadPreview}
    />
  );
}

function AuditResults({
  dataset,
  datasets,
  onNavigate,
  onSelectDataset,
  audit,
  explanations,
  loadProfile,
  loadPreview,
}: Omit<ResultsViewProps, "auditLoading" | "onAskAssistant"> & { audit: AuditTrail; explanations: StepExplanation[] | null }) {
  const summary = useMemo(() => summarize(audit), [audit]);
  const lineage = useMemo(() => buildLineage(audit), [audit]);
  const parent = useMemo(
    () => (dataset.parent_id ? datasets.find((d) => d.dataset_id === dataset.parent_id) ?? null : null),
    [datasets, dataset.parent_id]
  );
  const parentId = dataset.parent_id;

  /* ---- async: profiles + previews (cached loaders; results ignored after unmount) ---- */
  const previewDefault = useCallback((id: string) => loadPreview(id), [loadPreview]);
  const [currentProfile, retryCurrent] = useLoaded(dataset.dataset_id, loadProfile);
  const [parentProfile, retryParent] = useLoaded(parentId, loadProfile);
  const [currentPreview] = useLoaded(dataset.dataset_id, previewDefault);
  const [parentPreview] = useLoaded(parentId, previewDefault);

  const cp = currentProfile.status === "ok" ? currentProfile.data : null;
  const pp = parentProfile.status === "ok" ? parentProfile.data : null;

  const currentCols = useMemo(() => cp?.map((p) => p.name) ?? dataset.column_names, [cp, dataset.column_names]);
  const parentCols = useMemo(() => pp?.map((p) => p.name) ?? parent?.column_names ?? null, [pp, parent]);
  const sharedCols = useMemo(() => {
    if (!parentCols) return [];
    const s = new Set(parentCols);
    return currentCols.filter((c) => s.has(c));
  }, [parentCols, currentCols]);
  const inspectDefault = useMemo(
    () => sharedCols.find((c) => (lineage.actions.get(c) ?? []).some((a) => a.includes("filled"))) ??
      sharedCols.find((c) => (lineage.actions.get(c)?.length ?? 0) > 0) ??
      sharedCols[0] ??
      "",
    [sharedCols, lineage]
  );

  /* ---- timeline expand state ---- */
  const [open, setOpen] = useState<Set<number>>(
    () => new Set(audit.steps.flatMap((s, i) => (s.rows_changed !== 0 ? [i] : [])))
  );
  const toggle = useCallback((i: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);
  const allOpen = open.size === audit.steps.length && audit.steps.length > 0;
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(audit.steps.map((_, i) => i)));
  const timelineRef = useRef<HTMLOListElement>(null);
  const pickStep = useCallback((i: number) => {
    setOpen((prev) => (prev.has(i) ? prev : new Set(prev).add(i)));
    requestAnimationFrame(() => {
      const el = timelineRef.current?.querySelector<HTMLElement>(`[data-step-toggle="${i}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    });
  }, []);

  const explByIndex = useMemo(
    () =>
      audit.steps.map((s, i) => {
        const e = explanations?.[i]?.step_name === s.step_name ? explanations[i] : explanations?.find((x) => x.step_name === s.step_name);
        return explanationExtra(s, e?.explanation);
      }),
    [audit, explanations]
  );

  /* ---- audit export ---- */
  const auditJson = useCallback(
    () =>
      JSON.stringify(
        {
          dataset_id: dataset.dataset_id,
          name: dataset.name,
          parent_id: dataset.parent_id,
          created_at: dataset.created_at,
          audit_trail: audit,
          ...(explanations ? { step_explanations: explanations } : {}),
        },
        null,
        2
      ),
    [dataset, audit, explanations]
  );
  const downloadAudit = () => {
    const url = URL.createObjectURL(new Blob([auditJson()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeFileBase(dataset.name)}_audit.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /* ---- guarantee badge ---- */
  const { before, after, removals, additions } = summary;
  const rowsLost = removals.reduce((n, r) => n - r.delta, 0);
  const rowsAdded = additions.reduce((n, r) => n + r.delta, 0);
  let guarantee: { tone: Tone; icon: IconName; title: string; text: string };
  if (removals.length === 0) {
    guarantee = {
      tone: "success",
      icon: "checkCircle",
      title: "No rows lost",
      text:
        rowsAdded > 0
          ? `Rows only increased: ${additions.map((a) => `${plural(a.delta, "row")} added by ${stepLabel(a.step)}`).join("; ")}.`
          : `All ${plural(before.rows, "row")} came through every step. Any unexpected row-count change would have aborted the run.`,
    };
  } else {
    guarantee = {
      tone: "warning",
      icon: "alert",
      title: removals.map((r) => `${plural(-r.delta, "row")} removed by ${stepLabel(r.step)} (explicitly enabled)`).join(" · "),
      text:
        removals.map((r) => REMOVAL_REASON[r.step] ?? "Row removal was explicitly enabled for this step.").join(" ") +
        (rowsAdded > 0 ? ` ${plural(rowsAdded, "row")} were also added.` : "") +
        " No other step changed the row count — the orchestrator aborts on any unrequested change.",
    };
  }
  const rowNote =
    removals.length || additions.length
      ? `Row count changed (${[
          ...removals.map((r) => `${signed(r.delta)} in ${stepLabel(r.step)}`),
          ...additions.map((a) => `${signed(a.delta)} in ${stepLabel(a.step)}`),
        ].join(", ")}), and positions were renumbered.`
      : "";

  const nullsFilled = Math.max(0, before.nulls - after.nulls);
  const fileBase = dataset.dataset_id;

  return (
    <div className="rs-root">
      {/* ---------- Hero ---------- */}
      <section className="card rs-hero" aria-labelledby="rs-hero-title">
        <div className="rs-hero-top">
          <div className="rs-hero-text">
            <div className="rs-eyebrow">
              <Icon name="history" size={14} /> Audit trail · {plural(audit.steps.length, "step")}
            </div>
            <h2 id="rs-hero-title" className="rs-hero-title">
              {dataset.name}
            </h2>
            <p className="rs-hero-sub">
              {parent ? (
                <>
                  Cleaned from <strong>{parent.name}</strong> · {fmtInt(before.rows)} × {fmtInt(before.columns)} →{" "}
                  {fmtInt(after.rows)} × {fmtInt(after.columns)}
                </>
              ) : (
                <>
                  {fmtInt(before.rows)} × {fmtInt(before.columns)} → {fmtInt(after.rows)} × {fmtInt(after.columns)}
                </>
              )}
            </p>
          </div>
          <div className="rs-hero-actions">
            <div className="rs-dl" role="group" aria-label="Download cleaned data">
              <span className="rs-dl-label">
                <Icon name="download" size={14} /> Download
              </span>
              <a className="btn btn-primary btn-sm" href={downloadUrl(fileBase, "csv")} download>
                CSV
              </a>
              <a className="btn btn-secondary btn-sm" href={downloadUrl(fileBase, "xlsx")} download>
                Excel
              </a>
              <a className="btn btn-secondary btn-sm" href={downloadUrl(fileBase, "json")} download>
                JSON
              </a>
            </div>
            <div className="row rs-hero-btns">
              <Button size="sm" variant="secondary" icon="brain" onClick={() => onNavigate("models")}>
                Recommend models
              </Button>
              {parentId && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="database"
                  onClick={() => onSelectDataset(parentId)}
                  disabled={!parent}
                  title={parent ? `Open ${parent.name}` : "The source dataset is no longer in this session"}
                >
                  Open source
                </Button>
              )}
            </div>
          </div>
        </div>
        <div className={`rs-guarantee rs-guarantee-${guarantee.tone}`} role="status">
          <Icon name={guarantee.icon} size={20} />
          <div>
            <div className="rs-guarantee-title">{guarantee.title}</div>
            <div className="rs-guarantee-text">{guarantee.text}</div>
          </div>
        </div>
      </section>

      {/* ---------- Stat tiles ---------- */}
      <div className="grid-stats rs-stats">
        <Stat
          label="Rows"
          icon="table"
          tone={rowsLost > 0 ? "warning" : "neutral"}
          value={
            <span className="rs-ba">
              {fmtInt(before.rows)} <span className="rs-ba-arrow">→</span> {fmtInt(after.rows)}
            </span>
          }
          hint={after.rows === before.rows ? "unchanged" : `${signed(after.rows - before.rows)} net`}
        />
        <Stat
          label="Columns"
          icon="columns"
          value={
            <span className="rs-ba">
              {fmtInt(before.columns)} <span className="rs-ba-arrow">→</span> {fmtInt(after.columns)}
            </span>
          }
          hint={after.columns === before.columns ? "unchanged" : `${signed(after.columns - before.columns)} net`}
        />
        <Stat
          label="Missing values"
          icon="search"
          tone={after.nulls > 0 ? "warning" : before.nulls > 0 ? "success" : "neutral"}
          value={
            <span className="rs-ba">
              {fmtInt(before.nulls)} <span className="rs-ba-arrow">→</span> {fmtInt(after.nulls)}
            </span>
          }
          hint={
            after.nulls > 0
              ? `${fmtInt(after.nulls)} still missing`
              : before.nulls > 0
                ? `all ${fmtInt(nullsFilled)} resolved`
                : "none to fill"
          }
        />
        <Stat label="Duration" icon="gauge" value={fmtMs(summary.durationMs)} hint={`across ${plural(audit.steps.length, "step")}`} />
        <Stat
          label="Warnings"
          icon="alert"
          tone={summary.warningCount > 0 ? "warning" : "success"}
          value={fmtInt(summary.warningCount)}
          hint={summary.warningCount > 0 ? `in ${plural(summary.warningSteps, "step")}` : "none raised"}
        />
      </div>

      {/* ---------- Flow ---------- */}
      {audit.steps.length > 0 && (
        <Card title="Through the pipeline" subtitle="Counts after each step — each chart has its own scale" icon="gauge">
          <FlowChart stages={summary.stages} onPick={pickStep} />
        </Card>
      )}

      {/* ---------- Timeline ---------- */}
      <Card
        title="Step by step"
        subtitle="Every change the pipeline made, in the order it ran"
        icon="layers"
        actions={
          audit.steps.length > 0 ? (
            <Button size="sm" variant="ghost" icon={allOpen ? "chevronRight" : "chevronDown"} onClick={toggleAll}>
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          ) : undefined
        }
      >
        {audit.steps.length === 0 ? (
          <p className="rs-note">This audit trail contains no steps.</p>
        ) : (
          <ol className="rs-timeline" ref={timelineRef}>
            {audit.steps.map((s, i) => (
              <StepItem key={i} step={s} index={i} open={open.has(i)} onToggle={toggle} explanation={explByIndex[i]} />
            ))}
          </ol>
        )}
      </Card>

      {/* ---------- Columns + inspector ---------- */}
      {parentId && parentCols ? (
        <>
          <ColumnChanges
            parentCols={parentCols}
            currentCols={currentCols}
            parentProfile={pp}
            currentProfile={cp}
            lineage={lineage}
            profilesLoading={parentProfile.status === "loading" || currentProfile.status === "loading"}
            profileError={
              parentProfile.status === "error"
                ? parentProfile.error
                : currentProfile.status === "error"
                  ? currentProfile.error
                  : null
            }
            onRetry={() => {
              if (parentProfile.status === "error") retryParent();
              if (currentProfile.status === "error") retryCurrent();
            }}
          />
          {sharedCols.length > 0 ? (
            <Inspector
              columns={sharedCols}
              defaultColumn={inspectDefault}
              parentProfile={pp}
              currentProfile={cp}
              parentPreview={parentPreview}
              currentPreview={currentPreview}
              aligned={summary.rowsAligned}
              rowNote={rowNote}
              lineage={lineage}
              statsLoading={parentProfile.status === "loading" || currentProfile.status === "loading"}
            />
          ) : (
            <Card title="Before / after inspector" icon="search">
              <p className="rs-note">No column exists in both the source and this output, so there is nothing to compare side by side.</p>
            </Card>
          )}
        </>
      ) : parentId && parentProfile.status === "loading" ? (
        <Card title="Column changes" icon="columns">
          <SkeletonBlock lines={5} />
        </Card>
      ) : parentId && parentProfile.status === "error" ? (
        <Callout tone="warning" title="Couldn’t load the source dataset" action={<Button size="sm" onClick={retryParent}>Retry</Button>}>
          {parentProfile.error} Column comparison and the before/after inspector need it.
        </Callout>
      ) : null}

      {/* ---------- Export ---------- */}
      <Card title="Export the audit" subtitle="A machine-readable record of every step, for reports or reproducibility" icon="file">
        <div className="row">
          <Button size="sm" icon="download" onClick={downloadAudit}>
            Download audit (JSON)
          </Button>
          <CopyButton text={auditJson} label="Copy audit JSON" />
        </div>
      </Card>
    </div>
  );
}
