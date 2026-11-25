import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import "./OverviewView.css";
import type { OverviewViewProps } from "./contracts";
import type { ColumnProfile, ColumnSuggestion, DatasetSummary, PipelineConfigIn, TabId } from "../types";
import { Badge, Button, Callout, EmptyState, IconButton, Meter, Segmented, Skeleton, SkeletonBlock, Stat } from "../components/ui";
import type { Tone } from "../components/ui";
import { Icon } from "../components/icons";
import type { IconName } from "../components/icons";
import { errorMessage, getSuggestions, isAbortError } from "../api/client";
import { KIND_LABELS, fmtInt, fmtPct, fmtRelativeTime, plural } from "../lib/format";
import {
  computeHealth,
  detectTarget,
  estimateOutputShape,
  getInsights,
  kindComposition,
  scanDuplicates,
} from "../lib/insights";
import type { HealthResult, Insight, InsightAction, Severity, ShapeEstimate, TargetGuess } from "../lib/insights";

/* =========================================================================
   Constants
   ========================================================================= */

const SEVERITY_ICON: Record<Severity, IconName> = {
  danger: "alert",
  warning: "alert",
  info: "info",
  success: "checkCircle",
};
const SEVERITY_LABEL: Record<Severity, string> = {
  danger: "Critical",
  warning: "Warning",
  info: "Tip",
  success: "All good",
};

type InsightFilter = "all" | "attention" | "tips";
const INITIAL_INSIGHTS = 6;
const INITIAL_ROLES = 8;
const MAX_CHIPS = 6;

/** Questions the rule-based chat assistant has a dedicated answer for (chat_assistant._detect_intent). */
const ASK_PROMPTS: { label: string; question: string; icon: IconName }[] = [
  { label: "Which algorithm?", question: "Which algorithm should I use for this dataset?", icon: "brain" },
  { label: "Missing data", question: "How much data is missing and how will it be cleaned?", icon: "search" },
  { label: "Outliers", question: "Are there any outliers in this dataset?", icon: "target" },
  { label: "Summary", question: "Give me a summary of this dataset.", icon: "file" },
];

const ROLE_META: Record<string, { label: string; tone: Tone; rank: number }> = {
  drop_candidate: { label: "Drop candidate", tone: "warning", rank: 0 },
  identifier: { label: "Identifier", tone: "info", rank: 1 },
  target: { label: "Target", tone: "success", rank: 2 },
  feature: { label: "Feature", tone: "accent", rank: 3 },
};
const roleMeta = (role: string) =>
  ROLE_META[role] ?? { label: role.replace(/_/g, " "), tone: "neutral" as Tone, rank: 4 };

const DELIMITERS: Record<string, string> = {
  ",": "Comma ( , )",
  ";": "Semicolon ( ; )",
  "\t": "Tab",
  "|": "Pipe ( | )",
  " ": "Space",
};

/* =========================================================================
   View
   ========================================================================= */

interface AppliedNote {
  label: string;
  before: PipelineConfigIn;
  after: PipelineConfigIn;
}

