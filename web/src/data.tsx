// AG Grid and AG Charts live here so only the pages that show data load them.
import { AllCommunityModule, colorSchemeDark, colorSchemeLight, themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
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
});

export function Grid<T>({ rows, columns, height = 420, onRowClick, getRowId, empty = "Nothing here yet" }: {
  rows: T[]; columns: ColDef<T>[]; height?: number | string; onRowClick?: (row: T) => void; getRowId?: (row: T) => string; empty?: string;
}) {
  const theme = useResolvedTheme();
  return (
    <div style={{ height }}>
      <AgGridProvider modules={gridModules}>
      <AgGridReact<T>
        theme={theme === "dark" ? darkGrid : lightGrid}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true, filter: true, flex: 1, minWidth: 110 }}
        animateRows
        suppressCellFocus
        getRowId={getRowId ? (p) => getRowId(p.data) : undefined}
        onRowClicked={onRowClick ? (e) => e.data && onRowClick(e.data) : undefined}
        rowStyle={onRowClick ? { cursor: "pointer" } : undefined}
        overlayNoRowsTemplate={`<span style="opacity:.7">${empty}</span>`}
      />
      </AgGridProvider>
    </div>
  );
}

export const chartPalette = ["#2f5bea", "#0f9d94", "#c27803", "#6d4ae0", "#c42b2b", "#7c8597", "#3aa0e8"];
const chartPaletteDark = ["#7090ff", "#2ec4b9", "#f0a531", "#a48bff", "#f26d6d", "#9aa1b2", "#5bb8f5"];
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
