/**
 * Preview tab: a windowed data grid.
 *
 * - Rows are virtualized (fixed row height, only the visible window plus
 *   overscan is rendered) so 1,000 rows × 50+ columns stays smooth.
 * - Cells are formatted lazily (only rendered rows call cellText).
 * - Larger row limits go through the cached loadPreview(); stale responses
 *   (limit changed / view unmounted) are ignored.
 * - Outlier highlighting uses profile[col].outlier_indices, which are
 *   POSITIONAL row indices (the backend resets the index after row removal)
 *   and are capped at 100 per column.
 */
import { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, UIEvent } from "react";
import type { PreviewViewProps } from "./contracts";
import type { ColumnKind, ColumnProfile, PreviewResult } from "../types";
import { Badge, Button, Callout, EmptyState, KindBadge, Skeleton, Spinner } from "../components/ui";
import { Icon } from "../components/icons";
import { errorMessage, isAbortError } from "../api/client";
import { DEFAULT_PREVIEW_LIMIT } from "../hooks/useWorkspace";
import { KIND_LABELS, cellText, fmtInt, fmtPct, plural } from "../lib/format";
import "./PreviewView.css";

const ROW_H = 32;
const HEADER_H = 50;
const OVERSCAN = 8;
const LIMITS = [100, 500, 1000] as const;
/** Profile caps outlier_indices at this many entries per column. */
const OUTLIER_INDEX_CAP = 100;
const CHAR_W = 7.2;

type Row = Record<string, unknown>;
type SortState = { col: string; desc: boolean } | null;

interface FetchState {
  status: "idle" | "loading" | "error";
  error: string | null;
}

function isMissing(v: unknown): boolean {
  return v === null || v === undefined;
}

/** Rough column width from header + a sample of cell contents (cheap: raw String(), no number formatting). */
function columnWidth(name: string, kind: ColumnKind | undefined, rows: Row[]): number {
  let longest = 0;
  const n = Math.min(rows.length, 150);
  for (let i = 0; i < n; i++) {
    const v = rows[i][name];
    if (isMissing(v)) continue;
    const len = typeof v === "string" ? v.length : String(v).length;
    if (len > longest) longest = len;
    if (longest >= 40) break;
  }
  const badgeW = kind ? KIND_LABELS[kind].length * 6.6 + 26 : 0;
  const headerW = Math.max(name.length * (CHAR_W + 0.5), badgeW) + 34; // + sort icon
  const contentW = Math.min(longest, 40) * CHAR_W + 26;
  return Math.round(Math.min(300, Math.max(76, headerW, contentW)));
}

