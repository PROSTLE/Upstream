// AG Grid and AG Charts live here so only the pages that show data load them.
import { AllCommunityModule, colorSchemeLight, themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { AllCommunityModule as ChartsModule, ModuleRegistry as ChartsRegistry, type AgChartOptions } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";

ChartsRegistry.registerModules([ChartsModule]);
const gridModules = [AllCommunityModule];

// ---------- AG Grid & AG Charts ----------

export const gridTheme = themeQuartz.withPart(colorSchemeLight).withParams({
  fontFamily: ["Inter Variable", "system-ui", "sans-serif"],
  fontSize: 13,
  backgroundColor: "#ffffff",
  foregroundColor: "#15161a",
  accentColor: "#2f5bea",
  borderColor: "#ecebe5",
  headerBackgroundColor: "#fbfbf9",
  headerTextColor: "#6c6e78",
  headerFontWeight: 600,
  rowHoverColor: "#f6f8ff",
  selectedRowBackgroundColor: "#eef2fe",
  wrapperBorderRadius: 14,
  wrapperBorder: false,
  spacing: 7,
  rowBorder: { color: "#f0efea" },
  columnBorder: false,
});

export function Grid<T>({ rows, columns, height = 420, onRowClick, getRowId }: {
  rows: T[]; columns: ColDef<T>[]; height?: number | string; onRowClick?: (row: T) => void; getRowId?: (row: T) => string;
}) {
  return (
    <div style={{ height }}>
      <AgGridProvider modules={gridModules}>
      <AgGridReact<T>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true, filter: true, flex: 1, minWidth: 110 }}
        animateRows
        suppressCellFocus
        getRowId={getRowId ? (p) => getRowId(p.data) : undefined}
        onRowClicked={onRowClick ? (e) => e.data && onRowClick(e.data) : undefined}
        rowStyle={onRowClick ? { cursor: "pointer" } : undefined}
        overlayNoRowsTemplate='<span style="color:#6c6e78">Nothing here yet</span>'
      />
      </AgGridProvider>
    </div>
  );
}

export const chartPalette = ["#2f5bea", "#0f9d94", "#c27803", "#6d4ae0", "#c42b2b", "#7c8597", "#3aa0e8"];

export function Chart({ options, height = 260 }: { options: AgChartOptions; height?: number }) {
  const merged = {
    background: { fill: "transparent" },
    padding: { top: 8, right: 8, bottom: 8, left: 8 },
    theme: {
      baseTheme: "ag-default",
      palette: { fills: chartPalette, strokes: chartPalette },
      params: { fontFamily: "Inter Variable, Inter, system-ui, sans-serif", fontSize: 12, foregroundColor: "#3d3f47" },
    },
    ...options,
  } as AgChartOptions;
  return <AgCharts options={merged} style={{ height, width: "100%" }} />;
}
