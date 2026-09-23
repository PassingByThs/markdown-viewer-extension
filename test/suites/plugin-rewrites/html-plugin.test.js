import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import * as xml from 'xml';

import { HtmlPlugin } from '../../../src/plugins/html-plugin.ts';

// HtmlPlugin touches the global `document`: it sanitizes the raw HTML a document
// wrote and then inlines local images inside it. The suite installs a fibjs XML
// DOM for its duration — a real parser, so the sanitizer's tree walk is actually
// exercised — and restores whatever was there before. A regex-based fake cannot
// stand in for it: sanitizing needs attributes, child nodes and template parsing.
let previousDocument;

describe('HtmlPlugin', () => {
  before(() => {
    previousDocument = globalThis.document;
    globalThis.document = new xml.Document('text/html');
  });

  after(() => {
    globalThis.document = previousDocument;
    delete globalThis.platform;
  });

  /** Install the minimal platform the plugin reads (the document service). */
  function installPlatform(options = {}) {
    const calls = [];
    globalThis.platform = {
      document: {
        resolvePath(input) {
          calls.push(input);
          return `file:///workspace/${input.replace(/^\.\//, '')}`;
        },
        async readFile(input) {
          calls.push(input);
          if (options.failReads) throw new Error('Unable to read resource (404)');
          return 'ZmFrZQ==';
        },
      },
    };
    return calls;
  }

  it('should inline local image src without rewriting html links', async () => {
    const plugin = new HtmlPlugin();
    const calls = installPlatform();

    const input = '<p><a href="./note.md">Doc</a><a href="#section">Section</a><img src="images/pic.png" alt="pic"></p>';
    const output = await plugin.preprocessContent(input);

    assert.deepStrictEqual(calls, ['./images/pic.png', 'file:///workspace/images/pic.png']);
    assert.ok(output.includes('href="./note.md"'), 'document-relative href should remain unchanged');
    assert.ok(output.includes('href="#section"'), 'fragment href should remain unchanged');
    assert.ok(output.includes('src="data:image/png;base64,ZmFrZQ=="'), 'image src should be inlined');
  });

  it('should sanitize the markup before it reaches the DOM', async () => {
    // The plugin used to insert the raw document HTML into a live element (to
    // find the images worth inlining), so `<img src=x onerror=…>` ran its
    // handler as soon as the failing load reported back — before any sanitizer
    // had seen the markup.
    const plugin = new HtmlPlugin();
    installPlatform({ failReads: true });

    const output = await plugin.preprocessContent(
      '<div class="box"><img src="./missing.png" onerror="console.error(1)"><script>console.error(1)</script></div>',
    );

    assert.doesNotMatch(output, /onerror/i, 'event handler attributes must be gone');
    assert.doesNotMatch(output, /<script/i, 'script elements must be gone');
    assert.match(output, /class="box"/, 'the harmless parts of the block are kept');
  });

  it('should drop javascript: URLs while keeping safe ones', async () => {
    const plugin = new HtmlPlugin();
    installPlatform();

    const output = await plugin.preprocessContent(
      '<p><a href="javascript:console.error(1)">bad</a><a href="https://example.com">good</a></p>',
    );

    assert.doesNotMatch(output, /javascript:/i);
    assert.match(output, /href="https:\/\/example\.com"/);
  });
});