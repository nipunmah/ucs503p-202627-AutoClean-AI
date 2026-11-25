import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import "./App.css";
import { useWorkspace } from "./hooks/useWorkspace";
import type { AuditTrail, StepExplanation, TabId } from "./types";
import Sidebar from "./components/Sidebar";
import Toaster from "./components/Toaster";
import CommandPalette, { type Command } from "./components/CommandPalette";
import { DownloadMenu, SyntheticMenu } from "./components/Popover";
import { Icon, type IconName } from "./components/icons";
import { Badge, Button, Callout, EmptyState, IconButton, Kbd, Spinner } from "./components/ui";
import ChatAssistant from "./components/ChatAssistant";
import OverviewView from "./views/OverviewView";
import ColumnsView from "./views/ColumnsView";
import PreviewView from "./views/PreviewView";
import CleanView from "./views/CleanView";
import ResultsView from "./views/ResultsView";
import ModelsView from "./views/ModelsView";
import { sampleFile } from "./lib/sampleData";
import { fmtInt, plural } from "./lib/format";
import { downloadUrl } from "./api/client";

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "columns", label: "Columns", icon: "columns" },
  { id: "preview", label: "Preview", icon: "table" },
  { id: "clean", label: "Clean", icon: "wand" },
  { id: "results", label: "Results", icon: "history" },
  { id: "models", label: "Models", icon: "brain" },
];

