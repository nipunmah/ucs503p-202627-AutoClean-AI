/**
 * All app-level state and backend calls, owned by App.tsx (no state library).
 *
 * Efficiency notes:
 * - Datasets are immutable on the backend (every transform produces a new
 *   dataset_id), so profile/preview/audit responses are cached per id forever
 *   for the life of the page. Switching between datasets is instant after the
 *   first load.
 * - Selection uses a request token so a slow response for a previously
 *   selected dataset can never overwrite the current one (race-safe).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  combineDatasets,
  errorMessage,
  generateSynthetic,
  getAuditTrail,
  getPreview,
  getProfile,
  listDatasets,
  runPipeline as apiRunPipeline,
  uploadDatasets,
} from "../api/client";
import type {
  AuditTrail,
  ColumnProfile,
  DatasetSummary,
  DerivedDatasetResult,
  PipelineConfigIn,
  PreviewResult,
  RunPipelineResult,
} from "../types";
import { DEFAULT_PIPELINE_CONFIG } from "../types";
import type { Tone } from "../components/ui";

export interface Toast {
  id: number;
  tone: Tone;
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
  /** ms before auto-dismiss; 0 = sticky */
  duration: number;
}

export interface RunState {
  status: "idle" | "running" | "success" | "error";
  /** dataset the pipeline was run on */
  sourceId: string | null;
  result: RunPipelineResult | null;
  error: string | null;
}

export type BackendStatus = "checking" | "online" | "offline";

export type ProfileLoader = (id: string) => Promise<ColumnProfile[]>;
export type PreviewLoader = (id: string, limit?: number) => Promise<PreviewResult>;
export type AuditLoader = (id: string) => Promise<AuditTrail | null>;

export const DEFAULT_PREVIEW_LIMIT = 100;

/** Drop per-column overrides for columns that don't exist in this dataset and clamp numeric inputs. */
export function sanitizeConfig(config: PipelineConfigIn, columnNames: string[]): PipelineConfigIn {
  const cols = new Set(columnNames);
  const pick = <V,>(rec: Record<string, V>): Record<string, V> =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => cols.has(k)));
  const card = Math.round(Number(config.one_hot_max_cardinality));
  const filterList = (list: string[] | null) => {
    if (list === null) return null;
    const kept = list.filter((c) => cols.has(c));
    return kept.length > 0 ? kept : null;
  };
  return {
    ...config,
    impute_overrides: pick(config.impute_overrides),
    outlier_overrides: pick(config.outlier_overrides),
    encoding_overrides: pick(config.encoding_overrides),
    one_hot_max_cardinality: Number.isFinite(card) ? Math.min(500, Math.max(2, card)) : 15,
    dedupe_subset: filterList(config.dedupe_subset),
    scale_columns: config.scale_columns === null ? null : config.scale_columns.filter((c) => cols.has(c)),
  };
}

/** Stable per-mount Map (useState initializer runs once). */
function useCache<T>() {
  return useState(() => new Map<string, Promise<T>>())[0];
}