export default function PreviewView({ dataset, profile, preview, loading, loadPreview }: PreviewViewProps) {
  const [limit, setLimit] = useState<number>(DEFAULT_PREVIEW_LIMIT);
  const [fetched, setFetched] = useState<{ limit: number; data: PreviewResult } | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle", error: null });
  const [reloadTick, setReloadTick] = useState(0);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [missingOnly, setMissingOnly] = useState(false);
  const [outliersOnly, setOutliersOnly] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [colPanelOpen, setColPanelOpen] = useState(false);
  const [sort, setSort] = useState<SortState>(null);
  const filterId = useId();
  const panelId = useId();

  /* ---------------- data loading ---------------- */
  const usesBase = limit === DEFAULT_PREVIEW_LIMIT && preview !== null;
  useEffect(() => {
    if (usesBase) return;
    // App is still loading the default preview; wait for it instead of duplicating the request.
    if (limit === DEFAULT_PREVIEW_LIMIT && loading) return;
    let cancelled = false;
    setFetchState({ status: "loading", error: null });
    loadPreview(dataset.dataset_id, limit).then(
      (data) => {
        if (cancelled) return;
        setFetched({ limit, data });
        setFetchState({ status: "idle", error: null });
      },
      (e: unknown) => {
        if (cancelled || isAbortError(e)) return;
        setFetchState({ status: "error", error: errorMessage(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [usesBase, limit, loading, dataset.dataset_id, loadPreview, reloadTick]);

  // While a bigger limit loads, keep showing what we already have.
  const data: PreviewResult | null = usesBase ? preview : fetched?.limit === limit ? fetched.data : (fetched?.data ?? preview);
  const loadingMore = !usesBase && fetchState.status === "loading";
  const totalRows = data?.total_rows ?? dataset.rows;

  /* ---------------- derived column info ---------------- */
  const profileByName = useMemo(() => {
    const m = new Map<string, ColumnProfile>();
    for (const p of profile ?? []) m.set(p.name, p);
    return m;
  }, [profile]);

  const outlierSets = useMemo(() => {
    const m = new Map<string, ReadonlySet<number>>();
    for (const p of profile ?? []) if (p.outlier_indices.length > 0) m.set(p.name, new Set(p.outlier_indices));
    return m;
  }, [profile]);

  const cappedOutlierCols = useMemo(
    () => (profile ?? []).filter((p) => p.outlier_count > OUTLIER_INDEX_CAP),
    [profile],
  );

  const columns = useMemo(() => data?.columns ?? [], [data]);
  const rows = useMemo(() => data?.rows ?? [], [data]);

  // Widths sample the first 150 rows only, so recomputing on a limit change is cheap.
  const widthByCol = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of columns) m.set(c, columnWidth(c, profileByName.get(c)?.kind, rows));
    return m;
  }, [columns, rows, profileByName]);

  const visibleCols = useMemo(() => columns.filter((c) => !hidden.has(c)), [columns, hidden]);
  const numericCols = useMemo(
    () => new Set(columns.filter((c) => profileByName.get(c)?.kind === "numeric")),
    [columns, profileByName],
  );

  /* ---------------- row filtering / sorting ---------------- */
  const q = deferredQuery.trim().toLowerCase();
  const rowOrder = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (missingOnly && !visibleCols.some((c) => isMissing(r[c]))) continue;
      if (outliersOnly && !visibleCols.some((c) => outlierSets.get(c)?.has(i))) continue;
      if (q) {
        let hit = false;
        for (const c of visibleCols) {
          const v = r[c];
          if (!isMissing(v) && String(v).toLowerCase().includes(q)) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
      }
      out.push(i);
    }
    if (sort && columns.includes(sort.col)) {
      const { col, desc } = sort;
      const numeric = numericCols.has(col);
      const dir = desc ? -1 : 1;
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      out.sort((a, b) => {
        const va = rows[a][col];
        const vb = rows[b][col];
        // Missing values always sort last, whatever the direction.
        const ma = isMissing(va);
        const mb = isMissing(vb);
        if (ma || mb) return ma === mb ? a - b : ma ? 1 : -1;
        let c: number;
        if (numeric || (typeof va === "number" && typeof vb === "number")) {
          const na = Number(va);
          const nb = Number(vb);
          const nanA = Number.isNaN(na);
          const nanB = Number.isNaN(nb);
          if (nanA || nanB) return nanA === nanB ? a - b : nanA ? 1 : -1;
          c = na - nb;
        } else {
          c = collator.compare(String(va), String(vb));
        }
        return c !== 0 ? c * dir : a - b;
      });
    }
    return out;
  }, [rows, visibleCols, missingOnly, outliersOnly, outlierSets, q, sort, columns, numericCols]);

  const missingRowCount = useMemo(
    () => rows.reduce<number>((n, r) => (visibleCols.some((c) => isMissing(r[c])) ? n + 1 : n), 0),
    [rows, visibleCols],
  );

  /* ---------------- virtualization ---------------- */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [firstRow, setFirstRow] = useState(0);
  const [viewH, setViewH] = useState(560);

  // Callback ref (React 19 cleanup form): the grid is conditionally rendered, so observe it whenever it mounts.
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      scrollRef.current = null;
    };
  }, []);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setFirstRow(Math.floor(e.currentTarget.scrollTop / ROW_H));
  }, []);

  // Jump back to the top when the row set changes meaningfully (filter / sort), not on limit change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop > 0) {
      el.scrollTop = 0;
      setFirstRow(0);
    }
  }, [q, missingOnly, outliersOnly, sort]);

  const rowCount = rowOrder.length;
  const start = Math.max(0, Math.min(firstRow, rowCount) - OVERSCAN);
  const end = Math.min(rowCount, Math.ceil(firstRow + Math.max(0, viewH - HEADER_H) / ROW_H) + OVERSCAN);

  const rowNumW = Math.max(52, String(Math.max(0, rows.length - 1)).length * 8 + 30);
  const gridCols = useMemo(
    () => [`${rowNumW}px`, ...visibleCols.map((c) => `${widthByCol.get(c) ?? 120}px`)].join(" "),
    [rowNumW, visibleCols, widthByCol],
  );
  const totalW = useMemo(
    () => visibleCols.reduce((w, c) => w + (widthByCol.get(c) ?? 120), rowNumW),
    [visibleCols, widthByCol, rowNumW],
  );

  const toggleSort = useCallback((col: string) => {
    setSort((s) => (s?.col !== col ? { col, desc: false } : !s.desc ? { col, desc: true } : null));
  }, []);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || e.target !== el) return;
    if (e.key === "Home" && e.ctrlKey) {
      el.scrollTo({ top: 0 });
      e.preventDefault();
    } else if (e.key === "End" && e.ctrlKey) {
      el.scrollTo({ top: el.scrollHeight });
      e.preventDefault();
    }
  };

  /* ---------------- render ---------------- */
  if (!data) {
    if (fetchState.status === "error") {
      return (
        <Callout
          tone="danger"
          title="Couldn't load the preview"
          action={
            <Button size="sm" icon="refresh" onClick={() => setReloadTick((t) => t + 1)}>
              Retry
            </Button>
          }
        >
          {fetchState.error}
        </Callout>
      );
    }
    return <PreviewSkeleton />;
  }

  if (columns.length === 0) {
    return (
      <EmptyState icon="table" title="Nothing to preview">
        This dataset has no columns.
      </EmptyState>
    );
  }

  const anyOutliers = outlierSets.size > 0;
  const filtersActive = q !== "" || missingOnly || outliersOnly;
  const loadedRows = rows.length;
  const gridStyle = { "--pv-cols": gridCols, "--pv-row-h": `${ROW_H}px`, "--pv-head-h": `${HEADER_H}px` } as CSSProperties;

  return (
    <div className="pv-view stack">
      <header className="pv-head">
        <div>
          <h2 className="pv-title">Preview</h2>
          <p className="pv-sub muted">
            {plural(totalRows, "row")} × {plural(columns.length, "column")}
            {totalRows > loadedRows && ` · first ${fmtInt(loadedRows)} loaded`}
          </p>
        </div>
        <div className="pv-limit">
          <span className="faint pv-limit-label" id={`${panelId}-limit`}>
            Rows to load
          </span>
          <div className="segmented segmented-sm" role="radiogroup" aria-labelledby={`${panelId}-limit`}>
            {LIMITS.map((l, i) => {
              const prev = i > 0 ? LIMITS[i - 1] : 0;
              const pointless = i > 0 && prev >= totalRows;
              return (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={limit === l}
                  className={limit === l ? "active" : ""}
                  disabled={pointless && limit !== l}
                  title={pointless ? `All ${fmtInt(totalRows)} rows already fit in ${fmtInt(prev)}` : `Load the first ${fmtInt(l)} rows`}
                  onClick={() => setLimit(l)}
                >
                  {fmtInt(l)}
                </button>
              );
            })}
          </div>
          {loadingMore && <Spinner size={14} />}
        </div>
      </header>

      {fetchState.status === "error" && !usesBase && (
        <Callout
          tone="danger"
          title={`Couldn't load ${fmtInt(limit)} rows`}
          action={
            <Button size="sm" icon="refresh" onClick={() => setReloadTick((t) => t + 1)}>
              Retry
            </Button>
          }
        >
          {fetchState.error} Showing the previously loaded rows instead.
        </Callout>
      )}

      <div className="pv-toolbar">
        <div className="pv-search">
          <Icon name="search" size={14} className="pv-search-icon" />
          <label htmlFor={filterId} className="sr-only">
            Filter loaded rows by text
          </label>
          <input
            id={filterId}
            type="search"
            className="input input-sm"
            placeholder="Filter loaded rows…"
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
        <button
          type="button"
          className={`pv-chip${missingOnly ? " pv-chip-on" : ""}`}
          aria-pressed={missingOnly}
          onClick={() => setMissingOnly((v) => !v)}
          title="Show only rows with at least one missing value in the visible columns"
        >
          Only rows with missing values <span className="pv-chip-count">{fmtInt(missingRowCount)}</span>
        </button>
        {anyOutliers && (
          <button
            type="button"
            className={`pv-chip pv-chip-outlier${outliersOnly ? " pv-chip-on" : ""}`}
            aria-pressed={outliersOnly}
            onClick={() => setOutliersOnly((v) => !v)}
            title="Show only rows with an IQR outlier in a visible column"
          >
            <span className="pv-swatch" aria-hidden="true" /> Only outlier rows
          </button>
        )}
        <Button
          size="sm"
          variant={colPanelOpen ? "secondary" : "ghost"}
          icon="columns"
          iconRight={colPanelOpen ? "chevronDown" : "chevronRight"}
          aria-expanded={colPanelOpen}
          aria-controls={panelId}
          onClick={() => setColPanelOpen((v) => !v)}
        >
          Columns {visibleCols.length < columns.length ? `${visibleCols.length}/${columns.length}` : ""}
        </Button>
      </div>

      {colPanelOpen && (
        <ColumnPicker
          id={panelId}
          columns={columns}
          hidden={hidden}
          profileByName={profileByName}
          onChange={setHidden}
          onClose={() => setColPanelOpen(false)}
        />
      )}

      <div className="pv-statusbar">
        <span className="muted" aria-live="polite">
          Showing {fmtInt(rowCount)} of {plural(loadedRows, "loaded row")} ({fmtInt(totalRows)} total)
          {sort && (
            <>
              {" · "}sorted by <strong>{sort.col}</strong> {sort.desc ? "descending" : "ascending"}
            </>
          )}
        </span>
        <span className="row">
          {anyOutliers && (
            <span className="pv-legend faint">
              <span className="pv-swatch" aria-hidden="true" /> IQR outlier
            </span>
          )}
          <span className="pv-legend faint">
            <span className="pv-null">null</span> missing
          </span>
          {(filtersActive || sort) && (
            <Button
              size="sm"
              variant="ghost"
              icon="x"
              onClick={() => {
                setQuery("");
                setMissingOnly(false);
                setOutliersOnly(false);
                setSort(null);
              }}
            >
              Reset
            </Button>
          )}
        </span>
      </div>

      {cappedOutlierCols.length > 0 && (
        <p className="pv-hint faint">
          <Icon name="info" size={13} /> Outlier highlighting covers at most the first {OUTLIER_INDEX_CAP} outliers per column (the profile
          caps the list):{" "}
          {cappedOutlierCols
            .slice(0, 4)
            .map((p) => `“${p.name}” has ${fmtInt(p.outlier_count)}`)
            .join(", ")}
          {cappedOutlierCols.length > 4 ? `, and ${cappedOutlierCols.length - 4} more` : ""}.
        </p>
      )}

      {visibleCols.length === 0 ? (
        <EmptyState
          icon="columns"
          title="All columns are hidden"
          action={
            <Button size="sm" icon="refresh" onClick={() => setHidden(new Set())}>
              Show all columns
            </Button>
          }
        />
      ) : (
        <div
          ref={attachScroll}
          className={`pv-scroll${loadingMore ? " pv-scroll-busy" : ""}`}
          style={{ ...gridStyle, height: HEADER_H + Math.max(rowCount, 3) * ROW_H + 16 }}
          tabIndex={0}
          role="table"
          aria-label={`Data preview: ${fmtInt(rowCount)} rows, ${fmtInt(visibleCols.length)} columns. Scroll with arrow keys and Page Up / Page Down.`}
          aria-rowcount={rowCount + 1}
          aria-colcount={visibleCols.length + 1}
          aria-busy={loadingMore || undefined}
          onScroll={onScroll}
          onKeyDown={onGridKey}
        >
          <div className="pv-inner" style={{ width: totalW, height: HEADER_H + rowCount * ROW_H }}>
            <div className="pv-row pv-header" role="row" aria-rowindex={1}>
              <div className="pv-cell pv-rownum pv-corner" role="columnheader" title="Row position (0-based, matches the backend's row index)">
                #
              </div>
              {visibleCols.map((c) => (
                <HeaderCell key={c} col={c} profile={profileByName.get(c)} sort={sort?.col === c ? sort : null} onSort={toggleSort} />
              ))}
            </div>
            {start > 0 && <div style={{ height: start * ROW_H }} aria-hidden="true" />}
            {rowOrder.slice(start, end).map((ri, k) => (
              <GridRow
                key={ri}
                rowIndex={ri}
                ariaIndex={start + k + 2}
                row={rows[ri]}
                cols={visibleCols}
                numericCols={numericCols}
                outlierSets={outlierSets}
              />
            ))}
          </div>
          {rowCount === 0 && (
            <div className="pv-norows" style={{ width: "100%" }}>
              <span className="muted">No loaded rows match these filters.</span>
            </div>
          )}
        </div>
      )}

      {totalRows > loadedRows && (
        <p className="pv-hint faint">
          Filtering and sorting apply to the {fmtInt(loadedRows)} loaded rows only.{" "}
          {limit < LIMITS[LIMITS.length - 1] && "Load more rows above to look further."}
        </p>
      )}
    </div>
  );
}

