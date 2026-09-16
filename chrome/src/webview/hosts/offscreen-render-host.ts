import type { RenderHost } from '../../../../src/renderers/host/render-host';

type OffscreenMessageService = {
  sendEnvelope: (
    type: string,
    payload: unknown,
    timeout?: number,
    source?: string
  ) => Promise<{ ok: boolean; data?: unknown; error?: { message?: string } }>;
};

export class OffscreenRenderHost implements RenderHost {
  private messageService: OffscreenMessageService;
  private source: string;
  private readyPromise: Promise<void> | null = null;

  constructor(messageService: OffscreenMessageService, source: string) {
    this.messageService = messageService;
    this.source = source;
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.probeUntilReady().catch((error) => {
        // Do not cache the failure — a later call may succeed.
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  /**
   * The first message of a session can fail before the request is even dispatched
   * (Chrome's binding throws while the service worker is starting) and the offscreen
   * document is created on demand. Probe with PING so the first real request — the
   * theme push or the first diagram — does not pay for that cold start, which is how
   * the first render of a session used to fail silently.
   */
  private async probeUntilReady(): Promise<void> {
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.messageService.sendEnvelope('PING', {}, 15000, this.source);
        return;
      } catch (error) {
        if (attempt === attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  async send<T = unknown>(type: string, payload: unknown, timeoutMs: number = 300000): Promise<T> {
    const response = await this.messageService.sendEnvelope(type, payload, timeoutMs, this.source);
    if (!response.ok) {
      throw new Error(response.error?.message || `${type} failed`);
    }
    return response.data as T;
  }
}
