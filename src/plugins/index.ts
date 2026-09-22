/**
 * Plugin Registry
 * 
 * Centralized plugin management system.
 * New plugins can be added here without modifying main.js or docx-exporter.js.
 * 
 * Architecture:
 * - registerRemarkPlugins(): Register all plugins for remark processing (main.js)
 * - getPluginByType(): Get a specific plugin by type (docx-exporter.js)
 * - plugins: Direct access to plugin array (for advanced use)
 */
import { MermaidPlugin } from './mermaid-plugin';
import { VegaLitePlugin } from './vegalite-plugin';
import { VegaPlugin } from './vega-plugin';
import { HtmlPlugin } from './html-plugin';
import { SvgPlugin } from './svg-plugin';
import { DotPlugin } from './dot-plugin';
import { InfographicPlugin } from './infographic-plugin';
import { JsonCanvasPlugin } from './canvas-plugin';
import { DrawioPlugin } from './drawio-plugin';
import { PlantumlPlugin } from './plantuml-plugin';
import { EchartsPlugin } from './echarts-plugin';
import { replacePlaceholderWithImage } from './plugin-html-utils';
import { createErrorHTML, withNodeSourceInfo } from './plugin-content-utils';
import { recordRenderDiagnostic } from '../core/render-diagnostics';
import { convertPluginResultToDOCX, withBlockImageAlignment } from '../exporters/docx-exporter';
import { syncBlockHtmlFromDOM } from '../core/viewer/viewer-controller';
import type { BasePlugin } from './base-plugin';
import type { Processor } from 'unified';
import type { Node, Parent } from 'unist';
import type {
  TaskData,
  TaskStatus,
  AsyncTaskResult,
  AsyncTaskPlugin,
  AsyncTaskQueueManager,
  TranslateFunction,
  EscapeHtmlFunction,
  PlaceholderResult,
  PluginRenderer,
  PluginRenderResult
} from '../types/index';

// ============================================================================
// Type Definitions
// ============================================================================

// PluginRenderer / PluginRenderResult are defined in src/types/plugin.ts

/**
 * Visit function type from unist-util-visit
 */
type VisitFn = (
  tree: Node,
  test: string,
  visitor: (node: Node, index: number | undefined, parent: Parent | undefined) => void
) => void;

/**
 * DOCX helper objects
 */
interface DOCXHelpers {
  [key: string]: unknown;
}

// ============================================================================
// Plugin Instances
// ============================================================================

// Plugin instances array
// Order matters: HTML plugin first to process raw HTML before other plugins generate placeholders
export const plugins: BasePlugin[] = [
  new HtmlPlugin(),
  new MermaidPlugin(),
  new VegaLitePlugin(),
  new VegaPlugin(),
  new SvgPlugin(),
  new DotPlugin(),
  new InfographicPlugin(),
  new JsonCanvasPlugin(),
  new DrawioPlugin(),
  new PlantumlPlugin(),
  new EchartsPlugin()
];

// ============================================================================
// Plugin Registration
// ============================================================================

/**
 * Register all plugins to a remark processor
 * This creates a single unified plugin that processes all node types in document order
 * @param processor - Unified/remark processor
 * @param renderer - Renderer instance
 * @param asyncTask - Async task creator from AsyncTaskQueueManager
 * @param translate - Translation function
 * @param escapeHtml - HTML escape function
 * @param visit - unist-util-visit function
 * @returns The processor (for chaining)
 */
