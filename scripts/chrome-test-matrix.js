#!/usr/bin/env node

/**
 * Chrome version matrix for the installed-extension e2e suites.
 *
 * Downloads Chrome for Testing builds (the only branded builds that still honour
 * `--load-extension` and are published for every version) into
 * `.cache/chrome-for-testing/<version>/`, then runs a test file once per version
 * with `MV_CHROME_EXECUTABLE` pointed at that build — see
 * test/helpers/extension-launch.ts for the headless handling of old builds.
 *
 * Why: the bundled Playwright Chromium is always the newest, so version-specific
 * platform behaviour (e.g. the contextMenus Promise support added in Chrome 123)
 * can only be verified against real older builds.
 *
 * Builds much older than the host OS may not start at all — Chrome 120/121
 * segfault on macOS 26 before any extension code runs. Those versions are
 * reported as skipped; run the same command on Linux/CI to cover them:
 *   docker run --rm --user 0 --platform linux/amd64 -v "$PWD":/work:ro -w /work \
 *     -e MV_TEST_RUNNER=node -e MV_CHROME_CACHE_DIR=/tmp/cft \
 *     mcr.microsoft.com/playwright:v1.62.1-noble \
 *     node scripts/chrome-test-matrix.js 120 121
 * (shared libraries and Node come from the image, the repo is mounted read-only;
 * drop --platform on an x64 host.)
 *
 * Usage:
 *   node scripts/chrome-test-matrix.js                  # default matrix 120..123
 *   node scripts/chrome-test-matrix.js 121 121.0.6167.85
 *   node scripts/chrome-test-matrix.js --test test/suites/extension-e2e/index.js
 *   node scripts/chrome-test-matrix.js --install-only 120
 *   MV_TEST_RUNNER=node node scripts/chrome-test-matrix.js 121
 *   node scripts/chrome-test-matrix.js --strict 120 121   # CI: skips become failures
 *
 * Requires `npm run build:chrome` (dist/chrome) before running tests.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Override with MV_CHROME_CACHE_DIR when the repo is mounted read-only (container).
const CACHE_DIR = process.env.MV_CHROME_CACHE_DIR
  ? path.resolve(process.env.MV_CHROME_CACHE_DIR)
  : path.join(PROJECT_ROOT, '.cache', 'chrome-for-testing');
const EXT_DIR = path.join(PROJECT_ROOT, 'dist', 'chrome');

const VERSIONS_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';

const DEFAULT_VERSIONS = ['120', '121', '122', '123'];
const DEFAULT_TEST = 'test/suites/extension-e2e/browser-context-menu.test.ts';

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { versions: [], test: DEFAULT_TEST, installOnly: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--test') {
      options.test = argv[++i];
      if (!options.test) fail('--test needs a path');
    } else if (arg === '--install-only') {
      options.installOnly = true;
    } else if (arg === '--strict') {
      // CI mode: a version that cannot run on the host is a failure, not a skip.
      options.strict = true;
    } else if (arg === '--help' || arg === '-h') {
      log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`);
    } else {
      options.versions.push(arg);
    }
  }
  if (options.versions.length === 0) options.versions = [...DEFAULT_VERSIONS];
  return options;
}

/** CfT platform folder — matches the layout inside the release zips. */
function platformKey() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux64';
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64' : arch === 'ia32' ? 'win32' : 'win64';
  fail(`unsupported platform: ${platform}/${arch}`);
  return '';
}

