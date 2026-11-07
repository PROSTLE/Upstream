// AG Studio theme for /insights. Colours, borders and radii are the app's own design tokens
// (web/src/styles.css), and the chart palette is the app's (chartPalette in data.tsx), so the board
// reads as one more page of the app. Two named modes follow the app's light/dark switch, the same way
// lightGrid and darkGrid do for the app's own grids: Insights.tsx sets data-ag-theme-mode.
import { studioTheme } from "ag-studio";
import { chartPalette, chartPaletteDark } from "../data.tsx";

export const LIGHT_MODE = "upstream-light";
export const DARK_MODE = "upstream-dark";

const FONT = 'var(--font)';

const paletteParams = (colors: string[]) =>
  Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => {
      const c = colors[i % colors.length];
      return [[`chartPaletteFills${i + 1}Color`, c], [`chartPaletteStrokes${i + 1}Color`, c]];
    }).flat(),
  );

const tokens = {
  light: { canvas: "#f6f6f3", surface: "#ffffff", surface2: "#fafaf8", border: "#e7e6e0", rowBorder: "#f0efea", text: "#14151a", muted: "#676973", accent: "#2f5bea", hover: "#f5f7ff", selected: "#eef2fe" },
  dark: { canvas: "#0d0e11", surface: "#15161b", surface2: "#1a1c22", border: "#282a32", rowBorder: "#22242b", text: "#ecedf1", muted: "#989ba8", accent: "#7090ff", hover: "#1d2030", selected: "#1f2540" },
};

function params(t: (typeof tokens)["light"], palette: string[], scheme: "light" | "dark") {
  const line = (color: string) => ({ width: 1, color });
  return {
    browserColorScheme: scheme,
    fontFamily: FONT,
    fontSize: 14,
    textColor: t.text,
    foregroundColor: t.text,
    subtleTextColor: t.muted,
    backgroundColor: t.surface,
    borderColor: t.border,
    accentColor: t.accent,
    iconColor: t.muted,
    rowHoverColor: t.hover,

    // The canvas is the page itself: no frame, the app's background, widgets as the app's cards.
    studioWrapperBorder: false,
    studioWrapperBorderRadius: 0,
    studioWrapperSpacing: 0,
    studioWrapperBackgroundColor: t.canvas,
    studioCanvasBorder: false,
    studioCanvasBorderRadius: 0,
    studioCanvasShadow: false,
    studioCanvasBackgroundColor: t.canvas,
    studioCanvasPadding: 12,
    studioCanvasRowHeight: 18,
    studioCanvasFontFamily: FONT,

    studioWidgetBackgroundColor: t.surface,
    studioWidgetBorder: line(t.border),
    studioWidgetBorderRadius: 14,
    studioWidgetPadding: 12,
    studioWidgetTitleFontFamily: FONT,
    studioWidgetTitleFontSize: 15,
    studioWidgetTitleFontWeight: 600,
    studioWidgetTitleTextColor: t.text,
    studioWidgetSubtitleFontFamily: FONT,
    studioWidgetSubtitleFontSize: 13,
    studioWidgetSubtitleTextColor: t.muted,
    studioWidgetCaptionFontFamily: FONT,
    studioWidgetCaptionFontSize: 12,
    studioWidgetCaptionTextColor: t.muted,
    studioWidgetResizeBorderColor: t.accent,

    studioPanelContainerBackgroundColor: t.surface,
    studioPanelContainerBorder: line(t.border),
    studioPanelContainerBorderRadius: 14,
    studioPanelDividerColor: t.border,
    studioPanelDividerActiveColor: t.accent,
    studioPanelSectionBorderColor: t.border,
    studioPanelHeaderFontFamily: FONT,
    studioPanelHeaderFontWeight: 600,
    studioPanelChevronButtonHoverBackgroundColor: t.hover,
    studioPanelChevronButtonHoverColor: t.accent,
    studioToggleButtonActiveBackgroundColor: t.selected,
    studioToggleButtonActiveBorderColor: t.accent,
    studioToggleButtonActiveColor: t.accent,

    gridFontFamily: FONT,
    gridFontSize: 13,
    gridCellTextColor: t.text,
    gridHeaderBackgroundColor: t.surface2,
    gridHeaderTextColor: t.muted,
    gridHeaderFontWeight: 600,
    gridHeaderFontSize: 12,
    gridRowHeight: 36,
    gridRowBorder: line(t.rowBorder),
    gridHeaderRowBorder: line(t.border),
    gridPinnedRowBorder: line(t.border),
    gridRowHoverColor: t.hover,
    gridWrapperBorder: false,

    chartFontFamily: FONT,
    chartTextColor: t.text,
    chartSubtleTextColor: t.muted,
    chartAxisLineColor: t.border,
    chartGridLineColor: t.rowBorder,
    ...paletteParams(palette),
  };
}

export const insightsTheme = studioTheme
  .withParams(params(tokens.light, chartPalette, "light"), LIGHT_MODE)
  .withParams(params(tokens.dark, chartPaletteDark, "dark"), DARK_MODE);
