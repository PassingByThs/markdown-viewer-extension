/**
 * Remote-document resources (issue #128 follow-up).
 *
 * A markdown file served over http:// has to resolve and read its images
 * exactly like a local one: that is what the exported DOCX/HTML/EPUB embed
 * (they need the bytes) and what the viewer needs to draw an SVG image. Three
 * URL shapes are covered, because they take different read paths:
 *
 *   assets/logo.png              relative — resolved against the document URL
 *   /root-logo.png               root-relative — the *site* root, not the disk
 *   http://127.0.0.1:<b>/x.png   absolute and cross-origin — worker fetch, which
 *                                is why chrome/manifest.json allows http(s) in
 *                                connect-src
 *
 * Two origins are served so the cross-origin read happens for real, and both
 * viewer hosts are exercised:
 *
 *   standalone — the content script takes over the http page, so relative reads
 *                resolve in the page's own context (the case from the issue:
 *                SVG images were missing there). An SVG image node is *read*
 *                before it is drawn, so a rendered `data:image/png` proves the
 *                read succeeded — a failed read renders an error block instead.
 *   embed      — the extension-page host, whose reads go through the background
 *                worker. The calls ResourceEmbedder makes during an export are
 *                issued directly and checked byte by byte.
 *
 * The export's *delivery* step is intentionally not driven here: a remote
 * document downloads through chrome.downloads (optional permission + browser
 * prompt), and the embed host resets the document base URL when an export
 * starts, so an in-test export would not exercise the resolution rules under
 * test. What the exporters do with these URLs — ResourceEmbedder →
 * DocumentService — is what the read assertions pin down.
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import zlib from 'node:zlib';

import { type Page } from 'playwright-core';

import {
  FIXED_SETTINGS,
  POST_OPEN_DOCUMENT_JS,
  SET_STORAGE_JS,
  VIEWER_EMBED_READY_JS,
  WAIT_RENDERED_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  waitFor,
  waitImagesJs,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC-32 (PNG chunk checksum); the table-less variant is fine for a fixture. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a real (decodable) PNG so `naturalWidth` assertions mean something. */
function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = rgb[0];
      raw[pixel + 1] = rgb[1];
      raw[pixel + 2] = rgb[2];
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBytes = Buffer.from(type, 'ascii');
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SVG_FIXTURE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30">'
  + '<rect width="60" height="30" fill="#2f5fd0"/></svg>',
  'utf8',
);

interface ServedRequest {
  path: string;
}

interface TestServer {
  origin: string;
  close(): Promise<void>;
}

/** Serve an in-memory route table and record which paths were requested. */
function startServer(
  routes: Map<string, { type: string; body: Buffer }>,
  log: ServedRequest[],
): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      log.push({ path });
      const route = routes.get(path);
      if (!route) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': route.type,
        'cache-control': 'no-store',
      });
      response.end(route.body);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Markdown exercising every URL shape the reader has to resolve. */
function markdownFor(crossOriginUrl: string): string {
  return [
    '# Remote document',
    '',
    '![relative png](assets/logo.png)',
    '![root png](/root-logo.png)',
    `![cross png](${crossOriginUrl})`,
    '',
    '![relative svg](assets/logo.svg)',
    '![root svg](/root-logo.svg)',
    '',
  ].join('\n');
}