type Theme = "dark" | "light";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("autoclean-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* storage unavailable */
    }
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("autoclean-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function App() {
  const ws = useWorkspace();
  const [theme, toggleTheme] = useTheme();
  const [tab, setTab] = useState<TabId>("overview");
  const [chatOpen, setChatOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{ id: number; text: string } | null>(null);
  const questionSeq = useRef(0);
  const [explanations, setExplanations] = useState<Record<string, StepExplanation[]>>({});
  const [audit, setAudit] = useState<AuditTrail | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditedIds, setAuditedIds] = useState<Set<string>>(new Set());

  const { selected, selectedId, datasets, loadAudit, select, runPipeline, upload } = ws;

  /* Audit trail for the selected dataset (only derived datasets can have one). */
  useEffect(() => {
    let cancelled = false;
    setAudit(null);
    if (!selected || !selected.parent_id) {
      setAuditLoading(false);
      return;
    }
    setAuditLoading(true);
    loadAudit(selected.dataset_id)
      .then((a) => !cancelled && setAudit(a))
      .catch(() => !cancelled && setAudit(null))
      .finally(() => !cancelled && setAuditLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected, loadAudit]);

  /* Which datasets are pipeline outputs (for the sidebar "clean" badge). Cached per id. */
  useEffect(() => {
    let cancelled = false;
    const derived = datasets.filter((d) => d.parent_id);
    Promise.all(derived.map((d) => loadAudit(d.dataset_id).then((a) => (a ? d.dataset_id : null)).catch(() => null))).then(
      (ids) => {
        if (!cancelled) setAuditedIds(new Set(ids.filter((x): x is string => x !== null)));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [datasets, loadAudit]);

  const selectDataset = useCallback(
    (id: string) => {
      void select(id);
      setSidebarOpen(false);
    },
    [select]
  );

  const askAssistant = useCallback((text: string) => {
    setPendingQuestion({ id: ++questionSeq.current, text });
    setChatOpen(true);
  }, []);

  const handleRun = useCallback(
    async (resultName?: string | null) => {
      const res = await runPipeline(resultName);
      if (res) {
        setExplanations((prev) => ({ ...prev, [res.dataset_id]: res.step_explanations }));
        await select(res.dataset_id);
        setTab("results");
      }
    },
    [runPipeline, select]
  );

  const loadSample = useCallback(() => {
    void upload([sampleFile()]);
  }, [upload]);

  /* Global keyboard shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        setChatOpen((o) => !o);
        return;
      }
      if (e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        setTab(TABS[Number(e.key) - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [];
    TABS.forEach((t, i) =>
      cmds.push({
        id: `tab-${t.id}`,
        group: "Navigate",
        label: `Go to ${t.label}`,
        icon: t.icon,
        hint: `Alt+${i + 1}`,
        disabled: !selected,
        run: () => setTab(t.id),
      })
    );
    cmds.push(
      {
        id: "run",
        group: "Actions",
        label: "Run cleaning pipeline",
        icon: "play",
        disabled: !selected || ws.run.status === "running",
        run: () => void handleRun(),
      },
      { id: "upload", group: "Actions", label: "Upload files…", icon: "upload", run: () => document.querySelector<HTMLInputElement>("[data-testid=file-input]")?.click() },
      { id: "sample", group: "Actions", label: "Load sample dataset", icon: "flask", run: loadSample },
      {
        id: "dl-csv",
        group: "Actions",
        label: "Download current dataset as CSV",
        icon: "download",
        disabled: !selected,
        run: () => selected && window.open(downloadUrl(selected.dataset_id, "csv"), "_blank"),
      },
      { id: "chat", group: "Actions", label: chatOpen ? "Close assistant" : "Open assistant", icon: "chat", hint: isMac ? "⌘/" : "Ctrl+/", run: () => setChatOpen((o) => !o) },
      { id: "theme", group: "Actions", label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`, icon: theme === "dark" ? "sun" : "moon", run: toggleTheme }
    );
    for (const d of datasets) {
      cmds.push({
        id: `ds-${d.dataset_id}`,
        group: "Datasets",
        label: d.name,
        icon: "database",
        hint: `${fmtInt(d.rows)} × ${d.columns}`,
        run: () => selectDataset(d.dataset_id),
      });
    }
    return cmds;
  }, [selected, ws.run.status, handleRun, loadSample, chatOpen, theme, toggleTheme, datasets, selectDataset]);

  const parent = selected?.parent_id ? datasets.find((d) => d.dataset_id === selected.parent_id) ?? null : null;
  const hasResults = !!audit || auditLoading;

  const renderView = () => {
    if (!selected) return null;
    const base = {
      dataset: selected,
      datasets,
      onNavigate: setTab,
      onSelectDataset: selectDataset,
      onAskAssistant: askAssistant,
    };
    switch (tab) {
      case "overview":
        return (
          <OverviewView
            {...base}
            uploadInfo={ws.uploadInfo[selected.dataset_id] ?? null}
            profile={ws.profile}
            preview={ws.preview}
            loading={ws.datasetLoading}
            config={ws.config}
            onConfigChange={ws.setConfig}
          />
        );
      case "columns":
        return <ColumnsView {...base} profile={ws.profile} loading={ws.datasetLoading} config={ws.config} onConfigChange={ws.setConfig} />;
      case "preview":
        return <PreviewView {...base} profile={ws.profile} preview={ws.preview} loading={ws.datasetLoading} loadPreview={ws.loadPreview} />;
      case "clean":
        return (
          <CleanView
            {...base}
            profile={ws.profile}
            loading={ws.datasetLoading}
            config={ws.config}
            onConfigChange={ws.setConfig}
            onResetConfig={ws.resetConfig}
            onRun={handleRun}
            run={ws.run}
          />
        );
      case "results":
        return (
          <ResultsView
            {...base}
            audit={audit}
            auditLoading={auditLoading}
            explanations={explanations[selected.dataset_id] ?? null}
            loadProfile={ws.loadProfile}
            loadPreview={ws.loadPreview}
          />
        );
      case "models":
        return <ModelsView {...base} profile={ws.profile} loading={ws.datasetLoading} />;
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className={`app${sidebarOpen ? " sidebar-open" : ""}${chatOpen ? " chat-open" : ""}`}>
        <aside className="sidebar" aria-label="Dataset library">
          <Sidebar
            datasets={datasets}
            selectedId={selectedId}
            onSelect={selectDataset}
            checkedIds={ws.checkedIds}
            onToggleChecked={ws.toggleChecked}
            onClearChecked={ws.clearChecked}
            onUpload={(files) => void ws.upload(files)}
            onLoadSample={loadSample}
            uploading={ws.busy === "upload"}
            combining={ws.busy === "combine"}
            onCombine={(opts) => void ws.combine(opts)}
            auditedIds={auditedIds}
          />
        </aside>
        {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}

        <main className="main">
          <div className="topbar">
            <IconButton className="menu-toggle" icon="layers" label="Show datasets" onClick={() => setSidebarOpen(true)} />
            <div className="topbar-title">
              {selected ? (
                <>
                  <h1 className="dataset-title" title={selected.name}>
                    {selected.name}
                  </h1>
                  <div className="dataset-chips">
                    <Badge>{plural(selected.rows, "row")}</Badge>
                    <Badge>{plural(selected.columns, "column")}</Badge>
                    {auditedIds.has(selected.dataset_id) && <Badge tone="success">cleaned</Badge>}
                    {parent && (
                      <button type="button" className="lineage-link" onClick={() => selectDataset(parent.dataset_id)} title="Open parent dataset">
                        <Icon name="arrowRight" size={12} /> from {parent.name}
                      </button>
                    )}
                    {ws.datasetLoading && <Spinner size={14} />}
                  </div>
                </>
              ) : (
                <h1 className="dataset-title muted">Workspace</h1>
              )}
            </div>
            <div className="topbar-actions">
              {selected && (
                <>
                  <SyntheticMenu disabled={!selected} busy={ws.busy === "synthetic"} rows={selected.rows} onGenerate={ws.synthetic} />
                  <DownloadMenu datasetId={selected.dataset_id} />
                </>
              )}
              <button type="button" className="palette-trigger" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
                <Icon name="search" size={14} />
                <span>Search</span>
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>K</Kbd>
              </button>
              <IconButton icon={theme === "dark" ? "sun" : "moon"} label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={toggleTheme} />
              <IconButton icon="chat" label={chatOpen ? "Close assistant" : "Open assistant"} active={chatOpen} onClick={() => setChatOpen((o) => !o)} />
            </div>
          </div>

          {ws.backendStatus === "offline" && (
            <div className="page-pad">
              <Callout
                tone="danger"
                title="Backend unreachable"
                action={
                  <Button size="sm" icon="refresh" onClick={() => void ws.refreshDatasets().catch(() => undefined)}>
                    Retry
                  </Button>
                }
              >
                Start it with <code>./.venv/Scripts/python -m uvicorn app.main:app --port 8000</code> in <code>backend/</code>.
              </Callout>
            </div>
          )}

          {selected ? (
            <>
              <nav className="tabs" role="tablist" aria-label="Dataset views">
                {TABS.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls="tabpanel"
                    className={`tab${tab === t.id ? " active" : ""}`}
                    onClick={() => setTab(t.id)}
                    title={`${t.label} (Alt+${i + 1})`}
                  >
                    <Icon name={t.icon} size={15} />
                    <span>{t.label}</span>
                    {t.id === "columns" && ws.profile && <span className="tab-count">{ws.profile.length}</span>}
                    {t.id === "results" && hasResults && <span className="tab-dot" aria-label="has results" />}
                    {tab === t.id && <motion.span layoutId="tab-underline" className="tab-underline" />}
                  </button>
                ))}
              </nav>
              {ws.datasetError ? (
                <div className="page-pad">
                  <Callout
                    tone="danger"
                    title="Couldn't load this dataset"
                    action={
                      <Button size="sm" icon="refresh" onClick={() => selectedId && void ws.select(selectedId)}>
                        Retry
                      </Button>
                    }
                  >
                    {ws.datasetError}
                  </Callout>
                </div>
              ) : (
                <AnimatePresence mode="wait">
                  <motion.div
                    key={`${tab}:${selectedId}`}
                    id="tabpanel"
                    role="tabpanel"
                    aria-labelledby={`tab-${tab}`}
                    className="view"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.14 }}
                  >
                    {renderView()}
                  </motion.div>
                </AnimatePresence>
              )}
            </>
          ) : (
            <div className="welcome">
              <EmptyState
                icon="sparkles"
                title={datasets.length > 0 ? "Pick a dataset to get started" : "Turn messy data into model-ready data"}
                action={
                  <div className="welcome-actions">
                    <Button variant="primary" icon="upload" onClick={() => document.querySelector<HTMLInputElement>("[data-testid=file-input]")?.click()}>
                      Upload a file
                    </Button>
                    <Button icon="flask" onClick={loadSample} loading={ws.busy === "upload"}>
                      Try the sample dataset
                    </Button>
                  </div>
                }
              >
                {datasets.length > 0
                  ? "Choose one from the library on the left, or upload another file."
                  : "Upload a CSV, Excel or JSON file. AutoClean profiles every column, fixes types, fills gaps, handles outliers, encodes and scales — and records every change in an audit trail. Rows are never dropped unless you ask."}
              </EmptyState>
              <ol className="welcome-steps">
                <li>
                  <Icon name="gauge" size={16} />
                  <span>
                    <strong>Profile</strong> — health score, column types and issues at a glance
                  </span>
                </li>
                <li>
                  <Icon name="wand" size={16} />
                  <span>
                    <strong>Clean</strong> — smart defaults from your data, override any column
                  </span>
                </li>
                <li>
                  <Icon name="history" size={16} />
                  <span>
                    <strong>Audit</strong> — every step's effect on rows, columns and missing values
                  </span>
                </li>
                <li>
                  <Icon name="brain" size={16} />
                  <span>
                    <strong>Model</strong> — algorithm recommendations with reasons
                  </span>
                </li>
              </ol>
            </div>
          )}
        </main>

        <ChatAssistant
          open={chatOpen}
          onOpenChange={setChatOpen}
          datasetId={selectedId}
          datasetName={selected?.name ?? null}
          pendingQuestion={pendingQuestion}
          onPendingConsumed={() => setPendingQuestion(null)}
        />

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
        <Toaster toasts={ws.toasts} onDismiss={ws.dismissToast} />
      </div>
    </MotionConfig>
  );
}

export default App;
