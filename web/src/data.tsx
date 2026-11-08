// AG Grid and AG Charts live here so only the pages that show data load them.
import {
  AllCommunityModule, colorSchemeDark, colorSchemeLight, themeQuartz,
  type ColDef, type ColumnState, type GridApi, type ICellRendererParams, type IRowNode, type ProcessCellForExportParams,
} from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { useCallback, useRef, useState } from "react";
import { Download, RotateCcw, Search } from "lucide-react";
import { PackageChip, Status } from "./ui.tsx";
import { moneyStr } from "./format.ts";
import { AllCommunityModule as ChartsModule, ModuleRegistry as ChartsRegistry, type AgChartOptions } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { useResolvedTheme } from "./theme.ts";

ChartsRegistry.registerModules([ChartsModule]);
const gridModules = [AllCommunityModule];

// ---------- AG Grid & AG Charts ----------

const shared = {
  fontFamily: ["Inter Variable", "system-ui", "sans-serif"],
  fontSize: 13,
  headerFontWeight: 600,
  wrapperBorderRadius: 14,
  wrapperBorder: false,
  spacing: 7,
  columnBorder: false,
};

const lightGrid = themeQuartz.withPart(colorSchemeLight).withParams({
  ...shared,
  backgroundColor: "#ffffff",
  foregroundColor: "#14151a",
  accentColor: "#2f5bea",
  borderColor: "#ecebe5",
  headerBackgroundColor: "#fafaf8",
  headerTextColor: "#676973",
  rowHoverColor: "#f5f7ff",
  selectedRowBackgroundColor: "#eef2fe",
  rowBorder: { color: "#f0efea" },
  valueChangeValueHighlightBackgroundColor: "rgba(15, 157, 148, 0.22)",
});

const darkGrid = themeQuartz.withPart(colorSchemeDark).withParams({
  ...shared,
  backgroundColor: "#15161b",
  foregroundColor: "#ecedf1",
  accentColor: "#7090ff",
  borderColor: "#282a32",
  headerBackgroundColor: "#1a1c22",
  headerTextColor: "#989ba8",
  rowHoverColor: "#1d2030",
  selectedRowBackgroundColor: "#1f2540",
  rowBorder: { color: "#22242b" },
  valueChangeValueHighlightBackgroundColor: "rgba(46, 196, 185, 0.24)",
});

// ---------- cells shared by every grid ----------

/**
 * Money in a grid: tabular figures and a flash when the amount changes. Below zero is red; with `signed`
 * (a ledger, where the sign is the point), above zero is green.
 */
export function moneyCol<T>(
  headerName: string,
  field: string,
  currency: (row: T) => string,
  { signed = false, ...extra }: Partial<ColDef<T>> & { signed?: boolean } = {},
): ColDef<T> {
  return {
    headerName,
    field: field as ColDef<T>["field"],
    maxWidth: 140,
    type: "numericColumn",
    cellClass: "num",
    enableCellChangeFlash: true,
    valueFormatter: (p) => (p.value == null ? "—" : moneyStr(String(p.value), p.data ? currency(p.data) : "USD")),
    cellRenderer: (p: ICellRendererParams<T>) => <Money text={p.valueFormatted ?? ""} value={p.value} signed={signed} />,
    ...extra,
  };
}

function Money({ text, value, signed }: { text: string; value: unknown; signed: boolean }) {
  const n = value == null ? 0 : Number(value);
  const tone = n < 0 ? " neg" : signed && n > 0 ? " pos" : "";
  return <span className={`grid-money${tone}`}>{text}</span>;
}

/** What Upstream's own money states are called on screen. PayPal's statuses keep PayPal's words. */
const MONEY_STATE: Record<string, string> = {
  reserved: "Held", held: "Held", in_batch: "Sent", sending: "Sending", sent: "Sent", paid: "Paid",
  receiver_unclaimed: "Unclaimed", released: "Released",
};

/** A status pill that flashes when the status changes. `value` overrides the cell value, e.g. to fill a gap. */
export function statusCol<T>(headerName: string, field: string, extra: Partial<ColDef<T>> & { live?: (v: string) => boolean; value?: (row: T) => string | null } = {}): ColDef<T> {
  const { live, value, ...rest } = extra;
  return {
    headerName,
    field: field as ColDef<T>["field"],
    maxWidth: 160,
    enableCellChangeFlash: true,
    valueFormatter: (p) => (p.value ? (MONEY_STATE[p.value] ?? String(p.value)) : "—"),
    cellRenderer: (p: ICellRendererParams<T>) => {
      const v = value && p.data ? value(p.data) : (p.value as string | null);
      return <Status value={v} label={v ? MONEY_STATE[v] : undefined} live={v ? live?.(v) : false} />;
    },
    ...rest,
  };
}

