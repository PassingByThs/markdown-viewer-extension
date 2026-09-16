/**
 * Unified Renderer Service
 * 
 * Application-layer renderer service that uses RenderHost for diagram rendering.
 * Platform-agnostic - works with any RenderHost implementation (Offscreen, Iframe).
 * 
 * Architecture:
 * - Chrome: Uses OffscreenRenderHost (offscreen document)
 * - Mobile/VSCode: Uses IframeRenderHost (iframe)
 * 
 * The RenderHost interface abstracts the communication mechanism,
 * allowing this service to work identically across all platforms.
 * 
 * RenderHost is lazily initialized - only created when first needed.
 */

import type { RenderHost } from '../renderers/host/render-host';
import type { CacheService } from './cache-service';
import type { RendererThemeConfig, RenderResult } from '../types/index';

// ============================================================================
// Types
// ============================================================================

/**
 * Factory function to create RenderHost (for lazy initialization)
 */
export type RenderHostFactory = () => RenderHost;

/**
 * Options for initializing the RendererService
 */
export interface RendererServiceOptions {
  /**
   * Factory function to create RenderHost (lazy initialization)
   */
  createHost: RenderHostFactory;
  
  /**
   * Optional CacheService for caching render results
   */
  cache?: CacheService;
}

// ============================================================================
// Renderer Service
// ============================================================================

/**
 * Unified renderer service using RenderHost for backend communication.
 * Supports cache integration. RenderHost is lazily initialized on first use.
 */
export class RendererService {
  private createHost: RenderHostFactory;
  private host: RenderHost | null = null;
  private cache: CacheService | null;
  
  private themeConfig: RendererThemeConfig | null = null;
  private themeDirty = true;

  constructor(options: RendererServiceOptions) {
    this.createHost = options.createHost;
    this.cache = options.cache ?? null;
  }

  /**
   * Get or create the RenderHost (lazy initialization)
   */
  private getHost(): RenderHost {
    if (!this.host) {
      this.host = this.createHost();
    }
    return this.host;
  }

  /**
   * Initialize the renderer service
   */
  async init(): Promise<void> {
    // Renderer initialization handled by RenderHost on first use
  }

  /**
   * Wait for render host to be ready
   */
  async ensureReady(): Promise<void> {
    await this.getHost().ensureReady();
  }

  /**
   * Get current theme configuration
   */
  getThemeConfig(): RendererThemeConfig | null {
    return this.themeConfig;
  }

  /**
   * Set theme configuration for rendering
   * Note: Theme is not applied immediately to support lazy iframe initialization.
   * It will be applied on the first render via applyThemeIfNeeded().
   */
  setThemeConfig(config: RendererThemeConfig): void {
    this.themeConfig = config;
    this.themeDirty = true;
  }

  /**
   * Apply theme configuration to render host if dirty
   */
  private async applyThemeIfNeeded(): Promise<void> {
    if (!this.themeConfig || !this.themeDirty) {
      return;
    }
    const host = this.getHost();
    await host.ensureReady();
    await host.send('SET_THEME_CONFIG', { config: this.themeConfig }, 300000);
    this.themeDirty = false;
  }

  /**
   * Render content using the render host
   * @param type - Render type (mermaid, vega, dot, etc.)
   * @param input - Content to render (string or object)
   * @returns Render result with base64 image data
   */
  async render(
    type: string,
    input: string | object
  ): Promise<RenderResult> {
    // Generate cache key
    const inputString = typeof input === 'string' ? input : JSON.stringify(input);
    const cacheType = `${type.toUpperCase()}_PNG`;
    
    // Check cache first
    if (this.cache) {
      const cacheKey = await this.cache.generateKey(inputString, cacheType, this.themeConfig);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached as RenderResult;
      }
      
      // Apply theme if needed
      await this.applyThemeForRender();
      
      // Render via host
      const result = await this.getHost().send<RenderResult>('RENDER_DIAGRAM', {
        renderType: type,
        input,
        themeConfig: this.themeConfig
      }, 60000);
      
      // Cache the result asynchronously (don't wait)
      this.cache.set(cacheKey, result, cacheType).catch(() => {});
      
      return result;
    }
    
    // No cache - render directly
    await this.applyThemeForRender();
    
    return this.getHost().send<RenderResult>('RENDER_DIAGRAM', {
      renderType: type,
      input,
      themeConfig: this.themeConfig
    }, 60000);
  }

  /**
   * Push the current theme to the render host without letting a failure abort the
   * render. Pushing the theme is a best-effort follow-up (the diagram is what the
   * caller asked for), and on a cold start the very first host call of a session
   * can fail with a transport error — that used to reject the whole render, which
   * is how the first diagram of a session intermittently never appeared. The
   * second attempt usually succeeds, so the first diagram still follows the theme;
   * if both fail the render goes ahead and themeDirty keeps the theme queued.
   */
  private async applyThemeForRender(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.applyThemeIfNeeded();
        return;
      } catch (error) {
        console.warn(
          `[RendererService] theme push attempt ${attempt + 1} failed:`,
          (error as Error).message,
        );
      }
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.host) {
      await this.host.cleanup?.();
      this.host = null;
    }
  }
}
