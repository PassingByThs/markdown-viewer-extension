import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  assetFileName,
  ensureOutputDirectory,
  formatAssetReport,
  parseArgs,
  parseSummaryPages,
} from '../../../scripts/documd.js';
import { DEFAULT_RENDER_SETTINGS } from '../../../src/config/defaults.ts';

describe('Markdown HTML CLI arguments', () => {
  it('uses stable defaults', () => {
    const options = parseArgs(['notes.md']);
    assert.equal(options.input, 'notes.md');
    assert.equal(options.theme, 'default');
    assert.equal(options.frontmatterDisplay, 'hide');
    assert.equal(options.tableLayout, 'center');
    assert.equal(options.timeoutMs, 120_000);
  });

  it('shares the extension default render/layout settings (single source)', () => {
    const options = parseArgs(['notes.md']);
    for (const key of ['theme', 'language', 'frontmatterDisplay', 'tableLayout', 'imageLayout', 'diagramLayout', 'tableMergeEmpty', 'firstLineIndent']) {
      assert.equal(
        options[key],
        DEFAULT_RENDER_SETTINGS[key],
        `parseArgs default for ${key} must come from the shared config`,
      );
    }
  });

  it('parses rendering options', () => {
    const options = parseArgs([
      'notes.md',
      'notes.html',
      '--theme', 'midnight',
      '--frontmatter', 'table',
      '--table-layout', 'left',
      '--merge-empty-cells',
      '--timeout', '30',
    ]);

    assert.equal(options.output, 'notes.html');
    assert.equal(options.theme, 'midnight');
    assert.equal(options.frontmatterDisplay, 'table');
    assert.equal(options.tableLayout, 'left');
    assert.equal(options.tableMergeEmpty, true);
    assert.equal(options.timeoutMs, 30_000);
  });

  it('rejects invalid enum options', () => {
    assert.throws(
      () => parseArgs(['notes.md', '--frontmatter', 'show']),
      /--frontmatter must be hide, table, or raw/,
    );
    assert.throws(
      () => parseArgs(['notes.md', '--first-line-indent', '9']),
      /--first-line-indent must be an integer between 0 and 4/,
    );
    assert.throws(
      () => parseArgs(['notes.md', '--first-line-indent', 'abc']),
      /--first-line-indent must be an integer between 0 and 4/,
    );
    assert.equal(parseArgs(['notes.md', '--first-line-indent', '0']).firstLineIndent, 0);
    assert.equal(parseArgs(['notes.md', '--first-line-indent', '4']).firstLineIndent, 4);
  });

  it('accepts an output file directly under an existing filesystem root', async () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    await ensureOutputDirectory(path.join(filesystemRoot, 'documd-root-output-test.html'));
  });
});

describe('SUMMARY book parsing', () => {
  it('parses pages with titles, links and depth', () => {
    const pages = parseSummaryPages(
      '# Book\n\n- [Intro](intro.md)\n- [Chapter One](chapter1.md)\n  - [Nested](sub/deep.md)\n\n## Boilerplate\n',
      '',
    );
    assert.deepEqual(pages, [
      { href: 'intro.md', title: 'Intro', depth: 0 },
      { href: 'chapter1.md', title: 'Chapter One', depth: 0 },
      { href: 'sub/deep.md', title: 'Nested', depth: 1 },
    ]);
  });

  it('skips boilerplate links and merges the summary directory', () => {
    const pages = parseSummaryPages(
      '- [Mail](mailto:x@y.z)\n- [Anchor](#top)\n- [Page](page.md)\n',
      'docs',
    );
    assert.deepEqual(pages, [{ href: 'docs/page.md', title: 'Page', depth: 0 }]);
  });

  it('keeps absolute URLs untouched', () => {
    const pages = parseSummaryPages('- [Remote](https://example.com/x.md)\n', '');
    assert.deepEqual(pages, [{ href: 'https://example.com/x.md', title: 'Remote', depth: 0 }]);
  });
});