export default function OverviewView({
  dataset,
  datasets,
  onNavigate,
  onSelectDataset,
  onAskAssistant,
  uploadInfo,
  profile,
  preview,
  loading,
  config,
  onConfigChange,
}: OverviewViewProps) {
  const [filter, setFilter] = useState<InsightFilter>("all");
  const [showAllInsights, setShowAllInsights] = useState(false);
  const [applied, setApplied] = useState<AppliedNote | null>(null);

  const health = useMemo(() => (profile ? computeHealth(profile, dataset.rows, preview) : null), [profile, dataset.rows, preview]);
  const insights = useMemo(
    () => (profile ? getInsights(profile, preview, dataset, config) : []),
    [profile, preview, dataset, config]
  );
  const dups = useMemo(() => scanDuplicates(preview), [preview]);
  const shape = useMemo(
    () => (profile ? estimateOutputShape(profile, dataset.rows, config, dups) : null),
    [profile, dataset.rows, config, dups]
  );
  const target = useMemo(() => (profile ? detectTarget(profile) : null), [profile]);

  const counts = useMemo(() => {
    let attention = 0;
    let tips = 0;
    let critical = 0;
    for (const i of insights) {
      if (i.severity === "danger") critical++;
      if (i.severity === "danger" || i.severity === "warning") attention++;
      else if (i.severity === "info") tips++;
    }
    return { attention, tips, critical };
  }, [insights]);

  const visibleInsights = useMemo(() => {
    const list =
      filter === "attention"
        ? insights.filter((i) => i.severity === "danger" || i.severity === "warning")
        : filter === "tips"
          ? insights.filter((i) => i.severity === "info" || i.severity === "success")
          : insights;
    return list;
  }, [insights, filter]);

  const applyConfig = useCallback(
    (label: string, next: PipelineConfigIn) => {
      setApplied({ label, before: config, after: next });
      onConfigChange(next);
    },
    [config, onConfigChange]
  );

  if (!profile) {
    if (loading) return <OverviewSkeleton />;
    return (
      <EmptyState
        icon="gauge"
        title="Profile not available"
        action={
          <Button icon="refresh" onClick={() => onSelectDataset(dataset.dataset_id)}>
            Reload dataset
          </Button>
        }
      >
        The column profile for “{dataset.name}” hasn't loaded, so there's nothing to analyse yet.
      </EmptyState>
    );
  }

  if (profile.length === 0) {
    return (
      <EmptyState icon="columns" title="This dataset has no columns">
        Upload a file with at least one column to see an overview.
      </EmptyState>
    );
  }

  const shown = showAllInsights ? visibleInsights : visibleInsights.slice(0, INITIAL_INSIGHTS);
  const hidden = visibleInsights.length - shown.length;

  return (
    <div className="ov">
      <OverviewStats profile={profile} rows={dataset.rows} dups={dups} attention={counts.attention} tips={counts.tips} />

      <div className="ov-layout">
        <div className="ov-main">
          <section className="card ov-insights" aria-labelledby="ov-insights-title">
            <header className="ov-section-head">
              <div className="card-title-wrap">
                <span className="card-icon">
                  <Icon name="sparkles" size={16} />
                </span>
                <div>
                  <h3 className="card-title" id="ov-insights-title">
                    Insights
                  </h3>
                  <p className="card-subtitle">Rule-based checks against what the pipeline will actually do. Each one says why.</p>
                </div>
              </div>
              <Segmented<InsightFilter>
                size="sm"
                ariaLabel="Filter insights"
                value={filter}
                onChange={(v) => {
                  setFilter(v);
                  setShowAllInsights(false);
                }}
                options={[
                  { value: "all", label: `All ${insights.length}` },
                  { value: "attention", label: `Needs attention ${counts.attention}` },
                  { value: "tips", label: `Tips ${insights.length - counts.attention}` },
                ]}
              />
            </header>

            {applied && (
              <div className="ov-applied-note" role="status">
                <Callout
                  tone="success"
                  title={`Applied: ${applied.label}`}
                  action={
                    <div className="ov-applied-actions">
                      {config === applied.after && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="refresh"
                          onClick={() => {
                            onConfigChange(applied.before);
                            setApplied(null);
                          }}
                        >
                          Undo
                        </Button>
                      )}
                      <Button size="sm" iconRight="arrowRight" onClick={() => onNavigate("clean")}>
                        Review in Clean
                      </Button>
                      <IconButton icon="x" label="Dismiss" size={28} onClick={() => setApplied(null)} />
                    </div>
                  }
                >
                  Pipeline settings updated. Nothing runs until you press Run in the Clean tab.
                </Callout>
              </div>
            )}

            {visibleInsights.length === 0 ? (
              <p className="ov-none muted">
                {filter === "attention" ? "Nothing needs attention." : "No tips for this dataset."}
              </p>
            ) : (
              <ul className="ov-insight-list">
                {shown.map((insight) => (
                  <InsightItem
                    key={insight.id}
                    insight={insight}
                    config={config}
                    onApply={applyConfig}
                    onConfigChange={onConfigChange}
                    onNavigate={onNavigate}
                    onAsk={onAskAssistant}
                  />
                ))}
              </ul>
            )}
            {(hidden > 0 || (showAllInsights && visibleInsights.length > INITIAL_INSIGHTS)) && (
              <div className="ov-more">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={showAllInsights ? "chevronRight" : "chevronDown"}
                  aria-expanded={showAllInsights}
                  onClick={() => setShowAllInsights((s) => !s)}
                >
                  {showAllInsights ? "Show fewer" : `Show ${hidden} more`}
                </Button>
              </div>
            )}
          </section>

          <RolesCard datasetId={dataset.dataset_id} profile={profile} target={target} />
          <SourceCard dataset={dataset} datasets={datasets} uploadInfo={uploadInfo} onSelectDataset={onSelectDataset} />
        </div>

        <aside className="ov-side" aria-label="Dataset summary">
          {health && <HealthCard health={health} />}
          {shape && (
            <NextStepCard
              dataset={dataset}
              columns={profile.length}
              shape={shape}
              critical={counts.critical}
              onNavigate={onNavigate}
              onAsk={onAskAssistant}
            />
          )}
          <CompositionCard profile={profile} onNavigate={onNavigate} />
        </aside>
      </div>
    </div>
  );
}

