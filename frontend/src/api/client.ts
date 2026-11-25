import type {
  AuditTrail,
  ChatReply,
  ColumnProfile,
  ColumnSuggestion,
  DatasetSummary,
  DerivedDatasetResult,
  PipelineConfigIn,
  PreviewResult,
  RecommendationResult,
  RunPipelineResult,
} from "../types";

// Must match the backend dev server; CORS in backend/app/main.py allows :5173.
export const API_BASE = "http://127.0.0.1:8000";

/** Error carrying the HTTP status and the backend's human-readable `detail`. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Turn any thrown value into a message fit for a toast/banner. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof DOMException && e.name === "AbortError") return "Request cancelled.";
  if (e instanceof TypeError) return "Can't reach the backend at " + API_BASE + ". Is the server running?";
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function extractDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const d = parsed.detail;
    if (typeof d === "string") return d.replace(/^"(.*)"$/s, "$1");
    // FastAPI validation errors: [{loc, msg, ...}]
    if (Array.isArray(d)) {
      return d
        .map((item) => {
          const it = item as { loc?: unknown[]; msg?: string };
          const loc = Array.isArray(it.loc) ? it.loc.filter((x) => x !== "body").join(".") : "";
          return loc ? `${loc}: ${it.msg ?? "invalid"}` : it.msg ?? "invalid";
        })
        .join("; ");
    }
  } catch {
    /* not JSON */
  }
  return null;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    const detail = extractDetail(body);
    throw new ApiError(res.status, detail ?? (body || `${res.status} ${res.statusText}`));
  }
  return res.json() as Promise<T>;
}

function postJson<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  }).then((r) => handle<T>(r));
}

export async function uploadDatasets(files: File[]): Promise<DatasetSummary[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const res = await fetch(`${API_BASE}/api/datasets/upload`, { method: "POST", body: form });
  return handle(res);
}

export async function listDatasets(signal?: AbortSignal): Promise<DatasetSummary[]> {
  return handle(await fetch(`${API_BASE}/api/datasets`, { signal }));
}

export async function getProfile(datasetId: string, signal?: AbortSignal): Promise<ColumnProfile[]> {
  return handle(await fetch(`${API_BASE}/api/datasets/${datasetId}/profile`, { signal }));
}

export async function getPreview(datasetId: string, limit = 100, signal?: AbortSignal): Promise<PreviewResult> {
  return handle(await fetch(`${API_BASE}/api/datasets/${datasetId}/preview?limit=${limit}`, { signal }));
}

/** Returns null (not an error) when the dataset wasn't produced by a pipeline run. */
export async function getAuditTrail(datasetId: string, signal?: AbortSignal): Promise<AuditTrail | null> {
  const res = await fetch(`${API_BASE}/api/datasets/${datasetId}/audit`, { signal });
  if (res.status === 404) return null;
  return handle(res);
}

export async function getSuggestions(datasetId: string, signal?: AbortSignal): Promise<ColumnSuggestion[]> {
  return handle(await fetch(`${API_BASE}/api/pipeline/${datasetId}/suggestions`, { signal }));
}

export function runPipeline(datasetId: string, config: PipelineConfigIn, resultName?: string | null): Promise<RunPipelineResult> {
  return postJson("/api/pipeline/run", { dataset_id: datasetId, config, result_name: resultName ?? null });
}

export function combineDatasets(
  datasetIds: string[],
  mode: "concat" | "merge",
  on: string[] | null,
  how: "outer" | "left" | "right" | "inner",
  resultName?: string | null
): Promise<DerivedDatasetResult> {
  return postJson("/api/pipeline/combine", { dataset_ids: datasetIds, mode, on, how, result_name: resultName ?? null });
}

export function generateSynthetic(
  datasetId: string,
  nRows: number,
  seed: number | null,
  augment: boolean
): Promise<DerivedDatasetResult> {
  return postJson("/api/pipeline/synthetic", { dataset_id: datasetId, n_rows: nRows, seed, augment });
}

export function downloadUrl(datasetId: string, format: "csv" | "json" | "xlsx"): string {
  return `${API_BASE}/api/datasets/${datasetId}/download?format=${format}`;
}

export function getRecommendations(
  datasetId: string,
  targetColumn?: string | null,
  signal?: AbortSignal
): Promise<RecommendationResult> {
  return postJson("/api/assistant/recommend", { dataset_id: datasetId, target_column: targetColumn ?? null }, signal);
}

export function sendChatMessage(datasetId: string, message: string, targetColumn?: string | null): Promise<ChatReply> {
  return postJson("/api/assistant/chat", { dataset_id: datasetId, message, target_column: targetColumn ?? null });
}
