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
 *
 * The prompt is styled by `.mv-local-files-*` in ui/styles.css, which every
 * content-script-hosted viewer injects, so it follows the current theme
 * instead of carrying its own palette.
 */

import Localization from '../../../src/utils/localization';

/**
 * One file the user handed over, with the path it had inside the picked folder.
 */
interface PickedFile {
  /** Normalized path as reported by the picker, e.g. `test/assets/logo.svg` */
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

/**
 * Record that a local file was read through the regular paths.
 */
export function noteLocalReadSuccess(): void {
  localReadsWork = true;
}

/**
 * Normalize a path for matching: forward slashes, no protocol, no percent
 * escapes. Case is kept — readFromPickedFiles falls back to a case-insensitive
 * pass for platforms whose picker reports different casing.
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
    .replace(/\/+/g, '/');
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
    // Exact casing first: on a case-sensitive filesystem `Logo.svg` and
    // `logo.svg` are different files, and the picker reports the real one.
    const match = findPickedFile(suffix, false) ?? findPickedFile(suffix, true);
    if (!match) {
      continue;
    }

    return binary ? readPickedFileAsBase64(match.file) : readPickedFileAsText(match.file);
  }

  return null;
}

/**
 * Find the picked file matching a path suffix, preferring the closest match.
 *
 * A folder picked above the document makes every picked path longer than the
 * one the document wrote, so the entry with the fewest extra leading segments
 * wins, and an exact path match beats every suffix. Two different files that
 * match equally well are reported: silently picking one would embed the wrong
 * picture.
 *
 * @param suffix - Path tail to match (already normalized)
 * @param ignoreCase - Match case-insensitively (Windows/macOS-style pickers)
 * @returns The chosen file, or null when nothing matches
 */
function findPickedFile(suffix: string, ignoreCase: boolean): PickedFile | null {
  const needle = ignoreCase ? suffix.toLowerCase() : suffix;
  let best: PickedFile | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let ambiguous = false;

  for (const entry of pickedFiles) {
    const candidate = ignoreCase ? entry.path.toLowerCase() : entry.path;
    let score: number;
    if (candidate === needle) {
      score = -1; // Exact path: beats every suffix match.
    } else if (candidate.endsWith(`/${needle}`)) {
      score = candidate.length - needle.length;
    } else {
      continue;
    }

    if (score < bestScore) {
      best = entry;
      bestScore = score;
      ambiguous = false;
    } else if (score === bestScore && best && entry.path !== best.path) {
      ambiguous = true;
    }
  }

  if (ambiguous) {
    console.warn(
      `[LocalFileAccess] more than one selected file matches "${suffix}"; using ${best?.path}. `
      + 'Pick the folder that holds this document\'s images to make the choice exact.'
    );
  }

  return best;
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
