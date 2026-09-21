/**
 * Local file access granted by picking a folder (Firefox).
 *
 * Firefox refuses to hand a `file://` file to an extension: `fetch()` is
 * specified to reject non-http schemes ("CORS request not http"), XMLHttpRequest
 * is refused the same way, page contexts are confined to the file's own
 * directory tree by `security.fileuri.strict_origin_policy` (the default), and
 * an image the page loaded keeps its pixels out of reach (a tainted canvas).
 * Verified on Firefox 157: the only local resource a page can still read is the
 * one the user handed over themselves.
 *
 * So when a `file://` document needs its local images for an export, and the
 * regular read paths are refused, the user is asked once to pick the folder
 * holding them. Those `File` objects are readable in full, which also restores
 * inline SVG and vector SVG in DOCX. The prompt runs at export time because a
 * file picker cannot be opened without a user gesture.
 */

import Localization from '../../../src/utils/localization';

/**
 * One file the user handed over, with the path it had inside the picked folder.
 */
interface PickedFile {
  /** Lower-case path as reported by the picker, e.g. `test/assets/logo.svg` */
  path: string;
  file: File;
}

/**
 * Files the user picked, in selection order.
 */
const pickedFiles: PickedFile[] = [];

/**
 * Upper bound on remembered files; a bigger folder simply keeps its first
 * entries, and files past the cap fall back to the regular (failing) paths.
 */
const MAX_PICKED_FILES = 4000;

/**
 * Set when a local read succeeded through the regular paths, which means the
 * browser is willing and no prompt is needed (permission relaxed, or not
 * Firefox's default policy).
 */
let localReadsWork = false;

let stylesInjected = false;

/**
 * Record that a local file was read through the regular paths.
 */
export function noteLocalReadSuccess(): void {
  localReadsWork = true;
}

/**
 * Normalize a path for matching: lower case, forward slashes, no protocol.
 * @param value - Path or URL
 * @returns Comparable path
 */
function normalizePath(value: string): string {
  let path = value;
  try {
    path = decodeURIComponent(value);
  } catch {
    // Keep the raw form when it is not valid percent-encoding.
  }
  return path
    .replace(/\\/g, '/')
    .replace(/^file:\/+/i, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

/**
 * Read a local file the user handed over.
 *
 * The exporter asks for paths as written in the document (`assets/logo.svg`),
 * while the picker reports them relative to the folder the user chose
 * (`test/assets/logo.svg`), so the last path segments are what get matched.
 *
 * @param url - Requested path or URL
 * @param binary - Return base64-encoded content instead of text
 * @returns File content, or null when the user did not hand over that file
 */
export async function readFromPickedFiles(url: string, binary: boolean): Promise<string | null> {
  const target = normalizePath(url);
  if (!target || pickedFiles.length === 0) {
    return null;
  }

  const segments = target.split('/').filter(Boolean);
  // Try the full path first, then progressively shorter tails, ending with the
  // bare file name so a folder picked one level up still matches.
  for (let start = 0; start < segments.length; start += 1) {
    const suffix = segments.slice(start).join('/');
    if (!suffix) {
      continue;
    }
    const match = pickedFiles.find((entry) => entry.path === suffix || entry.path.endsWith(`/${suffix}`));
    if (!match) {
      continue;
    }

    return binary ? readPickedFileAsBase64(match.file) : readPickedFileAsText(match.file);
  }

  return null;
}

/**
 * Read a picked file as text, through a FileReader of our own.
 *
 * The `File` objects come from an `<input>` this script added to the page, so
 * they belong to the page realm: their own methods (`text()`, `arrayBuffer()`)
 * hand back page promises, and awaiting one from a content script fails with
 * "Permission denied to access property constructor" through Xray wrappers. A
 * FileReader created here, and the string its events deliver, live in our own
 * realm instead.
 *
 * @param file - Picked file
 * @returns File text
 */
function readPickedFileAsText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error(`Failed to read the selected file ${file.name}`));
    reader.readAsText(file);
  });
}

/**
 * Read a picked file as base64, through a FileReader of our own (see
 * readPickedFileAsText). A data URL keeps the result a plain string, so no
 * cross-realm object ever crosses back into the content script.
 *
 * @param file - Picked file
 * @returns Base64-encoded file content
 */
function readPickedFileAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) {
        reject(new Error(`Failed to read the selected file ${file.name}`));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error(`Failed to read the selected file ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Local resources the rendered document references, as written in the DOM.
 *
 * Reading them is exactly what the exporter will need, so they double as the
 * probe that decides whether the prompt is worth showing. The content container
 * is preferred, so viewer chrome (toolbar icons and the like) cannot answer for
 * the document's own images; the whole document is the fallback for hosts that
 * render elsewhere.
 *
 * @returns Local `src` values, or an empty list when the document has none
 */
function collectLocalResourceUrls(): string[] {
  if (typeof document === 'undefined') {
    return [];
  }

  const scopes = [
    document.querySelector('#markdown-content'),
    document.querySelector('.markdown-viewer-content'),
    document.body,
  ];

  const urls: string[] = [];
  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    for (const image of Array.from(scope.querySelectorAll('img[src]'))) {
      const src = image.getAttribute('src') || '';
      if (!src || /^(https?:|data:|blob:|moz-extension:|chrome-extension:|about:)/i.test(src)) {
        continue;
      }
      if (!urls.includes(src)) {
        urls.push(src);
      }
    }
    if (urls.length > 0) {
      break;
    }
  }
  return urls;
}

/**
 * Whether the document being viewed is a local file.
 * @returns True for `file://` documents
 */
function isLocalDocument(): boolean {
  return typeof window !== 'undefined' && window.location?.protocol === 'file:';
}

/**
 * What the user answered when asked for the folder holding local images.
 */
type LocalFilePromptAnswer = 'pick' | 'skip' | 'cancel';

/**
 * Ask the user for the folder holding the document's local images, unless the
 * regular read paths already work or files were handed over before.
 *
 * Skipping only affects the current export: nothing is remembered about it, so
 * changing one's mind costs no more than being asked again next time. Handing
 * files over is what makes the question stop. Backing out instead — clicking the
 * backdrop, pressing Escape, or dismissing the folder dialog — aborts the export:
 * that reads as "never mind", and only the explicit button asks to continue
 * without images.
 *
 * @param read - Reader for the regular paths, used to probe whether a prompt is needed
 * @returns False when the user cancelled the export; failures are reported, not thrown
 */
export async function prepareLocalResourceAccess(read: (url: string) => Promise<string>): Promise<boolean> {
  if (pickedFiles.length > 0 || !isLocalDocument() || localReadsWork) {
    return true;
  }

  const urls = collectLocalResourceUrls();
  if (urls.length === 0) {
    // Nothing local to embed: the export needs no local bytes.
    return true;
  }

  // Probe with resources the export actually needs. Earlier failures say
  // nothing here — a missing `SUMMARY.md` the viewer looks for, or one absent
  // image, would otherwise condemn a document whose images read fine — while a
  // single working read means the browser is cooperating and nothing needs
  // asking. Two candidates, so one image missing from disk does not decide for
  // the rest.
  for (const url of urls.slice(0, 2)) {
    try {
      await read(url);
      noteLocalReadSuccess();
      return true;
    } catch {
      // Try the next candidate, then ask.
    }
  }

  const answer = await showLocalFilePrompt(collectFolderHint(urls));
  if (answer === 'cancel') {
    console.info('[LocalFileAccess] export cancelled at the folder prompt');
    return false;
  }
  if (answer === 'skip') {
    console.info(
      '[LocalFileAccess] exporting without local images; the next export will offer the folder picker again'
    );
    return true;
  }

  const pickedCount = await pickFolder();
  if (pickedCount === 0) {
    // Backing out of the folder dialog is "never mind" just like the backdrop:
    // the export is cancelled, and the explicit button is what continues
    // without images.
    console.info('[LocalFileAccess] folder selection dismissed, export cancelled');
    return false;
  }

  // Confirm the picked folder actually covers this document's resources before
  // keeping the answer: a folder picked by mistake would otherwise silence the
  // prompt for the rest of the session.
  try {
    await read(urls[0]);
    console.info(`[LocalFileAccess] using ${pickedCount} selected file(s) for this document's local resources`);
  } catch {
    console.warn(
      `[LocalFileAccess] none of the ${pickedCount} selected file(s) matched ${urls[0]}; `
      + 'pick the folder that contains this document\'s images'
    );
    pickedFiles.length = 0;
  }

  return true;
}

/**
 * Best-effort folder name to mention in the prompt, taken from the first local
 * resource's directory.
 * @param urls - Local resource paths
 * @returns Folder name, or an empty string when unknown
 */
function collectFolderHint(urls: string[]): string {
  const first = urls[0] || '';
  const segments = normalizePath(first).split('/').filter(Boolean);
  segments.pop();
  return segments.pop() || '';
}

/**
 * How long to keep looking for the picker's result once the dialog has closed.
 *
 * Firefox fires `change` only after it has enumerated the chosen directory, and
 * `webkitdirectory` enumerates it recursively: on a cold or slow folder — or one
 * an on-access scanner walks first — that takes seconds. Concluding "cancelled"
 * any earlier turns a real selection into a silently cancelled export, so the
 * answer is polled for instead.
 */
const PICKER_RESULT_TIMEOUT_MS = 5000;
const PICKER_POLL_INTERVAL_MS = 250;

/**
 * Open a folder picker and remember what it returns.
 *
 * `webkitdirectory` is what makes Firefox offer a folder instead of files. A
 * dismissal resolves to 0 — immediately on the `cancel` event, or after the
 * result timeout when the dialog closes without answering.
 *
 * @returns How many files were handed over
 */
function pickFolder(): Promise<number> {
  return new Promise<number>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    input.style.display = 'none';

    const alreadyPicked = pickedFiles.length;
    let settled = false;
    let pollTimer: number | null = null;

    const stopPolling = (): void => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const finish = (value: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      stopPolling();
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(value);
    };

    const remember = (): void => {
      const files = Array.from(input.files || []);
      for (const file of files) {
        if (pickedFiles.length >= MAX_PICKED_FILES) {
          break;
        }
        const relative = file.webkitRelativePath || file.name;
        pickedFiles.push({ path: normalizePath(relative), file });
      }
      finish(pickedFiles.length - alreadyPicked);
    };

    // Focus returns to the page when the folder dialog closes. The `change` event
    // is the fast path; polling covers the window between the dialog closing and
    // Firefox finishing its enumeration.
    const startPolling = (): void => {
      if (pollTimer !== null || settled) {
        return;
      }
      const deadline = Date.now() + PICKER_RESULT_TIMEOUT_MS;
      pollTimer = window.setInterval(() => {
        if (settled) {
          stopPolling();
          return;
        }
        if (input.files && input.files.length > 0) {
          remember();
          return;
        }
        if (Date.now() >= deadline) {
          finish(0);
        }
      }, PICKER_POLL_INTERVAL_MS);
    };

    const onFocus = (): void => {
      // Let the `change` event win when it arrives right behind the focus.
      window.setTimeout(() => {
        if (!settled) {
          startPolling();
        }
      }, 250);
    };

    input.addEventListener('change', remember);
    input.addEventListener('cancel', () => finish(0));
    window.addEventListener('focus', onFocus);

    document.documentElement.appendChild(input);
    input.click();
  });
}