/** A package, with its ecosystem's mark. */
export function packageCol<T>(headerName: string, field: string, ecosystem: (row: T) => string, extra: Partial<ColDef<T>> = {}): ColDef<T> {
  return {
    headerName,
    field: field as ColDef<T>["field"],
    minWidth: 170,
    cellRenderer: (p: ICellRendererParams<T>) =>
      p.value && p.data ? (
        <span className="row" style={{ height: "100%" }}>
          <PackageChip ecosystem={ecosystem(p.data)} name={String(p.value)} />
        </span>
      ) : (
        "—"
      ),
    ...extra,
  };
}

/** A count drawn as a short bar against the largest in the grid, with the number beside it. */
export function barCol<T>(headerName: string, field: string, extra: Partial<ColDef<T>> = {}): ColDef<T> {
  return {
    headerName,
    field: field as ColDef<T>["field"],
    maxWidth: 150,
    type: "numericColumn",
    enableCellChangeFlash: true,
    cellRenderer: (p: ICellRendererParams<T>) => {
      const n = Number(p.value ?? 0);
      let max = 0;
      p.api.forEachNode((node) => {
        const v = Number(p.api.getCellValue({ rowNode: node, colKey: p.column! }) ?? 0);
        if (v > max) max = v;
      });
      return (
        <span className="grid-bar" title={`${n} of ${max}, the most in this list`}>
          <span className="track"><span className="fill" style={{ width: max && n > 0 ? `${Math.max(4, (n / max) * 100)}%` : 0 }} /></span>
          <span className="num">{n}</span>
        </span>
      );
    },
    ...extra,
  };
}

// ---------- the grid ----------

const STATE_KEY = (name: string) => `upstream.grid.${name}`;
function readState(name: string): ColumnState[] | null {
  try {
    const raw = localStorage.getItem(STATE_KEY(name));
    return raw ? (JSON.parse(raw) as ColumnState[]) : null;
  } catch {
    return null;
  }
}
function writeState(name: string, state: ColumnState[] | null) {
  try {
    if (state) localStorage.setItem(STATE_KEY(name), JSON.stringify(state));
    else localStorage.removeItem(STATE_KEY(name));
  } catch {
    /* private window or storage blocked: the layout just isn't remembered */
  }
}

function idsOf<T>(api: GridApi<T>): Set<string> {
  const ids = new Set<string>();
  api.forEachNode((n) => {
    if (n.id) ids.add(n.id);
  });
  return ids;
}

/** A cell as it goes into a CSV: lists of packages become their names, never "[object Object]". */
function csvCell(p: ProcessCellForExportParams): string {
  const v = p.value;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? (x.name ?? JSON.stringify(x)) : String(x))).join("; ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return v == null ? "" : String(v);
}

/**
 * Every table in the app. With `name`, it gets a toolbar (a quick filter and Export CSV) and remembers
 * its column order, widths and sort in this browser. Rows keep their identity through `getRowId`, so
 * when a poll or a PayPal webhook changes a row, its changed cells flash, and new rows flash whole.
 */
