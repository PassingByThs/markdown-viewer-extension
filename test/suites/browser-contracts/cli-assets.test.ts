import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import { createBrowserRenderHarness, type BrowserRenderHarness } from '../../helpers/browser-render-harness.ts';

const ASSET_FIXTURE = path.resolve('test/fixtures/layout/asset-export.md');
const ERROR_FIXTURE = path.resolve('test/fixtures/layout/asset-export-error.md');
const DIAGRAM_FIXTURE = path.resolve('test/fixtures/layout/diagram-center.md');
const INVALID_MERMAID_FIXTURE = path.resolve('test/fixtures/layout/invalid-mermaid.md');
const ICON_FIXTURE = path.resolve('test/fixtures/layout/assets/icon48.png');

const RENDER_DEFAULTS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide' as const,
  tableLayout: 'center' as const,
  tableMergeEmpty: false,
  timeoutMs: 120_000,
};

describe('CLI asset collection contract (collectAssets page API)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: ASSET_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  it('returns figures and images in document order, numbered from 1', async () => {
    const { assets } = await harness.collectAssets(ASSET_FIXTURE, RENDER_DEFAULTS);

    assert.equal(assets.length, 3, 'Expected one image and two figures');
    assert.deepEqual(assets.map((asset) => asset.kind), ['image', 'diagram', 'diagram']);
    assert.deepEqual(assets.map((asset) => asset.index), [1, 2, 3]);
    assert.deepEqual(assets.map((asset) => asset.type), ['image', 'mermaid', 'mermaid']);
  });

  it('locates every asset at its markdown line', async () => {
    const { assets } = await harness.collectAssets(ASSET_FIXTURE, RENDER_DEFAULTS);

    const [image, firstDiagram, secondDiagram] = assets;
    assert.equal(image.line, 6, 'the image is on the line of its markdown');
    assert.equal(firstDiagram.line, 8, 'the first figure starts at its fence');
    assert.equal(secondDiagram.line, 15, 'the second figure starts at its fence');
    assert.ok(
      image.line! < firstDiagram.line! && firstDiagram.line! < secondDiagram.line!,
      'lines must follow document order',
    );
  });

  it('carries the rendered PNG payload of every figure', async () => {
    const { assets } = await harness.collectAssets(ASSET_FIXTURE, RENDER_DEFAULTS);

    for (const diagram of assets.filter((asset) => asset.kind === 'diagram')) {
      assert.equal(diagram.error, undefined, 'a rendered figure carries no error');
      assert.ok(diagram.pngBase64 && diagram.pngBase64.length > 0, 'a figure carries its PNG bytes');
      assert.equal(
        Buffer.from(diagram.pngBase64, 'base64').subarray(0, 8).toString('hex'),
        '89504e470d0a1a0a',
        'the payload must be a PNG',
      );
      assert.ok(diagram.width && diagram.height, 'a rendered figure reports its pixel size');
      assert.ok(diagram.blockId, 'a rendered figure names its placeholder block');
    }
  });

  it('copies images byte-for-byte from their source resource', async () => {
    const { assets } = await harness.collectAssets(ASSET_FIXTURE, RENDER_DEFAULTS);
    const [image] = assets;
    const source = await fs.readFile(ICON_FIXTURE);

    assert.equal(image.error, undefined);
    assert.equal(image.contentType, 'image/png');
    assert.equal(image.src, './assets/icon48.png', 'the src stays document-relative');
    assert.ok(image.imageBase64, 'the image carries its original bytes');
    assert.deepEqual(
      Buffer.from(image.imageBase64!, 'base64'),
      source,
      'an image is copied, never re-encoded',
    );
    assert.equal(image.width, 48);
    assert.equal(image.height, 48);
  });

  it('exports SVG payloads when asked for them', async () => {
    const { assets } = await harness.collectAssets(ASSET_FIXTURE, {
      ...RENDER_DEFAULTS,
      diagramFormat: 'svg',
    });

    for (const diagram of assets.filter((asset) => asset.kind === 'diagram')) {
      assert.equal(diagram.error, undefined);
      assert.ok(diagram.svg && diagram.svg.includes('<svg'), 'the figure carries its SVG source');
      assert.equal(diagram.pngBase64, undefined, 'one payload format at a time');
    }
  });

  it('restricts the walk to the requested kinds', async () => {
    const diagramsOnly = await harness.collectAssets(ASSET_FIXTURE, {
      ...RENDER_DEFAULTS,
      kinds: ['diagram'],
    });
    assert.deepEqual(diagramsOnly.assets.map((asset) => asset.kind), ['diagram', 'diagram']);

    const imagesOnly = await harness.collectAssets(ASSET_FIXTURE, {
      ...RENDER_DEFAULTS,
      kinds: ['image'],
    });
    assert.deepEqual(imagesOnly.assets.map((asset) => asset.kind), ['image']);
    // Indexes stay document-order positions: filtering must not renumber them.
    assert.deepEqual(imagesOnly.assets.map((asset) => asset.index), [1]);
  });
});