describe('CLI output format', () => {  it('defaults markdown input to html', () => {
    const options = parseArgs(['notes.md']);
    assert.equal(options.format, 'html');
    assert.equal(options.theme, 'default');
    assert.equal(options.frontmatterDisplay, 'hide');
    assert.equal(options.tableLayout, 'center');
    assert.equal(options.timeoutMs, 120_000);
  });

  it('defaults diagram input to svg', () => {
    assert.equal(parseArgs(['flow.puml']).format, 'svg');
    assert.equal(parseArgs(['chart.mmd']).format, 'svg');
  });

  it('infers the format from the output extension when --format is omitted', () => {
    assert.equal(parseArgs(['notes.md', 'out.epub']).format, 'epub');
    assert.equal(parseArgs(['notes.md', 'out.docx']).format, 'docx');
    assert.equal(parseArgs(['notes.md', 'out.pdf']).format, 'pdf');
    assert.equal(parseArgs(['flow.puml', 'out.png']).format, 'png');
    assert.equal(parseArgs(['flow.puml', 'out.drawio']).format, 'drawio');
    assert.equal(parseArgs(['flow.puml', 'out.svg']).format, 'svg');
    assert.equal(parseArgs(['notes.md', 'out.html']).format, 'html');
  });

  it('honors an explicit --format over the output extension', () => {
    assert.equal(parseArgs(['flow.puml', '--format', 'png', 'out.drawio']).format, 'png');
    assert.equal(parseArgs(['notes.md', '--format', 'docx', 'out.pdf']).format, 'docx');
  });

  it('accepts a second positional as the output file (pandoc style)', () => {
    const options = parseArgs(['test.md', 'test.pdf']);
    assert.equal(options.input, 'test.md');
    assert.equal(options.output, 'test.pdf');
    assert.equal(options.format, 'pdf');
    assert.equal(parseArgs(['notes.md', 'out.epub']).format, 'epub');
    assert.equal(parseArgs(['notes.md', 'out.html']).format, 'html');
    assert.equal(parseArgs(['flow.puml', 'out.svg']).format, 'svg');
    assert.equal(parseArgs(['flow.puml', 'out.png']).format, 'png');
    assert.equal(parseArgs(['chart.mmd', 'out.drawio']).format, 'drawio');
  });

  it('rejects an unrecognisable positional output instead of guessing', () => {
    assert.throws(
      () => parseArgs(['notes.md', 'out.xyz']),
      /unknown output format/,
    );
    assert.throws(
      () => parseArgs(['notes.bin', 'out.pdf']),
      /unknown input format/,
    );
    assert.throws(
      () => parseArgs(['a.md', 'b.md']),
      /unknown output format/,
    );
    // an explicit --format overrides the output extension (same as -o)
    assert.equal(parseArgs(['notes.md', 'out.xyz', '--format', 'pdf']).format, 'pdf');
  });

  it('defaults --book to epub', () => {
    assert.equal(parseArgs(['SUMMARY.md', '--book']).format, 'epub');
    assert.equal(parseArgs(['SUMMARY.md', '--book', '--format', 'pdf']).format, 'pdf');
  });

  it('parses rendering options', () => {
    const options = parseArgs([
      'notes.md',
      'notes.html',
      '--theme', 'midnight',
      '--frontmatter', 'table',
      '--table-layout', 'left',
      '--merge-empty-cells',
      '--timeout', '30',
    ]);

    assert.equal(options.output, 'notes.html');
    assert.equal(options.theme, 'midnight');
    assert.equal(options.frontmatterDisplay, 'table');
    assert.equal(options.tableLayout, 'left');
    assert.equal(options.tableMergeEmpty, true);
    assert.equal(options.timeoutMs, 30_000);
  });

  it('accepts --version and --help without an input', () => {
    assert.equal(parseArgs(['--version']).version, true);
    assert.equal(parseArgs(['-v']).version, true);
    assert.equal(parseArgs(['--help']).help, true);
  });

  it('rejects unknown formats, uninferable outputs and format/input mismatches', () => {
    assert.throws(
      () => parseArgs(['flow.puml', '--format', 'webp']),
      /--format must be html, epub, docx, pdf, svg, png or drawio/,
    );
    assert.throws(
      () => parseArgs(['notes.md', 'out.txt']),
      /unknown output format/,
    );
    assert.throws(
      () => parseArgs(['notes.md', '--format', 'svg']),
      /requires a diagram input/,
    );
    assert.throws(
      () => parseArgs(['flow.puml', '--format', 'html']),
      /cannot be exported as html/,
    );
    assert.throws(
      () => parseArgs(['SUMMARY.md', '--book', '--format', 'html']),
      /--book requires --format epub, docx or pdf/,
    );
  });
});