export function Grid<T>({ rows, columns, height = 420, onRowClick, getRowId, empty = "Nothing here yet", name }: {
  rows: T[]; columns: ColDef<T>[]; height?: number | string; onRowClick?: (row: T) => void; getRowId?: (row: T) => string; empty?: string; name?: string;
}) {
  const theme = useResolvedTheme();
  const api = useRef<GridApi<T> | null>(null);
  const known = useRef<Set<string> | null>(null);
  const [quick, setQuick] = useState("");
  const [customised, setCustomised] = useState(() => (name ? readState(name) !== null : false));

  const save = useCallback(
    (e: { api: GridApi<T>; finished?: boolean; source?: string }) => {
      if (!name || e.finished === false || e.source === "api" || e.source === "gridInitializing" || e.source === "flex") return;
      writeState(name, e.api.getColumnState());
      setCustomised(true);
    },
    [name],
  );

  const exportCsv = () => {
    const a = api.current;
    if (!a || !name) return;
    const columnKeys = (a.getAllDisplayedColumns() ?? []).filter((c) => c.getColDef().headerName).map((c) => c.getColId());
    a.exportDataAsCsv({ fileName: `upstream-${name}-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys, processCellCallback: csvCell });
  };

  const reset = () => {
    api.current?.resetColumnState();
    if (name) writeState(name, null);
    setCustomised(false);
  };

  return (
    <div className="grid-wrap">
      {name && (
        <div className="grid-toolbar">
          <label className="grid-search">
            <Search size={14} aria-hidden />
            <input type="search" placeholder="Filter rows" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Filter rows" />
          </label>
          <span className="grow" />
          {customised && (
            <button className="btn ghost sm" onClick={reset} title="Put the columns back as they were">
              <RotateCcw size={13} /> Reset columns
            </button>
          )}
          <button className="btn ghost sm" onClick={exportCsv} title="Download the rows shown, as a CSV file">
            <Download size={13} /> Export CSV
          </button>
        </div>
      )}
      <div style={{ height }}>
        <AgGridProvider modules={gridModules}>
        <AgGridReact<T>
          theme={theme === "dark" ? darkGrid : lightGrid}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true, filter: true, flex: 1, minWidth: 110 }}
          animateRows
          suppressCellFocus
          cellFlashDuration={900}
          cellFadeDuration={900}
          quickFilterText={name ? quick : undefined}
          getRowId={getRowId ? (p) => getRowId(p.data) : undefined}
          onGridReady={(e) => {
            api.current = e.api;
            const saved = name ? readState(name) : null;
            if (saved) e.api.applyColumnState({ state: saved, applyOrder: true });
          }}
          // The rows on first draw are the baseline; any row that turns up after that is new.
          onFirstDataRendered={(e) => {
            if (getRowId && !known.current) known.current = idsOf(e.api);
          }}
          onRowDataUpdated={(e) => {
            if (!getRowId) return;
            const ids = idsOf(e.api);
            const before = known.current;
            known.current = ids;
            if (!before) return;
            const fresh: IRowNode<T>[] = [];
            e.api.forEachNode((n) => {
              if (n.id && !before.has(n.id)) fresh.push(n);
            });
            // A webhook adds a row or two; a page filter swapping many rows in is not news.
            // New rows are drawn a frame later (they animate in), so flash once their cells exist.
            if (fresh.length > 0 && fresh.length <= 3) setTimeout(() => e.api.flashCells({ rowNodes: fresh }), 120);
          }}
          onColumnMoved={save}
          onColumnResized={save}
          onSortChanged={save}
          onColumnVisible={save}
          onColumnPinned={save}
          // The grid hears a click before React does, so a button's stopPropagation is too late: buttons and links inside a row are ruled out here.
          onRowClicked={onRowClick ? (e) => {
            if (e.data && !(e.event?.target instanceof Element && e.event.target.closest("a, button"))) onRowClick(e.data);
          } : undefined}
          rowStyle={onRowClick ? { cursor: "pointer" } : undefined}
          overlayNoRowsTemplate={`<span style="opacity:.7">${empty}</span>`}
        />
        </AgGridProvider>
      </div>
    </div>
  );
}

export const chartPalette = ["#2f5bea", "#0f9d94", "#c27803", "#6d4ae0", "#c42b2b", "#7c8597", "#3aa0e8"];
export const chartPaletteDark = ["#7090ff", "#2ec4b9", "#f0a531", "#a48bff", "#f26d6d", "#9aa1b2", "#5bb8f5"];
/** The chart palette for the theme on screen, for series that need a fixed colour per meaning. */
export function usePalette() {
  return useResolvedTheme() === "dark" ? chartPaletteDark : chartPalette;
}
/** The neutral "comparison" series colour (the baseline), readable in both themes. */
export function useNeutralFill() {
  return useResolvedTheme() === "dark" ? "#4a4e5c" : "#c9ccd6";
}

export function Chart({ options, height = 260 }: { options: AgChartOptions; height?: number }) {
  const dark = useResolvedTheme() === "dark";
  const palette = dark ? chartPaletteDark : chartPalette;
  const merged = {
    background: { fill: "transparent" },
    padding: { top: 8, right: 8, bottom: 8, left: 8 },
    theme: {
      baseTheme: dark ? "ag-default-dark" : "ag-default",
      palette: { fills: palette, strokes: palette },
      params: { fontFamily: "Inter Variable, Inter, system-ui, sans-serif", fontSize: 12, foregroundColor: dark ? "#c7c9d1" : "#3b3d45" },
    },
    ...options,
  } as AgChartOptions;
  return <AgCharts options={merged} style={{ height, width: "100%" }} />;
}
