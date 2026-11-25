/**
 * Props contracts between App.tsx and each workspace view. App.tsx owns all
 * state (see hooks/useWorkspace.ts) and passes it down; views never call the
 * mutation endpoints directly, they call these callbacks.
 *
 * Views MAY call read-only api/client.ts functions directly for data only
 * they need (e.g. getSuggestions, getRecommendations), but should prefer the
 * cached loaders passed in here for profile/preview/audit.
 */
import type {
  AuditTrail,
  ColumnProfile,
  DatasetSummary,
  PipelineConfigIn,
  PreviewResult,
  StepExplanation,
  TabId,
} from "../types";
import type { PreviewLoader, ProfileLoader, RunState } from "../hooks/useWorkspace";

interface BaseViewProps {
  /** Currently selected dataset (always non-null inside a view). */
  dataset: DatasetSummary;
  /** Every dataset in the session, for lineage (parent_id) lookups. */
  datasets: DatasetSummary[];
  onNavigate: (tab: TabId) => void;
  onSelectDataset: (id: string) => void;
  /** Opens the chat drawer and sends `question` about the current dataset. */
  onAskAssistant: (question: string) => void;
}

export interface OverviewViewProps extends BaseViewProps {
  /** Upload-only metadata (source_format, encoding_used, delimiter_used, sheet_used) if this dataset was uploaded this session. */
  uploadInfo: DatasetSummary | null;
  profile: ColumnProfile[] | null;
  preview: PreviewResult | null;
  loading: boolean;
  config: PipelineConfigIn;
  onConfigChange: (config: PipelineConfigIn) => void;
}

export interface ColumnsViewProps extends BaseViewProps {
  profile: ColumnProfile[] | null;
  loading: boolean;
  config: PipelineConfigIn;
  onConfigChange: (config: PipelineConfigIn) => void;
}

export interface PreviewViewProps extends BaseViewProps {
  profile: ColumnProfile[] | null;
  /** First DEFAULT_PREVIEW_LIMIT (100) rows. */
  preview: PreviewResult | null;
  loading: boolean;
  /** Cached; use to load more rows (e.g. limit 500/1000). */
  loadPreview: PreviewLoader;
}

export interface CleanViewProps extends BaseViewProps {
  profile: ColumnProfile[] | null;
  loading: boolean;
  config: PipelineConfigIn;
  onConfigChange: (config: PipelineConfigIn) => void;
  onResetConfig: () => void;
  /** Runs the pipeline on `dataset`. On success App selects the result dataset and switches to the Results tab. */
  onRun: (resultName?: string | null) => Promise<void>;
  run: RunState;
}

export interface ResultsViewProps extends BaseViewProps {
  /** Audit trail of the selected dataset; null if it wasn't produced by a pipeline run. */
  audit: AuditTrail | null;
  auditLoading: boolean;
  /** Only available right after a run in this session. */
  explanations: StepExplanation[] | null;
  loadProfile: ProfileLoader;
  loadPreview: PreviewLoader;
}

export interface ModelsViewProps extends BaseViewProps {
  profile: ColumnProfile[] | null;
  loading: boolean;
}

export interface ChatAssistantProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: string | null;
  datasetName: string | null;
  /** A question queued by onAskAssistant; send it once, then call onPendingConsumed. */
  pendingQuestion: { id: number; text: string } | null;
  onPendingConsumed: () => void;
}
