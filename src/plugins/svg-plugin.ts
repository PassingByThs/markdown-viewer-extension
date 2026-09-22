/**
 * SVG Plugin
 * 
 * Handles SVG code blocks and SVG image files in content script and DOCX export
 */
import { BasePlugin } from './base-plugin';
import type { DocumentService } from '../types/platform';
import type { ASTNode } from '../types/index';
import {
  ensureRelativeDotSlash,
  isAbsoluteFilesystemPath,
  isDocumentRelativeUrl,
  isNetworkUrl,
} from '../utils/document-url';

export class SvgPlugin extends BasePlugin {
  private _currentNodeType: string | null = null;

  constructor() {
    super('svg');
    this._currentNodeType = null; // Track current node type being processed
  }

  /**
   * Extract content from AST node
   * Handles both SVG code blocks and SVG image files
   * @param node - AST node
   * @returns SVG content or URL, or null if not applicable
   */
  extractContent(node: ASTNode): string | null {
    // Store node type for isInline() to use
    this._currentNodeType = node.type;

    // Handle SVG code blocks: ```svg ... ```
    if (node.type === 'code' && node.lang === 'svg') {
      return node.value || null;
    }

    // Handle SVG image files: ![](*.svg)
    if (node.type === 'image') {
      const url = node.url || '';
      const isSvg = url.toLowerCase().endsWith('.svg') || 
                    url.toLowerCase().includes('image/svg+xml');
      if (isSvg) {
        return url; // Return URL for later fetching
      }
    }

    return null;
  }

  /**
   * SVG uses inline rendering for images, block for code blocks
   * @returns True for inline rendering (images), false for block (code blocks)
   */
  isInline(): boolean {
    return this._currentNodeType === 'image';
  }

  /**
   * Check if content is a URL (for image nodes)
   * SVG code block content (containing <svg> tags) is never a URL.
   * @param content - Extracted content
   * @returns True if content is a URL
   */
  isUrl(content: string): boolean {
    // SVG markup from code blocks is not a URL
    if (content.includes('<svg')) {
      return false;
    }
    // Remote URLs are passed directly to the renderer for loading via <img>
    if (isNetworkUrl(content)) {
      return false;
    }
    // File paths: absolute, relative with ../, ./, or with / or \ separators
    // Also treat anything with a file extension as a path
    return content.startsWith('file://') ||
           content.startsWith('data:') ||
           content.startsWith('./') ||
           content.startsWith('../') ||
           content.includes('/') || // Relative paths with directories
           content.includes('\\') || // Windows paths
           /\.\w+$/.test(content); // Any filename with extension (e.g., "test.svg")
  }

  /**
   * Fetch SVG content from URL
   * Uses DocumentService for unified file access across all platforms.
   * @param url - URL to fetch (file://, data:, or relative path)
   * @returns SVG content
   */
  async fetchContent(url: string): Promise<string> {
    // Handle data: URLs (no platform API needed)
    if (url.startsWith('data:image/svg+xml')) {
      const base64Match = url.match(/^data:image\/svg\+xml;base64,(.+)$/);
      if (base64Match) {
        return atob(base64Match[1]);
      }
      const urlMatch = url.match(/^data:image\/svg\+xml[;,](.+)$/);
      if (urlMatch) {
        return decodeURIComponent(urlMatch[1]);
      }
      throw new Error('Unsupported SVG data URL format');
    }

    // Get DocumentService from platform
    const doc = (globalThis.platform as { document?: DocumentService } | undefined)?.document;
    if (!doc) {
      throw new Error('DocumentService not available - platform not initialized');
    }

    try {
      if (url.startsWith('file://')) {
        return await doc.readFile(url.slice(7));
      }

      if (url.startsWith('data:')) {
        return await doc.readFile(url);
      }

      if (isDocumentRelativeUrl(url)) {
        const normalizedRelativePath = ensureRelativeDotSlash(url);
        const resolvedPath = doc.resolvePath(normalizedRelativePath);
        return isAbsoluteFilesystemPath(resolvedPath)
          ? await doc.readFile(stripFileProtocol(resolvedPath))
          : await doc.readRelativeFile(resolvedPath);
      }

      return await doc.readFile(stripFileProtocol(url));
    } catch (error) {
      throw new Error(`Cannot load SVG file: ${url} - ${(error as Error).message}`);
    }
  }

  /**
   * Plain-<img> fallback for a local SVG image whose source cannot be read.
   *
   * The browser can still load the file as an ordinary image — that is exactly
   * how the equivalent .png node is rendered — so showing it beats replacing the
   * picture with an error block when the platform blocks local file reads
   * (Firefox content scripts cannot read file:// URLs at all).
   *
   * Only local image nodes in local documents qualify: network URLs never reach
   * fetchContent() (the renderer loads them through <img> directly), and a
   * data: URL needs no platform access.
   *
   * @param content - Extracted node content (the image URL)
   * @param node - AST node being processed
   * @returns Relative URL to render as <img>, or null when no fallback applies
   */
  createFetchFallbackUrl(content: string, node?: ASTNode): string | null {
    const isImageNode = node ? node.type === 'image' : this._currentNodeType === 'image';
    if (!isImageNode || !content) {
      return null;
    }
    if (content.startsWith('data:') || isNetworkUrl(content)) {
      return null;
    }
    // Only for local documents. There the browser loads the file itself (the
    // same way it already loads the .png next to it), which beats an error
    // block. For remote documents a failed fetch is far more likely to be a
    // 404/CORS problem, where the error text is the more useful outcome.
    if (typeof window === 'undefined' || window.location?.protocol !== 'file:') {
      return null;
    }
    // Same normalization rehype-image-uri applies to every other image, so the
    // fallback resolves exactly like a .png would.
    return ensureRelativeDotSlash(content);
  }

  /**
   * Get AST node selector(s) for remark visit
   * SVG plugin handles both code blocks and image nodes
   * @returns Array of node types ['code', 'image']
   */
  get nodeSelector(): string[] {
    return ['code', 'image'];
  }
}

function stripFileProtocol(path: string): string {
  return path.startsWith('file://') ? path.slice(7) : path;
}
