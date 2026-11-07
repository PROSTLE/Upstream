// A widget's `formatShape` must return an AG Studio shape, which Studio uses to keep the widget's
// options when a report is reloaded and to tell its agents what they may set. Studio exports no
// standalone shape builder, but `api.defineAiCommand` hands one to its factory synchronously, so a
// format shape borrows it there. The command itself is never registered or run.
import type { AgFormatShapeParams, AgShapeBuilder, AgStudioApi } from "ag-studio";

export function shapeBuilder(params: AgFormatShapeParams): AgShapeBuilder {
  let builder: AgShapeBuilder | undefined;
  (params.api as unknown as AgStudioApi).defineAiCommand(((s: AgShapeBuilder) => {
    builder = s;
    return { input: s.object({}), execute: async () => ({ success: true, value: undefined }) };
  }) as never);
  if (!builder) throw new Error("AG Studio did not provide a shape builder.");
  return builder;
}

/** The cross-filter options every clickable widget keeps (see createCrossFilterSection). */
export const crossFilterProps = (s: AgShapeBuilder) => ({
  crossFilter: s.enum(["highlight", "filter", "none"], { description: 'How this widget follows cross filters from other widgets: "highlight" dims what does not match, "filter" hides it.' }).optional(),
  triggerCrossFilter: s.boolean({ description: "Whether clicking a row here filters the rest of the board. Defaults to true." }).optional(),
});
