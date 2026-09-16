/**
 * Scope a stylesheet to a container selector.
 *
 * Why this exists
 * ---------------
 * The webview stylesheet is written for **standalone documents**, where the
 * viewer owns `<html>`/`<body>` (browser tab, VS Code webview, mobile shell).
 * Some hosts instead inject a plugin's `styles.css` into the *host application
 * document* — Obsidian does this. Every top-level selector then competes with
 * the host's own styles, and because plugin CSS is injected after the host's
 * `app.css`, an unscoped `body { color: … }` silently overrides the host
 * editor's text color (issue #126).
 *
 * What it does
 * ------------
 * Rewrites every top-level selector so it can only match inside the viewer
 * container (`.markdown-viewer-preview` in Obsidian):
 *
 *   .foo                  →  .scope .foo
 *   .mv-embed .foo        →  .scope.mv-embed .foo        (scope IS the container)
 *   *                     →  .scope, .scope *
 *   :root                 →  .scope                      (variables land here)
 *   body                  →  .scope                      (viewport decls dropped)
 *   :root.dark .foo       →  :root.dark .scope .foo      (host context kept)
 *   body.toc-hidden .foo  →  body.toc-hidden .scope .foo
 *   html[data-x] .foo     →  html[data-x] .scope .foo
 *
 * Host-contextual selectors keep their host prefix and get the scope inserted
 * after it. That matters because shared runtime code toggles state classes
 * (`toc-hidden`, `toc-position-right`, `remark-panel-open`, …) on
 * `document.body`, and viewport-state rules must keep matching those. The
 * declarations still only reach viewer elements, never the host chrome.
 *
 * `@font-face` / `@keyframes` / `@page` are left untouched: font families and
 * animation names are document-global by nature and carry no selectors.
 */

import postcss from 'postcss';

/** At-rules whose contents are not selector lists (copied verbatim). */
const OPAQUE_AT_RULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  'font-face',
  'page',
  'property',
  'counter-style',
]);

/** Declaration names dropped when a bare `body {}` rule is collapsed to the scope. */
const VIEWPORT_DECLARATIONS = ['height', 'overflow'];

/** Selector start that refers to the host document root rather than the viewer. */
const HOST_CONTEXT = /^(?::root|html|body)(?![\w-])/;

/**
 * Split a selector into its first compound selector and the rest
 * (combinators preserved). Parentheses, brackets, quotes and escapes shield
 * their contents, so `:is(a, b) > .c` is not split inside `:is()`.
 *
 * @param {string} selector
 * @returns {{ first: string, rest: string }}
 */
export function splitFirstCompound(selector) {
  let depth = 0;
  let quote = '';

  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];

    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[') {
      depth++;
      continue;
    }
    if (char === ')' || char === ']') {
      depth--;
      continue;
    }
    if (depth > 0) continue;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '>' || char === '+' || char === '~') {
      return { first: selector.slice(0, i), rest: selector.slice(i) };
    }
  }

  return { first: selector, rest: '' };
}

/**
 * Consume the leading host-context compounds of a selector.
 *
 * `html[data-code-view] body.remark-panel-open #x` → host part
 * `html[data-code-view] body.remark-panel-open`, remainder ` #x`.
 *
 * @param {string} selector
 * @returns {{ host: string, rest: string } | null} null when the selector does
 *   not start at the host document root.
 */
function splitHostContext(selector) {
  let offset = 0;
  let host = '';

  while (offset < selector.length) {
    // Combinator (or whitespace) that separates the next compound.
    const gap = /^[\s>+~]*/.exec(selector.slice(offset))[0];
    const remaining = selector.slice(offset + gap.length);
    if (!remaining) break;

    const { first, rest } = splitFirstCompound(remaining);
    if (!HOST_CONTEXT.test(first)) break;

    const compound = remaining.slice(0, remaining.length - rest.length);
    host = host ? `${host}${gap}${compound}` : compound;
    offset += gap.length + compound.length;
  }

  return host ? { host, rest: selector.slice(offset) } : null;
}

/**
 * @param {string} firstCompound
 * @param {string[]} containerClasses
 */
function matchesContainer(firstCompound, containerClasses) {
  return containerClasses.some((cls) => new RegExp(`\\.${cls}(?![\\w-])`).test(firstCompound));
}

/**
 * Rewrite one selector into its scoped form(s).
 *
 * @param {string} selector
 * @param {string} scope - Scope selector, e.g. `.markdown-viewer-preview`.
 * @param {string[]} containerClasses - Classes carried by the scope element
 *   itself. Selectors starting with one of them are part of the container, not
 *   a descendant of it, so the scope compound is merged instead of nested.
 * @returns {{ selectors: string[], collapsedDocumentRoot: boolean }}
 */
export function scopeSelector(selector, scope, containerClasses = []) {
  const host = splitHostContext(selector);

  if (host) {
    // `body` / `:root` alone describe the document root the viewer CSS builds
    // on; the scope element plays that role inside the host document.
    if (!host.rest && (host.host === 'body' || host.host === ':root')) {
      return { selectors: [scope], collapsedDocumentRoot: true };
    }
    // Other host-state selectors (`body.theme-dark`, `:root.dark`, …) stay
    // host-contextual and only narrow down where the scope may appear.
    return { selectors: [`${host.host} ${scope}${host.rest}`], collapsedDocumentRoot: false };
  }

  if (selector === '*') {
    return { selectors: [scope, `${scope} *`], collapsedDocumentRoot: false };
  }

  const { first } = splitFirstCompound(selector);
  if (containerClasses.length && matchesContainer(first, containerClasses)) {
    // The first compound already targets the container element itself.
    return { selectors: [`${scope}${selector}`], collapsedDocumentRoot: false };
  }

  return { selectors: [`${scope} ${selector}`], collapsedDocumentRoot: false };
}

/**
 * Scope every rule in a stylesheet.
 *
 * @param {string} css - Stylesheet text.
 * @param {object} options
 * @param {string} options.scope - Scope selector, e.g. `.markdown-viewer-preview`.
 * @param {string[]} [options.containerClasses] - Classes on the scope element
 *   itself (see {@link scopeSelector}).
 * @param {string[]} [options.dropDeclarations] - Declaration names removed from
 *   rule bodies that collapsed the document root (default: `height`, `overflow`).
 * @returns {string} Scoped stylesheet.
 */
export function scopeCss(css, { scope, containerClasses = [], dropDeclarations = VIEWPORT_DECLARATIONS } = {}) {
  if (!scope) throw new Error('scopeCss: `scope` is required');

  const root = postcss.parse(css);

  const visit = (container) => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'atrule') {
        if (!OPAQUE_AT_RULES.has(node.name.toLowerCase()) && node.nodes) visit(node);
        continue;
      }
      if (node.type !== 'rule') continue;

      const selectors = [];
      let collapsed = false;

      for (const original of node.selectors) {
        const result = scopeSelector(original.trim(), scope, containerClasses);
        selectors.push(...result.selectors);
        collapsed = collapsed || result.collapsedDocumentRoot;
      }

      node.selector = selectors.join(', ');

      // The scope element is not the viewport, so viewport-only declarations
      // from the document-root rule must not follow it into the host.
      if (collapsed && dropDeclarations.length) {
        node.walkDecls((decl) => {
          if (dropDeclarations.includes(decl.prop.toLowerCase())) decl.remove();
        });
      }
    }
  };

  visit(root);
  return root.toString();
}