export function registerRemarkPlugins(
  processor: Processor,
  renderer: PluginRenderer,
  asyncTask: AsyncTaskQueueManager['asyncTask'],
  translate: TranslateFunction,
  escapeHtml: EscapeHtmlFunction,
  visit: VisitFn
): Processor {
  // Create a unified plugin that processes all plugins in a single AST traversal
  processor.use(function unifiedPluginProcessor() {
    return (tree: Node) => {
      // Collect all unique node types that plugins are interested in
      const nodeTypes = new Set<string>();
      for (const plugin of plugins) {
        for (const nodeType of plugin.nodeSelector) {
          nodeTypes.add(nodeType);
        }
      }

      // Single traversal of AST, processing nodes in document order
      for (const nodeType of nodeTypes) {
        visit(tree, nodeType, (node: Node, index: number | undefined, parent: Parent | undefined) => {
          if (index === undefined || !parent) return;
          
          // Find the first plugin that can handle this node
          for (const plugin of plugins) {
            const content = plugin.extractContent(node);
            if (!content) continue;

            // Capture inline/block mode at match time. Some plugins (notably SVG)
            // derive inline mode from the current AST node type; reading isInline()
            // later inside async callbacks can observe a different node and corrupt
            // layout (e.g. inline badge images becoming block diagrams).
            const isInline = plugin.isInline();

            // This plugin can handle this node, create async task
            const initialStatus = plugin.isUrl(content) ? 'fetching' : 'ready';
            const placeholderPlugin = { ...plugin, isInline: () => isInline } as typeof plugin;

            // Resolve the plain-image fallback now, while this node is in hand:
            // if fetching the URL fails later, the task manager can still show
            // the resource as a native <img> instead of an error block.
            const taskData = withNodeSourceInfo(plugin.createTaskData(content), node);
            const fetchFallbackUrl = plugin.createFetchFallbackUrl(content, node);
            if (fetchFallbackUrl) {
              taskData.fetchFallbackUrl = fetchFallbackUrl;
            }

            const result = asyncTask(
              async (data: TaskData) => {
                const { id, code, sourceHash } = data;
                
                // Check if placeholder exists BEFORE rendering
                const placeholderBefore = document.getElementById(id);
                
                if (!placeholderBefore) {
                  // A newer render replaced the document while this task waited: the
                  // block is rendered by that pass instead. Keep this quiet — it is
                  // normal supersede traffic, not a failure.
                  return;
                }                
                try {
                  // Preprocess content (e.g., inline local images for HTML plugin)
                  const processedCode = await plugin.preprocessContent(code || '');
                  const renderResult = await renderer.render(plugin.type, processedCode);
                  
                  if (renderResult) {
                    replacePlaceholderWithImage(id, renderResult, plugin.type, isInline, sourceHash as string);
                    // Sync rendered content back to in-memory cache
                    // This ensures block moves don't lose rendered diagrams
                    syncBlockHtmlFromDOM(id);
                  } else {
                    // The renderer resolved without producing anything. Removing the
                    // placeholder leaves a gap in the document, so say why instead of
                    // leaving the reader (and the logs) with nothing.
                    const noResultLine = typeof data.sourceLine === 'number' ? data.sourceLine : null;
                    console.warn(
                      `[PluginTask] ${plugin.type} produced no result for ${id}${noResultLine ? ` (line ${noResultLine})` : ''} — the block will be missing`,
                    );
                    recordRenderDiagnostic({
                      level: 'error',
                      kind: 'block-missing',
                      type: plugin.type,
                      line: noResultLine,
                      blockId: id,
                      message: 'the renderer produced no result — the block will be missing',
                    });
                    const placeholder = document.getElementById(id);
                    if (placeholder) {
                      placeholder.remove();
                    }
                  }
                } catch (error) {
                  // Ignore cancellation errors silently
                  if ((error as Error).message === 'Render cancelled' || 
                      (error as Error).message === 'Request cancelled') {
                    return;
                  }
                  // Report as a concise warning with the source line — the
                  // error is already surfaced in the document itself via the
                  // placeholder error block, so a full stack trace here is
                  // noise (and would be dumped into every CLI export).
                  const sourceLine = typeof data.sourceLine === 'number' ? data.sourceLine : null;
                  console.warn(
                    `[PluginTask] ${plugin.type} render failed for ${id}${sourceLine ? ` (line ${sourceLine})` : ''}: ${(error as Error).message}`,
                  );
                  recordRenderDiagnostic({
                    level: 'error',
                    kind: 'render-failed',
                    type: plugin.type,
                    line: sourceLine,
                    blockId: id,
                    message: (error as Error).message,
                  });
                  const placeholder = document.getElementById(id);
                  if (placeholder) {
                    const errorDetail = escapeHtml((error as Error).message || '');
                    const localizedError = translate('async_processing_error', [plugin.type, errorDetail]) 
                      || `${plugin.type} error: ${errorDetail}`;
                    placeholder.outerHTML = createErrorHTML(localizedError, {
                      pluginType: plugin.type,
                      sourceLine,
                      blockId: id,
                    });
                    // Also sync error state to memory
                    syncBlockHtmlFromDOM(id);
                  }
                }
              },
              taskData,
              placeholderPlugin,
              translate,
              initialStatus
            );

            // For URLs, start fetching immediately
            if (plugin.isUrl(content)) {
              plugin.fetchContent(content)
                .then((fetchedContent: string) => {
                  result.task.data.code = fetchedContent;
                  result.task.setReady();
                })
                .catch((error: Error) => {
                  result.task.setError(error);
                });
            }

            (parent.children as Node[])[index] = result.placeholder;
            
            // Stop checking other plugins once we found a match
            break;
          }
        });
      }
    };
  });

  return processor;
}

