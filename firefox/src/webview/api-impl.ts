/**
 * Firefox Platform API Implementation
 * 
 * Runs in content script context, uses browser.* API.
 * Uses background page rendering (Firefox MV2 background page has DOM access).
 * This is similar to Chrome's Offscreen API approach.
 */

import {
  BaseI18nService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE
} from '../../../src/services';

import type { LocaleMessages } from '../../../src/services';
import type { PlatformBridgeAPI } from '../../../src/types/index';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { BrowserRuntimeTransport } from '../../../chrome/src/transports/chrome-runtime-transport';
import { getWebExtensionApi } from '../../../src/utils/platform-info';

import { BackgroundRenderHost } from './hosts/background-render-host';

import { CacheService, StorageService, FileService, FileStateService, RendererService, SettingsService, createSettingsService } from '../../../src/services';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Download options
 */
interface DownloadOptions {
  mimeType?: string;
  [key: string]: unknown;
}

// ============================================================================
// Service Channel (Background ↔ Content Script)
// ============================================================================

const backgroundServiceChannel = new ServiceChannel(new BrowserRuntimeTransport(), {
  source: 'firefox-content',
  timeoutMs: 30000,
});

const webExtensionApi = getWebExtensionApi();

// Unified cache service (same as Chrome/Mobile)
const cacheService = new CacheService(backgroundServiceChannel);

// Unified storage service (same as Chrome/Mobile)
const storageService = new StorageService(backgroundServiceChannel);

// Unified file service (same as Chrome/Mobile)
const fileService = new FileService(backgroundServiceChannel);

// Unified file state service (same as Chrome/Mobile)
const fileStateService = new FileStateService(backgroundServiceChannel);

// Bridge compatibility layer (for plugins that need direct message access)
export const bridge: PlatformBridgeAPI = {
  sendRequest: async <T = unknown>(type: string, payload: unknown): Promise<T> => {
    return (await backgroundServiceChannel.send(type, payload)) as T;
  },
  postMessage: (type: string, payload: unknown): void => {
    backgroundServiceChannel.post(type, payload);
  },
  addListener: (handler: (message: unknown) => void): (() => void) => {
    return backgroundServiceChannel.onAny((message) => {
      handler(message);
    });
  },
};

// ============================================================================
// Firefox Document Service
// ============================================================================

import { BaseDocumentService } from '../../../src/services/document-service';
import type { ReadFileOptions } from '../../../src/types/platform';
import { loadImageAsBuffer } from '../../../src/utils/image-loader';
import {
  readFromPickedFiles,
  noteLocalReadSuccess,
  prepareLocalResourceAccess as promptForLocalResources,
} from './local-file-access';

/**
 * Firefox Document Service Implementation
 *
 * Firefox refuses to let *extension* contexts read `file://` URLs: `fetch()`
 * from the content script is rejected with "NetworkError when attempting to
 * fetch resource" / "Cross-Origin Request Blocked … CORS request not http".
 *
 * Local reads therefore try, in order: the background page (it runs on the
 * `moz-extension://` origin and can fetch local files once the extension holds
 * the Firefox 153+ "Access local files on your computer" permission,
 * about:addons → Permissions and data, mirroring what Chrome's offscreen
 * document does for the Chrome build), a helper injected into the page (reads
 * with the page's own privileges, returns the file untouched), and a plain
 * content-script fetch. Image bytes additionally fall back to rasterising the
 * file through a canvas, so they survive even when every read path is denied.
 *
 * Only the background page depends on that permission, which is why the other
 * paths exist: granting it is not optional on Firefox 153+ — without it Firefox
 * does not even inject the content script into `file://` documents, so the
 * viewer never starts — and every reinstall/update resets it (the popup warns
 * and offers a one-click grant, see checkFileAccess in ui-helpers.ts). The
 * failure is reported with the state of every path.
 *
 * Remote URLs are always read from the content script so they keep the page's
 * own credentials (a background fetch would be cookie-less).
 */
