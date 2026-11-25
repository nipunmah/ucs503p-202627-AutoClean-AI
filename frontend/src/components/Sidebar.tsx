import { useMemo, useRef, useState } from "react";
import type { DatasetSummary } from "../types";
import { Icon } from "./icons";
import { Badge, Button, IconButton, Segmented, Spinner } from "./ui";
import { fmtCompact, fmtRelativeTime } from "../lib/format";

type JoinHow = "outer" | "left" | "right" | "inner";

interface Props {
  datasets: DatasetSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  checkedIds: Set<string>;
  onToggleChecked: (id: string) => void;
  onClearChecked: () => void;
  onUpload: (files: File[]) => void;
  onLoadSample: () => void;
  uploading: boolean;
  combining: boolean;
  onCombine: (opts: { ids: string[]; mode: "concat" | "merge"; on: string[] | null; how: JoinHow; name: string | null }) => void;
  /** dataset ids that have an audit trail (cleaned outputs), for the badge */
  auditedIds: Set<string>;
}

interface TreeNode {
  ds: DatasetSummary;
  depth: number;
}

/** Flatten datasets into lineage order: each parent followed by its derived children. */
function buildTree(datasets: DatasetSummary[]): TreeNode[] {
  const ids = new Set(datasets.map((d) => d.dataset_id));
  const children = new Map<string, DatasetSummary[]>();
  const roots: DatasetSummary[] = [];
  for (const d of datasets) {
    if (d.parent_id && ids.has(d.parent_id)) {
      const arr = children.get(d.parent_id) ?? [];
      arr.push(d);
      children.set(d.parent_id, arr);
    } else roots.push(d);
  }
  const out: TreeNode[] = [];
  const visit = (d: DatasetSummary, depth: number) => {
    out.push({ ds: d, depth });
    for (const c of children.get(d.dataset_id) ?? []) visit(c, Math.min(depth + 1, 4));
  };
  // newest roots first
  [...roots].reverse().forEach((r) => visit(r, 0));
  return out;
}

