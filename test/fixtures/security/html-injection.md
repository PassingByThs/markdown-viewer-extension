# HTML injection payloads

Every payload below announces itself with `console.error('PWNED-…')`: the CLI
prints page console errors, so an executed payload is visible in stderr. None of
them may run, and none of the markup may survive as live markup.

## The reported one: image error handlers

<img src=x onerror="console.error('PWNED-raw-img')">

<div><img src="./missing-a.png" onerror="console.error('PWNED-div-img')"></div>

Inline: <img src="./missing-b.png" onerror="console.error('PWNED-inline-img')"> in a paragraph.

<details><summary>details</summary><img src="./missing-c.png" onerror="console.error('PWNED-details-img')"></details>

| col |
| --- |
| <img src="./missing-d.png" onerror="console.error('PWNED-table-img')"> |

- <img src="./missing-e.png" onerror="console.error('PWNED-list-img')">

> <img src="./missing-f.png" onerror="console.error('PWNED-quote-img')">

## Other elements and attributes

<svg onload="console.error('PWNED-svg-onload')"></svg>

<iframe srcdoc="<script>console.error('PWNED-iframe')</script>"></iframe>

<script>console.error('PWNED-script')</script>

<template><img src="./missing-g.png" onerror="console.error('PWNED-template')"></template>

<video><source src="./missing.mp4" onerror="console.error('PWNED-source')"></video>

<a href="javascript:console.error('PWNED-js-url')">javascript link</a>

<div srcdoc="x" autofocus onfocus="console.error('PWNED-focus')" tabindex="0">focusable</div>

## Footnote labels are markup too

Body text with a reference[^pwn] and one with an attribute breakout[^attr].

[^pwn"><img src="./missing-i.png" onerror="console.error('PWNED-footnote')">]: note text

[^attr' autofocus onfocus="console.error('PWNED-footnote-id')"]: another note

```html
<img src="./missing-h.png" onerror="console.error('PWNED-fence')">
```

## Harder shapes: SVG data URLs and foreign content

<svg><use href="data:image/svg+xml,<svg id='p' onload='console.error(&quot;PWNED-use-data&quot;)'></svg>#p"></use></svg>

<img src="data:image/svg+xml,<svg onload='console.error(&quot;PWNED-img-data&quot;)'></svg>">

<math><mtext><img src="./missing-j.png" onerror="console.error('PWNED-mathml')"></mtext></math>

## The documented feature still has to work

<div style="padding: 8px; border-left: 3px solid #0284c7; background: #f0f9ff;">
  <strong>Styled HTML block</strong>: inline styles must survive sanitizing.
</div>