class FirefoxDocumentService extends BaseDocumentService {
  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    return this.readUrl(toFileUrl(absolutePath), options);
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    // Resolve relative path based on current document location
    const absoluteUrl = new URL(relativePath, window.location.href).href;
    return this.readUrl(absoluteUrl, options);
  }

  /**
   * Read a URL.
   *
   * Local (file:) URLs run through every path in turn (background page, page
   * helper, content script, and for images a canvas raster); each fails fast, and
   * the combined failure is reported with the state of every path.
   *
   * @param url - Absolute URL (file://, http(s)://)
   * @param options - Read options
   * @returns File content (string, or base64 when `binary` is set)
   */
  private async readUrl(url: string, options?: ReadFileOptions): Promise<string> {
    const binary = options?.binary ?? false;

    if (!url.startsWith('file:')) {
      return fetchUrlAsText(url, binary);
    }

    // Files the user handed over through the folder picker need no permission at
    // all, so they are tried first — and on a default Firefox profile they are
    // the only readable source of local contents.
    const picked = await readFromPickedFiles(url, binary);
    if (picked !== null) {
      return picked;
    }

    const attempts: Array<[string, () => Promise<string>]> = [
      ['background page', () => readViaBackgroundPage(url, binary)],
      ['page helper', () => readViaPageContext(url, binary)],
      ['content script', () => fetchUrlAsText(url, binary)],
    ];

    // Last resort for image bytes: let the document load the file into an <img>
    // and rasterise it through a canvas. The load is performed by the page, not
    // by the extension, so it works even when Firefox denies the extension every
    // file read — although a local file is its own origin on a default profile,
    // which taints the canvas and leaves the pixels unreadable too.
    if (binary) {
      attempts.push(['image element', () => readImageElementAsPng(url)]);
    }

    const failures: string[] = [];
    for (const [label, attempt] of attempts) {
      try {
        const content = await attempt();
        noteLocalReadSuccess();
        return content;
      } catch (error) {
        failures.push(`${label}: ${(error as Error).message}`);
      }
    }

    await warnLocalFileAccessBlocked();
    throw new Error(failures.join('; '));
  }
}

/**
 * Recover image bytes by rasterising the file through the document.
 *
 * `<img>` subresource loads are performed by the page itself (that is how local
 * images already render in the viewer), and on Firefox a canvas that draws an
 * image from the document's own directory is left origin-clean, so
 * `toDataURL()` yields the pixels. This costs a re-encode to PNG — hence it is
 * only the last resort, after the paths that preserve the original bytes.
 *
 * @param url - Absolute file:// URL of an image
 * @returns Base64-encoded PNG content
 */
async function readImageElementAsPng(url: string): Promise<string> {
  const loaded = await loadImageAsBuffer(url);
  if (!loaded) {
    // Tell the two reasons apart, because they need different fixes: the
    // document may have refused the file (nothing to do here), or it loaded it
    // but keeps the pixels off-limits — an image outside the document's own
    // directory is its own origin to Firefox, which taints the canvas.
    const loadable = await canLoadAsImageElement(url);
    throw new Error(
      loadable
        ? 'the image loaded, but this document cannot read its pixels back'
        : 'the document could not load the image'
    );
  }

  const chunkSize = 0x8000;
  let binaryString = '';
  for (let i = 0; i < loaded.buffer.length; i += chunkSize) {
    binaryString += String.fromCharCode(...loaded.buffer.subarray(i, i + chunkSize));
  }
  return btoa(binaryString);
}

/**
 * Check whether the document can load a local image at all, without reading it
 * back (used to explain a failed rasterisation).
 * @param url - Absolute file:// URL
 * @returns True when the image loads
 */