// ============================================================================
// Plugin Lookup Functions
// ============================================================================

/**
 * Get a plugin by type
 * @param type - Plugin type (e.g., 'mermaid', 'svg', 'html')
 * @returns Plugin instance or null if not found
 */
export function getPluginByType(type: string): BasePlugin | null {
  return plugins.find(p => p.type === type) || null;
}

/**
 * Get a plugin that can handle a specific AST node
 * @param node - AST node (e.g., code block or html node)
 * @returns Plugin instance or null if no plugin can handle
 */
export function getPluginForNode(node: Node): BasePlugin | null {
  for (const plugin of plugins) {
    if (plugin.extractContent(node) !== null) {
      return plugin;
    }
  }
  
  return null;
}

/**
 * Get all plugin types
 * @returns Array of plugin types
 */
export function getPluginTypes(): string[] {
  return plugins.map(p => p.type);
}

// ============================================================================
// DOCX Conversion
// ============================================================================

/**
 * Convert AST node to DOCX element using appropriate plugin
 * High-level wrapper that encapsulates plugin lookup, content extraction, and conversion
 * 
 * @param node - AST node to convert
 * @param renderer - Renderer instance for generating images
 * @param docxHelpers - DOCX helper objects and functions
 * @param progressCallback - Optional callback to report progress
 * @returns DOCX element (Paragraph/ImageRun) or null if no plugin handles this node
 */
export async function convertNodeToDOCX(
  node: Node,
  renderer: PluginRenderer,
  docxHelpers: DOCXHelpers,
  progressCallback: (() => void) | null = null
): Promise<unknown | null> {
  // Find plugin that can handle this node
  const plugin = getPluginForNode(node);
  if (!plugin) {
    return null;
  }

  // Extract content from node
  let content = plugin.extractContent(node);
  if (!content) {
    return null;
  }

  // Handle URL fetching if needed
  if (plugin.isUrl && plugin.isUrl(content)) {
    content = await plugin.fetchContent(content);
  }

  // Render to unified format
  let renderResult = await plugin.renderToCommon(renderer, content);

  // Report plugin failures once, as a concise warning with the source line —
  // the error text is also carried into the DOCX itself via the error result.
  // The diagnostic is what lets a host (the documd CLI) fail the conversion
  // instead of only printing a line a batch render would scroll past.
  if (renderResult.type === 'error') {
    const position = (node as { position?: { start?: { line?: number } } }).position;
    const line = position?.start?.line;
    const reason = renderResult.content.text || 'the engine failed to render this block';
    console.warn(
      `[PluginTask] ${plugin.type} render failed${line ? ` (line ${line})` : ''}: ${reason}`,
    );
    recordRenderDiagnostic({
      level: 'error',
      kind: 'render-failed',
      type: plugin.type,
      line: typeof line === 'number' ? line : null,
      blockId: null,
      message: reason,
    });
  }

  // Block diagrams/charts should follow the user's diagram alignment setting in DOCX.
  if (plugin.type !== 'image' && renderResult.type === 'image' && !renderResult.display.inline) {
    const diagramLayout = (docxHelpers.diagramLayout === 'left' ? 'left' : 'center') as 'left' | 'center';
    renderResult = withBlockImageAlignment(renderResult, diagramLayout);
  }
  
  // Convert to DOCX
  const result = convertPluginResultToDOCX(renderResult, plugin.type);

  // Report progress if callback provided
  if (progressCallback) {
    progressCallback();
  }

  return result;
}
