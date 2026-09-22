/**
 * Image Loader Utilities
 * 
 * Load remote images via browser-native <img> tag + canvas,
 * bypassing fetch() and connect-src CSP restrictions.
 * Only requires img-src to allow https: (all platforms do).
 */

/**
 * Request CORS mode only where CORS exists.
 *
 * A `file:` URL cannot answer a CORS request, so asking for one turns a load
 * that would otherwise succeed into a failure — that is how local images broke
 * in a default Firefox profile, where every file is its own origin. Local
 * origins are handled by the canvas read-back instead, which needs no CORS mode.
 *
 * @param url - Image URL
 * @param img - Image element about to be loaded
 */
function requestCorsWhereSupported(url: string, img: HTMLImageElement): void {
  if (/^https?:/i.test(url)) {
    img.crossOrigin = 'anonymous';
  }
}

/**
 * Load remote image via <img> tag, return as base64 data URL.
 * @param url - Remote image URL (http:// or https://)
 * @returns data:URL string, or null if loading fails
 */
export function loadImageAsDataUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    requestCorsWhereSupported(url, img);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Load remote image via <img> tag, return as Uint8Array buffer.
 * @param url - Remote image URL (http:// or https://)
 * @returns PNG buffer with dimensions, or null if loading fails
 */
export function loadImageAsBuffer(url: string): Promise<{ buffer: Uint8Array; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    requestCorsWhereSupported(url, img);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        const binary = atob(base64);
        const buffer = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          buffer[i] = binary.charCodeAt(i);
        }
        resolve({ buffer, width: img.naturalWidth, height: img.naturalHeight });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