function canLoadAsImageElement(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/**
 * Marker the injected helper uses so unrelated page messages are ignored.
 */
const PAGE_READ_MESSAGE_SOURCE = 'markdown-viewer-read-local-file';

/**
 * How long to wait for the injected helper before giving up.
 */
const PAGE_READ_TIMEOUT_MS = 2500;

/**
 * Cleared once the helper times out, which means the page refused to run it
 * (inline scripts are what a strict Content-Security-Policy blocks). Waiting for
 * every later file would add the full timeout to each of them, and the remaining
 * paths still work, so the helper is skipped from then on.
 */
let pageReadUsable = true;

/**
 * Token that ties a helper reply to the request that asked for it.
 *
 * Content scripts match page messages by shape rather than by window identity
 * (see readViaPageContext), so without a secret any page script could post a
 * reply of its own and feed its bytes into the exported document.
 *
 * @returns Random hex token
 */
function createHelperNonce(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Read a local file with the page's own privileges, through an injected helper.
 *
 * A `file://` page can fetch files out of its own directory — that privilege
 * belongs to the page, not to the extension, whose fetches Firefox rejects. The
 * helper is therefore appended to the page and posts the result back.
 *
 * This is the only path that can recover *text* (an SVG's source, needed to
 * inline a diagram) when the extension is denied file access, and unlike the
 * canvas route it returns the file untouched, so original image bytes and vector
 * SVG survive.
 *
 * @param url - Absolute file:// URL
 * @param binary - Return base64-encoded content instead of text
 * @returns File content
 * @throws When the page cannot run the helper, or the read fails there
 */
async function readViaPageContext(url: string, binary: boolean): Promise<string> {
  if (!pageReadUsable) {
    throw new Error('page helper disabled after an earlier timeout');
  }
  if (typeof document === 'undefined' || !document.documentElement) {
    throw new Error('no document to run the helper in');
  }

  const requestId = `read-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // Kept out of the DOM below (the helper element is removed as soon as it has
  // run), so only the injected code knows it.
  const nonce = createHelperNonce();

  return new Promise<string>((resolve, reject) => {
    const script = document.createElement('script');
    const helperSource = `
(() => {
  const reply = (ok, data, error) => window.postMessage(
    { source: ${JSON.stringify(PAGE_READ_MESSAGE_SOURCE)}, id: ${JSON.stringify(requestId)}, nonce: ${JSON.stringify(nonce)}, ok, data, error },
    '*'
  );
  fetch(${JSON.stringify(url)})
    .then((response) => {
      if (!response.ok) { throw new Error('HTTP ' + response.status); }
      return response.arrayBuffer();
    })
    .then((buffer) => {
      const bytes = new Uint8Array(buffer);
      if (${binary ? 'true' : 'false'}) {
        let binaryString = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binaryString += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        reply(true, btoa(binaryString), null);
      } else {
        reply(true, new TextDecoder().decode(bytes), null);
      }
    })
    .catch((error) => reply(false, null, String((error && error.message) || error)));
})();
`;

    const cleanup = (): void => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      script.remove();
    };

    const timer = setTimeout(() => {
      // No answer means the page never executed the helper (CSP) rather than a
      // slow read: stop paying for it on every later file.
      pageReadUsable = false;
      cleanup();
      reject(new Error(`page helper did not answer within ${PAGE_READ_TIMEOUT_MS}ms`));
    }, PAGE_READ_TIMEOUT_MS);

    function onMessage(event: MessageEvent): void {
      // Matched by shape — a content script sees the page's message through an
      // Xray wrapper, where identity checks only survive by accident — plus the
      // nonce, which the page never sees.
      const data = event.data as { source?: unknown; id?: unknown; nonce?: unknown; ok?: unknown; data?: unknown; error?: unknown } | null;
      if (!data || data.source !== PAGE_READ_MESSAGE_SOURCE || data.id !== requestId || data.nonce !== nonce) {
        return;
      }

      cleanup();

      if (data.ok === true && typeof data.data === 'string') {
        resolve(data.data);
        return;
      }
      reject(new Error(typeof data.error === 'string' ? data.error : 'page helper failed'));
    }

    window.addEventListener('message', onMessage);
    script.textContent = helperSource;
    document.documentElement.appendChild(script);
    // Appending runs the helper synchronously, so the element can go right away:
    // a page script can no longer read the nonce out of the injected source.
    script.remove();
  });
}

/**
 * Read a local file through the extension background page.
 * @param url - Absolute file:// URL
 * @param binary - Return base64-encoded content instead of text
 * @returns File content
 */
async function readViaBackgroundPage(url: string, binary: boolean): Promise<string> {
  const response = await backgroundServiceChannel.send('READ_LOCAL_FILE', {
    filePath: url,
    binary,
  }) as { content?: unknown } | undefined;

  // A background page without the READ_LOCAL_FILE handler answers with
  // undefined (Firefox resolves the message with no response) rather than
  // failing, so treat an unusable payload as an error and fall back.
  if (!response || typeof response.content !== 'string') {
    throw new Error('background page returned no file content');
  }
  return response.content;
}

/**
 * Report, once per page, that no local file read path worked.
 *
 * Every path is included so a single log line is enough to tell which context
 * broke and whether the Firefox 153+ "Access local files on your computer"
 * permission (about:addons → extension → Permissions and data) was granted.
 */
let localFileAccessWarningShown = false;

async function warnLocalFileAccessBlocked(): Promise<void> {
  if (localFileAccessWarningShown) {
    return;
  }
  localFileAccessWarningShown = true;

  let state = '';
  try {
    const allowed = await webExtensionApi.extension?.isAllowedFileSchemeAccess?.();
    if (typeof allowed === 'boolean') {
      state = allowed
        ? ' Local file access is GRANTED, so the permission is not the cause — please report this warning as-is.'
        : ' Local file access is NOT granted — enable "Access local files on your computer" and reload the page.';
    }
  } catch {
    // The API is unavailable in this context (or older than Firefox 153).
  }

  console.warn(
    '[DocumentService] Firefox could not read a local file through any path '
    + '(page bridge, background page, content-script fetch); the whole resource '
    + 'will be missing from the document (e.g. DOCX/HTML export).' + state,
  );
}

/**
 * Build a fetchable file:// URL from a filesystem path.
 * @param path - Absolute path ('/x/y.svg', 'C:\x\y.svg') or a file:// URL
 * @returns file:// URL
 */
function toFileUrl(path: string): string {
  if (path.startsWith('file://')) {
    return path;
  }
  const normalized = path.replace(/\\/g, '/');
  // Windows drive letter (C:/…): the URL form needs a third slash, file:///C:/…
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}

/**
 * Read a URL from the content script context.
 *
 * Everything goes through XMLHttpRequest, for two separate reasons: `fetch()` is
 * specified to reject `file:` URLs ("CORS request not http"), and the response a
 * content script's `fetch()` resolves with belongs to the page realm, so reading
 * it trips over Xray wrappers ("Permission denied to access property
 * constructor"). XHR belongs to the content script itself, keeps the page's
 * credentials for same-origin documents, and reaches cross-origin hosts the
 * extension holds permissions for.
 *
 * @param url - Absolute URL
 * @param binary - Return base64-encoded content instead of text
 * @returns Fetched content
 */
async function fetchUrlAsText(url: string, binary: boolean): Promise<string> {
  const bytes = await readUrlViaXhr(url);

  if (binary) {
    // Chunked conversion: the naive char-by-char loop is quadratic-ish and
    // stalls the content script on multi-megabyte images.
    const chunkSize = 0x8000;
    let binaryString = '';
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
      binaryString += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binaryString);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Read a URL with XMLHttpRequest (see fetchUrlAsText).
 * @param url - Absolute URL
 * @returns Response bytes
 */
function readUrlViaXhr(url: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';

    request.onload = () => {
      const bytes = request.response ? new Uint8Array(request.response as ArrayBuffer) : null;
      // Local files are answered from disk, where status 0 is the normal
      // success case; remote ones answer with the usual status codes.
      const statusOk = request.status === 0 || (request.status >= 200 && request.status < 300);
      if (!statusOk || !bytes) {
        reject(new Error(`HTTP ${request.status}: ${request.statusText}`));
        return;
      }
      resolve(bytes);
    };
    request.onerror = () => reject(new Error('NetworkError when fetching the resource'));
    request.send();
  });
}

// Create singleton instance
const firefoxDocumentService = new FirefoxDocumentService();

// ============================================================================
// Firefox Resource Service
// ============================================================================

/**
 * Firefox Resource Service
 * Resources are accessed via browser.runtime.getURL
 */
class FirefoxResourceService {
  getURL(path: string): string {
    return webExtensionApi.runtime.getURL(path);
  }

  /**
   * Fetch asset content
   * @param path - Asset path relative to extension root
   * @returns Asset content as string
   */
  async fetch(path: string): Promise<string> {
    const url = this.getURL(path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${path}: ${response.status}`);
    }
    return response.text();
  }
}