/** Memoize a promise per key; failures are evicted so they can be retried. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = load().catch((e: unknown) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, p);
  return p;
}

export function useWorkspace() {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("checking");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState<ColumnProfile[] | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<PipelineConfigIn>(DEFAULT_PIPELINE_CONFIG);
  const [run, setRun] = useState<RunState>({ status: "idle", sourceId: null, result: null, error: null });
  const [busy, setBusy] = useState<null | "upload" | "combine" | "synthetic">(null);
  /** Extra metadata only the upload response carries (encoding, delimiter, format...). */
  const [uploadInfo, setUploadInfo] = useState<Record<string, DatasetSummary>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);

  const profileCache = useCache<ColumnProfile[]>();
  const previewCache = useCache<PreviewResult>();
  const auditCache = useCache<AuditTrail | null>();
  const selectToken = useRef(0);
  const toastId = useRef(0);

  /* ---------------- toasts ---------------- */
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const notify = useCallback((t: Omit<Toast, "id" | "duration"> & { duration?: number }) => {
    const id = ++toastId.current;
    const duration = t.duration ?? (t.tone === "danger" ? 8000 : 4500);
    setToasts((prev) => [...prev.slice(-4), { ...t, id, duration }]);
    return id;
  }, []);

  const notifyError = useCallback(
    (title: string, e: unknown) => notify({ tone: "danger", title, message: errorMessage(e) }),
    [notify]
  );

  /* ---------------- cached loaders ---------------- */
  const loadProfile: ProfileLoader = useCallback(
    (id) => cached(profileCache, id, () => getProfile(id)),
    [profileCache]
  );
  const loadPreview: PreviewLoader = useCallback(
    (id, limit = DEFAULT_PREVIEW_LIMIT) => cached(previewCache, `${id}:${limit}`, () => getPreview(id, limit)),
    [previewCache]
  );
  const loadAudit: AuditLoader = useCallback(
    (id) => cached(auditCache, id, () => getAuditTrail(id)),
    [auditCache]
  );

  /* ---------------- datasets ---------------- */
  const refreshDatasets = useCallback(async () => {
    try {
      const list = await listDatasets();
      setDatasets(list);
      setBackendStatus("online");
      return list;
    } catch (e) {
      setBackendStatus("offline");
      throw e;
    }
  }, []);

  useEffect(() => {
    refreshDatasets().catch(() => {
      /* surfaced via backendStatus banner */
    });
  }, [refreshDatasets]);

  const select = useCallback(
    async (id: string | null) => {
      const token = ++selectToken.current;
      setSelectedId(id);
      setDatasetError(null);
      if (id === null) {
        setProfile(null);
        setPreview(null);
        setDatasetLoading(false);
        return;
      }
      setDatasetLoading(true);
      setProfile(null);
      setPreview(null);
      try {
        const [p, pv] = await Promise.all([loadProfile(id), loadPreview(id)]);
        if (token !== selectToken.current) return; // a newer selection won
        setProfile(p);
        setPreview(pv);
      } catch (e) {
        if (token !== selectToken.current) return;
        setDatasetError(errorMessage(e));
      } finally {
        if (token === selectToken.current) setDatasetLoading(false);
      }
    },
    [loadProfile, loadPreview]
  );

  const selected = useMemo(() => datasets.find((d) => d.dataset_id === selectedId) ?? null, [datasets, selectedId]);

  /* ---------------- multi-select ---------------- */
  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearChecked = useCallback(() => setCheckedIds(new Set()), []);

  /* ---------------- actions ---------------- */
  const upload = useCallback(
    async (files: File[]): Promise<DatasetSummary[]> => {
      if (files.length === 0) return [];
      setBusy("upload");
      try {
        const uploaded = await uploadDatasets(files);
        setUploadInfo((prev) => ({ ...prev, ...Object.fromEntries(uploaded.map((u) => [u.dataset_id, u])) }));
        await refreshDatasets();
        for (const u of uploaded) {
          if (u.warnings.length > 0)
            notify({ tone: "warning", title: `${u.name}: ${u.warnings.length} ingestion warning(s)`, message: u.warnings.join(" ") });
        }
        notify({
          tone: "success",
          title: uploaded.length === 1 ? `Uploaded ${uploaded[0].name}` : `Uploaded ${uploaded.length} files`,
          message: uploaded.map((u) => `${u.name}: ${u.rows.toLocaleString()} rows × ${u.columns} cols`).join(" · "),
        });
        if (uploaded.length > 0) void select(uploaded[0].dataset_id);
        return uploaded;
      } catch (e) {
        notifyError("Upload failed", e);
        return [];
      } finally {
        setBusy(null);
      }
    },
    [notify, notifyError, refreshDatasets, select]
  );

  const runPipeline = useCallback(
    async (resultName?: string | null): Promise<RunPipelineResult | null> => {
      if (!selectedId) return null;
      const sourceId = selectedId;
      setRun({ status: "running", sourceId, result: null, error: null });
      try {
        const cols = profile?.map((p) => p.name) ?? selected?.column_names ?? [];
        const result = await apiRunPipeline(sourceId, sanitizeConfig(config, cols), resultName);
        // Seed the audit cache so the Results view doesn't refetch.
        auditCache.set(result.dataset_id, Promise.resolve(result.audit_trail));
        setRun({ status: "success", sourceId, result, error: null });
        await refreshDatasets().catch(() => undefined);
        const warnCount = result.audit_trail.steps.reduce((n, s) => n + s.warnings.length, 0);
        notify({
          tone: warnCount > 0 ? "warning" : "success",
          title: "Pipeline finished",
          message: `${result.rows.toLocaleString()} rows × ${result.columns} cols${warnCount ? ` · ${warnCount} warning(s)` : ""}`,
        });
        return result;
      } catch (e) {
        const msg = errorMessage(e);
        setRun({ status: "error", sourceId, result: null, error: msg });
        notifyError("Pipeline failed", e);
        return null;
      }
    },
    [selectedId, profile, selected, config, auditCache, refreshDatasets, notify, notifyError]
  );

  const reportWarnings = useCallback(
    (res: DerivedDatasetResult) => {
      if (res.report.warnings.length > 0)
        notify({ tone: "warning", title: `${res.report.warnings.length} warning(s)`, message: res.report.warnings.join(" ") });
    },
    [notify]
  );

  const combine = useCallback(
    async (opts: {
      ids: string[];
      mode: "concat" | "merge";
      on: string[] | null;
      how: "outer" | "left" | "right" | "inner";
      name?: string | null;
    }): Promise<DerivedDatasetResult | null> => {
      setBusy("combine");
      try {
        const res = await combineDatasets(opts.ids, opts.mode, opts.on, opts.how, opts.name);
        await refreshDatasets();
        reportWarnings(res);
        notify({ tone: "success", title: `Created ${res.name}`, message: `${res.rows.toLocaleString()} rows × ${res.columns} cols` });
        setCheckedIds(new Set());
        void select(res.dataset_id);
        return res;
      } catch (e) {
        notifyError("Combine failed", e);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refreshDatasets, reportWarnings, notify, notifyError, select]
  );

  const synthetic = useCallback(
    async (opts: { nRows: number; seed: number | null; augment: boolean }): Promise<DerivedDatasetResult | null> => {
      if (!selectedId) return null;
      setBusy("synthetic");
      try {
        const n = Math.max(1, Math.min(100_000, Math.round(opts.nRows) || 1));
        const res = await generateSynthetic(selectedId, n, opts.seed, opts.augment);
        await refreshDatasets();
        reportWarnings(res);
        notify({ tone: "success", title: `Created ${res.name}`, message: `${res.rows.toLocaleString()} rows × ${res.columns} cols` });
        void select(res.dataset_id);
        return res;
      } catch (e) {
        notifyError("Synthetic generation failed", e);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [selectedId, refreshDatasets, reportWarnings, notify, notifyError, select]
  );

  const resetConfig = useCallback(() => setConfig(DEFAULT_PIPELINE_CONFIG), []);

  return {
    // data
    datasets,
    backendStatus,
    refreshDatasets,
    selectedId,
    selected,
    select,
    profile,
    preview,
    datasetLoading,
    datasetError,
    uploadInfo,
    // loaders (cached)
    loadProfile,
    loadPreview,
    loadAudit,
    // multi-select
    checkedIds,
    toggleChecked,
    clearChecked,
    // config + run
    config,
    setConfig,
    resetConfig,
    run,
    runPipeline,
    // tools
    busy,
    upload,
    combine,
    synthetic,
    // toasts
    toasts,
    notify,
    dismissToast,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
