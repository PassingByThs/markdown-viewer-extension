/**
 * HTML injection contract, end to end: render a document full of payloads with
 * the real CLI and prove that none of it becomes code.
 *
 * The regression this guards: an HTML block is inserted into a live element by
 * the HTML plugin (it inlines local images there) *before* the render pipeline
 * sanitizes anything. An `<img src=x onerror=…>` therefore ran its handler as
 * soon as the failing load reported back — `[browser] PWNED-img-onerror` in the
 * CLI's stderr — because the attribute was still there when the element was
 * created. Sanitizing has to happen before the markup reaches the DOM, which is
 * only observable with a real browser.
 *
 * Payloads announce themselves with `console.error`, the level the CLI forwards
 * to stderr, so "nothing executed" is exactly "no PWNED in stderr".
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as xml from 'xml';

const CLI = path.resolve('dist/cli/documd.js');
const FIXTURE = path.resolve('test/fixtures/security/html-injection.md');

describe('documd HTML injection', () => {
  let workDir: string;
  let artifact: string;
  let run: { status: number | null; stdout: string; stderr: string };
  let html: string;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documd-injection-'));
    artifact = path.join(workDir, 'html-injection.html');

    run = spawnSync(process.execPath, [CLI, FIXTURE, artifact], { encoding: 'utf8' });
    assert.equal(run.status, 0, `the payload document must still convert:\n${run.stderr}`);
    assert.equal(fs.existsSync(artifact), true, 'the export is written');
    html = fs.readFileSync(artifact, 'utf8');
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('runs no payload from the document', () => {
    // Payloads announce themselves with console.error, the level the CLI
    // forwards to stderr: no PWNED is exactly "nothing executed".
    assert.doesNotMatch(run.stderr, /PWNED/, `a payload executed in the page — stderr was:\n${run.stderr}`);
    assert.doesNotMatch(run.stdout, /PWNED/, 'and nothing leaked into the report either');
  });

  it('keeps no active markup in the export', () => {
    // Parse the artifact instead of matching text: the sanitizer quotes removed
    // markup (escaped, inert) inside its notice, and an exported document also
    // contains highlighted code that mentions these very attribute names.
    const document = new xml.Document('text/html');
    const root = document.createElement('div');
    root.innerHTML = html;

    const BLOCKED_TAGS = new Set(['SCRIPT', 'IFRAME', 'TEMPLATE', 'NOSCRIPT', 'OBJECT', 'EMBED']);
    const offenders: string[] = [];
    for (const element of Array.from(root.querySelectorAll('*')) as Array<Record<string, unknown>>) {
      const tag = String(element.tagName || '').toUpperCase();
      if (BLOCKED_TAGS.has(tag)) {
        offenders.push(`<${tag.toLowerCase()}>`);
      }
      for (const attribute of Array.from((element.attributes ?? []) as Array<{ name: string; value: string }>)) {
        const name = String(attribute.name).toLowerCase();
        const value = String(attribute.value ?? '');
        if (name.startsWith('on') || name === 'srcdoc' || /javascript:/i.test(value)) {
          offenders.push(`${tag}[${name}]`);
        }
      }
    }

    assert.deepEqual(offenders, [], `active markup survived into the export: ${offenders.join(', ')}`);
  });

  it('still renders the HTML blocks the feature exists for', () => {
    // Raw HTML blocks are rendered as figures (the html plugin rasterizes them),
    // so the document's markup must not appear as live markup — and the blocks
    // must still come out as figures rather than as errors or empty placeholders.
    assert.doesNotMatch(html, /mv-plugin-error/, 'no block failed to render');
    assert.ok(
      (html.match(/data-plugin-type="html"/g) || []).length >= 4,
      'the HTML blocks are rendered as figures',
    );
    assert.ok(
      (html.match(/src="data:image\/png;base64,/g) || []).length >= 4,
      'and the figures carry rasterized content',
    );
  });
});