/* =========================================================================
   Stat tiles
   ========================================================================= */

const OverviewStats = memo(function OverviewStats({
  profile,
  rows,
  dups,
  attention,
  tips,
}: {
  profile: ColumnProfile[];
  rows: number;
  dups: ReturnType<typeof scanDuplicates>;
  attention: number;
  tips: number;
}) {
  const s = useMemo(() => {
    const nulls = profile.reduce((n, p) => n + p.null_count, 0);
    const cells = rows * profile.length;
    const colsWithNulls = profile.filter((p) => p.null_count > 0).length;
    const numeric = profile.filter((p) => p.kind === "numeric");
    const outCols = numeric.filter((p) => p.outlier_count > 0).length;
    const outVals = numeric.reduce((n, p) => n + p.outlier_count, 0);
    const kinds = kindComposition(profile)
      .sort((a, b) => b.count - a.count)
      .slice(0, 2)
      .map((k) => `${k.count} ${KIND_LABELS[k.kind].toLowerCase()}`)
      .join(" · ");
    return { nulls, ratio: cells ? nulls / cells : 0, colsWithNulls, numeric: numeric.length, outCols, outVals, kinds };
  }, [profile, rows]);

  const dupHint = !dups
    ? undefined
    : dups.count === 0
      ? dups.exact
        ? "no exact duplicates"
        : `no duplicates in first ${fmtInt(dups.rowsChecked)}`
      : `${plural(dups.count, "duplicate")}${dups.exact ? "" : ` in first ${fmtInt(dups.rowsChecked)}`}`;

  return (
    <div className="grid-stats ov-stats">
      <Stat icon="table" label="Rows" value={fmtInt(rows)} hint={dupHint} tone={dups && dups.count > 0 ? "warning" : "neutral"} />
      <Stat icon="columns" label="Columns" value={fmtInt(profile.length)} hint={s.kinds} />
      <Stat
        icon="search"
        label="Missing cells"
        value={fmtInt(s.nulls)}
        tone={s.nulls === 0 ? "success" : s.ratio >= 0.05 ? "warning" : "neutral"}
        hint={s.nulls === 0 ? "complete dataset" : `${fmtPct(s.ratio)} of cells · ${plural(s.colsWithNulls, "column")}`}
      />
      <Stat
        icon="target"
        label="Outlier values"
        value={fmtInt(s.outVals)}
        tone={s.outVals > 0 ? "warning" : "neutral"}
        hint={s.numeric === 0 ? "no numeric columns" : `in ${s.outCols} of ${plural(s.numeric, "numeric column")}`}
      />
      <Stat
        icon="sparkles"
        label="Needs attention"
        value={fmtInt(attention)}
        tone={attention === 0 ? "success" : "warning"}
        hint={`${plural(tips, "tip")} below`}
      />
    </div>
  );
});

/* =========================================================================
   Insight item
   ========================================================================= */

interface InsightItemProps {
  insight: Insight;
  config: PipelineConfigIn;
  onApply: (label: string, next: PipelineConfigIn) => void;
  onConfigChange: (c: PipelineConfigIn) => void;
  onNavigate: (tab: TabId) => void;
  onAsk: (question: string) => void;
}

