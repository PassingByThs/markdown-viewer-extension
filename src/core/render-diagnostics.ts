/**
 * Render Diagnostics
 *
 * A structured channel for what goes wrong while the render pipeline works: a
 * diagram engine that threw, a block whose content was dropped, an image that
 * could not be read. The console warning stays the human-facing signal (the
 * extension's devtools log, the CLI's `[browser]` passthrough); this sink turns
 * the same events into data a host can act on — which engine, which markdown
 * line, why — so a batch render can report failures instead of only logging
 * them (see the documd CLI's diagram-error report).
 *
 * Diagnostics are additive: recording one never changes what the document
 * renders. Only a host that reads the sink decides what a diagnostic means
 * (e.g. "the export exits non-zero").
 */

export type RenderDiagnosticLevel = 'error' | 'warning';

export type RenderDiagnosticKind =
  /** An engine threw while rendering a block. */
  | 'render-failed'
  /** A block produced nothing and was dropped — content is missing. */
  | 'block-missing'
  /** A stale result was dropped on purpose (a newer render superseded it). */
  | 'block-superseded'
  /** A resource (diagram source, image) could not be fetched or read. */
  | 'resource-failed';

export interface RenderDiagnostic {
  level: RenderDiagnosticLevel;
  kind: RenderDiagnosticKind;
  /** Plugin / diagram type (plantuml, mermaid, html, image, ...) when known. */
  type?: string | null;
  /** 1-based line in the markdown source, when the block position was known. */
  line?: number | null;
  /** Placeholder id of the block the problem belongs to, when there is one. */
  blockId?: string | null;
  message: string;
}

const diagnostics: RenderDiagnostic[] = [];

/**
 * Record one diagnostic. Call this next to the console warning it mirrors, so
 * the log and the report never disagree about what happened.
 */
export function recordRenderDiagnostic(diagnostic: RenderDiagnostic): void {
  diagnostics.push({
    type: null,
    line: null,
    blockId: null,
    ...diagnostic,
  });
}

/** Snapshot of the diagnostics recorded since the last reset. */
export function getRenderDiagnostics(): RenderDiagnostic[] {
  return diagnostics.slice();
}

/** Drop everything recorded so far (a host calls this before each render). */
export function clearRenderDiagnostics(): void {
  diagnostics.length = 0;
}
