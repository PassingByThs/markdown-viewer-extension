/**
 * Plugin HTML Utilities
 * Converts unified plugin render results to HTML
 */

import type { PluginRenderResult, UnifiedRenderResult } from '../types/index';
import { registerDiagramExport } from '../ui/diagram-export-registry';

/**
 * Convert unified plugin render result to HTML string
 * @param id - Placeholder element ID
 * @param renderResult - Unified render result from plugin.renderToCommon()
 * @param pluginType - Plugin type for alt text
 * @param sourceHash - Content hash for DOM diff matching
 * @returns HTML string
 */
export function convertPluginResultToHTML(
  id: string,
  renderResult: UnifiedRenderResult,
  pluginType = 'diagram',
  sourceHash?: string
): string {
  if (renderResult.type === 'empty') {
    return '';
  }
  
  if (renderResult.type === 'error') {
    return `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${renderResult.content.text}</pre>`;
  }
  
  // Handle PNG image format
  if (renderResult.type === 'image') {
    const { base64, width } = renderResult.content;
    const { inline } = renderResult.display;
    // Renderer outputs the PNG at 4x for retina sharpness; design display width is 1/4 of intrinsic.
    // Strategy: design width on the wrapper <div>; <img> stays fully auto, bounded by
    // max-width:100% and (in print) max-height. Both <img> dims auto so the CSS replaced-element
    // sizing algorithm preserves aspect ratio when max-height clamps tall diagrams.
    // Alignment (centered by default, left with .diagram-layout-left) is controlled by
    // container-level CSS classes, so no inline margin/text-align is set here.
    const displayWidth = Math.round((width || 0) / 4);
    const wrapperStyle = displayWidth > 0
      ? `width: ${displayWidth}px; max-width: 100%;`
      : '';
    const imgStyle = 'max-width: 100%; height: auto;';

    const dataAttrs = sourceHash 
      ? `data-source-hash="${sourceHash}" data-plugin-type="${pluginType}" data-plugin-rendered="true"` 
      : '';
    
    if (inline) {
      return `<img class="diagram-inline" src="data:image/png;base64,${base64}" alt="${pluginType} diagram" style="${displayWidth > 0 ? `width: ${displayWidth}px; ` : ''}max-width: 100%; height: auto;" ${dataAttrs} />`;
    }
    
    return `<div class="diagram-block" style="${wrapperStyle}" ${dataAttrs}>
      <img src="data:image/png;base64,${base64}" alt="${pluginType} diagram" style="${imgStyle}" />
    </div>`;
  }
  
  return '';
}

/**
 * Create a DOM element from unified plugin render result.
 *
 * Uses createElement + explicit property assignment (img.src = ...) instead of
 * HTML string parsing (outerHTML/innerHTML). This is required because Firefox
 * has a known bug (Bug 2019834) where <img> elements with data: URI src
 * inserted via HTML parsing fail to load on first encounter (clean cache),
 * showing alt text instead of the image. Using createElement bypasses this
 * bug and reliably loads data: URI images across all browsers.
 *
 * @param renderResult - Unified render result from plugin.renderToCommon()
 * @param pluginType - Plugin type for alt text
 * @param sourceHash - Content hash for DOM diff matching
 * @param imgAttrs - Authored <img> attributes (width/height/alt) captured from
 *   the markdown source; they override the renderer-derived display size
 * @returns DOM element, or null for empty results
 */
