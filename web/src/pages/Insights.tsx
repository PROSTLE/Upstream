// /insights: Upstream's money and attribution on an AG Studio board, themed to match the app.
// Loaded lazily (App.tsx), so AG Studio's bundle is only fetched on this page.
// The data is read-only. A visitor may rearrange the board; their layout is kept in this browser
// only (localStorage) and never sent to the server.
import "../insights/insights.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgStudioAiModule, enableStudioDevValidations, type AgReportState, type AgStudioApi, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { LayoutGrid, Pencil, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { useApi } from "../api.ts";
import { useResolvedTheme } from "../theme.ts";
import { ErrorBox, PageHead, Skeleton } from "../ui.tsx";
import { buildStudioData, type StudioPayload } from "../insights/data.ts";
import { PAGES } from "../insights/defaultReport.ts";
import report from "../insights/report.json";
import { DARK_MODE, insightsTheme, LIGHT_MODE } from "../insights/theme.ts";
import { insightsWidgets } from "../insights/widgets/index.ts";
import { buildInsightsAi } from "../insights/ai/harness.ts";
import type { InsightsContext, UpstreamRegistry } from "../insights/widgets/types.ts";

if (import.meta.env.DEV) enableStudioDevValidations();

const LICENSE = (import.meta.env.VITE_AG_STUDIO_LICENSE_KEY as string | undefined) || undefined;
const LAYOUT_KEY = "upstream.insights.report.v1";
/** The default board, as Studio saved it (api.getState()) from insights/defaultReport.ts. */
const DEFAULT_REPORT = report as unknown as AgReportState<UpstreamRegistry>;

function savedLayout(): AgReportState<UpstreamRegistry> | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as AgReportState<UpstreamRegistry>) : null;
  } catch {
    return null;
  }
}
/** What makes a layout: the widgets, where they sit, and the filters set on them. Not cross-filter clicks or selection. */
const layoutOf = (state: AgReportState<UpstreamRegistry>) =>
  JSON.stringify(state.pages.map((p) => ({ id: p.id, widgets: p.widgets, widgetLayout: p.widgetLayout, filter: p.filter })));
const withoutClicks = (state: AgReportState<UpstreamRegistry>): AgReportState<UpstreamRegistry> => ({
  ...state,
  pages: state.pages.map(({ crossFilter: _c, selection: _s, ...page }) => page),
});
function saveLayout(state: AgReportState<UpstreamRegistry> | null) {
  try {
    if (state) localStorage.setItem(LAYOUT_KEY, JSON.stringify(withoutClicks(state)));
    else localStorage.removeItem(LAYOUT_KEY);
  } catch {
    /* private window or storage blocked: the board still works, it just won't remember */
  }
}