function InsightItem({ insight, config, onApply, onConfigChange, onNavigate, onAsk }: InsightItemProps) {
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const extraCols = insight.columns.length - MAX_CHIPS;

  const renderAction = (action: InsightAction, primary: boolean) => {
    if (action.type === "navigate")
      return (
        <Button size="sm" variant={primary ? "secondary" : "ghost"} iconRight="arrowRight" onClick={() => onNavigate(action.tab)}>
          {action.label}
        </Button>
      );
    if (action.type === "ask")
      return (
        <Button size="sm" variant={primary ? "secondary" : "ghost"} icon="chat" onClick={() => onAsk(action.question)}>
          {action.label}
        </Button>
      );

    if (action.isApplied(config))
      return (
        <span className="ov-applied">
          <span className="ov-applied-badge">
            <Icon name="check" size={13} /> Applied
          </span>
          <Button size="sm" variant="ghost" onClick={() => onConfigChange(action.revert(config))} title="Remove just this setting">
            Undo
          </Button>
          <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => onNavigate("clean")}>
            Review in Clean
          </Button>
        </span>
      );

    if (action.dropsRows) {
      if (confirming)
        return (
          <span className="ov-confirm" role="group" aria-label="Confirm row removal">
            <span className="ov-confirm-text">
              <Icon name="alert" size={13} /> This removes rows from the cleaned output.
            </span>
            <Button
              size="sm"
              variant="danger"
              autoFocus
              onClick={() => {
                setConfirming(false);
                onApply(action.label, action.apply(config));
              }}
            >
              Yes, {action.label.charAt(0).toLowerCase() + action.label.slice(1)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        );
      return (
        <Button size="sm" variant="danger" icon="trash" onClick={() => setConfirming(true)}>
          {action.label}
        </Button>
      );
    }

    return (
      <Button size="sm" variant={primary ? "secondary" : "ghost"} icon="sliders" onClick={() => onApply(action.label, action.apply(config))}>
        {action.label}
      </Button>
    );
  };

  return (
    <li className={`ov-insight ov-sev-${insight.severity}`} aria-labelledby={titleId}>
      <span className="ov-insight-icon" aria-hidden="true">
        <Icon name={SEVERITY_ICON[insight.severity]} size={15} />
      </span>
      <div className="ov-insight-body">
        <div className="ov-insight-head">
          <span className="sr-only">{SEVERITY_LABEL[insight.severity]}: </span>
          <h4 className="ov-insight-title" id={titleId}>
            {insight.title}
          </h4>
        </div>
        <p className="ov-insight-detail">{insight.detail}</p>
        {insight.columns.length > 0 && (
          <ul className="ov-chips" aria-label="Columns">
            {insight.columns.slice(0, MAX_CHIPS).map((c) => (
              <li key={c} className="ov-chip" title={c}>
                {c}
              </li>
            ))}
            {extraCols > 0 && (
              <li className="ov-chip ov-chip-more" title={insight.columns.slice(MAX_CHIPS).join(", ")}>
                +{extraCols} more
              </li>
            )}
          </ul>
        )}
        {(insight.action || insight.secondary) && (
          <div className="ov-insight-actions">
            {insight.action && renderAction(insight.action, true)}
            {insight.secondary && !confirming && renderAction(insight.secondary, false)}
          </div>
        )}
      </div>
    </li>
  );
}

/* =========================================================================
   Health score
   ========================================================================= */

const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

const scoreTone = (s: number): Tone => (s >= 90 ? "success" : s >= 70 ? "info" : s >= 50 ? "warning" : "danger");

