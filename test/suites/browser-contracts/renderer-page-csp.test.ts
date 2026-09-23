/**
 * Renderer-page CSP contract.
 *
 * The HTML sanitizer is the first layer; this is the second. The page the CLI
 * renders in carries a CSP without `'unsafe-inline'` for scripts, so markup that
 * reached the DOM anyway — a sanitizer gap, a plugin that forgets to clean its
 * input, a future contributor's mistake — still cannot execute: the browser
 * refuses the inline handler and reports a violation.
 *
 * That is exactly what this suite proves, by putting *unsanitized* markup into
 * the page (bypassing the pipeline on purpose) and checking that nothing runs.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createBrowserRenderHarness, type BrowserRenderHarness } from '../../helpers/browser-render-harness.ts';

const FIXTURE = path.resolve('test/fixtures/layout/body-text.md');

describe('renderer page CSP', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: FIXTURE });
    await harness.snapshotDom(FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 60_000,
    });
  });

  after(async () => {
    await harness.dispose();
  });

  it('refuses to run an inline handler that bypassed the sanitizer', async () => {
    const injected = await harness.evaluateInPage(() => {
      const target = document.getElementById('markdown-content');
      if (!target) return 'no container';
      // Raw markup, straight into the live DOM: the sanitizer never saw it.
      target.insertAdjacentHTML('beforeend', '<img id="csp-probe" src="./missing-csp-probe.png" onerror="console.error(\'PWNED-CSP-HANDLER\')">');
      return 'injected';
    });
    assert.equal(injected, 'injected');

    // Give the failing load time to report back and fire the handler.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const messages = harness.consoleMessages().map((message) => message.text).join('\n');
    assert.doesNotMatch(messages, /PWNED-CSP-HANDLER/, `an inline handler ran:\n${messages}`);
  });

  it('refuses to run an inline script element that bypassed the sanitizer', async () => {
    await harness.evaluateInPage(() => {
      const script = document.createElement('script');
      script.textContent = 'console.error("PWNED-CSP-SCRIPT")';
      document.body.appendChild(script);
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const messages = harness.consoleMessages().map((message) => message.text).join('\n');
    assert.doesNotMatch(messages, /PWNED-CSP-SCRIPT/, `an inline script ran:\n${messages}`);
  });

  it('still runs the renderer bundle the page loads itself', async () => {
    const api = await harness.evaluateInPage(() => typeof window.markdownCli?.render);
    assert.equal(api, 'function', 'the page CSP must not break the renderer itself');
  });
});