function exePathIn(dir, platform) {
  if (platform.startsWith('mac')) {
    return path.join(dir, `chrome-${platform}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS',
      'Google Chrome for Testing');
  }
  if (platform.startsWith('win')) return path.join(dir, `chrome-${platform}`, 'chrome.exe');
  return path.join(dir, `chrome-${platform}`, 'chrome');
}

async function loadVersions() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, 'known-good-versions-with-downloads.json');
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  log(`Fetching ${VERSIONS_URL}`);
  const response = await fetch(VERSIONS_URL);
  if (!response.ok) fail(`cannot fetch the version index: HTTP ${response.status}`);
  const text = await response.text();
  fs.writeFileSync(cacheFile, text);
  return JSON.parse(text);
}

/** Accepts a full version or a major-prefix; the newest match wins. */
function resolveVersion(index, requested) {
  const matches = index.versions.filter(
    (entry) => entry.version === requested || entry.version.startsWith(`${requested}.`),
  );
  if (matches.length === 0) fail(`no Chrome for Testing build matches "${requested}"`);
  return matches[matches.length - 1];
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) fail(`download failed (HTTP ${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, bytes);
  return bytes.length;
}

/**
 * Minimal zip extractor (stored + deflate). Self-contained on purpose: the CI and
 * container images used for the low-version matrix often have neither `unzip` nor
 * a `tar` that can read zips.
 */
function extractZip(zipPath, targetDir) {
  const CENTRAL_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  const buffer = fs.readFileSync(zipPath);

  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`not a zip archive: ${zipPath}`);

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error(`corrupt zip directory in ${zipPath}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const unixMode = (externalAttributes >>> 16) & 0xffff;

    // The local header repeats the name/extra lengths, so data starts after them.
    const dataStart = localOffset + 30
      + buffer.readUInt16LE(localOffset + 26)
      + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    const target = path.join(targetDir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if ((unixMode & 0xf000) === 0xa000) {
        // Symlink entry: the payload is the link target.
        fs.rmSync(target, { force: true });
        fs.symlinkSync(data.toString('utf8'), target);
      } else {
        fs.writeFileSync(target, method === 0 ? data : zlib.inflateRawSync(data));
        // Chrome for Testing archives carry unix modes, and they matter: without
        // the exec bit on chrome_crashpad_handler & co the new headless mode
        // traps (SIGTRAP) right at startup. Archives without modes get 0644.
        fs.chmodSync(target, unixMode & 0o777 ? unixMode & 0o777 : 0o644);
      }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

async function ensureBrowser(index, requested) {
  const platform = platformKey();
  const entry = resolveVersion(index, requested);
  // Platform-scoped: the same repo checkout can hold the macOS and Linux builds
  // of one version (e.g. when the matrix also runs in a container).
  const dir = path.join(CACHE_DIR, `${entry.version}-${platform}`);
  const exe = exePathIn(dir, platform);

  if (fs.existsSync(exe)) {
    log(`• Chrome ${entry.version} — cached`);
    return { version: entry.version, exe };
  }

  const downloadInfo = (entry.downloads.chrome ?? []).find((item) => item.platform === platform);
  if (!downloadInfo) fail(`Chrome ${entry.version} has no ${platform} build`);

  log(`• Chrome ${entry.version} — downloading (${platform})`);
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(CACHE_DIR, `${entry.version}-${platform}.zip`);
  const size = await download(downloadInfo.url, zipPath);
  log(`  ${(size / 1024 / 1024).toFixed(0)} MB — extracting`);
  extractZip(zipPath, dir);
  fs.rmSync(zipPath, { force: true });

  if (!fs.existsSync(exe)) fail(`unexpected archive layout, no binary at ${exe}`);
  try {
    fs.chmodSync(exe, 0o755);
  } catch {
    // best effort — macOS/Linux archives keep the bit already
  }
  return { version: entry.version, exe };
}

function runSuite(exe, testFile) {
  const runner = process.env.MV_TEST_RUNNER || 'fibjs';
  const started = Date.now();
  try {
    execFileSync(runner, ['--test', testFile], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: { ...process.env, MV_CHROME_EXECUTABLE: exe },
    });
    return { ok: true, seconds: (Date.now() - started) / 1000 };
  } catch {
    return { ok: false, seconds: (Date.now() - started) / 1000 };
  }
}

/**
 * Older Chrome builds can segfault on a newer host OS (Chrome 120/121 crash on
 * macOS 26 long before any extension code runs). Detect that up front so the
 * matrix reports "unsupported on this host" instead of a puzzling suite failure.
 * A browser that starts but does not exit from the smoke run is NOT rejected —
 * `--dump-dom` hangs on some builds (e.g. Chrome 123 on macOS 26) while the
 * browser drives perfectly well through CDP.
 *
 * Returns `{ ok: true, note? }` or `{ ok: false, reason }`.
 */
function browserRunsOnHost(exe) {
  const major = Number((execFileSync(exe, ['--version'], { encoding: 'utf8' }).match(/(\d+)\./) ?? [])[1]);
  const headlessFlag = major >= 132 ? '--headless' : '--headless=new';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-cft-check-'));
  try {
    execFileSync(exe,
      [headlessFlag, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        `--user-data-dir=${profile}`, '--dump-dom', 'about:blank'],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (error) {
    if (error.killed || error.code === 'ETIMEDOUT') {
      return { ok: true, note: 'smoke run did not exit (not a crash)' };
    }
    const stderr = String(error.stderr ?? '').trim().split('\n')
      .map((line) => line.trim()).filter(Boolean).slice(-2).join(' | ');
    return {
      ok: false,
      reason: error.signal ? `browser crashed (${error.signal})` : String(error.message).slice(0, 140),
      detail: stderr.slice(0, 300),
    };
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.installOnly && !fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    fail('dist/chrome missing — run "npm run build:chrome" first');
  }

  const index = await loadVersions();
  log(`Chrome for Testing matrix (${platformKey()}) — test: ${options.test}\n`);

  const results = [];
  for (const requested of options.versions) {
    const { version, exe } = await ensureBrowser(index, requested);
    if (options.installOnly) {
      log(`  → ${exe}\n`);
      continue;
    }
    const smoke = browserRunsOnHost(exe);
    if (!smoke.ok) {
      log(`  ⊘ SKIP — Chrome ${version} cannot run on this host (${process.platform} ${process.arch}): ` +
        `${smoke.reason}${smoke.detail ? ` — ${smoke.detail}` : ''}; use a Linux/CI runner for it\n`);
      results.push({ version, requested, ok: false, skipped: true, seconds: 0 });
      continue;
    }
    if (smoke.note) log(`  note: ${smoke.note}`);
    log(`  running suite against Chrome ${version} …`);
    const result = runSuite(exe, options.test);
    results.push({ version, requested, ...result });
    log(`  ${result.ok ? '✓ PASS' : '✗ FAIL'} — Chrome ${version} (${result.seconds.toFixed(1)}s)\n`);
  }

  if (results.length === 0) return;

  log('summary');
  for (const result of results) {
    const mark = result.skipped ? '⊘' : result.ok ? '✓' : '✗';
    const suffix = result.skipped ? 'skipped — not runnable here' : result.ok ? '' : 'FAILED';
    log(`  ${mark} Chrome ${result.version}${suffix ? ` — ${suffix}` : ''}`);
  }
  if (results.some((result) => !result.ok && !result.skipped)) process.exit(1);
  if (options.strict && results.some((result) => result.skipped)) {
    fail('--strict: some versions could not run on this host, so they were not covered');
  }
}

main().catch((error) => fail(error?.stack || String(error)));