// ============================================================================
// Firefox Message Service
// ============================================================================

/**
 * Firefox Message Service
 * Handles Background ↔ Content Script communication
 * Directly sends message to background (message itself contains type)
 */
class FirefoxMessageService {
  /**
   * Send message directly to background script.
   * The message should already contain { id, type, payload, ... } structure.
   */
  async send<T = unknown>(message: unknown): Promise<T> {
    try {
      // Send message directly - Firefox browser.runtime.sendMessage returns Promise
      const response = await webExtensionApi.runtime.sendMessage(message);
      return response as T;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Message send failed: ${errorMessage}`);
    }
  }

  addListener(callback: (message: unknown) => void): () => void {
    return bridge.addListener(callback);
  }
}

// ============================================================================
// Firefox I18n Service
// ============================================================================

/**
 * Firefox I18n Service
 * Uses browser.i18n API for localization
 * Extends BaseI18nService for common message lookup logic
 */
class FirefoxI18nService extends BaseI18nService {
  constructor() {
    super();
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] init failed:', error);
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.locale = locale;
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (e) {
      console.warn('Failed to load locale:', locale, e);
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      const url = webExtensionApi.runtime.getURL(`_locales/${locale}/messages.json`);
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      console.warn('[I18n] fetchLocaleData failed for', locale, error);
      return null;
    }
  }

  getUILanguage(): string {
    return webExtensionApi.i18n?.getUILanguage() || navigator.language || FALLBACK_LOCALE;
  }

  /**
   * Get message using browser.i18n API (native Firefox i18n)
   */
  getNativeMessage(key: string, substitutions?: string | string[]): string {
    return webExtensionApi.i18n?.getMessage(key, substitutions) || key;
  }
}

// ============================================================================
// Firefox Platform API
// ============================================================================

/**
 * Firefox Platform API
 * Implements PlatformAPI interface for Firefox WebExtension environment
 * Uses background page rendering (Firefox MV2 has DOM access in background)
 */
class FirefoxPlatformAPI {
  public readonly platform = 'firefox' as const;
  
  // Services
  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly fileState: FileStateService;
  public readonly resource: FirefoxResourceService;
  public readonly message: FirefoxMessageService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: FirefoxI18nService;
  public readonly document: FirefoxDocumentService;
  public readonly settings: SettingsService;
  
  // Internal bridge reference (for advanced usage)
  public readonly _bridge: PlatformBridgeAPI;

  constructor() {
    // Initialize services
    this.storage = storageService;
    this.file = fileService;
    this.fileState = fileStateService;
    this.resource = new FirefoxResourceService();
    this.message = new FirefoxMessageService();
    this.cache = cacheService;
    this.document = firefoxDocumentService; // Unified document service
    
    // Unified renderer service with BackgroundRenderHost
    // Firefox MV2 background page has DOM access (like Chrome's Offscreen API)
    // So we can render diagrams directly in the background page
    this.renderer = new RendererService({
      createHost: () => new BackgroundRenderHost('firefox-renderer'),
      cache: this.cache,
    });
    
    this.i18n = new FirefoxI18nService();
    // Settings service
    this.settings = createSettingsService(this.storage);
    
    // Internal bridge reference
    this._bridge = bridge;
  }

  /**
   * Initialize all platform services
   */
  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }

  /**
   * Download file using browser.downloads API
   */
  async downloadFile(filename: string, data: string, mimeType: string): Promise<void> {
    try {
      // Create blob URL from base64 data
      const byteCharacters = atob(data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mimeType });
      const url = URL.createObjectURL(blob);

      // Check if downloads permission is available (it's optional)
      const hasDownloadsPermission = await webExtensionApi.permissions?.contains({ permissions: ['downloads'] }) || false;
      if (!hasDownloadsPermission) {
        // Fallback: use <a> element download
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
        return;
      }

      // Use browser.downloads API when available
      if (webExtensionApi.downloads?.download) {
        await webExtensionApi.downloads.download({
          url,
          filename,
          saveAs: true,
        });
      } else {
        // Safety fallback for environments without downloads API
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
        return;
      }

      // Clean up blob URL after a delay
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      // Don't log or throw error if user canceled the download
      const errorMsg = String((error as Error)?.message || error);
      if (errorMsg.includes('canceled') || errorMsg.includes('cancelled')) {
        // User canceled, just clean up silently
        return;
      }
      console.error('Download failed:', error);
      throw error;
    }
  }

  /**
   * Check if extension has file access permission
   */
  async hasFileAccess(): Promise<boolean> {
    // Firefox doesn't have a direct equivalent to chrome.extension.isAllowedFileSchemeAccess
    // File access is controlled by the user through about:config
    return true; // Assume true, user will see errors if not allowed
  }

  /**
   * Make local resources readable before an export that embeds them.
   *
   * Firefox refuses extension and page reads of `file://` files on a default
   * profile, so the user is asked to hand over the folder holding them; those
   * files are then used by the document service instead (see
   * local-file-access.ts). A no-op (and true) when the regular read paths already
   * work, false when the user cancelled the export at the prompt.
   *
   * @returns False to abort the export
   */
  async prepareLocalResourceAccess(): Promise<boolean> {
    return promptForLocalResources((url) => this.document.readRelativeFile(url));
  }
}

// ============================================================================
// Export
// ============================================================================

export const platform = new FirefoxPlatformAPI();

export {
  FirefoxResourceService,
  FirefoxMessageService,
  FirefoxI18nService,
  FirefoxPlatformAPI,
  DEFAULT_SETTING_LOCALE
};