export function createPluginResultElement(
  renderResult: UnifiedRenderResult,
  pluginType = 'diagram',
  sourceHash?: string,
  imgAttrs?: { width?: string | null; height?: string | null; alt?: string | null } | null
): HTMLElement | null {
  if (renderResult.type === 'empty') {
    return null;
  }

  if (renderResult.type === 'error') {
    const pre = document.createElement('pre');
    pre.style.cssText = 'background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;';
    pre.textContent = renderResult.content.text || '';
    return pre;
  }

  // Handle PNG image format
  if (renderResult.type === 'image') {
    const { base64, width } = renderResult.content;
    const { inline } = renderResult.display;
    // Renderer outputs the PNG at 4x for retina sharpness; design display width
    // is 1/4 of intrinsic. An authored width/height attribute from the source
    // markdown wins over this derived size (standard <img> semantics).
    const displayWidth = Math.round((width || 0) / 4);

    const img = document.createElement('img');
    // Key: set src via JS property assignment, NOT via HTML parser.
    // This bypasses Firefox Bug 2019834 where data: URI images inserted via
    // outerHTML/innerHTML fail to load on first encounter (clean cache).
    img.src = `data:image/png;base64,${base64}`;
    img.alt = (imgAttrs && imgAttrs.alt) || `${pluginType} diagram`;
    img.style.cssText = 'max-width: 100%; height: auto;';

    if (imgAttrs && imgAttrs.width) {
      img.setAttribute('width', imgAttrs.width);
    }
    if (imgAttrs && imgAttrs.height) {
      img.setAttribute('height', imgAttrs.height);
    }

    if (inline) {
      img.className = 'diagram-inline';
      if (!(imgAttrs && imgAttrs.width) && displayWidth > 0) {
        img.style.width = `${displayWidth}px`;
      }
      if (sourceHash) {
        img.dataset.sourceHash = sourceHash;
        img.dataset.pluginType = pluginType;
        img.dataset.pluginRendered = 'true';
      }
      return img;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'diagram-block';
    // Alignment (centered by default, left with .diagram-layout-left) is
    // controlled by container-level CSS classes, so no inline margin/text-align
    // is set here.
    wrapper.style.cssText = displayWidth > 0
      ? `width: ${displayWidth}px; max-width: 100%;`
      : '';
    if (sourceHash) {
      wrapper.dataset.sourceHash = sourceHash;
      wrapper.dataset.pluginType = pluginType;
      wrapper.dataset.pluginRendered = 'true';
    }
    wrapper.appendChild(img);
    return wrapper;
  }

  return null;
}

/**
 * Replace placeholder with rendered content in DOM
 * @param id - Placeholder element ID
 * @param result - Render result with base64, width, height, format
 * @param pluginType - Plugin type
 * @param isInline - Whether to render inline or block
 * @param expectedSourceHash - Source hash to validate against placeholder (prevents race conditions)
 */
export function replacePlaceholderWithImage(id: string, result: PluginRenderResult, pluginType: string, isInline: boolean, expectedSourceHash: string): void {
  const placeholder = document.getElementById(id);
  if (placeholder) {
    // Preserve source hash from placeholder for DOM diff matching
    const sourceHash = (placeholder as HTMLElement).dataset?.sourceHash;

    // Validate source hash match to prevent concurrent rendering race conditions
    if (sourceHash && expectedSourceHash !== sourceHash) {
      // The placeholder belongs to an older render pass: dropping the result is
      // correct, but it is also the moment a diagram can disappear from the page
      // without a trace, so leave a line behind.
      console.warn(
        `[PluginTask] ${pluginType} result dropped for ${id}: source hash changed (rendered ${expectedSourceHash}, current ${sourceHash})`,
      );
      return;
    }

    // Convert result to unified format (always PNG)
    const content: UnifiedRenderResult['content'] = {
      base64: result.base64,
      width: result.width,
      height: result.height
    };

    const renderResult: UnifiedRenderResult = {
      type: 'image',
      content: content,
      display: {
        inline: isInline,
        alignment: isInline ? 'left' : 'center'
      }
    };

    // Authored <img> attributes (width/height/alt) were stored on the
    // placeholder by createPlaceholderElement; re-apply them to the rendered
    // image so standard <img> semantics survive the plugin takeover.
    const element = createPluginResultElement(renderResult, pluginType, sourceHash, {
      width: placeholder.dataset.width || null,
      height: placeholder.dataset.height || null,
      alt: placeholder.dataset.alt || null,
    });
    if (element) {
      placeholder.replaceWith(element);
    } else {
      // createPluginResultElement rejects results it cannot render (e.g. a missing
      // base64 payload). Removing the placeholder then leaves a gap with no other
      // trace, so report the block that was lost.
      console.warn(`[PluginTask] ${pluginType} result could not be turned into an element for ${id} — the block will be missing`);
      placeholder.remove();
    }

    // Register intermediate formats for diagram export (SVG, DrawIO)
    if (sourceHash && (result.svg || result.drawioXml)) {
      registerDiagramExport(sourceHash, {
        pluginType,
        svg: result.svg,
        drawioXml: result.drawioXml,
      });
    }
  }
}