describe('documd --assets (export figures and images)', () => {
  it('defaults to exporting every asset as png', () => {
    const options = parseArgs(['report.md', '--assets', './figures']);
    assert.equal(options.assetsDir, './figures');
    assert.equal(options.assetKind, 'all');
    assert.equal(options.format, 'png', 'figures default to png');
    assert.equal(options.failOnError, true, 'a failed render fails the run by default');
  });

  it('parses --kind, --only and --format svg', () => {
    const options = parseArgs([
      'report.md',
      '--assets', 'figs',
      '--kind', 'diagrams',
      '--only', '1,3',
      '--format', 'svg',
    ]);
    assert.equal(options.assetKind, 'diagrams');
    assert.equal(options.format, 'svg');
    assert.deepEqual([...options.onlyIndexes].sort((a, b) => a - b), [1, 3]);
  });

  it('relaxes the exit code on demand', () => {
    assert.equal(parseArgs(['report.md', '--no-fail-on-error']).failOnError, false);
    assert.equal(parseArgs(['report.md', '--fail-on-error']).failOnError, true);
  });

  it('rejects asset options that would do nothing or mean the wrong thing', () => {
    assert.throws(
      () => parseArgs(['report.md', '--kind', 'images']),
      /--kind requires --assets/,
    );
    assert.throws(
      () => parseArgs(['report.md', '--only', '1']),
      /--only requires --assets/,
    );
    assert.throws(
      () => parseArgs(['report.md', '--assets', 'figs', '--kind', 'photos']),
      /--kind must be all, diagrams, or images/,
    );
    assert.throws(
      () => parseArgs(['report.md', '--assets', 'figs', '--only', '0']),
      /--only takes asset numbers/,
    );
    assert.throws(
      () => parseArgs(['report.md', '--assets', 'figs', '--only', 'first']),
      /--only takes asset numbers/,
    );
    assert.throws(
      () => parseArgs(['report.md', '--assets', 'figs', '--format', 'html']),
      /--assets exports figures as png or svg/,
    );
    assert.throws(
      () => parseArgs(['report.md', '--assets', 'figs', '--book']),
      /--book is not supported/,
    );
    assert.throws(
      () => parseArgs(['chart.mmd', '--assets', 'figs']),
      /is a diagram source/,
    );
    assert.throws(
      () => parseArgs(['report.md', 'out.html', '--assets', 'figs']),
      /--assets writes into its own directory/,
    );
  });

  it('names files by document-order number so --only names the same asset back', () => {
    const diagram = { index: 2, kind: 'diagram', type: 'mermaid' };
    assert.equal(
      assetFileName(diagram, { documentBase: 'report.md', diagramFormat: 'png' }),
      'report-02-mermaid.png',
    );
    assert.equal(
      assetFileName(diagram, { documentBase: 'report.md', diagramFormat: 'svg' }),
      'report-02-mermaid.svg',
    );

    const image = { index: 1, kind: 'image', src: 'https://example.com/img/photo.JPEG' };
    assert.equal(
      assetFileName(image, { documentBase: 'report', diagramFormat: 'png' }),
      'report-01-photo.jpeg',
      'an image keeps its original extension',
    );
  });

  it('reports every asset with its number, location and outcome', () => {
    const assets = [
      { index: 1, kind: 'image', src: 'assets/icon.png', line: 6 },
      { index: 2, kind: 'diagram', type: 'mermaid', line: 8, error: 'Parse error on line 1' },
      { index: 3, kind: 'diagram', type: 'mermaid', line: 16 },
    ];
    const report = formatAssetReport(
      assets,
      [{ assetIndex: 1, fileName: 'report-01-icon.png' }],
      { input: 'report.md' },
    );

    assert.match(report, /^report\.md: 2 diagrams, 1 image \(3 assets\)$/m);
    assert.match(report, /report-01-icon\.png/, 'a written asset names its file');
    assert.match(report, /line 6/, 'an asset names its markdown line');
    assert.match(report, /failed: Parse error on line 1/, 'a failed asset names the reason');
    assert.match(report, /skipped/, 'an unselected asset says so instead of looking failed');
    assert.match(report, /line 16/, 'line numbers are padded into a column');
  });
});

describe('standalone dist/cli publish directory', () => {
  it('is a self-contained installable package', () => {
    const cliDir = path.resolve('dist/cli');
    const pkg = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@markdown-viewer/documd');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.bin, { documd: './documd.js' });
    for (const required of ['documd.js', 'browser-renderer.js', 'styles.css', 'themes', 'README.md']) {
      assert.ok(fs.existsSync(path.join(cliDir, required)), `dist/cli must contain ${required}`);
    }
  });

  it('publishes the scoped package as public', () => {
    const cliDir = path.resolve('dist/cli');
    const pkg = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8'));
    assert.equal(pkg.private, false, 'the CLI package must not be marked private');
    assert.equal(
      pkg.publishConfig?.access,
      'public',
      'scoped packages default to private access — publishConfig.access=public is required',
    );
    for (const required of ['documd.js', 'browser-renderer.js', 'styles.css', 'themes/', 'stencils/', 'README.md']) {
      assert.ok(pkg.files.includes(required), `files must include ${required}`);
    }
  });

  it('declares its runtime dependencies so the installed CLI can run', () => {
    const cliDir = path.resolve('dist/cli');
    const pkg = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8'));
    assert.ok(
      pkg.dependencies?.['playwright-core'],
      'documd.js imports playwright-core at runtime — it must be a declared dependency',
    );
    assert.match(pkg.dependencies['playwright-core'], /^\^\d+\.\d+\.\d+$/, 'playwright-core must be a caret range');
  });

  it('runs as a CLI entry point and prints its version', () => {
    // Guards the entry check in documd.js: it must run main() when invoked
    // as a script (a realpath comparison that failed silently before).
    const cliDir = path.resolve('dist/cli');
    const out = execFileSync(process.execPath, [path.join(cliDir, 'documd.js'), '--version'], {
      encoding: 'utf8',
    });
    assert.match(out, /^documd v\d+\.\d+\.\d+ — https:\/\/docu\.md/, `unexpected --version output: ${out}`);
  });
});
