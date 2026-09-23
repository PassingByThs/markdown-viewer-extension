/**
 * CLI browser launch / print contracts.
 *
 * How documd picks a browser, which flags it hands to it, and how it pulls a
 * PDF out of it — checked without starting anything: the launch plan is a pure
 * function, the launcher and the CDP session are injected/stubbed, so the rules
 * cost no browser start. The end-to-end side of the same rules lives in
 * cli-browser-e2e.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

import {
  browserLaunchPlan,
  extraBrowserArgs,
  launchBrowser,
  parseArgs,
  printPageToPdf,
  resolveChromePath,
} from '../../../scripts/documd.js';

const NO_ENV = {};

describe('documd browser launch plan', () => {
  it('starts the bundled Chromium first, then falls back to installed Chrome', () => {
    const attempts = browserLaunchPlan(parseArgs(['notes.md']), NO_ENV);

    assert.deepEqual(attempts.map((attempt) => attempt.label), ['bundled Chromium', 'installed Chrome']);
    assert.equal(attempts[0].options.channel, undefined, 'without a channel Playwright resolves its bundled headless build');
    assert.equal(attempts[1].options.channel, 'chrome');
  });

  it('starts every browser sandboxless', () => {
    const attempts = browserLaunchPlan(parseArgs(['notes.md']), NO_ENV);

    for (const attempt of attempts) {
      assert.equal(
        attempt.options.args.includes('--no-sandbox'),
        true,
        `${attempt.label} must be started with --no-sandbox (Chromium's sandbox cannot nest) `,
      );
      assert.equal(
        attempt.options.chromiumSandbox,
        undefined,
        'the sandbox is never requested back through Playwright',
      );
    }
  });

  it('launches headless with a bounded start budget', () => {
    const [attempt] = browserLaunchPlan(parseArgs(['notes.md']), NO_ENV);

    assert.equal(attempt.options.headless, true);
    assert.ok(
      attempt.options.timeout > 0 && attempt.options.timeout <= 60_000,
      `a launch must not wait forever (got ${attempt.options.timeout})`,
    );
  });

  it('replaces both browsers with one explicit binary', () => {
    const attempts = browserLaunchPlan(parseArgs(['notes.md', '--chrome', './my-chromium']), NO_ENV);

    assert.equal(attempts.length, 1, 'one binary, no browser left to fall back to');
    assert.equal(attempts[0].options.executablePath, path.resolve('./my-chromium'));
    assert.equal(attempts[0].options.channel, undefined);
    assert.equal(attempts[0].options.args.includes('--no-sandbox'), true);
  });

  it('takes the binary from DOCUMD_CHROME_PATH, with --chrome winning over it', () => {
    const options = parseArgs(['notes.md']);

    assert.equal(
      resolveChromePath(options, { DOCUMD_CHROME_PATH: '/opt/chromium' }),
      path.resolve('/opt/chromium'),
    );
    assert.equal(
      resolveChromePath({ ...options, chromePath: './local-chrome' }, { DOCUMD_CHROME_PATH: '/opt/chromium' }),
      path.resolve('./local-chrome'),
    );
    assert.equal(resolveChromePath(options, NO_ENV), '', 'no override means the default browsers');
  });

  it('passes extra Chromium flags, environment first', () => {
    const options = parseArgs([
      'notes.md',
      '--browser-arg', '--disable-gpu',
      '--browser-arg', '--font-render-hinting=none',
    ]);

    assert.deepEqual(
      extraBrowserArgs(options, { DOCUMD_CHROME_ARGS: '--disable-lcd-text  --force-color-profile=srgb' }),
      ['--disable-lcd-text', '--force-color-profile=srgb', '--disable-gpu', '--font-render-hinting=none'],
    );
    const [attempt] = browserLaunchPlan(options, { DOCUMD_CHROME_ARGS: '--disable-lcd-text' });
    assert.deepEqual(
      attempt.options.args,
      ['--disable-lcd-text', '--disable-gpu', '--font-render-hinting=none', '--no-sandbox'],
    );
  });

  it('does not pass --no-sandbox twice', () => {
    const attempts = browserLaunchPlan(parseArgs(['notes.md', '--browser-arg', '--no-sandbox']), NO_ENV);

    assert.deepEqual(attempts[0].options.args, ['--no-sandbox']);
  });

  it('rejects --browser-arg without a value', () => {
    assert.throws(() => parseArgs(['notes.md', '--browser-arg']), /--browser-arg requires a value/);
  });
});

/** A browser stub: what `launch()` hands back, and how it fails. */
function stubBrowser({ newPageThrows } = {}) {
  const calls = { pages: 0, closed: 0 };
  return {
    calls,
    browser: {
      newPage: async () => {
        calls.pages += 1;
        if (newPageThrows) throw new Error(newPageThrows);
        return { setContent: async () => {}, close: async () => {} };
      },
      close: async () => {
        calls.closed += 1;
      },
    },
  };
}

/** Capture the CLI's stderr notices while a stub run happens. */
async function captureWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

