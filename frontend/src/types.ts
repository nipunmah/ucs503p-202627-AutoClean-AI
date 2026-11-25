export type ColumnKind = "numeric" | "boolean" | "datetime" | "categorical" | "text" | "identifier" | "empty";

export interface DatasetSummary {
  dataset_id: string;
  name: string;
  rows: number;
  columns: number;
  column_names: string[];
  parent_id: string | null;
  created_at: string;
  warnings: string[];
  // Only present on the /upload response, not on /api/datasets listings.
  source_format?: string;
  encoding_used?: string | null;
  delimiter_used?: string | null;
  sheet_used?: string | null;
}

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  non_null_count: number;
  null_count: number;
  null_ratio: number;
  unique_count: number;
  numeric_convertible_ratio: number;
  datetime_convertible_ratio: number;
  sample_values: string[];
  outlier_count: number;
  /** Positional row indices (backend resets the index after any row removal). Capped at 100. */
  outlier_indices: number[];
  /** numeric: min/max/mean/median/std; may be empty for other kinds. */
  stats: Record<string, number>;
}

export interface StepReport {
  step_name: string;
  description: string;
  rows_before: number;
  rows_after: number;
  rows_changed: number;
  columns_before: number;
  columns_after: number;
  columns_changed: number;
  nulls_before: number;
  nulls_after: number;
  /** Step-specific; see backend/app/core/pipeline/*.py for each step's shape. */
  details: Record<string, unknown>;
  warnings: string[];
  duration_ms: number;
}

export interface AuditTrail {
  original: { rows: number; columns: number; nulls: number };
  steps: StepReport[];
  step_count: number;
}

export interface StepExplanation {
  step_name: string;
  explanation: string;
}

export interface RunPipelineResult {
  dataset_id: string;
  name: string;
  rows: number;
  columns: number;
  audit_trail: AuditTrail;
  step_explanations: StepExplanation[];
}

/** Result of /combine and /synthetic — a single hand-built StepReport. */
export interface DerivedDatasetResult {
  dataset_id: string;
  name: string;
  rows: number;
  columns: number;
  report: StepReport;
}

export type ImputeStrategy = "median" | "mean" | "mode" | "ffill_bfill" | "skip";
export type OutlierStrategy = "flag" | "clip" | "remove" | "skip";
export type EncodingStrategy = "onehot" | "label" | "skip";
export type ScaleMethod = "standard" | "minmax" | "robust" | "none";

export interface PipelineConfigIn {
  coerce_types: boolean;
  numeric_impute_strategy: string;
  categorical_impute_strategy: string;
  datetime_impute_strategy: string;
  impute_overrides: Record<string, string>;
  dedupe: boolean;
  dedupe_subset: string[] | null;
  outlier_default_strategy: OutlierStrategy;
  outlier_overrides: Record<string, OutlierStrategy>;
  encode: boolean;
  one_hot_max_cardinality: number;
  encoding_overrides: Record<string, EncodingStrategy>;
  engineer_features: boolean;
  scale_method: ScaleMethod;
  scale_columns: string[] | null;
}

// Must stay in sync with backend orchestrator.PipelineConfig defaults.
export const DEFAULT_PIPELINE_CONFIG: PipelineConfigIn = {
  coerce_types: true,
  numeric_impute_strategy: "median",
  categorical_impute_strategy: "mode",
  datetime_impute_strategy: "ffill_bfill",
  impute_overrides: {},
  dedupe: false,
  dedupe_subset: null,
  outlier_default_strategy: "flag",
  outlier_overrides: {},
  encode: true,
  one_hot_max_cardinality: 15,
  encoding_overrides: {},
  engineer_features: true,
  scale_method: "standard",
  scale_columns: null,
};

export interface PreviewResult {
  columns: string[];
  rows: Record<string, unknown>[];
  total_rows: number;
  returned_rows: number;
}

export interface ColumnSuggestion {
  column: string;
  suggested_role: string;
  confidence: number;
  reason: string;
}

export interface AlgorithmRecommendation {
  algorithm: string;
  score: number;
  reasons: string[];
  caveats: string[];
}

export type ProblemType = "binary_classification" | "multiclass_classification" | "regression" | "clustering";

export interface RecommendationResult {
  problem_type: ProblemType;
  target_column: string | null;
  target_auto_detected: boolean;
  dataset_characteristics: Record<string, unknown>;
  recommendations: AlgorithmRecommendation[];
  preprocessing_notes: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  recommendations?: AlgorithmRecommendation[];
  intent?: string;
  error?: boolean;
}

export interface ChatReply {
  reply: string;
  intent: string;
  recommendations: AlgorithmRecommendation[] | null;
}

export type TabId = "overview" | "columns" | "preview" | "clean" | "results" | "models";