export function Insights() {
  const { data, error, loading, reload } = useApi<StudioPayload>("/api/studio/data");
  const theme = useResolvedTheme();
  const studioData = useMemo(() => (data ? buildStudioData(data) : undefined), [data]);
  const context = useMemo<InsightsContext>(() => ({ currency: data?.currency ?? "USD" }), [data?.currency]);
  // Studio reads `ai` once, when it is created, and the AI module has to be registered first.
  const aiOn = Boolean(data?.ai?.enabled);
  const ai = useMemo(() => (aiOn && data?.ai ? buildInsightsAi(data.ai.model) : undefined), [aiOn, data?.ai?.model]);
  const modules = useMemo(() => (aiOn ? [AgStudioAiModule] : undefined), [aiOn]);
  const [initialState] = useState(() => savedLayout() ?? DEFAULT_REPORT);
  const [page, setPage] = useState(initialState.selectedPageId);
  const [mode, setMode] = useState<AgStudioMode>("view");
  const [custom, setCustom] = useState(() => savedLayout() != null);
  const apiRef = useRef<AgStudioApi<UpstreamRegistry> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resetting = useRef(false);
  const baseline = useRef<string | null>(null);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const showPage = (id: string) => {
    const api = apiRef.current;
    if (!api) return;
    api.setState({ ...api.getState(), selectedPageId: id });
    setPage(id);
  };
  const [chatOpen, setChatOpen] = useState(false);
  const toggleChat = () => {
    const api = apiRef.current;
    if (!api) return;
    const state = api.getState();
    const open = !chatOpen;
    api.setState({ ...state, panels: { ...state.panels, ai: { ...state.panels?.ai, collapsed: !open } } });
    setChatOpen(open);
    // Studio shows its side panels, the AI one included, in edit mode.
    setMode(open ? "edit" : "view");
  };
  const collapseAi = () => {
    const api = apiRef.current;
    if (!api) return;
    const state = api.getState();
    if (!state.panels?.ai?.collapsed) api.setState({ ...state, panels: { ...state.panels, ai: { ...state.panels?.ai, collapsed: true } } });
  };
  // Edit layout shows Studio's compose and data panels, but leaves the AI one shut unless Ask AI opened it.
  // Studio opens its panels as it switches mode, so this runs after the switch.
  useEffect(() => {
    if (mode !== "edit" || chatOpen) return;
    const t = setTimeout(collapseAi, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, chatOpen]);
  const toggleEdit = () => {
    const next = mode === "edit" ? "view" : "edit";
    if (next === "view" && chatOpen) {
      collapseAi();
      setChatOpen(false);
    }
    setMode(next);
  };
  const reset = () => {
    const api = apiRef.current;
    clearTimeout(saveTimer.current);
    saveLayout(null);
    setCustom(false);
    if (!api) return;
    resetting.current = true;
    api.setState({ ...DEFAULT_REPORT, selectedPageId: page });
    api.clearHistory();
  };

  return (
    <div className="page insights-page">
      <PageHead
        eyebrow="Insights · built on AG Studio"
        title="Insights"
        subtitle="Where the money went and what your agent really used, on one board. Click a package or a maintainer to filter everything else."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} />Refresh data</button>
          </div>
        }
      />
      {error && <ErrorBox error={error} />}
      <div className="insights-bar">
        <div className="tabs" role="tablist" aria-label="Board pages">
          {PAGES.map((p) => (
            <button key={p.id} role="tab" aria-selected={page === p.id} className={`tab ${page === p.id ? "active" : ""}`} onClick={() => showPage(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {data && !aiOn && <span className="muted small">AI is off on this demo.</span>}
        {custom && <span className="muted small">Your layout is saved in this browser only.</span>}
        <button className="btn sm" onClick={reset} disabled={!custom} title="Back to the default board"><RotateCcw size={14} />Reset layout</button>
        {aiOn && (
          <button className={`btn sm ${chatOpen ? "primary" : ""}`} onClick={() => toggleChat()} aria-pressed={chatOpen} title="Studio's agents, on Muse Spark. They can read the board and build widgets; they can't change data or move money.">
            <Sparkles size={14} />{chatOpen ? "Close AI" : "Ask AI"}
          </button>
        )}
        <button className={`btn sm ${mode === "edit" ? "primary" : ""}`} onClick={toggleEdit} aria-pressed={mode === "edit"}>
          {mode === "edit" ? <><LayoutGrid size={14} />Done editing</> : <><Pencil size={14} />Edit layout</>}
        </button>
      </div>
      <div className="insights-frame ag-theme-mode" data-ag-theme-mode={theme === "dark" ? DARK_MODE : LIGHT_MODE}>
        {studioData ? (
          <AgStudioProvider licenseKey={LICENSE} modules={modules}>
            <AgStudio<UpstreamRegistry>
              style={{ height: "100%", width: "100%" }}
              theme={insightsTheme}
              data={studioData}
              widgets={insightsWidgets}
              ai={ai as never}
              initialState={initialState}
              context={context}
              mode={mode}
              onStudioReady={(e) => {
                // The board as it opened: a later change only counts as the visitor's layout if it differs from this.
                if (!custom) baseline.current = layoutOf(e.api.getState() as AgReportState<UpstreamRegistry>);
              }}
              onApiReady={(e) => {
                // Studio types its events with the default registry; this instance runs ours.
                apiRef.current = e.api as unknown as AgStudioApi<UpstreamRegistry>;
                // Development builds only: lets a script read the board's state (report.json is exported this way).
                if (import.meta.env.DEV) (window as unknown as { __insightsApi?: unknown }).__insightsApi = e.api;
              }}
              onStateUpdated={(e) => {
                if (e.state.selectedPageId !== page) setPage(e.state.selectedPageId);
                const ai = e.state.panels?.ai;
                if (ai && Boolean(!ai.collapsed) !== chatOpen) setChatOpen(!ai.collapsed);
                // Only a change to the board itself (widgets, layout, filters) counts as the visitor's layout;
                // switching pages doesn't, and neither does the reset this page made itself.
                if (!e.durable) return;
                const state = e.state as AgReportState<UpstreamRegistry>;
                if (resetting.current) {
                  resetting.current = false;
                  baseline.current = layoutOf(state);
                  return;
                }
                if (baseline.current != null && layoutOf(state) === baseline.current) return; // a cross-filter click, not a layout change
                clearTimeout(saveTimer.current);
                saveTimer.current = setTimeout(() => {
                  saveLayout(state);
                  setCustom(true);
                }, 500);
              }}
            />
          </AgStudioProvider>
        ) : (
          <div className="insights-skeleton" role="status" aria-label="Loading the board">
            <div className="grid4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={96} r={14} />)}</div>
            <div className="row" style={{ gap: 12, alignItems: "stretch" }}>
              <div style={{ flex: 13 }}><Skeleton h={320} r={14} /></div>
              <div style={{ flex: 11 }}><Skeleton h={320} r={14} /></div>
            </div>
          </div>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        PayPal sandbox data from this server{data ? `, read ${new Date(data.generatedAt).toLocaleString()}` : ""}. Nothing on this board can change data or move money.
      </p>
    </div>
  );
}
