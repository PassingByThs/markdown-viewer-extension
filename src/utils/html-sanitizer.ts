/**
 * HTML Sanitizer
 * 
 * The one place where markup that came from a document is made safe to put into
 * the DOM, shared by the HTML block plugin and the rendered-document sanitizer.
 * Parsing happens in an inert `<template>`: nothing executes there and nothing
 * loads, which is what makes it safe to clean markup that has not been cleaned
 * yet. Callers that need a live element must sanitize *first* — an `<img src>`
 * inserted into a live tree starts loading immediately, so a failing URL fires
 * its onerror handler before any sanitizer ever sees the markup.
 *
 * When sanitizing is impossible (no usable DOM), the result is a notice, not the
 * original markup: a sanitizer that falls back to raw HTML hands a document
 * exactly the execution channel it exists to close.
 */

import { isSafeSrcset, isSafeUrl } from './url-safety.ts';

/**
 * Options for a sanitizing pass.
 */
export interface HtmlSanitizeOptions {
  /** Replace removed elements with a visible notice instead of dropping them. */
  reportBlocked?: boolean;
}

/** Node type numbers, so sanitizing does not depend on a global `Node`. */
const ELEMENT_NODE = 1;
const COMMENT_NODE = 8;

/**
 * Elements that are active content, re-enter the parser, or hijack the page:
 * scripts and plugin hosts, media that loads and fires events, document-head
 * machinery (a `<base>`/`<link>`/`<meta>` from a block can hijack the page),
 * forms (a document must not render a working submission target), and
 * `<template>`/`<noscript>`, whose contents are parsed outside the tree a
 * walker sees (a classic sanitizer bypass).
 *
 * Deliberately NOT blocked: `<style>` (documented feature — html-demo.md's
 * "scoped CSS" block — with its `@import`/`expression(` neutralized below, and
 * CSS cannot execute), and the form *controls* (`<button>`, `<input>`, …) that
 * html-demo.md's button gallery and GFM task lists use: without a `<form>` and
 * with `action`/`formaction`/`autofocus`/`on*` stripped they are inert.
 */
const BLOCKED_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
  'AUDIO', 'VIDEO', 'SOURCE', 'TRACK',
  'BASE', 'META', 'LINK', 'FORM',
  'TEMPLATE', 'NOSCRIPT',
]);

/** Attributes that are active regardless of their value. */
const BLOCKED_ATTRIBUTES = new Set([
  'srcdoc', 'formaction', 'action', 'ping', 'poster', 'background',
  'lowsrc', 'dynsrc', 'http-equiv', 'autofocus', 'manifest',
]);

/** Attributes whose value is a URL (or URL list) and must pass the URL policy. */
const URL_ATTRIBUTES = new Set([
  'src', 'href', 'xlink:href', 'srcset', 'poster', 'action', 'formaction',
  'data', 'cite', 'longdesc', 'background', 'ping', 'usemap',
]);

/** Script URLs — also a catch-all for attributes nobody has heard of yet. */
const SCRIPT_URL = /(?:javascript|vbscript|livescript)\s*:|data\s*:\s*text\/html/i;

/** CSS that can execute or reach out; neutralized inside style values. */
const ACTIVE_CSS = /(?:expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|@import)/gi;

/**
 * Sanitize HTML content to remove dangerous elements and attributes.
 * @param html - Raw HTML content
 * @returns Sanitized HTML
 */
export function sanitizeHtml(html: string): string {
  return sanitizeHtmlFragment(html);
}

/**
 * Sanitize an HTML string.
 * @param html - Raw HTML markup
 * @param options - Policy options
 * @returns Sanitized markup, or a notice when sanitizing was impossible
 */
export function sanitizeHtmlFragment(html: string, options: HtmlSanitizeOptions = {}): string {
  try {
    const template = document.createElement('template');
    template.innerHTML = html;
    const root = (template.content ?? template) as DocumentFragment | Element;
    sanitizeHtmlTree(root, options);
    return template.innerHTML;
  } catch (error) {
    console.warn('[HtmlSanitizer] failed to sanitize markup; rendering a notice instead', error);
    return blockedNotice('Unsafe HTML could not be sanitized in this environment.');
  }
}

/**
 * Walk the node tree and remove dangerous elements/attributes
 * @param root - Root node to sanitize
 * @param options - Policy options
 */