describe('documd browser launch ladder', () => {
  it('hands over a browser that renders a page, sandboxless', async () => {
    const { browser, calls } = stubBrowser();
    const launched = [];

    const result = await launchBrowser(parseArgs(['notes.md']), {
      launch: async (options) => {
        launched.push(options);
        return browser;
      },
    });

    assert.equal(result, browser);
    assert.equal(launched.length, 1, 'the first browser is taken when it renders');
    assert.equal(launched[0].args.includes('--no-sandbox'), true);
    assert.equal(calls.pages, 1, 'the browser is checked by loading a page first');
    assert.equal(calls.closed, 0, 'a usable browser is handed over, not closed');
  });

  it('falls back to the next browser when one starts but cannot render', async () => {
    const broken = stubBrowser({ newPageThrows: 'browser.newPage: Target crashed' });
    const working = stubBrowser();
    const launched = [];

    const { result, warnings } = await captureWarnings(() => launchBrowser(parseArgs(['notes.md']), {
      launch: async (options) => {
        launched.push(options);
        return launched.length === 1 ? broken.browser : working.browser;
      },
    }));

    assert.equal(result, working.browser);
    assert.equal(launched.length, 2);
    assert.equal(launched[1].channel, 'chrome', 'the installed Chrome is the next candidate');
    assert.equal(broken.calls.closed, 1, 'the unusable browser is closed again');
    assert.match(
      warnings.join('\n'),
      /bundled Chromium started but cannot render \(browser\.newPage: Target crashed\); falling back to installed Chrome/,
    );
  });

  it('names everything it tried when no browser can run', async () => {
    const launched = [];

    const { warnings } = await captureWarnings(() => assert.rejects(
      launchBrowser(parseArgs(['notes.md']), {
        launch: async (options) => {
          launched.push(options);
          throw new Error('browserType.launch: Target closed');
        },
      }),
      /Could not run a browser \(tried bundled Chromium, installed Chrome\)/,
    ));

    assert.equal(launched.length, 2, 'every candidate is tried before giving up');
    assert.match(warnings.join('\n'), /bundled Chromium failed to start .*falling back to installed Chrome/);
  });
});

/** A page whose CDP session is scripted, so both print paths can be checked. */
function stubPage({ send, hasCdpSession = true } = {}) {
  const calls = { sent: [], detached: 0, pdf: 0, pdfOptions: undefined };
  return {
    calls,
    page: {
      context: () => ({
        newCDPSession: async () => {
          if (!hasCdpSession) throw new Error('Protocol error: CDP is not available');
          return {
            send: async (method, params) => {
              calls.sent.push({ method, params });
              return send ? send(method, params) : {};
            },
            detach: async () => {
              calls.detached += 1;
            },
          };
        },
      }),
      pdf: async (options) => {
        calls.pdf += 1;
        calls.pdfOptions = options;
        return Buffer.from('%PDF-from-playwright');
      },
    },
  };
}

describe('documd PDF printing', () => {
  it('prints inline over CDP, with the parameters page.pdf() would send', async () => {
    const bytes = Buffer.from('%PDF-inline-bytes');
    const { page, calls } = stubPage({ send: () => ({ data: bytes.toString('base64') }) });

    const pdf = await printPageToPdf(page, 5_000);

    assert.ok(pdf.equals(bytes), 'the inline base64 payload is the PDF');
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0].method, 'Page.printToPDF');
    assert.equal(
      calls.sent[0].params.transferMode,
      'ReturnAsBase64',
      'the stream transfer is the one that writes into the host temp directory',
    );
    assert.equal(calls.sent[0].params.printBackground, true);
    assert.equal(calls.sent[0].params.preferCSSPageSize, true);
    assert.equal(calls.sent[0].params.marginTop, 0, 'same margins as page.pdf()');
    assert.equal(calls.sent[0].params.scale, 1);
    assert.equal(calls.detached, 1, 'the CDP session is closed again');
    assert.equal(calls.pdf, 0, 'page.pdf() is not used when the inline transfer worked');
  });

  it('falls back to page.pdf() when the inline transfer fails', async () => {
    const { page, calls } = stubPage({
      send: () => {
        throw new Error('Protocol error (IO.read): Read failed');
      },
    });

    const { result: pdf, warnings } = await captureWarnings(() => printPageToPdf(page, 5_000));

    assert.equal(pdf.toString(), '%PDF-from-playwright');
    assert.equal(calls.pdf, 1);
    assert.equal(calls.detached, 1, 'the failed session is closed before the fallback');
    assert.deepEqual(calls.pdfOptions, { printBackground: true, preferCSSPageSize: true });
    assert.match(warnings.join('\n'), /inline PDF transfer failed/, 'the fallback is reported, not silent');
  });

  it('falls back to page.pdf() when the browser has no CDP session', async () => {
    const { page, calls } = stubPage({ hasCdpSession: false });

    const { result: pdf, warnings } = await captureWarnings(() => printPageToPdf(page, 5_000));

    assert.equal(pdf.toString(), '%PDF-from-playwright');
    assert.equal(calls.pdf, 1);
    assert.match(warnings.join('\n'), /inline PDF transfer failed/);
  });
});