/**
 * Render the prompt and report what the user chose.
 *
 * The two buttons carry the intent ("pick a folder", "continue without images"),
 * so anything else — clicking the backdrop, pressing Escape — means "never mind"
 * and reports a cancellation rather than silently dropping the images.
 *
 * @param folderHint - Folder name to name in the message
 * @returns The user's answer
 */
function showLocalFilePrompt(folderHint: string): Promise<LocalFilePromptAnswer> {
  return new Promise<LocalFilePromptAnswer>((resolve) => {
    injectStyles();

    const overlay = document.createElement('div');
    overlay.className = 'mv-local-files-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'mv-local-files-card';

    const title = document.createElement('div');
    title.className = 'mv-local-files-title';
    title.textContent = translate('local_file_access_title');

    const message = document.createElement('div');
    message.className = 'mv-local-files-message';
    message.textContent = folderHint
      ? translate('local_file_access_message', [folderHint])
      : translate('local_file_access_message_generic');

    const actions = document.createElement('div');
    actions.className = 'mv-local-files-actions';

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'mv-local-files-button mv-local-files-primary';
    pick.textContent = translate('local_file_access_pick');

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'mv-local-files-button';
    skip.textContent = translate('local_file_access_skip');

    const close = (value: LocalFilePromptAnswer): void => {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    };

    function onKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        close('cancel');
      }
    }

    pick.addEventListener('click', () => close('pick'));
    skip.addEventListener('click', () => close('skip'));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close('cancel');
      }
    });
    document.addEventListener('keydown', onKeydown);

    actions.append(pick, skip);
    card.append(title, message, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    pick.focus();
  });
}

/**
 * Inject the prompt's stylesheet once.
 */
function injectStyles(): void {
  if (stylesInjected) {
    return;
  }
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
.mv-local-files-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.mv-local-files-card {
  max-width: 460px;
  padding: 20px 22px;
  border-radius: 10px;
  background: #fff;
  color: #24292f;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  font-family: inherit;
  line-height: 1.5;
}
.mv-local-files-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.mv-local-files-message {
  font-size: 13px;
  white-space: pre-line;
}
.mv-local-files-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 18px;
}
.mv-local-files-button {
  padding: 7px 14px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #f6f8fa;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.mv-local-files-button:hover {
  background: #eef1f4;
}
.mv-local-files-primary {
  border-color: #1f6feb;
  background: #1f6feb;
  color: #fff;
}
.mv-local-files-primary:hover {
  background: #1a60cf;
}
@media (prefers-color-scheme: dark) {
  .mv-local-files-card {
    background: #1f2428;
    color: #e6edf3;
  }
  .mv-local-files-button {
    border-color: #444c56;
    background: #2d333b;
  }
  .mv-local-files-button:hover {
    background: #373e47;
  }
  .mv-local-files-primary {
    border-color: #4184e4;
    background: #4184e4;
    color: #fff;
  }
  .mv-local-files-primary:hover {
    background: #2f6fd0;
  }
}
`;

  (document.head || document.documentElement).appendChild(style);
}

/**
 * Translate a UI key, falling back to the key itself.
 * @param key - Localization key
 * @param substitutions - Optional substitutions
 * @returns Localized text
 */
function translate(key: string, substitutions?: string[]): string {
  try {
    return Localization.translate(key, substitutions) || key;
  } catch {
    return key;
  }
}
