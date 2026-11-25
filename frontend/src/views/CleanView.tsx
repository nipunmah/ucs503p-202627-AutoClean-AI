import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { CleanViewProps } from "./contracts";
import type { ColumnProfile, OutlierStrategy, PipelineConfigIn, ScaleMethod } from "../types";
import { DEFAULT_PIPELINE_CONFIG } from "../types";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  IconButton,
  Kbd,
  Segmented,
  SkeletonBlock,
  Spinner,
  Stat,
  Switch,
} from "../components/ui";
import type { Tone } from "../components/ui";
import { Icon } from "../components/icons";
import type { IconName } from "../components/icons";
import { PIPELINE_STEPS, fmtInt, plural, stepLabel } from "../lib/format";
import {
  CATEGORICAL_IMPUTE_OPTIONS,
  DATETIME_IMPUTE_OPTIONS,
  NUMERIC_IMPUTE_OPTIONS,
  ONE_HOT_MAX,
  ONE_HOT_MIN,
  OUTLIER_LABELS,
  PRESETS,
  detectPipelineOutput,
  estimatePipeline,
  imputeLabel,
  isIdLike,
  recommendConfig,
  sameConfig,
} from "../lib/autoconfig";
import type { AffectItem, ConfigReason, PipelineStepName, PresetId, StepEstimate, StepNote } from "../lib/autoconfig";
import "./CleanView.css";

/* ====================================================================== */

const STEP_META: Record<PipelineStepName, { icon: IconName; description: string }> = {
  coerce_types: {
    icon: "refresh",
    description: "Converts columns to numeric, boolean or date types. Values that can't convert become missing — never dropped.",
  },
  impute_missing: {
    icon: "plus",
    description: "Fills gaps so no row has to be dropped. The strategy is picked by column type unless a column has an override.",
  },
  handle_duplicates: {
    icon: "copy",
    description: "Always detects exact duplicate rows and reports them in the audit trail. Removing them is opt-in.",
  },
  handle_outliers: {
    icon: "target",
    description:
      "Finds numeric values outside Q1 − 1.5·IQR … Q3 + 1.5·IQR. Columns with fewer than 4 values or zero IQR are skipped.",
  },
  encode_categoricals: {
    icon: "columns",
    description:
      "Booleans → 0/1; categories up to the limit → one-hot, above it → integer label codes. Identifiers and free text are left as-is.",
  },
  engineer_features: {
    icon: "sparkles",
    description: "Appends numeric parts of dates (year, month, day, weekday) and text (length, word count). Existing columns are untouched.",
  },
  scale_features: {
    icon: "sliders",
    description: "Rescales numeric columns. 0/1 indicator columns are excluded; fitted parameters are recorded in the audit trail.",
  },
};

const PRESET_ICONS: Record<PresetId, IconName> = {
  smart: "wand",
  safe: "checkCircle",
  minimal: "layers",
  thorough: "flask",
};

const FIELD_LABELS: Record<string, string> = {
  coerce_types: "Type coercion",
  numeric_impute_strategy: "Numeric gaps",
  categorical_impute_strategy: "Categorical gaps",
  datetime_impute_strategy: "Date gaps",
  dedupe: "Duplicates",
  outlier_default_strategy: "Outliers",
  encode: "Encoding",
  one_hot_max_cardinality: "One-hot limit",
  engineer_features: "Features",
  scale_method: "Scaling",
};

const OUTLIER_HELP: Record<Exclude<OutlierStrategy, "skip">, string> = {
  flag: "Keeps every value and adds a true/false <column>__is_outlier indicator to each column that has outliers (0/1 once encoded).",
  clip: "Caps values at the IQR fences. Rows are kept; the extreme values themselves change.",
  remove: "Deletes every row with an outlier in this column. This drops data.",
};

const SCALE_HELP: Record<Exclude<ScaleMethod, "none">, string> = {
  standard: "Subtracts the mean and divides by the standard deviation (mean 0, std 1).",
  minmax: "Rescales each column to the 0–1 range using its min and max.",
  robust: "Subtracts the median and divides by the IQR — barely affected by outliers.",
};

const DATA_LOSS_SENTENCE =
  "The backend re-checks the row count after every step and aborts the whole run (DataLossError) if any step changes it without being configured to, so rows can only drop through the options listed here.";

function errorGuidance(msg: string): string {
  if (/data ?loss|aborted/i.test(msg))
    return "A step changed the row count without being configured to, so the backend stopped the run instead of returning incomplete data. Nothing was saved.";
  if (/reach the backend|failed to fetch|network/i.test(msg))
    return "The browser couldn't reach the API. Make sure the backend server is running, then try again.";
  if (/not found|404/i.test(msg))
    return "The server no longer has this dataset (its session store is in memory and resets on restart). Re-upload the file.";
  return "Nothing was saved. Review the step options — e.g. with type coercion off, numbers stored as text can make imputation or scaling fail — then run again.";
}

function noteIcon(tone: Tone): IconName {
  if (tone === "warning" || tone === "danger") return "alert";
  if (tone === "success") return "checkCircle";
  return "info";
}

function omitKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const next = { ...rec };
  delete next[key];
  return next;
}

/* ====================================================================== */