export default function Sidebar({
  datasets,
  selectedId,
  onSelect,
  checkedIds,
  onToggleChecked,
  onClearChecked,
  onUpload,
  onLoadSample,
  uploading,
  combining,
  onCombine,
  auditedIds,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"concat" | "merge">("concat");
  const [how, setHow] = useState<JoinHow>("outer");
  const [joinKey, setJoinKey] = useState("");

  const tree = useMemo(() => buildTree(datasets), [datasets]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? tree.filter((n) => n.ds.name.toLowerCase().includes(q)) : tree;
  }, [tree, filter]);

  const checked = useMemo(() => datasets.filter((d) => checkedIds.has(d.dataset_id)), [datasets, checkedIds]);
  /** Smart join-key candidates: columns present in every checked dataset. */
  const commonColumns = useMemo(() => {
    if (checked.length < 2) return [];
    const [first, ...rest] = checked;
    return first.column_names.filter((c) => rest.every((d) => d.column_names.includes(c)));
  }, [checked]);
  const effectiveKey = commonColumns.includes(joinKey) ? joinKey : (commonColumns.find((c) => /id$|_id|key/i.test(c)) ?? commonColumns[0] ?? "");

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onUpload(Array.from(list));
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      className={`sidebar-inner${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="sparkles" size={18} />
        </span>
        <div>
          <div className="brand-name">AutoClean AI</div>
          <div className="brand-sub">Model-ready data, fully audited</div>
        </div>
      </div>

      <button
        type="button"
        className="upload-zone"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        aria-label="Upload CSV, Excel or JSON files"
      >
        {uploading ? <Spinner size={18} /> : <Icon name="upload" size={18} />}
        <span className="upload-zone-text">
          <strong>{uploading ? "Uploading…" : "Upload data"}</strong>
          <span>CSV · TSV · Excel · JSON — or drop files here</span>
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".csv,.tsv,.txt,.xlsx,.xls,.json"
        hidden
        data-testid="file-input"
        onChange={(e) => handleFiles(e.target.files)}
      />

      <div className="sidebar-section-head">
        <span>Datasets</span>
        <Badge>{datasets.length}</Badge>
      </div>

      {datasets.length > 4 && (
        <label className="sidebar-search">
          <Icon name="search" size={14} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter datasets" aria-label="Filter datasets" />
        </label>
      )}

      <div className="dataset-list" role="listbox" aria-label="Datasets">
        {datasets.length === 0 && (
          <div className="dataset-empty">
            <p>No datasets yet.</p>
            <Button size="sm" variant="ghost" icon="flask" onClick={onLoadSample} disabled={uploading}>
              Load sample dataset
            </Button>
          </div>
        )}
        {visible.map(({ ds, depth }) => {
          const isSel = ds.dataset_id === selectedId;
          const isChecked = checkedIds.has(ds.dataset_id);
          const audited = auditedIds.has(ds.dataset_id);
          return (
            <div
              key={ds.dataset_id}
              role="option"
              aria-selected={isSel}
              tabIndex={0}
              className={`dataset-item${isSel ? " selected" : ""}${isChecked ? " checked" : ""}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => onSelect(ds.dataset_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(ds.dataset_id);
                }
              }}
              title={ds.name}
            >
              {depth > 0 && <span className="lineage-hook" aria-hidden="true" />}
              <input
                type="checkbox"
                className="dataset-check"
                checked={isChecked}
                aria-label={`Select ${ds.name} for combining`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={() => onToggleChecked(ds.dataset_id)}
              />
              <span className="dataset-main">
                <span className="dataset-name">{ds.name}</span>
                <span className="dataset-meta">
                  {fmtCompact(ds.rows)} × {ds.columns} · {fmtRelativeTime(ds.created_at)}
                </span>
              </span>
              {audited ? (
                <Badge tone="success" title="Produced by the cleaning pipeline">
                  clean
                </Badge>
              ) : ds.parent_id ? (
                <Badge tone="info" title="Derived from another dataset">
                  derived
                </Badge>
              ) : null}
            </div>
          );
        })}
        {datasets.length > 0 && visible.length === 0 && <p className="dataset-empty">No match for “{filter}”.</p>}
      </div>

      {checked.length > 0 && (
        <div className="combine-bar" aria-label="Combine selected datasets">
          <div className="combine-head">
            <span>
              <Icon name="merge" size={14} /> {checked.length} selected
            </span>
            <IconButton icon="x" label="Clear selection" size={26} onClick={onClearChecked} />
          </div>
          {checked.length < 2 ? (
            <p className="combine-hint">Tick one more dataset to combine.</p>
          ) : (
            <>
              <Segmented
                ariaLabel="Combine mode"
                size="sm"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "concat", label: "Stack rows", title: "Append rows; columns are aligned by name" },
                  { value: "merge", label: "Join on key", title: "SQL-style join on a shared column" },
                ]}
              />
              {mode === "merge" &&
                (commonColumns.length === 0 ? (
                  <p className="combine-hint warn">These datasets share no column names, so they can't be joined.</p>
                ) : (
                  <div className="combine-row">
                    <select className="input input-sm" value={effectiveKey} onChange={(e) => setJoinKey(e.target.value)} aria-label="Join key">
                      {commonColumns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <select className="input input-sm" value={how} onChange={(e) => setHow(e.target.value as JoinHow)} aria-label="Join type">
                      <option value="outer">outer</option>
                      <option value="inner">inner</option>
                      <option value="left">left</option>
                      <option value="right">right</option>
                    </select>
                  </div>
                ))}
              <Button
                variant="primary"
                size="sm"
                icon="merge"
                loading={combining}
                disabled={mode === "merge" && !effectiveKey}
                onClick={() =>
                  onCombine({
                    ids: checked.map((d) => d.dataset_id),
                    mode,
                    on: mode === "merge" ? [effectiveKey] : null,
                    how,
                    name: null,
                  })
                }
              >
                Combine {checked.length} datasets
              </Button>
            </>
          )}
        </div>
      )}

      {dragOver && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="upload" size={28} />
          Drop to upload
        </div>
      )}
    </div>
  );
}