describe('CLI asset collection contract (failed assets)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: ERROR_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  it('returns failed blocks as assets with an error instead of dropping them', async () => {
    const { assets } = await harness.collectAssets(ERROR_FIXTURE, RENDER_DEFAULTS);

    assert.equal(assets.length, 3, 'a failed figure or image is still an asset of the document');
    const [rendered, brokenDiagram, brokenImage] = assets;

    assert.equal(rendered.kind, 'diagram');
    assert.equal(rendered.error, undefined, 'the good figure renders');
    assert.ok(rendered.pngBase64, 'the good figure has its payload');

    assert.equal(brokenDiagram.kind, 'diagram');
    assert.ok(brokenDiagram.error, 'the broken figure reports why it failed');
    assert.equal(brokenDiagram.pngBase64, undefined, 'a failed figure has no payload');

    assert.equal(brokenImage.kind, 'image');
    assert.ok(brokenImage.error, 'the unreadable image reports why it failed');
    assert.equal(brokenImage.imageBase64, undefined, 'a failed image has no payload');
  });
});

describe('CLI render diagnostics contract (diagnostics page API)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: DIAGRAM_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  it('reports the engine, the line and the reason of a failed diagram', async () => {
    const { assets } = await harness.collectAssets(INVALID_MERMAID_FIXTURE, RENDER_DEFAULTS);
    const diagnostics = await harness.diagnostics();

    const errors = diagnostics.filter((diagnostic) => diagnostic.level === 'error');
    assert.ok(errors.length > 0, 'a failed diagram must produce an error diagnostic');
    assert.ok(
      errors.some((diagnostic) => diagnostic.kind === 'render-failed'),
      'the engine throwing is reported as render-failed',
    );
    for (const diagnostic of errors) {
      assert.equal(diagnostic.type, 'mermaid', 'the diagnostics name the engine');
      assert.equal(typeof diagnostic.line, 'number', 'the diagnostics name the markdown line');
      assert.ok(diagnostic.message, 'the diagnostics carry a reason');
    }

    // The same failure is visible as an un-exportable asset: the report and
    // the asset table never disagree — same block, same line, same reason.
    assert.equal(assets.length, 1);
    assert.ok(assets[0].error, 'the failed figure is an asset with an error');
    assert.equal(assets[0].line, 3, 'the failed figure is located at its fence');
    assert.ok(
      errors.some((diagnostic) => diagnostic.blockId === assets[0].blockId),
      'the asset and the diagnostic name the same block',
    );
  });

  it('is empty for a document whose figures all rendered', async () => {
    await harness.collectAssets(DIAGRAM_FIXTURE, RENDER_DEFAULTS);
    const errors = (await harness.diagnostics()).filter((diagnostic) => diagnostic.level === 'error');

    assert.deepEqual(errors, [], 'a clean render reports no errors');
  });

  it('is reset by the next render instead of accumulating', async () => {
    await harness.collectAssets(INVALID_MERMAID_FIXTURE, RENDER_DEFAULTS);
    const first = await harness.diagnostics();
    assert.ok(first.length > 0, 'the broken render reports its failure');

    await harness.collectAssets(DIAGRAM_FIXTURE, RENDER_DEFAULTS);
    const second = await harness.diagnostics();
    assert.deepEqual(second, [], 'the following clean render starts from a clean slate');
  });
});