describe('installed Chrome extension — remote document resources', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let standalone: Page;
  let embed: Page;
  let docOrigin = '';
  let crossOrigin = '';
  let crossPngUrl = '';
  const docRequests: ServedRequest[] = [];
  const crossRequests: ServedRequest[] = [];
  const servers: TestServer[] = [];

  const documentUrl = () => `${docOrigin}/notes/remote.md`;
  const embedUrl = () => `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`;

  before(async () => {
    const docRoutes = new Map<string, { type: string; body: Buffer }>([
      ['/notes/remote.md', { type: 'text/markdown; charset=utf-8', body: Buffer.alloc(0) }],
      ['/notes/assets/logo.png', { type: 'image/png', body: makePng(4, 3, [220, 60, 60]) }],
      ['/notes/assets/logo.svg', { type: 'image/svg+xml', body: SVG_FIXTURE }],
      ['/root-logo.png', { type: 'image/png', body: makePng(3, 4, [60, 120, 220]) }],
      ['/root-logo.svg', { type: 'image/svg+xml', body: SVG_FIXTURE }],
    ]);
    const crossRoutes = new Map<string, { type: string; body: Buffer }>([
      ['/cd-logo.png', { type: 'image/png', body: makePng(5, 5, [40, 180, 90]) }],
    ]);

    const docServer = await startServer(docRoutes, docRequests);
    servers.push(docServer);
    docOrigin = docServer.origin;
    const crossServer = await startServer(crossRoutes, crossRequests);
    servers.push(crossServer);
    crossOrigin = crossServer.origin;
    crossPngUrl = `${crossOrigin}/cd-logo.png`;

    // The document serves its final content, now that both origins are known
    // (the markdown embeds the cross-origin URL).
    docRoutes.set('/notes/remote.md', {
      type: 'text/markdown; charset=utf-8',
      body: Buffer.from(markdownFor(crossPngUrl), 'utf8'),
    });

    harness = await launchExtensionContext('remote-doc-images-');
    standalone = await harness.context.newPage();
    embed = await harness.context.newPage();

    // Settings live in chrome.storage, which only an extension page can write:
    // bootstrap them on the embed page, and the content-script viewer (an http
    // page, where `chrome.storage` does not exist in the page realm) picks them
    // up when it loads below.
    await embed.goto(embedUrl(), { waitUntil: 'load' });
    await waitFor(embed, VIEWER_EMBED_READY_JS);
    await evalJs(embed, SET_STORAGE_JS, { ...FIXED_SETTINGS });
    await embed.reload({ waitUntil: 'load' });
    await waitFor(embed, VIEWER_EMBED_READY_JS);
  });

  after(async () => {
    await harness?.close();
    for (const server of servers) {
      await server.close();
    }
  });

  it('renders a remote document in the content-script viewer and reads its SVG images', async () => {
    await standalone.goto(documentUrl(), { waitUntil: 'load' });
    await waitFor(standalone, WAIT_STANDALONE_READY_JS);
    await evalJs(standalone, waitImagesJs('#markdown-content'));
    // SVG image nodes are fetched and drawn asynchronously, so the rendered
    // picture only appears once the read has returned.
    await waitFor(
      standalone,
      `() => Array.from(document.querySelectorAll('#markdown-content img'))
        .filter((img) => (img.getAttribute('src') || '').startsWith('data:image/png;base64,')).length >= 2`,
      30000,
    );

    const report = await evalJs<{
      images: Array<{ src: string; width: number }>;
      errorBlocks: number;
    }>(standalone, `() => {
      const root = document.getElementById('markdown-content');
      return {
        images: Array.from(root.querySelectorAll('img')).map((img) => ({
          src: img.getAttribute('src') || '',
          width: img.naturalWidth,
        })),
        errorBlocks: root.querySelectorAll('pre').length,
      };
    }`);

    assert.equal(
      report.errorBlocks,
      0,
      'no image read may fail on a remote document (#128 was exactly that error block)',
    );

    const fileBacked = report.images.filter((image) => !image.src.startsWith('data:'));
    const rendered = report.images.filter((image) => image.src.startsWith('data:image/png;base64,'));
    assert.equal(
      report.images.length,
      5,
      `expected three raster files and two rendered SVG files, got ${JSON.stringify(report.images.map((image) => image.src.slice(0, 60)))}`,
    );
    assert.equal(fileBacked.length, 3, 'the raster files are loaded by the browser itself');
    for (const image of fileBacked) {
      assert.ok(image.width > 0, `image did not load: ${image.src}`);
    }
    // Both SVG files are read through the document service before being drawn.
    // The relative one resolves in the page's own context (content-script XHR);
    // the root-relative one only works once '/…' is routed to the document
    // origin instead of becoming file:///….
    assert.equal(rendered.length, 2, `both SVG files must be read and rendered: ${JSON.stringify(report.images)}`);
    for (const path of ['/notes/assets/logo.svg', '/root-logo.svg']) {
      assert.ok(
        docRequests.some((entry) => entry.path === path),
        `the document origin was never asked for ${path}`,
      );
    }
  });

  it('reads relative, root-relative and cross-origin resources through the export API', async () => {
    await embed.goto(embedUrl(), { waitUntil: 'load' });
    await waitFor(embed, VIEWER_EMBED_READY_JS);
    await evalJs(embed, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT',
      content: markdownFor(crossPngUrl),
      filename: 'remote.md',
      fileDir: '',
      documentBaseUri: documentUrl(),
    });
    await waitFor(embed, WAIT_RENDERED_JS);

    // The embed host installs a workspace file reader (its parent owns the
    // files) and does not forward `documentBaseUri`, so point the document
    // service at the remote document the way the host would and let the reads
    // take the real http paths.
    await evalJs(embed, `(documentUrl) => {
      const doc = globalThis.platform.document;
      doc.setWorkspaceFileReader(null);
      doc.setDocumentPath('remote.md', documentUrl);
      return doc.baseUrl;
    }`, documentUrl());

    const reads = await evalJs<Record<string, { head?: number[]; svg?: boolean; error?: string }>>(embed, `async (input) => {
      const doc = globalThis.platform && globalThis.platform.document;
      if (!doc) { return { service: { error: 'platform.document unavailable' } }; }
      const head = (base64) => {
        const binary = atob(base64.slice(0, 12));
        return Array.from(binary).map((char) => char.charCodeAt(0)).slice(0, 8);
      };
      const readBinary = async (url, viaFile) => {
        try {
          const base64 = viaFile
            ? await doc.readFile(url, { binary: true })
            : await doc.readRelativeFile(url, { binary: true });
          return { head: head(base64) };
        } catch (error) {
          return { error: String((error && error.message) || error) };
        }
      };
      const readText = async (url, viaFile) => {
        try {
          const text = viaFile ? await doc.readFile(url) : await doc.readRelativeFile(url);
          return { svg: text.includes('<svg') };
        } catch (error) {
          return { error: String((error && error.message) || error) };
        }
      };
      // The calls ResourceEmbedder makes for a remote document: relative and
      // absolute URLs go through readRelativeFile, while a '/…' path counts as
      // absolute and reaches readFile.
      return {
        relative: await readBinary('assets/logo.png', false),
        root: await readBinary('/root-logo.png', true),
        cross: await readBinary(input.crossUrl, false),
        relativeSvg: await readText('assets/logo.svg', false),
        rootSvg: await readText('/root-logo.svg', true),
      };
    }`, { crossUrl: crossPngUrl });

    assert.deepEqual(reads.relative?.head, PNG_SIGNATURE, `relative read failed: ${reads.relative?.error}`);
    assert.deepEqual(reads.root?.head, PNG_SIGNATURE, `root-relative read failed: ${reads.root?.error}`);
    assert.deepEqual(reads.cross?.head, PNG_SIGNATURE, `cross-origin read failed: ${reads.cross?.error}`);
    assert.equal(reads.relativeSvg?.svg, true, `relative SVG read failed: ${reads.relativeSvg?.error}`);
    assert.equal(reads.rootSvg?.svg, true, `root-relative SVG read failed: ${reads.rootSvg?.error}`);

    // The bytes of an absolute URL can only come from the worker: the extension
    // host may not read another origin on its own.
    assert.ok(
      crossRequests.some((entry) => entry.path === '/cd-logo.png'),
      `the cross-origin server was never asked for the image: ${JSON.stringify(crossRequests)}`,
    );
  });
});
