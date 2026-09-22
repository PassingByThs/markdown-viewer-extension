/**
 * UI helpers for popup
 */

import { getWebExtensionApi, isPlatform } from '../../utils/platform-info';
import { translate } from './i18n-helpers';

/**
 * Show a confirmation modal
 * @param title - Modal title
 * @param message - Modal message
 * @returns True if confirmed, false otherwise
 */
export function showConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('modal-title');
    const messageEl = document.getElementById('modal-message');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn) {
      // Fallback to native confirm if modal elements are missing
      resolve(confirm(message));
      return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.style.display = 'flex';

    const cleanup = (): void => {
      modal.style.display = 'none';
      confirmBtn.replaceWith(confirmBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };

    (confirmBtn as HTMLButtonElement).onclick = () => {
      cleanup();
      resolve(true);
    };

    (cancelBtn as HTMLButtonElement).onclick = () => {
      cleanup();
      resolve(false);
    };

    // Close on click outside
    modal.onclick = (e: MouseEvent) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };
  });
}

/**
 * Message type for toast
 */
type MessageType = 'success' | 'error' | 'info';

/**
 * Show a toast message
 * @param text - Message text
 * @param type - Message type ('success', 'error', 'info')
 */
export function showMessage(text: string, type: MessageType = 'info'): void {
  const message = document.createElement('div');
  message.className = `mv-toast mv-toast--${type}`;
  message.textContent = text;

  document.body.appendChild(message);

  setTimeout(() => {
    message.style.opacity = '1';
  }, 100);

  setTimeout(() => {
    message.style.opacity = '0';
    setTimeout(() => {
      if (message.parentElement) {
        message.parentElement.removeChild(message);
      }
    }, 300);
  }, 2000);
}

/**
 * Show error message
 * @param text - Error text
 */
export function showError(text: string): void {
  console.error('Popup Error:', text);
  showMessage(`Error: ${text}`, 'error');
}

/**
 * Check file access permission and show a warning when disabled.
 *
 * Both Chrome (chrome.extension.isAllowedFileSchemeAccess) and Firefox 153+
 * (browser.extension.isAllowedFileSchemeAccess — reflects the per-extension
 * "Access local files on your computer" toggle on about:addons) expose the
 * same check. Browsers/builds without the API hide the warning silently.
 *
 * Chrome can only be switched on from chrome://extensions, so the warning links
 * there. Firefox exposes the permission as a requestable origin, so the warning
 * also offers a one-click grant (see requestFileSchemeAccess) and links to
 * about:addons as the manual fallback.
 */
export async function checkFileAccess(): Promise<void> {
  const warningSection = document.getElementById('file-access-warning');
  if (!warningSection) {
    return;
  }

  let extensionApi: { isAllowedFileSchemeAccess?: () => Promise<boolean> } | undefined;
  let runtimeId = '';
  let tabsApi: { create: (options: { url: string }) => Promise<unknown> } | undefined;
  try {
    const api = getWebExtensionApi();
    extensionApi = api.extension;
    runtimeId = api.runtime?.id ?? '';
    tabsApi = api.tabs;
  } catch {
    // Platform identity unavailable — do not surface a warning we cannot verify.
  }

  if (!extensionApi || typeof extensionApi.isAllowedFileSchemeAccess !== 'function') {
    warningSection.style.display = 'none';
    return;
  }

  let isAllowed: boolean;
  try {
    isAllowed = await extensionApi.isAllowedFileSchemeAccess();
  } catch {
    // API rejected — keep the warning hidden rather than mislead.
    warningSection.style.display = 'none';
    return;
  }

  // Only show the warning when permission is disabled.
  if (isAllowed) {
    warningSection.style.display = 'none';
    return;
  }

  const isFirefox = isPlatform('firefox');

  // Firefox has no deep link into the per-extension toggle; about:addons is
  // where the user finds the "Access local files on your computer" permission
  // for docu.md.
  const settingsUrl = isFirefox
    ? 'about:addons'
    : `chrome://extensions/?id=${encodeURIComponent(runtimeId)}`;

  const descEl = document.getElementById('file-access-warning-desc');
  if (descEl) {
    const baseText = translate('file_access_disabled_desc_short') ||
      '要查看本地文件，请访问';
    const linkText = translate('file_access_settings_link') || '扩展设置页面';
    const suffixText = isFirefox
      ? (translate('file_access_disabled_suffix_firefox') ||
        '并在「权限与数据」中启用「访问您计算机上的本地文件」')
      : (translate('file_access_disabled_suffix') ||
        '并启用「允许访问文件网址」选项');

    // Built as DOM nodes rather than innerHTML so translated strings never get
    // parsed as markup.
    const link = document.createElement('a');
    link.href = settingsUrl;
    link.textContent = linkText;
    link.style.cssText = 'color: var(--color-warning); text-decoration: underline; cursor: pointer;';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openSettingsPage(settingsUrl, tabsApi);
    });

    descEl.textContent = '';
    descEl.append(`${baseText} `, link, ` ${suffixText}`);
  }

  if (isFirefox) {
    appendFileAccessRequestButton(warningSection, settingsUrl, tabsApi);
  }

  warningSection.style.display = 'block';
}