const HealthCard = memo(function HealthCard({ health }: { health: HealthResult }) {
  const [open, setOpen] = useState(true);
  const offset = RING_C * (1 - health.score / 100);
  const ringStyle = { strokeDasharray: RING_C, strokeDashoffset: offset, "--ov-circ": RING_C } as CSSProperties;

  return (
    <section className="card ov-health" aria-labelledby="ov-health-title">
      <div className="ov-health-top">
        <svg
          className={`ov-ring ov-tone-${health.tone}`}
          width="128"
          height="128"
          viewBox="0 0 128 128"
          role="img"
          aria-label={`Health score ${health.score} out of 100: ${health.grade}`}
        >
          <circle className="ov-ring-track" cx="64" cy="64" r={RING_R} />
          <circle className="ov-ring-value" cx="64" cy="64" r={RING_R} style={ringStyle} />
          <text className="ov-ring-score" x="64" y="62" textAnchor="middle" dominantBaseline="middle">
            {health.score}
          </text>
          <text className="ov-ring-max" x="64" y="86" textAnchor="middle">
            / 100
          </text>
        </svg>
        <div className="ov-health-text">
          <h3 className="card-title" id="ov-health-title">
            Data health
          </h3>
          <div className={`ov-grade ov-tone-${health.tone}`}>{health.grade}</div>
          <p className="ov-health-sub">
            Weighted average of {plural(health.components.length, "check")}, computed from the profile in your browser.
          </p>
          <button
            type="button"
            className="ov-link"
            aria-expanded={open}
            aria-controls="ov-health-breakdown"
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
            {open ? "Hide breakdown" : "Show breakdown"}
          </button>
        </div>
      </div>
      {open && (
        <ul className="ov-breakdown" id="ov-health-breakdown">
          {health.components.map((c) => (
            <li key={c.key} className="ov-bd-item">
              <div className="ov-bd-head">
                <span className="ov-bd-label">{c.label}</span>
                <span className="ov-bd-weight faint" title="Share of the overall score">
                  ×{fmtPct(c.weight, 0)}
                </span>
                <span className="ov-bd-score">{Math.round(c.score)}</span>
              </div>
              <Meter value={c.score / 100} tone={scoreTone(c.score)} label={`${c.label}: ${Math.round(c.score)} of 100`} height={5} />
              <p className="ov-bd-reason">{c.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});

/* =========================================================================
   Next step (CTA + expected output + ask chips)
   ========================================================================= */

function NextStepCard({
  dataset,
  columns,
  shape,
  critical,
  onNavigate,
  onAsk,
}: {
  dataset: DatasetSummary;
  columns: number;
  shape: ShapeEstimate;
  critical: number;
  onNavigate: (tab: TabId) => void;
  onAsk: (q: string) => void;
}) {
  // Exact duplicates are known when the preview covers every row; outlier removal can only be bounded.
  const dedupeOnly = shape.rowsMayDrop.every((r) => r.reason === "duplicate removal is on" && r.upTo !== null);
  const rowText =
    shape.rowsMayDrop.length === 0 ? fmtInt(dataset.rows) : dedupeOnly ? `≈ ${fmtInt(shape.rows)}` : `≤ ${fmtInt(dataset.rows)}`;

  return (
    <section className="card ov-next" aria-labelledby="ov-next-title">
      <h3 className="card-title" id="ov-next-title">
        Next step
      </h3>
      <p className="ov-next-sub muted">With the current pipeline settings, the cleaned output should be about:</p>

      <div className="ov-shape" aria-label="Estimated output shape">
        <div className="ov-shape-cell">
          <span className="ov-shape-label">Rows</span>
          <span className="ov-shape-value">
            <span className="faint">{fmtInt(dataset.rows)}</span>
            <Icon name="arrowRight" size={13} />
            {rowText}
          </span>
        </div>
        <div className="ov-shape-cell">
          <span className="ov-shape-label">Columns</span>
          <span className="ov-shape-value">
            <span className="faint">{fmtInt(columns)}</span>
            <Icon name="arrowRight" size={13} />≈ {fmtInt(shape.columns)}
          </span>
        </div>
      </div>

      {shape.deltas.length > 0 && (
        <ul className="ov-deltas">
          {shape.deltas.map((d) => (
            <li key={d.label} title={d.columns.join(", ")}>
              <span className={`ov-delta ${d.delta > 0 ? "ov-delta-up" : "ov-delta-down"}`}>
                {d.delta > 0 ? "+" : ""}
                {fmtInt(d.delta)}
              </span>
              <span className="ov-delta-text">
                {d.label}
                <span className="faint"> · {d.columns.slice(0, 3).join(", ")}{d.columns.length > 3 ? "…" : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {shape.rowsMayDrop.length === 0 ? (
        <p className="ov-rowsafe">
          <Icon name="checkCircle" size={14} /> No rows will be removed with these settings.
        </p>
      ) : (
        <div className="ov-rowdrop" role="note">
          <Icon name="alert" size={14} />
          <span>
            Rows can be removed:{" "}
            {shape.rowsMayDrop
              .map((r) => (r.upTo === null ? r.reason : `${r.reason} (up to ${plural(r.upTo, "row")})`))
              .join("; ")}
            .
          </span>
        </div>
      )}
      {critical > 0 && (
        <div className="ov-rowdrop ov-critical" role="note">
          <Icon name="alert" size={14} />
          <span>
            {plural(critical, "critical issue")} in Insights: the run may fail or drop rows. Review {critical === 1 ? "it" : "them"} first.
          </span>
        </div>
      )}
      <p className="ov-estimate-note faint">
        Estimate: outliers are re-detected after imputation, so the exact numbers can differ slightly.
      </p>

      <div className="ov-next-actions">
        <Button variant="primary" size="lg" icon="wand" onClick={() => onNavigate("clean")}>
          Clean this dataset
        </Button>
        {dataset.parent_id && (
          <Button icon="history" onClick={() => onNavigate("results")}>
            Audit trail
          </Button>
        )}
      </div>

      <div className="ov-ask">
        <div className="ov-ask-label">
          <Icon name="chat" size={13} /> Ask the assistant <span className="faint">(rule-based, answers from this data)</span>
        </div>
        <div className="ov-ask-chips">
          {ASK_PROMPTS.map((p) => (
            <button key={p.label} type="button" className="ov-ask-chip" onClick={() => onAsk(p.question)} title={p.question}>
              <Icon name={p.icon} size={13} />
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   Column-type composition
   ========================================================================= */

const CompositionCard = memo(function CompositionCard({
  profile,
  onNavigate,
}: {
  profile: ColumnProfile[];
  onNavigate: (tab: TabId) => void;
}) {
  const comp = useMemo(() => kindComposition(profile), [profile]);
  const total = profile.length;
  const summary = comp.map((k) => `${k.count} ${KIND_LABELS[k.kind]}`).join(", ");

  return (
    <section className="card ov-comp" aria-labelledby="ov-comp-title">
      <header className="ov-section-head">
        <h3 className="card-title" id="ov-comp-title">
          Column types
        </h3>
        <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => onNavigate("columns")}>
          All columns
        </Button>
      </header>
      <div className="ov-comp-bar" role="img" aria-label={`Column types: ${summary}`}>
        {comp.map((k) => (
          <span
            key={k.kind}
            className={`ov-comp-seg kind-${k.kind}`}
            style={{ flexGrow: k.count }}
            title={`${KIND_LABELS[k.kind]}: ${k.count} (${fmtPct(k.count / total, 0)})`}
          />
        ))}
      </div>
      <ul className="ov-legend">
        {comp.map((k) => (
          <li key={k.kind} className={`ov-legend-item kind-${k.kind}`}>
            <span className="ov-legend-dot" aria-hidden="true" />
            <span className="ov-legend-label">{KIND_LABELS[k.kind]}</span>
            <span className="ov-legend-count">{k.count}</span>
            <span className="ov-legend-pct faint">{fmtPct(k.count / total, 0)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});

/* =========================================================================
   Column roles (backend rule-based advisor)
   ========================================================================= */

type SuggestState =
  | { status: "loading" }
  | { status: "ok"; data: ColumnSuggestion[] }
  | { status: "error"; error: string };

function RolesCard({ datasetId, profile, target }: { datasetId: string; profile: ColumnProfile[]; target: TargetGuess | null }) {
  const [state, setState] = useState<SuggestState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rolesId = useId();

  useEffect(() => {
    const ctrl = new AbortController();
    getSuggestions(datasetId, ctrl.signal)
      .then((data) => setState({ status: "ok", data }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        setState({ status: "error", error: errorMessage(e) });
      });
    return () => ctrl.abort();
  }, [datasetId, attempt]);

  const retry = () => {
    setState({ status: "loading" });
    setAttempt((a) => a + 1);
  };

  const kindByName = useMemo(() => new Map(profile.map((p) => [p.name, p.kind])), [profile]);

  const sorted = useMemo(() => {
    if (state.status !== "ok") return [];
    return state.data
      .map((s, i) => ({ s, i }))
      .sort((a, b) => roleMeta(a.s.suggested_role).rank - roleMeta(b.s.suggested_role).rank || a.i - b.i)
      .map((x) => x.s);
  }, [state]);

  const roleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sorted) m.set(s.suggested_role, (m.get(s.suggested_role) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => roleMeta(a[0]).rank - roleMeta(b[0]).rank);
  }, [sorted]);

  const shown = showAll ? sorted : sorted.slice(0, INITIAL_ROLES);

  return (
    <section className="card ov-roles" aria-labelledby="ov-roles-title" aria-busy={state.status === "loading"}>
      <header className="ov-section-head">
        <div className="card-title-wrap">
          <span className="card-icon">
            <Icon name="target" size={16} />
          </span>
          <div>
            <h3 className="card-title" id="ov-roles-title">
              Column roles
            </h3>
            <p className="card-subtitle">From the backend's rule-based advisor (no AI model). Select a row for the reason.</p>
          </div>
        </div>
        {state.status === "ok" && (
          <div className="ov-role-summary">
            {roleCounts.map(([role, n]) => (
              <Badge key={role} tone={roleMeta(role).tone}>
                {n} {roleMeta(role).label.toLowerCase()}
              </Badge>
            ))}
          </div>
        )}
      </header>

      {state.status === "loading" && (
        <div className="ov-roles-skel">
          {Array.from({ length: Math.min(4, profile.length) }, (_, i) => (
            <div key={i} className="ov-roles-skel-row">
              <Skeleton width="38%" />
              <Skeleton width={70} height={18} radius={999} />
              <Skeleton width={60} />
            </div>
          ))}
        </div>
      )}

      {state.status === "error" && (
        <div className="ov-roles-error">
          <span className="muted">
            <Icon name="info" size={14} /> Couldn't load role suggestions. {state.error}
          </span>
          <Button size="sm" icon="refresh" onClick={retry}>
            Retry
          </Button>
        </div>
      )}

      {state.status === "ok" && sorted.length === 0 && <p className="ov-none muted">No suggestions returned.</p>}

      {state.status === "ok" && sorted.length > 0 && (
        <>
          <ul className="ov-role-list">
            {shown.map((s, idx) => {
              const meta = roleMeta(s.suggested_role);
              const isOpen = expanded === s.column;
              const kind = kindByName.get(s.column);
              const isTarget = target?.column === s.column;
              const panelId = `${rolesId}-${idx}`;
              return (
                <li key={s.column} className={`ov-role${isOpen ? " open" : ""}`}>
                  <button
                    type="button"
                    className="ov-role-row"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setExpanded(isOpen ? null : s.column)}
                    title={s.reason}
                  >
                    <span className="ov-role-name">
                      <span className="ov-role-col">{s.column}</span>
                      {kind && <span className={`ov-role-kind kind-${kind}`}>{KIND_LABELS[kind]}</span>}
                    </span>
                    <span className="ov-role-tags">
                      {isTarget && (
                        <Badge tone="success" title={`Likely target: ${target.reason}`}>
                          likely target
                        </Badge>
                      )}
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </span>
                    <span className="ov-role-conf" aria-label={`Confidence ${fmtPct(s.confidence, 0)}`}>
                      <span className="ov-role-meter">
                        <Meter value={s.confidence} tone={meta.tone} height={4} />
                      </span>
                      <span className="ov-role-pct">{fmtPct(s.confidence, 0)}</span>
                    </span>
                    <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} className="ov-role-chev" />
                  </button>
                  {isOpen && (
                    <div className="ov-role-reason" id={panelId}>
                      {s.reason}
                      {isTarget && (
                        <span className="ov-role-target-note">
                          {" "}
                          Also the likely target: {target.reason} (same rules as the Models tab).
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="ov-roles-foot">
            <span className="faint">Confidence is the fixed weight of the rule that matched, not a learned probability.</span>
            {sorted.length > INITIAL_ROLES && (
              <Button size="sm" variant="ghost" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${sorted.length}`}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/* =========================================================================
   Source & lineage
   ========================================================================= */

function SourceCard({
  dataset,
  datasets,
  uploadInfo,
  onSelectDataset,
}: {
  dataset: DatasetSummary;
  datasets: DatasetSummary[];
  uploadInfo: DatasetSummary | null;
  onSelectDataset: (id: string) => void;
}) {
  const parent = useMemo(
    () => (dataset.parent_id ? datasets.find((d) => d.dataset_id === dataset.parent_id) ?? null : null),
    [dataset.parent_id, datasets]
  );
  const children = useMemo(() => datasets.filter((d) => d.parent_id === dataset.dataset_id), [datasets, dataset.dataset_id]);
  const created = new Date(dataset.created_at);
  const createdValid = !Number.isNaN(created.getTime());

  const rows: { label: string; value: ReactNode }[] = [];
  if (uploadInfo?.source_format) rows.push({ label: "Format", value: uploadInfo.source_format.toUpperCase() });
  if (uploadInfo?.encoding_used) rows.push({ label: "Encoding", value: <span className="mono">{uploadInfo.encoding_used}</span> });
  if (uploadInfo?.delimiter_used)
    rows.push({ label: "Delimiter", value: DELIMITERS[uploadInfo.delimiter_used] ?? <span className="mono">{JSON.stringify(uploadInfo.delimiter_used)}</span> });
  if (uploadInfo?.sheet_used) rows.push({ label: "Sheet", value: uploadInfo.sheet_used });
  rows.push({ label: "Shape", value: `${plural(dataset.rows, "row")} × ${plural(dataset.columns, "column")}` });
  if (createdValid)
    rows.push({
      label: "Created",
      value: (
        <time dateTime={dataset.created_at} title={created.toLocaleString()}>
          {fmtRelativeTime(dataset.created_at) || created.toLocaleString()}
        </time>
      ),
    });

  return (
    <section className="card ov-source" aria-labelledby="ov-source-title">
      <header className="ov-section-head">
        <div className="card-title-wrap">
          <span className="card-icon">
            <Icon name="file" size={16} />
          </span>
          <div>
            <h3 className="card-title" id="ov-source-title">
              Source &amp; lineage
            </h3>
            <p className="card-subtitle">{dataset.parent_id ? "Derived from another dataset" : uploadInfo ? "Uploaded file" : "Dataset in this session"}</p>
          </div>
        </div>
      </header>

      <dl className="ov-dl">
        {rows.map((r) => (
          <div key={r.label} className="ov-dl-row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
        {dataset.parent_id && (
          <div className="ov-dl-row">
            <dt>Derived from</dt>
            <dd>
              {parent ? (
                <button type="button" className="ov-lineage" onClick={() => onSelectDataset(parent.dataset_id)} title="Open parent dataset">
                  <Icon name="database" size={13} />
                  <span>{parent.name}</span>
                  <Icon name="arrowRight" size={12} />
                </button>
              ) : (
                <span className="faint mono">{dataset.parent_id.slice(0, 8)}… (not in this session)</span>
              )}
            </dd>
          </div>
        )}
        {children.length > 0 && (
          <div className="ov-dl-row">
            <dt>Derived datasets</dt>
            <dd className="ov-lineage-list">
              {children.map((c) => (
                <button key={c.dataset_id} type="button" className="ov-lineage" onClick={() => onSelectDataset(c.dataset_id)} title="Open derived dataset">
                  <Icon name="layers" size={13} />
                  <span>{c.name}</span>
                  <Icon name="arrowRight" size={12} />
                </button>
              ))}
            </dd>
          </div>
        )}
      </dl>

      {!uploadInfo && !dataset.parent_id && (
        <p className="ov-source-note faint">File format and encoding are only known for files uploaded since this page was opened.</p>
      )}

      {dataset.warnings.length > 0 && (
        <div className="ov-warnings">
          {dataset.warnings.map((w, i) => (
            <Callout key={i} tone="warning" title={i === 0 ? `${plural(dataset.warnings.length, "warning")} from ingestion` : undefined}>
              {w}
            </Callout>
          ))}
        </div>
      )}
    </section>
  );
}

/* =========================================================================
   Loading skeleton
   ========================================================================= */

function OverviewSkeleton() {
  return (
    <div className="ov" aria-busy="true" aria-label="Loading overview">
      <div className="grid-stats ov-stats">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="stat">
            <Skeleton width="50%" height={12} />
            <Skeleton width="40%" height={26} />
            <Skeleton width="70%" height={11} />
          </div>
        ))}
      </div>
      <div className="ov-layout">
        <div className="ov-main">
          <div className="card">
            <Skeleton width="30%" height={18} />
            <div className="ov-skel-gap" />
            <SkeletonBlock lines={7} />
          </div>
        </div>
        <div className="ov-side">
          <div className="card ov-skel-health">
            <Skeleton width={128} height={128} radius={999} />
            <div className="ov-skel-col">
              <Skeleton width="60%" height={16} />
              <Skeleton width="40%" height={22} />
              <Skeleton width="90%" />
            </div>
          </div>
          <div className="card">
            <SkeletonBlock lines={5} />
          </div>
        </div>
      </div>
    </div>
  );
}