/* ======================================================================
   Grid pieces (memoized: scrolling only mounts/unmounts edge rows)
   ====================================================================== */

const HeaderCell = memo(function HeaderCell({
  col,
  profile,
  sort,
  onSort,
}: {
  col: string;
  profile: ColumnProfile | undefined;
  sort: { desc: boolean } | null;
  onSort: (col: string) => void;
}) {
  const missing = profile && profile.null_count > 0 ? ` · ${fmtPct(profile.null_ratio)} missing` : "";
  return (
    <div
      className={`pv-cell pv-hcell${profile?.kind === "numeric" ? " pv-num" : ""}`}
      role="columnheader"
      aria-sort={sort ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className="pv-hbtn"
        onClick={() => onSort(col)}
        title={`${col}${profile ? ` (${KIND_LABELS[profile.kind]}${missing})` : ""} — click to sort`}
      >
        <span className="pv-hname">
          <span className="pv-hname-text">{col}</span>
          <Icon
            name="chevronDown"
            size={12}
            className={`pv-sort-icon${sort ? " pv-sort-on" : ""}${sort && !sort.desc ? " pv-sort-asc" : ""}`}
          />
        </span>
        {profile ? <KindBadge kind={profile.kind} /> : <span className="faint pv-hkind">–</span>}
      </button>
    </div>
  );
});

const GridRow = memo(function GridRow({
  rowIndex,
  ariaIndex,
  row,
  cols,
  numericCols,
  outlierSets,
}: {
  rowIndex: number;
  ariaIndex: number;
  row: Row;
  cols: string[];
  numericCols: ReadonlySet<string>;
  outlierSets: ReadonlyMap<string, ReadonlySet<number>>;
}) {
  return (
    <div className="pv-row" role="row" aria-rowindex={ariaIndex}>
      <div className="pv-cell pv-rownum" role="rowheader">
        {rowIndex}
      </div>
      {cols.map((c) => {
        const v = row[c];
        const outlier = outlierSets.get(c)?.has(rowIndex) ?? false;
        if (isMissing(v)) {
          return (
            <div key={c} className={`pv-cell pv-cell-null${numericCols.has(c) ? " pv-cell-null-num" : ""}`} role="cell">
              <span className="pv-null">null</span>
            </div>
          );
        }
        const text = cellText(v) ?? "";
        const num = typeof v === "number" || numericCols.has(c);
        return (
          <div
            key={c}
            className={`pv-cell${num ? " pv-num" : ""}${outlier ? " pv-outlier" : ""}${typeof v === "boolean" ? " pv-bool" : ""}`}
            role="cell"
            title={outlier ? `${text} — IQR outlier in “${c}”` : text.length > 18 ? text : undefined}
          >
            {text}
          </div>
        );
      })}
    </div>
  );
});

/* ======================================================================
   Column picker
   ====================================================================== */

function ColumnPicker({
  id,
  columns,
  hidden,
  profileByName,
  onChange,
  onClose,
}: {
  id: string;
  columns: string[];
  hidden: ReadonlySet<string>;
  profileByName: ReadonlyMap<string, ColumnProfile>;
  onChange: (next: ReadonlySet<string>) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const searchId = useId();
  const needle = q.trim().toLowerCase();
  const matches = useMemo(() => (needle ? columns.filter((c) => c.toLowerCase().includes(needle)) : columns), [columns, needle]);
  const withMissing = useMemo(() => columns.filter((c) => (profileByName.get(c)?.null_count ?? 0) > 0), [columns, profileByName]);

  const toggle = (c: string) => {
    const next = new Set(hidden);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    onChange(next);
  };
  const setMatches = (show: boolean) => {
    const next = new Set(hidden);
    for (const c of matches) {
      if (show) next.delete(c);
      else next.add(c);
    }
    onChange(next);
  };

  return (
    <div
      id={id}
      className="pv-picker"
      role="group"
      aria-label="Choose visible columns"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="pv-picker-bar">
        <div className="pv-search pv-picker-search">
          <Icon name="search" size={14} className="pv-search-icon" />
          <label htmlFor={searchId} className="sr-only">
            Search columns
          </label>
          <input
            id={searchId}
            type="search"
            className="input input-sm"
            placeholder="Search columns…"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button size="sm" variant="ghost" onClick={() => setMatches(true)}>
          Show {needle ? "matches" : "all"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMatches(false)}>
          Hide {needle ? "matches" : "all"}
        </Button>
        {withMissing.length > 0 && withMissing.length < columns.length && (
          <Button
            size="sm"
            variant="ghost"
            title="Show only columns that have missing values"
            onClick={() => onChange(new Set(columns.filter((c) => !withMissing.includes(c))))}
          >
            Only with missing ({withMissing.length})
          </Button>
        )}
        <span className="pv-picker-count faint">
          {fmtInt(columns.length - hidden.size)} of {fmtInt(columns.length)} shown
        </span>
      </div>
      {matches.length === 0 ? (
        <p className="muted pv-picker-empty">No columns match “{q}”.</p>
      ) : (
        <ul className="pv-picker-list">
          {matches.map((c) => {
            const p = profileByName.get(c);
            return (
              <li key={c}>
                <label className="pv-picker-item">
                  <input type="checkbox" checked={!hidden.has(c)} onChange={() => toggle(c)} />
                  <span className="pv-picker-name" title={c}>
                    {c}
                  </span>
                  {p && <KindBadge kind={p.kind} />}
                  {p && p.null_count > 0 && <Badge tone="warning">{fmtPct(p.null_ratio)}</Badge>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ======================================================================
   Skeleton
   ====================================================================== */

function PreviewSkeleton() {
  return (
    <div className="pv-view stack" aria-busy="true" aria-label="Loading preview">
      <div className="pv-head">
        <div className="stack pv-skel-head">
          <Skeleton width={120} height={22} />
          <Skeleton width={200} height={13} />
        </div>
        <Skeleton width={180} height={28} radius={8} />
      </div>
      <div className="pv-toolbar">
        <Skeleton width={240} height={30} radius={7} />
        <Skeleton width={200} height={26} radius={999} />
      </div>
      <div className="pv-skel-grid">
        {Array.from({ length: 10 }, (_, r) => (
          <div key={r} className="pv-skel-row">
            {Array.from({ length: 6 }, (_, c) => (
              <Skeleton key={c} width={`${55 + ((r * 7 + c * 13) % 40)}%`} height={r === 0 ? 14 : 11} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