/**
 * Ask the browser to grant this extension local file access.
 *
 * Firefox 153+ turns the manifest `file:///*` host permission into a
 * user-grantable permission, so it can be requested from here (a popup click is
 * a user gesture) instead of sending the user hunting through about:addons.
 *
 * @returns True when the permission is granted
 */
async function requestFileSchemeAccess(): Promise<boolean> {
  try {
    const api = getWebExtensionApi() as {
      permissions?: { request?: (request: { origins?: string[] }) => Promise<boolean> };
    };
    if (typeof api.permissions?.request !== 'function') {
      return false;
    }
    return (await api.permissions.request({ origins: ['file:///*'] })) === true;
  } catch {
    // Browser refuses to prompt for file:// origins — caller falls back to the
    // settings page.
    return false;
  }
}

/**
 * Add the one-click "enable local file access" button to the warning box.
 * @param warningSection - Warning container element
 * @param settingsUrl - Settings page to open when the request is refused
 * @param tabsApi - Optional tabs API for opening the settings page
 */
function appendFileAccessRequestButton(
  warningSection: HTMLElement,
  settingsUrl: string,
  tabsApi: { create: (options: { url: string }) => Promise<unknown> } | undefined,
): void {
  // checkFileAccess() can run more than once per popup; never stack buttons.
  document.getElementById('file-access-enable-btn')?.remove();

  const button = document.createElement('button');
  button.id = 'file-access-enable-btn';
  button.type = 'button';
  button.className = 'btn'; // shared popup button styling (incl. :disabled state)
  button.textContent = translate('file_access_enable_button') || '启用本地文件访问';

  button.addEventListener('click', () => {
    button.disabled = true;
    void requestFileSchemeAccess().then((granted) => {
      if (granted) {
        // The page(s) need a reload to use the new permission; hiding the
        // warning is the visible confirmation.
        warningSection.style.display = 'none';
        return;
      }
      button.disabled = false;
      openSettingsPage(settingsUrl, tabsApi);
    });
  });

  const container = warningSection.querySelector('.warning-content') || warningSection;
  container.appendChild(button);
}

/**
 * Open the browser's extension settings page.
 * @param url - about:/chrome:// URL
 * @param tabsApi - Optional tabs API (chrome:// and about: URLs cannot be
 *   opened with window.open)
 */
function openSettingsPage(
  url: string,
  tabsApi: { create: (options: { url: string }) => Promise<unknown> } | undefined,
): void {
  if (tabsApi) {
    void tabsApi.create({ url });
  } else {
    window.open(url, '_blank');
  }
}
