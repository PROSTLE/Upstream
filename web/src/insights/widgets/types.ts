// Types for Upstream's two AG Studio widgets, registered so Studio's state and forms are typed.
import type { AgBaseRegistry, AgBaseWidgetDefinition, AgDefaultWidgetDefinition, AgWidgetDataFormat, AgWidgetFieldReference } from "ag-studio";

export interface DeclaredVsUsedStyle {
  /** Heading drawn at the top of the widget. */
  heading?: string;
  /** Tag packages the dependency list pays but the agent never used. */
  showNeverUsed?: boolean;
  /** How many packages to draw, largest first. */
  maxRows?: number;
}
export interface DeclaredVsUsedDef {
  type: "declared-vs-used";
  dataMapping: {
    package: AgWidgetFieldReference[];
    listed: AgWidgetFieldReference[];
    used: AgWidgetFieldReference[];
    sessions: AgWidgetFieldReference[];
  };
  format?: AgWidgetDataFormat<DeclaredVsUsedStyle>;
}

export interface MoneyTrailStyle {
  heading?: string;
  maxRows?: number;
}
export interface MoneyTrailDef {
  type: "money-trail";
  dataMapping: {
    repo: AgWidgetFieldReference[];
    held: AgWidgetFieldReference[];
    sent: AgWidgetFieldReference[];
    paid: AgWidgetFieldReference[];
    claim?: AgWidgetFieldReference[];
    paypal?: AgWidgetFieldReference[];
    expires?: AgWidgetFieldReference[];
  };
  format?: AgWidgetDataFormat<MoneyTrailStyle>;
}

export interface UpstreamRegistry extends AgBaseRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | AgBaseWidgetDefinition<"declared-vs-used", DeclaredVsUsedDef> | AgBaseWidgetDefinition<"money-trail", MoneyTrailDef>)[];
}

/** Passed to every widget through Studio's `context` property. */
export interface InsightsContext {
  currency: string;
}