export function sanitizeHtmlTree(root: DocumentFragment | Element, options: HtmlSanitizeOptions = {}): void {
  const stack: Element[] = [];

  Array.from(root.childNodes).forEach((child) => {
    if (child.nodeType === ELEMENT_NODE) {
      stack.push(child as Element);
    } else if (child.nodeType === COMMENT_NODE) {
      child.remove();
    }
  });

  while (stack.length > 0) {
    const node = stack.pop()!;
    const tagName = (node.tagName || '').toUpperCase();

    const blockedForPolicy = BLOCKED_TAGS.has(tagName);
    if (blockedForPolicy) {
      if (options.reportBlocked) {
        node.replaceWith(blockedElement(describeBlockedNode(node, tagName)));
      } else {
        node.remove();
      }
      continue;
    }

    sanitizeAttributes(node);

    // A kept <style> element is CSS the browser applies to the whole page;
    // `@import` (and the old executable forms) would reach outside it, so the
    // text is neutralized too — mermaid's inline SVG styles need none of this.
    if (tagName === 'STYLE' && typeof node.textContent === 'string') {
      const neutralized = node.textContent.replace(ACTIVE_CSS, '');
      if (neutralized !== node.textContent) {
        node.textContent = neutralized;
      }
    }

    // Process children of every kept element — a blocked element never gets
    // here, so nothing can hide behind one.
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === ELEMENT_NODE) {
        stack.push(child as Element);
      } else if (child.nodeType === COMMENT_NODE) {
        child.remove();
      }
    });
  }
}

/**
 * Remove every attribute that can execute, fetch a script URL, or override the
 * page: `on*` handlers, active attributes, URL attributes that fail the URL
 * policy, and any attribute value that is itself a script URL.
 */
function sanitizeAttributes(element: Element): void {
  if (!element.hasAttributes()) return;

  Array.from(element.attributes).forEach((attr) => {
    const attrName = attr.name.toLowerCase();
    const value = attr.value ?? '';

    if (attrName.startsWith('on') || BLOCKED_ATTRIBUTES.has(attrName)) {
      element.removeAttribute(attr.name);
      return;
    }

    // Style first: a style value that mentions a script URL keeps its other
    // declarations and loses only the dangerous part, instead of being dropped
    // wholesale by the catch-all below.
    if (attrName === 'style') {
      const neutralized = value.replace(ACTIVE_CSS, '');
      if (neutralized !== value) {
        element.setAttribute(attr.name, neutralized);
      }
      return;
    }

    if (SCRIPT_URL.test(value)) {
      element.removeAttribute(attr.name);
      return;
    }

    if (!URL_ATTRIBUTES.has(attrName)) return;

    if (attrName === 'srcset') {
      if (!isSafeSrcset(value)) {
        element.removeAttribute(attr.name);
      }
      return;
    }

    if (!isSafeUrl(value)) {
      element.removeAttribute(attr.name);
    }
  });
}

/** Short description of a removed element, for the visible notice. */
function describeBlockedNode(node: Element, tagName: string): string {
  const markup = node.outerHTML || `<${tagName.toLowerCase()}>`;
  const truncated = markup.length > 500 ? `${markup.slice(0, 500)}...` : markup;
  return `Blocked insecure <${tagName.toLowerCase()}> element removed.\n\n${truncated}`;
}

/** The notice shown in place of removed markup (used by the viewer/exporters). */
function blockedElement(message: string): Element {
  const warning = document.createElement('pre');
  warning.className = 'blocked-html-warning';
  warning.setAttribute('style', 'background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px; white-space: pre-wrap;');
  warning.textContent = message;
  return warning;
}

function blockedNotice(message: string): string {
  try {
    return blockedElement(message).outerHTML;
  } catch {
    return `<pre class="blocked-html-warning">${message}</pre>`;
  }
}

/**
 * Check if sanitized HTML has any meaningful content
 * @param sanitizedHtml - Sanitized HTML string
 * @returns True if has content, false if empty or only whitespace
 */
export function hasHtmlContent(sanitizedHtml: string): boolean {
  const temp = document.createElement('div');
  temp.innerHTML = sanitizedHtml;
  // Check if there's any text content or element nodes
  return temp.textContent!.trim().length > 0 || temp.querySelector('*') !== null;
}

/**
 * Sanitize HTML and check if it has content in one step
 * @param html - Raw HTML content
 * @returns Sanitized HTML and content check result
 */
export function sanitizeAndCheck(html: string): { sanitized: string; hasContent: boolean } {
  // Skip simple line breaks (only <br> tags with whitespace/nbsp)
  if (/^(?:<br\s*\/?>(?:\s|&nbsp;)*)+$/i.test(html)) {
    return { sanitized: '', hasContent: false };
  }

  const sanitized = sanitizeHtml(html);
  const hasContent = hasHtmlContent(sanitized);
  return { sanitized, hasContent };
}
