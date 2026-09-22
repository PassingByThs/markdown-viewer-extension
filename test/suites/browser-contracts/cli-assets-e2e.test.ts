import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const CLI = path.resolve('dist/cli/documd.js');
const ASSET_FIXTURE = path.resolve('test/fixtures/layout/asset-export.md');
const ERROR_FIXTURE = path.resolve('test/fixtures/layout/asset-export-error.md');

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI binary and capture everything it said, whichever way it exited. */
function runCli(args: string[]): CliRun {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: failure.stdout || '',
      stderr: failure.stderr || '',
    };
  }
}

describe('documd --assets end to end', () => {
  let outputDir: string;

  before(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documd-assets-'));
  });

  after(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('writes every figure and image of the document into the directory', () => {
    const directory = path.join(outputDir, 'all');
    const run = runCli([ASSET_FIXTURE, '--assets', directory]);

    assert.equal(run.status, 0, `--assets must succeed on a clean document:\n${run.stderr}`);
    assert.match(run.stdout, /2 diagrams, 1 image \(3 assets\)/);
    assert.match(run.stdout, /Exported 3 assets to /);

    // The document-order numbers in the report are the numbers in the names.
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      'asset-export-01-icon48.png',
      'asset-export-02-mermaid.png',
      'asset-export-03-mermaid.png',
    ]);
    for (const name of fs.readdirSync(directory)) {
      const bytes = fs.readFileSync(path.join(directory, name));
      assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47', `${name} must be a PNG`);
      assert.ok(bytes.length > 100, `${name} must not be empty`);
    }
  });

  it('exports only the selected asset, in the selected figure format', () => {
    const directory = path.join(outputDir, 'only');
    const run = runCli([ASSET_FIXTURE, '--assets', directory, '--only', '2', '--format', 'svg']);

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fs.readdirSync(directory), ['asset-export-02-mermaid.svg']);
    assert.match(run.stdout, /skipped/, 'unselected assets are reported as skipped, not as failures');
    assert.match(fs.readFileSync(path.join(directory, 'asset-export-02-mermaid.svg'), 'utf8'), /<svg/);
  });
});

describe('documd render error report end to end', () => {
  let outputDir: string;

  before(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documd-errors-'));
  });

  after(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('names every failed asset by line and reason, and fails the run', () => {
    const directory = path.join(outputDir, 'failed');
    const run = runCli([ERROR_FIXTURE, '--assets', directory]);

    assert.equal(run.status, 1, 'a document with failed figures must fail the export');
    // The table is the report of this mode (stdout), rows included...
    assert.match(run.stdout, /line 11\s+failed: /, 'the failed figure is reported at its line');
    assert.match(run.stdout, /line 15\s+failed: unreadable/, 'the unreadable image is reported at its line');
    assert.match(run.stdout, /Exported 1 asset to /, 'what could be written is still written');
    // ...while the summary of what that means goes to stderr.
    assert.match(run.stderr, /2 of 3 selected assets could not be exported/);
    assert.match(run.stderr, /pass --no-fail-on-error to export anyway/);
    assert.deepEqual(fs.readdirSync(directory), ['asset-export-error-01-mermaid.png']);
  });

  it('still reports, but no longer fails, with --no-fail-on-error', () => {
    const directory = path.join(outputDir, 'relaxed');
    const run = runCli([ERROR_FIXTURE, '--assets', directory, '--no-fail-on-error']);

    assert.equal(run.status, 0, '--no-fail-on-error must relax the exit code');
    assert.match(run.stdout, /failed: /, 'the failures are still reported');
    assert.equal(run.stderr.includes('pass --no-fail-on-error'), false, 'the advice line is gone once honored');
  });

  it('reports render errors of a document conversion, not just of --assets', () => {
    const output = path.join(outputDir, 'converted.docx');
    const run = runCli([ERROR_FIXTURE, output]);

    assert.equal(run.status, 1, 'a conversion with failed figures must fail');
    assert.match(run.stderr, /Render errors \(2\):/);
    assert.match(run.stderr, /line 11\s+mermaid\s+/, 'the failed figure names engine and line');
    assert.match(run.stderr, /line 15\s+image\s+/, 'the unreadable image names its line');
    assert.ok(fs.existsSync(output), 'the document is still written — the report says what is missing');
    assert.ok(fs.statSync(output).size > 0, 'the written document is not empty');
  });
});
