/**
 * documd browser launch end to end: the real CLI, a real browser, and a
 * wrapper script standing in for it.
 *  - a PDF export: the print path must not need write access to the host temp
 *    directory (the one thing a macOS Seatbelt sandbox denies);
 *  - a wrapper script as `--chrome`: the browser must be started sandboxless
 *    (Chromium's sandbox cannot nest inside the sandboxes documd runs in) and
 *    every --browser-arg must reach it;
 *  - a wrapper that cannot start at all: the run must fail with the candidates
 *    it tried and what to install.
 *
 * Needs `npm run build:cli` and a browser (Playwright's bundled Chromium, or
 * Chrome); the wrapper cases are skipped when no browser binary can be found.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { chromium } from 'playwright-core';

const CLI = path.resolve('dist/cli/documd.js');
const FIXTURE = path.resolve('test/fixtures/layout/body-text.md');

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the real CLI binary and capture everything it said, whichever way it
 * exited. spawnSync, not execFileSync: the launch notices go to the stderr of a
 * *successful* run, which execFileSync only hands back for a failed one.
 */
function runCli(args: string[], env: Record<string, string> = {}): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
  });
  return {
    status: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/** Browser binary the wrapper scripts hand their arguments to. */
function bundledBrowser(): string {
  try {
    return chromium.executablePath();
  } catch {
    return process.env.MV_CHROME_EXECUTABLE || '';
  }
}

describe('documd browser launch end to end', () => {
  let workDir: string;
  let browserPath: string;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documd-browser-'));
    browserPath = bundledBrowser();
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** A stand-in browser: logs its argv, then behaves like a browser (or not). */
  function writeWrapper(name: string, script: string): string {
    const wrapper = path.join(workDir, name);
    fs.writeFileSync(wrapper, `#!/bin/sh\n${script}\n`);
    // Separate chmod: the mode option of writeFileSync is ignored under fibjs,
    // and a wrapper that is not executable looks exactly like a broken browser.
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  }

  function invocations(logPath: string): string[] {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n');
  }

  it('prints a PDF without writing into the host temp directory', () => {
    const output = path.join(workDir, 'body-text.pdf');
    const run = runCli([FIXTURE, output]);

    assert.equal(run.status, 0, `a PDF export must succeed:\n${run.stderr}`);
    const bytes = fs.readFileSync(output);
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    assert.match(bytes.toString('latin1'), /\/Type \/Page[^s]/, 'the PDF has a page');
    assert.doesNotMatch(
      run.stderr,
      /inline PDF transfer failed/,
      'the inline CDP transfer is the normal path, not a fallback',
    );
  });

  it('starts the browser sandboxless and passes --browser-arg on to it', () => {
    if (!browserPath) {
      return; // no browser to point the wrapper at (see the file header)
    }
    const log = path.join(workDir, 'flags.log');
    const wrapper = writeWrapper('record-args.sh', [
      'printf \'%s\\n\' "$*" >> "$DOCUMD_E2E_LOG"',
      'exec "$DOCUMD_E2E_BROWSER" "$@"',
    ].join('\n'));

    const run = runCli([
      FIXTURE, path.join(workDir, 'flags.html'),
      '--chrome', wrapper,
      '--browser-arg', '--documd-e2e-flag=1',
    ], { DOCUMD_E2E_LOG: log, DOCUMD_E2E_BROWSER: browserPath });

    assert.equal(run.status, 0, `the wrapper must behave like a browser:\n${run.stderr}`);
    const launched = invocations(log);
    assert.equal(launched.length, 1, 'a browser that renders is used straight away — no retries');
    assert.match(launched[0], /--no-sandbox\b/, 'Chromium is always started sandboxless');
    assert.match(launched[0], /--documd-e2e-flag=1/, 'every --browser-arg reaches the browser');
  });

  it('reports the browser it could not start', () => {
    const output = path.join(workDir, 'broken.html');
    const run = runCli([FIXTURE, output, '--chrome', writeWrapper('always-fails.sh', 'exit 1')]);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /Could not run a browser \(tried /, 'the failure names the candidates');
    assert.match(run.stderr, /playwright install chromium/, 'and what to install');
    assert.equal(fs.existsSync(output), false, 'nothing is written when there is no browser');
  });
});