export default function CleanView({
  dataset,
  datasets,
  onNavigate,
  onSelectDataset,
  onAskAssistant,
  profile,
  loading,
  config,
  onConfigChange,
  onResetConfig,
  onRun,
  run,
}: CleanViewProps) {
  const rows = dataset.rows;
  const [resultName, setResultName] = useState("");
  const [showAllReasons, setShowAllReasons] = useState(false);

  // Remember the last "on" value of steps whose off-state is a strategy value.
  const lastImpute = useRef({
    numeric: config.numeric_impute_strategy !== "skip" ? config.numeric_impute_strategy : DEFAULT_PIPELINE_CONFIG.numeric_impute_strategy,
    categorical:
      config.categorical_impute_strategy !== "skip" ? config.categorical_impute_strategy : DEFAULT_PIPELINE_CONFIG.categorical_impute_strategy,
    datetime: config.datetime_impute_strategy !== "skip" ? config.datetime_impute_strategy : DEFAULT_PIPELINE_CONFIG.datetime_impute_strategy,
  });
  const lastOutlier = useRef<OutlierStrategy>(config.outlier_default_strategy !== "skip" ? config.outlier_default_strategy : "flag");
  const lastScale = useRef<ScaleMethod>(config.scale_method !== "none" ? config.scale_method : "standard");

  const update = useCallback((patch: Partial<PipelineConfigIn>) => onConfigChange({ ...config, ...patch }), [config, onConfigChange]);

  const smart = useMemo(() => (profile ? recommendConfig(profile, rows, config) : null), [profile, rows, config]);
  const presetConfigs = useMemo(
    () =>
      profile
        ? PRESETS.map((p) => ({ preset: p, config: p.id === "smart" && smart ? smart.config : p.build(profile, rows, config) }))
        : null,
    [profile, rows, config, smart]
  );
  const activePreset: PresetId | null = useMemo(
    () => presetConfigs?.find((p) => sameConfig(p.config, config))?.preset.id ?? null,
    [presetConfigs, config]
  );
  const estimate = useMemo(() => (profile ? estimatePipeline(profile, rows, config) : null), [profile, rows, config]);
  const outputInfo = useMemo(() => detectPipelineOutput(dataset, datasets), [dataset, datasets]);
  const profileByName = useMemo(() => new Map((profile ?? []).map((p) => [p.name, p])), [profile]);
  const numericCols = useMemo(() => (profile ?? []).filter((p) => p.kind === "numeric"), [profile]);

  const running = run.status === "running";
  const runningHere = running && run.sourceId === dataset.dataset_id;
  const canRun = !!profile && !running;
  const errorHere = run.status === "error" && run.sourceId === dataset.dataset_id ? run.error : null;
  const successHere = run.status === "success" && run.sourceId === dataset.dataset_id ? run.result : null;
  const otherRunName = running && !runningHere ? datasets.find((d) => d.dataset_id === run.sourceId)?.name ?? "another dataset" : null;

  const handleRun = useCallback(() => {
    if (!canRun) return;
    void onRun(resultName.trim() || null);
  }, [canRun, onRun, resultName]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleRun();
      }
    },
    [handleRun]
  );

  /* ---------------- loading / missing profile ---------------- */
  if (!profile) {
    if (loading) {
      return (
        <div className="cl-root" aria-busy="true">
          <div className="cl-layout">
            <div className="stack">
              <Card title="Start from a preset" icon="wand">
                <SkeletonBlock lines={3} />
              </Card>
              {PIPELINE_STEPS.slice(0, 4).map((s) => (
                <Card key={s}>
                  <SkeletonBlock lines={3} />
                </Card>
              ))}
            </div>
            <div className="cl-aside">
              <Card title="Expected outcome" icon="gauge">
                <SkeletonBlock lines={4} />
              </Card>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="cl-root">
        <EmptyState
          icon="alert"
          title="Column profile unavailable"
          action={
            <Button icon="refresh" onClick={() => onSelectDataset(dataset.dataset_id)}>
              Retry
            </Button>
          }
        >
          The profile drives every step's preview and the Smart preset, so the pipeline can't be configured without it.
        </EmptyState>
      </div>
    );
  }

  const est = estimate as NonNullable<typeof estimate>;
  const steps = est.steps;
  const changedReasons = smart ? smart.reasons.filter((r) => r.changed) : [];
  const visibleReasons = smart ? (showAllReasons ? smart.reasons : changedReasons) : [];

  /* ---------------- step toggles ---------------- */
  const imputeOn = [config.numeric_impute_strategy, config.categorical_impute_strategy, config.datetime_impute_strategy].some((s) => s !== "skip");
  const setImputeOn = (on: boolean) => {
    if (on) {
      update({
        numeric_impute_strategy: lastImpute.current.numeric,
        categorical_impute_strategy: lastImpute.current.categorical,
        datetime_impute_strategy: lastImpute.current.datetime,
      });
    } else {
      lastImpute.current = {
        numeric: config.numeric_impute_strategy !== "skip" ? config.numeric_impute_strategy : lastImpute.current.numeric,
        categorical: config.categorical_impute_strategy !== "skip" ? config.categorical_impute_strategy : lastImpute.current.categorical,
        datetime: config.datetime_impute_strategy !== "skip" ? config.datetime_impute_strategy : lastImpute.current.datetime,
      };
      update({ numeric_impute_strategy: "skip", categorical_impute_strategy: "skip", datetime_impute_strategy: "skip" });
    }
  };
  const outliersOn = config.outlier_default_strategy !== "skip";
  const setOutliersOn = (on: boolean) => {
    if (on) update({ outlier_default_strategy: lastOutlier.current });
    else {
      lastOutlier.current = config.outlier_default_strategy;
      update({ outlier_default_strategy: "skip" });
    }
  };
  const scaleOn = config.scale_method !== "none";
  const setScaleOn = (on: boolean) => {
    if (on) update({ scale_method: lastScale.current });
    else {
      lastScale.current = config.scale_method;
      update({ scale_method: "none" });
    }
  };

  const imputeGapCount = (kinds: string[]) => profile.filter((p) => kinds.includes(p.kind) && p.null_count > 0).length;

  const runButton = (size: "md" | "lg", className?: string) => (
    <Button
      variant="primary"
      size={size}
      icon="play"
      loading={runningHere}
      disabled={!canRun}
      onClick={handleRun}
      className={className}
      aria-keyshortcuts="Control+Enter"
    >
      {runningHere ? "Running pipeline…" : "Run pipeline"}
    </Button>
  );

  return (
    <div className="cl-root" onKeyDown={onKeyDown} tabIndex={-1}>
      <header className="cl-head">
        <div className="cl-head-text">
          <h2 className="cl-title">Clean &amp; prepare</h2>
          <p className="cl-sub muted">
            {dataset.name} · {fmtInt(rows)} rows × {fmtInt(dataset.columns)} columns
          </p>
        </div>
        <div className="cl-head-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={onResetConfig} disabled={running} title="Reset every option and per-column override to the backend defaults">
            Reset
          </Button>
          {runButton("md", "cl-head-run")}
        </div>
      </header>

      <div className="cl-callouts">
        {otherRunName && (
          <Callout tone="info" title="A pipeline is already running">
            Running on “{otherRunName}”. You can configure this dataset meanwhile; only one run at a time is allowed.
          </Callout>
        )}
        {errorHere && (
          <Callout
            tone="danger"
            title="The last run failed"
            action={
              <Button size="sm" icon="refresh" onClick={handleRun} disabled={!canRun}>
                Retry
              </Button>
            }
          >
            <span className="cl-error-msg">{errorHere}</span>
            <span className="cl-error-help">{errorGuidance(errorHere)}</span>
          </Callout>
        )}
        {successHere && (
          <Callout
            tone="success"
            title="Last run finished"
            action={
              <Button
                size="sm"
                iconRight="arrowRight"
                onClick={() => {
                  onSelectDataset(successHere.dataset_id);
                  onNavigate("results");
                }}
              >
                Open result
              </Button>
            }
          >
            Created “{successHere.name}” with {fmtInt(successHere.rows)} rows × {fmtInt(successHere.columns)} columns.
          </Callout>
        )}
        {outputInfo.isOutput && (
          <Callout
            tone="info"
            title="This looks like a pipeline output"
            action={
              outputInfo.parent ? (
                <Button size="sm" variant="secondary" onClick={() => outputInfo.parent && onSelectDataset(outputInfo.parent.dataset_id)}>
                  Use original
                </Button>
              ) : undefined
            }
          >
            {outputInfo.markers.length > 0
              ? `It already has derived columns (${outputInfo.markers.slice(0, 3).join(", ")}${outputInfo.markers.length > 3 ? "…" : ""}). `
              : "Its name and lineage suggest it was produced by a previous run. "}
            Running again re-imputes, re-encodes and re-scales values that were already processed, and recreates derived columns.
            {outputInfo.parent ? ` Usually you want the original, “${outputInfo.parent.name}”.` : ""}
          </Callout>
        )}
        {rows === 0 && (
          <Callout tone="warning" title="This dataset has no rows">
            The pipeline will run but has nothing to clean.
          </Callout>
        )}
      </div>

      <div className="cl-layout">
        <div className="cl-main">
          {/* ---------------- presets ---------------- */}
          <Card
            title="Start from a preset"
            subtitle="Presets change strategies only — your per-column overrides and column lists are kept."
            icon="wand"
          >
            <div className="cl-presets" role="group" aria-label="Configuration presets">
              {PRESETS.map((p) => {
                const active = activePreset === p.id;
                const cfg = presetConfigs?.find((c) => c.preset.id === p.id)?.config;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`cl-preset${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    disabled={running || !cfg}
                    onClick={() => cfg && onConfigChange(cfg)}
                  >
                    <span className="cl-preset-head">
                      <span className="cl-preset-icon">
                        <Icon name={PRESET_ICONS[p.id]} size={15} />
                      </span>
                      <span className="cl-preset-label">{p.label}</span>
                      {active && <Icon name="check" size={15} className="cl-preset-check" />}
                    </span>
                    <span className="cl-preset-desc">{p.description}</span>
                    {p.dropsRows && (
                      <span className="cl-preset-flag">
                        <Badge tone="danger">Can drop rows</Badge>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {activePreset === null && <p className="cl-custom faint">Current settings: custom (no preset matches exactly).</p>}

            {smart && (
              <div className="cl-smart">
                <div className="cl-smart-head">
                  <div className="cl-smart-title">
                    <Icon name="wand" size={14} />
                    <span>
                      {changedReasons.length === 0
                        ? "Your settings match the Smart recommendation"
                        : `Smart would change ${plural(changedReasons.length, "setting")}`}
                    </span>
                  </div>
                  <div className="row">
                    <Button variant="ghost" size="sm" onClick={() => setShowAllReasons((v) => !v)} aria-expanded={showAllReasons}>
                      {showAllReasons ? "Show changes only" : `All reasons (${smart.reasons.length})`}
                    </Button>
                    {changedReasons.length > 0 && (
                      <Button size="sm" icon="wand" onClick={() => onConfigChange(smart.config)} disabled={running}>
                        Apply Smart
                      </Button>
                    )}
                  </div>
                </div>
                <p className="cl-smart-note faint">
                  Rule-based, not an AI model: each choice comes from this dataset's profile (skew, outlier counts, cardinality). It never
                  enables options that drop rows.
                </p>
                {visibleReasons.length > 0 && (
                  <ul className="cl-reasons">
                    {visibleReasons.map((r) => (
                      <ReasonRow key={r.field} reason={r} current={config} />
                    ))}
                  </ul>
                )}
                {smart.notes.length > 0 && (
                  <ul className="cl-notes cl-smart-notes">
                    {smart.notes.map((n) => (
                      <NoteRow key={n} note={{ tone: "info", text: n }} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>

          {/* ---------------- running ---------------- */}
          {runningHere && <RunningCard estimate={est} />}

          {/* ---------------- steps ---------------- */}
          <fieldset className="cl-fieldset" disabled={running}>
            <legend className="sr-only">Pipeline steps</legend>
            <ol className="cl-steps">
              <StepCard index={1} step="coerce_types" on={config.coerce_types} onToggle={(v) => update({ coerce_types: v })} estimate={steps.coerce_types} />

              <StepCard
                index={2}
                step="impute_missing"
                on={imputeOn}
                onToggle={setImputeOn}
                estimate={steps.impute_missing}
                offHint={
                  Object.values(config.impute_overrides).some((s) => s !== "skip")
                    ? "Per-column impute overrides still apply."
                    : "Still listed in the audit trail, but fills nothing."
                }
                extra={
                  imputeOn && imputeGapCount(["numeric", "datetime", "categorical", "boolean", "text", "identifier"]) > 0 ? (
                    <Button variant="ghost" size="sm" icon="chat" onClick={() => onAskAssistant("Which columns have missing values and how should I handle them?")}>
                      Ask assistant
                    </Button>
                  ) : undefined
                }
              >
                <div className="cl-options">
                  <StrategySelect
                    label="Numeric columns"
                    hint={`${plural(imputeGapCount(["numeric"]), "column")} with gaps`}
                    value={config.numeric_impute_strategy}
                    options={NUMERIC_IMPUTE_OPTIONS}
                    onChange={(v) => update({ numeric_impute_strategy: v })}
                  />
                  <StrategySelect
                    label="Categorical, boolean & text"
                    hint={`${plural(imputeGapCount(["categorical", "boolean", "text", "identifier"]), "column")} with gaps`}
                    value={config.categorical_impute_strategy}
                    options={CATEGORICAL_IMPUTE_OPTIONS}
                    onChange={(v) => update({ categorical_impute_strategy: v })}
                  />
                  <StrategySelect
                    label="Date columns"
                    hint={`${plural(imputeGapCount(["datetime"]), "column")} with gaps`}
                    value={config.datetime_impute_strategy}
                    options={DATETIME_IMPUTE_OPTIONS}
                    onChange={(v) => update({ datetime_impute_strategy: v })}
                  />
                </div>
              </StepCard>

              <StepCard
                index={3}
                step="handle_duplicates"
                on={true}
                estimate={steps.handle_duplicates}
                badge={config.dedupe ? <Badge tone="danger">Can drop rows</Badge> : <Badge tone="neutral">Detect only</Badge>}
              >
                <div className="cl-options-stack">
                  <Switch
                    id="cl-dedupe"
                    checked={config.dedupe}
                    onChange={(v) => update({ dedupe: v })}
                    label="Remove duplicate rows"
                    description="Drops repeated rows, keeping the first occurrence. Off = they're only counted."
                  />
                  {config.dedupe && (
                    <div className="cl-subfield">
                      <span className="field-label" id="cl-dedupe-scope">
                        Compare rows on
                      </span>
                      <Segmented
                        ariaLabel="Duplicate comparison scope"
                        size="sm"
                        value={config.dedupe_subset === null ? "all" : "some"}
                        options={[
                          { value: "all", label: "All columns" },
                          { value: "some", label: "Selected columns" },
                        ]}
                        onChange={(v) => update({ dedupe_subset: v === "all" ? null : [] })}
                      />
                      {config.dedupe_subset !== null && (
                        <>
                          <ColumnPicker
                            label="Columns that define a duplicate"
                            columns={profile}
                            selected={config.dedupe_subset}
                            onChange={(list) => update({ dedupe_subset: list })}
                          />
                          {config.dedupe_subset.length === 0 && (
                            <p className="field-hint">No columns selected — all columns will be compared.</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </StepCard>

              <StepCard
                index={4}
                step="handle_outliers"
                on={outliersOn}
                onToggle={setOutliersOn}
                estimate={steps.handle_outliers}
                badge={steps.handle_outliers.dropsRows ? <Badge tone="danger">Can drop rows</Badge> : undefined}
                offHint={
                  Object.values(config.outlier_overrides).some((s) => s !== "skip")
                    ? "Per-column outlier overrides still apply."
                    : "Still listed in the audit trail, but changes nothing."
                }
                extra={
                  outliersOn && numericCols.length > 0 ? (
                    <Button variant="ghost" size="sm" icon="chat" onClick={() => onAskAssistant("Which columns have outliers?")}>
                      Ask assistant
                    </Button>
                  ) : undefined
                }
              >
                {outliersOn && (
                  <div className="cl-subfield">
                    <span className="field-label">Default strategy</span>
                    <Segmented<Exclude<OutlierStrategy, "skip">>
                      ariaLabel="Default outlier strategy"
                      value={config.outlier_default_strategy as Exclude<OutlierStrategy, "skip">}
                      options={[
                        { value: "flag", label: OUTLIER_LABELS.flag, title: OUTLIER_HELP.flag },
                        { value: "clip", label: OUTLIER_LABELS.clip, title: OUTLIER_HELP.clip },
                        { value: "remove", label: OUTLIER_LABELS.remove, title: OUTLIER_HELP.remove },
                      ]}
                      onChange={(v) => update({ outlier_default_strategy: v })}
                    />
                    <p className="field-hint">{OUTLIER_HELP[config.outlier_default_strategy as Exclude<OutlierStrategy, "skip">]}</p>
                    {config.outlier_default_strategy === "remove" && (
                      <Callout tone="danger" title="Removes rows">
                        Every row with an outlier in any numeric column without its own override is deleted. Prefer Flag or Clip
                        unless you're sure the extreme values are errors.
                      </Callout>
                    )}
                  </div>
                )}
              </StepCard>

              <StepCard
                index={5}
                step="encode_categoricals"
                on={config.encode}
                onToggle={(v) => update({ encode: v })}
                estimate={steps.encode_categoricals}
              >
                {config.encode && (
                  <div className="cl-options">
                    <CardinalityInput value={config.one_hot_max_cardinality} onCommit={(n) => update({ one_hot_max_cardinality: n })} />
                  </div>
                )}
              </StepCard>

              <StepCard
                index={6}
                step="engineer_features"
                on={config.engineer_features}
                onToggle={(v) => update({ engineer_features: v })}
                estimate={steps.engineer_features}
              />

              <StepCard
                index={7}
                step="scale_features"
                on={scaleOn}
                onToggle={setScaleOn}
                estimate={steps.scale_features}
                offHint="Still listed in the audit trail as skipped."
              >
                {scaleOn && (
                  <div className="cl-options-stack">
                    <div className="cl-subfield">
                      <span className="field-label">Method</span>
                      <Segmented<Exclude<ScaleMethod, "none">>
                        ariaLabel="Scaling method"
                        value={config.scale_method as Exclude<ScaleMethod, "none">}
                        options={[
                          { value: "standard", label: "Standard", title: SCALE_HELP.standard },
                          { value: "minmax", label: "Min–max", title: SCALE_HELP.minmax },
                          { value: "robust", label: "Robust", title: SCALE_HELP.robust },
                        ]}
                        onChange={(v) => update({ scale_method: v })}
                      />
                      <p className="field-hint">{SCALE_HELP[config.scale_method as Exclude<ScaleMethod, "none">]}</p>
                    </div>
                    <div className="cl-subfield">
                      <span className="field-label">Columns</span>
                      <Segmented
                        ariaLabel="Columns to scale"
                        size="sm"
                        value={config.scale_columns === null ? "all" : "some"}
                        options={[
                          { value: "all", label: "All numeric (incl. derived)" },
                          { value: "some", label: "Only selected" },
                        ]}
                        onChange={(v) =>
                          update({
                            scale_columns: v === "all" ? null : numericCols.filter((p) => !isIdLike(p)).map((p) => p.name),
                          })
                        }
                      />
                      {config.scale_columns !== null &&
                        (numericCols.length > 0 ? (
                          <ColumnPicker
                            label="Numeric columns to scale"
                            columns={numericCols}
                            selected={config.scale_columns}
                            onChange={(list) => update({ scale_columns: list })}
                          />
                        ) : (
                          <p className="field-hint">This dataset has no numeric source columns to pick.</p>
                        ))}
                    </div>
                  </div>
                )}
              </StepCard>
            </ol>
          </fieldset>
        </div>

        {/* ---------------- aside ---------------- */}
        <aside className="cl-aside" aria-label="Run summary">
          <Card title="Expected outcome" icon="gauge">
            <div className="cl-outcome-stats">
              <Stat
                label="Rows"
                value={fmtInt(rows)}
                tone={est.rowsMayDrop ? "warning" : "success"}
                hint={est.rowsMayDrop ? "may decrease" : "all preserved"}
              />
              <Stat label="Steps on" value={`${est.activeSteps}/${PIPELINE_STEPS.length}`} hint="duplicates always counted" />
              <div className="cl-outcome-wide">
                <Stat
                  label="Columns"
                  value={`${fmtInt(est.columnsIn)} → ~${fmtInt(est.columnsOut)}`}
                  hint="estimate from the uploaded data's profile"
                />
              </div>
            </div>
            {est.rowsMayDrop && (
              <ul className="cl-notes">
                {est.rowDropReasons.map((r) => (
                  <NoteRow key={r} note={{ tone: "danger", text: `${r} — rows can be dropped.` }} />
                ))}
              </ul>
            )}
            <p className="cl-guarantee faint">
              <Icon name="checkCircle" size={13} />
              <span>{DATA_LOSS_SENTENCE}</span>
            </p>
          </Card>

          <Card title="Run" icon="play">
            <div className="stack cl-run">
              <Field label="Result name" htmlFor="cl-result-name" hint="Optional. Leave blank for the default.">
                <input
                  id="cl-result-name"
                  className="input"
                  value={resultName}
                  maxLength={200}
                  placeholder={`${dataset.name} (cleaned)`}
                  onChange={(e) => setResultName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      handleRun();
                    }
                  }}
                  disabled={running}
                />
              </Field>
              {runButton("lg", "cl-run-btn")}
              <p className="cl-run-hint faint">
                {running ? (
                  runningHere ? (
                    "Running every step in one request…"
                  ) : (
                    "Waiting for the other run to finish."
                  )
                ) : (
                  <>
                    <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd> runs from anywhere in this view. The source dataset is never modified — the result is saved as a new
                    dataset.
                  </>
                )}
              </p>
            </div>
          </Card>

          <OverridesCard config={config} profileByName={profileByName} onConfigChange={onConfigChange} onNavigate={onNavigate} disabled={running} />
        </aside>
      </div>
    </div>
  );
}

/* ====================================================================== */
/* Pieces                                                                  */
/* ====================================================================== */

function ReasonRow({ reason, current }: { reason: ConfigReason; current: PipelineConfigIn }) {
  const label = FIELD_LABELS[reason.field] ?? reason.field;
  const field = reason.field as keyof PipelineConfigIn;
  const raw = current[field];
  const fmt = (v: string) => (field.endsWith("impute_strategy") ? imputeLabel(v) : v);
  const currentText =
    typeof raw === "boolean"
      ? field === "dedupe"
        ? raw
          ? "remove"
          : "detect only"
        : raw
          ? "on"
          : "off"
      : typeof raw === "number"
        ? `≤ ${raw}`
        : typeof raw === "string"
          ? fmt(raw)
          : "";
  return (
    <li className={`cl-reason${reason.changed ? " is-changed" : ""}`}>
      <div className="cl-reason-head">
        <span className="cl-reason-field">{label}</span>
        {reason.changed && currentText && (
          <>
            <span className="cl-reason-from">{currentText}</span>
            <Icon name="arrowRight" size={12} className="faint" />
          </>
        )}
        <Badge tone={reason.changed ? "accent" : "neutral"}>{fmt(reason.value)}</Badge>
      </div>
      <p className="cl-reason-text">{reason.reason}</p>
    </li>
  );
}

function NoteRow({ note }: { note: StepNote }) {
  return (
    <li className={`cl-note cl-tone-${note.tone}`}>
      <Icon name={noteIcon(note.tone)} size={13} className="cl-note-icon" />
      <span>{note.text}</span>
    </li>
  );
}

function StepCard({
  index,
  step,
  on,
  onToggle,
  estimate,
  badge,
  offHint,
  extra,
  children,
}: {
  index: number;
  step: PipelineStepName;
  on: boolean;
  onToggle?: (on: boolean) => void;
  estimate: StepEstimate;
  badge?: ReactNode;
  offHint?: string;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const meta = STEP_META[step];
  const title = stepLabel(step);
  const headingId = `cl-step-${step}`;
  return (
    <li className={`cl-step${on ? " is-on" : " is-off"}`}>
      <div className="cl-step-rail" aria-hidden="true">
        <span className="cl-step-node">{index}</span>
      </div>
      <section className="card cl-step-card" aria-labelledby={headingId}>
        <header className="cl-step-head">
          <span className="cl-step-icon">
            <Icon name={meta.icon} size={16} />
          </span>
          <div className="cl-step-titles">
            <h3 className="cl-step-title" id={headingId}>
              <span className="cl-step-num faint">{index}.</span> {title}
            </h3>
            <div className="cl-step-badges">
              {badge}
              {!on && onToggle && <Badge tone="neutral">Off</Badge>}
            </div>
          </div>
          <div className="cl-step-actions">
            {extra}
            {onToggle && (
              <div className="cl-step-switch">
                <Switch
                  id={`cl-sw-${step}`}
                  checked={on}
                  onChange={onToggle}
                  label={
                    <>
                      <span className="sr-only">{title}</span>
                      <span className="cl-switch-state" aria-hidden="true">
                        {on ? "On" : "Off"}
                      </span>
                    </>
                  }
                />
              </div>
            )}
          </div>
        </header>
        <p className="cl-step-desc muted">{meta.description}</p>
        {on && children}
        <AffectBox estimate={estimate} offHint={!on ? offHint : undefined} />
      </section>
    </li>
  );
}

function AffectBox({ estimate, offHint }: { estimate: StepEstimate; offHint?: string }) {
  return (
    <div className="cl-affect">
      <div className="cl-affect-head">
        <Icon name="target" size={12} />
        <span>Will affect</span>
        {estimate.estimate && (
          <span className="cl-estimate" title="Computed from the uploaded data; earlier steps can change the real numbers">
            estimate
          </span>
        )}
      </div>
      <p className="cl-affect-summary">{estimate.summary}</p>
      {estimate.items.length > 0 && <ChipList items={estimate.items} />}
      {(estimate.notes.length > 0 || offHint) && (
        <ul className="cl-notes">
          {offHint && <NoteRow note={{ tone: "neutral", text: offHint }} />}
          {estimate.notes.map((n) => (
            <NoteRow key={n.text} note={n} />
          ))}
        </ul>
      )}
    </div>
  );
}

const CHIP_LIMIT = 10;

function ChipList({ items }: { items: AffectItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, CHIP_LIMIT);
  return (
    <ul className="cl-chips">
      {shown.map((it, i) => (
        <li key={`${it.label}-${i}`} className={`cl-chip cl-tone-${it.tone ?? "neutral"}`} title={it.detail ? `${it.label}: ${it.detail}` : it.label}>
          <span className="cl-chip-name">{it.label}</span>
          {it.detail && <span className="cl-chip-detail">{it.detail}</span>}
        </li>
      ))}
      {items.length > CHIP_LIMIT && (
        <li>
          <button type="button" className="cl-chip cl-chip-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? "Show less" : `+${items.length - CHIP_LIMIT} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

function StrategySelect({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  const all = options.includes(value) ? options : [...options, value];
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {all.map((o) => (
          <option key={o} value={o}>
            {imputeLabel(o)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function CardinalityInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [prev, setPrev] = useState(value);
  // Sync when the value changes from outside (preset, reset) without clobbering an in-progress edit.
  if (value !== prev) {
    setPrev(value);
    if (Number(draft) !== value) setDraft(String(value));
  }
  const n = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(n) && n >= ONE_HOT_MIN && n <= ONE_HOT_MAX;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        One-hot max distinct values
      </label>
      <input
        id={id}
        className="input"
        type="number"
        inputMode="numeric"
        min={ONE_HOT_MIN}
        max={ONE_HOT_MAX}
        step={1}
        value={draft}
        aria-invalid={!valid}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isInteger(v) && v >= ONE_HOT_MIN && v <= ONE_HOT_MAX && v !== value) onCommit(v);
        }}
        onBlur={() => {
          if (!valid) setDraft(String(value));
        }}
      />
      {valid ? (
        <div className="field-hint" id={`${id}-hint`}>
          ≤ {value} distinct values → one-hot columns; more → integer label codes.
        </div>
      ) : (
        <div className="field-error" id={`${id}-hint`} role="alert">
          Enter a whole number from {ONE_HOT_MIN} to {ONE_HOT_MAX}. Using {value} until then.
        </div>
      )}
    </div>
  );
}

const PICKER_FILTER_AT = 24;

function ColumnPicker({
  label,
  columns,
  selected,
  onChange,
}: {
  label: string;
  columns: ColumnProfile[];
  selected: string[];
  onChange: (list: string[]) => void;
}) {
  const filterId = useId();
  const [query, setQuery] = useState("");
  const set = useMemo(() => new Set(selected), [selected]);
  const offered = useMemo(() => new Set(columns.map((c) => c.name)), [columns]);
  // Selected names this picker doesn't offer (stale from another dataset, or the wrong kind) — shown so they can be removed.
  const foreign = useMemo(() => selected.filter((n) => !offered.has(n)), [selected, offered]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? columns.filter((c) => c.name.toLowerCase().includes(q)) : columns), [columns, q]);
  const toggle = (name: string) => {
    // Keep dataset column order for a stable, readable config.
    const next = set.has(name) ? selected.filter((c) => c !== name) : columns.map((c) => c.name).filter((c) => c === name || set.has(c));
    onChange(next);
  };
  return (
    <div className="cl-picker">
      <div className="cl-picker-head">
        <span className="field-hint">
          {label} · {fmtInt(selected.length - foreign.length)}/{fmtInt(columns.length)}
        </span>
        <span className="row">
          <button type="button" className="cl-link" onClick={() => onChange(columns.map((c) => c.name))}>
            All
          </button>
          <button type="button" className="cl-link" onClick={() => onChange([])}>
            None
          </button>
        </span>
      </div>
      {columns.length > PICKER_FILTER_AT && (
        <input
          id={filterId}
          className="input input-sm cl-picker-filter"
          type="search"
          placeholder={`Filter ${fmtInt(columns.length)} columns…`}
          aria-label={`Filter: ${label}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="cl-picker-list" role="group" aria-label={label}>
        {foreign.map((n) => (
          <button
            key={`foreign:${n}`}
            type="button"
            className="cl-pick cl-pick-foreign is-on"
            aria-pressed={true}
            onClick={() => onChange(selected.filter((c) => c !== n))}
            title={`${n}: not one of the columns offered here. Click to remove it from the list.`}
          >
            <Icon name="alert" size={12} />
            <span className="cl-pick-name">{n}</span>
          </button>
        ))}
        {visible.length === 0 && <span className="field-hint">No columns match “{query}”.</span>}
        {visible.map((c) => {
          const on = set.has(c.name);
          return (
            <button
              key={c.name}
              type="button"
              className={`cl-pick cl-kind-${c.kind}${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => toggle(c.name)}
              title={`${c.name} (${c.kind})`}
            >
              <Icon name={on ? "check" : "plus"} size={12} />
              <span className="cl-pick-name">{c.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ElapsedTimer() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="cl-elapsed">{Math.floor((now - start) / 1000)}s</span>;
}

function RunningCard({ estimate }: { estimate: ReturnType<typeof estimatePipeline> }) {
  return (
    <section className="card cl-running" aria-live="polite">
      <div className="cl-running-head">
        <Spinner size={16} />
        <strong>Running the pipeline</strong>
        <ElapsedTimer />
      </div>
      <div className="cl-bar" role="progressbar" aria-label="Pipeline running" aria-valuetext="In progress" />
      <p className="faint cl-running-note">
        All steps run on the server in a single request, so there's no per-step progress — the full audit trail appears when it finishes.
      </p>
      <ol className="cl-running-steps">
        {PIPELINE_STEPS.map((s) => {
          const e = estimate.steps[s];
          const state = !e.runs ? "skipped" : e.active ? "on" : "off (no-op)";
          return (
            <li key={s} className={`cl-running-step${e.active ? "" : " is-dim"}`}>
              <span>{stepLabel(s)}</span>
              <span className="faint">{state}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type OverrideType = "impute" | "outlier" | "encoding";

interface OverrideRow {
  type: OverrideType;
  column: string;
  value: string;
  issue: { tone: Tone; text: string } | null;
}

function OverridesCard({
  config,
  profileByName,
  onConfigChange,
  onNavigate,
  disabled,
}: {
  config: PipelineConfigIn;
  profileByName: Map<string, ColumnProfile>;
  onConfigChange: (c: PipelineConfigIn) => void;
  onNavigate: CleanViewProps["onNavigate"];
  disabled: boolean;
}) {
  const rows = useMemo<OverrideRow[]>(() => {
    const out: OverrideRow[] = [];
    const missing = { tone: "neutral" as Tone, text: "not in this dataset — ignored" };
    for (const [column, v] of Object.entries(config.impute_overrides)) {
      const p = profileByName.get(column);
      let issue: OverrideRow["issue"] = p ? null : missing;
      if (p && p.kind === "empty") issue = { tone: "neutral", text: "column is empty; the backend skips it" };
      else if (
        p &&
        p.null_count === 0 &&
        // Type coercion turns unparseable values into new gaps, so only claim "no effect" when none can appear.
        !(p.kind === "numeric" && p.numeric_convertible_ratio < 1) &&
        !(p.kind === "datetime" && p.datetime_convertible_ratio < 1)
      )
        issue = { tone: "neutral", text: "no missing values; no effect" };
      else if (p && (v === "mean" || v === "median") && p.kind !== "numeric") issue = { tone: "warning", text: `${v} doesn't apply to ${p.kind}; left missing` };
      else if (p && v.startsWith("constant:") && p.kind === "numeric")
        issue = { tone: "danger", text: "fills with text in a numeric column; the outlier step then fails unless it's skipped for this column" };
      out.push({ type: "impute", column, value: imputeLabel(v), issue });
    }
    for (const [column, v] of Object.entries(config.outlier_overrides)) {
      const p = profileByName.get(column);
      let issue: OverrideRow["issue"] = p ? null : missing;
      if (p && p.kind !== "numeric") issue = { tone: "neutral", text: "ignored: column isn't numeric" };
      else if (p && v === "remove") issue = { tone: "danger", text: "can drop rows" };
      out.push({ type: "outlier", column, value: OUTLIER_LABELS[v] ?? v, issue });
    }
    for (const [column, v] of Object.entries(config.encoding_overrides)) {
      const p = profileByName.get(column);
      let issue: OverrideRow["issue"] = p ? null : missing;
      if (p && p.kind !== "categorical") issue = { tone: "neutral", text: `ignored: column is ${p.kind}` };
      out.push({ type: "encoding", column, value: v === "onehot" ? "One-hot" : v === "label" ? "Label codes" : "Skip", issue });
    }
    return out;
  }, [config.impute_overrides, config.outlier_overrides, config.encoding_overrides, profileByName]);

  const remove = (r: OverrideRow) => {
    if (r.type === "impute") onConfigChange({ ...config, impute_overrides: omitKey(config.impute_overrides, r.column) });
    else if (r.type === "outlier") onConfigChange({ ...config, outlier_overrides: omitKey(config.outlier_overrides, r.column) });
    else onConfigChange({ ...config, encoding_overrides: omitKey(config.encoding_overrides, r.column) });
  };
  const clearAll = () => onConfigChange({ ...config, impute_overrides: {}, outlier_overrides: {}, encoding_overrides: {} });
  const typeLabel: Record<OverrideType, string> = { impute: "Missing", outlier: "Outliers", encoding: "Encoding" };

  return (
    <Card
      title="Per-column overrides"
      icon="columns"
      subtitle={rows.length ? `${plural(rows.length, "override")} take priority over step defaults` : undefined}
      actions={
        rows.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={disabled}>
            Clear all
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <p className="muted cl-ov-empty">None. Every column uses its step's default strategy.</p>
      ) : (
        <ul className="cl-ov-list">
          {rows.map((r) => (
            <li key={`${r.type}:${r.column}`} className="cl-ov">
              <div className="cl-ov-main">
                <span className="cl-ov-col" title={r.column}>
                  {r.column}
                </span>
                <span className="cl-ov-meta">
                  <span className="faint">{typeLabel[r.type]}</span>
                  <Badge tone={r.issue?.tone === "danger" ? "danger" : r.issue ? "neutral" : "accent"}>{r.value}</Badge>
                </span>
                {r.issue && <span className={`cl-ov-issue cl-tone-${r.issue.tone}`}>{r.issue.text}</span>}
              </div>
              <IconButton icon="x" size={28} label={`Remove ${typeLabel[r.type].toLowerCase()} override for ${r.column}`} onClick={() => remove(r)} disabled={disabled} />
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" iconRight="arrowRight" onClick={() => onNavigate("columns")} className="cl-ov-link">
        {rows.length ? "Edit in Columns" : "Set overrides in Columns"}
      </Button>
    </Card>
  );
}
