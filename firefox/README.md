# docu.md for Firefox

docu.md for Firefox is the Firefox browser version of docu.md Markdown Viewer. It is built for people who want to open Markdown in the browser, review a finished reading view, and export a document without moving the content into another editor.

Use this version when Firefox is your daily browser, when you prefer installing from Firefox Add-ons, or when you need to review local and web Markdown in a Firefox-based workflow.

## Highlights

- Preview local files and supported web Markdown directly in Firefox.
- Render rich Markdown content including tables, task lists, code blocks, math formulas, SVG content, and complex HTML tables.
- Display diagrams and charts from common text-based formats such as PlantUML, Mermaid, Vega/Vega-Lite, drawio, Canvas, Infographic, and Graphviz.
- Export to DOCX, PDF, or self-contained HTML where supported.
- Use document themes and local processing for a private handoff workflow.

## Install

Install from Firefox Add-ons:

https://addons.mozilla.org/firefox/addon/markdown-viewer-extension/

After installation, pin the extension if you want quicker access to settings and actions.

## First Run Setup

Firefox requires explicit user approval for extension permissions. For normal web pages, install the extension and open a supported Markdown resource. For local files, enable file access in the browser extension settings before opening files from your device.

If a local `.md` file opens as plain text or downloads instead of rendering, check the Firefox extension details page and confirm the required access is enabled.

## Main Workflows

### Open a Local Markdown File

1. Enable local file access for the extension.
2. Open a `.md` file from Firefox or drag it into the browser.
3. Review the rendered document.
4. Choose a theme if the document is meant for sharing or export.
5. Export when the document is ready.

### Review Markdown from the Web

Open a supported Markdown URL in Firefox. docu.md renders the file as a clean reading page, preserving document structure, tables, images, code blocks, math, and visual blocks where supported.

### Export a Finished Document

Use the export action when you need a handoff file. DOCX output is useful when the recipient needs an editable Word document. PDF or HTML may be available depending on the platform build and current feature support.

## Export and Output

docu.md focuses on turning Markdown into files people can actually use after writing is done:

- DOCX for editable documents.
- PDF for print-style sharing where supported.
- HTML for portable publishing where supported.
- Image/vector output for rendered visual blocks where supported.

Exact output options can vary by platform and release. If an output is unavailable in Firefox, export from another docu.md platform using the same source Markdown.

## Privacy

Normal preview and export processing happens locally. Your Markdown files do not need to be uploaded to a remote rendering service just to view or export them.

Firefox permission prompts are part of the browser security model. Local file access should be enabled only if you want docu.md to open files from your device.

## Platform Notes and Limitations

- Firefox permission behavior can differ from Chromium browsers.
- Local file rendering depends on browser-level extension access.
- Some web pages may prevent extension processing through browser or site restrictions.
- Feature parity is shared with the docu.md engine, but browser APIs can affect exact behavior.

## Troubleshooting

### Local files do not render

Open a local `.md` file: if it shows as plain text, the extension is not allowed
to read your files. Firefox 153+ treats file access as a permission you grant per
extension, and it is **off by default**:

1. Open the extension popup — when access is missing it shows a warning with an
   **Enable local file access** button; click it and allow the request.
2. If the request is refused, enable **Access local files on your computer**
   manually: `about:addons` → docu.md → **Permissions and data**.
3. Reopen the file (open pages do not pick the permission up).

Reinstalling or updating the extension resets this permission, so enable it
again after every update. Without it Firefox does not run the extension on
`file://` pages at all.

Granting it is not always enough: exports also need the local file origin policy
to allow reads outside the file's own directory, which is a separate setting —
see the next section.

### Local images are missing from an exported DOCX/HTML file

Embedding an image needs its bytes, and Firefox decides whether the extension may
read them. Local file access (above) is only the first of two settings:

1. **Extension file access** — required, and resets with every reinstall/update.
   The browser console reports the state of every read path and of the permission
   itself (`[DocumentService] Firefox could not read a local file…`).
2. **Local file origin policy** — `security.fileuri.strict_origin_policy`
   (default `true`) confines a local read to files in the **same directory**: a
   document in `notes/` cannot read `notes/assets/image.png`, and neither the
   extension nor the page can work around that. Setting it to `false` in
   `about:config` (then restarting) treats local files as one origin, which is
   what Chromium browsers do, and restores both local image display and image
   embedding.

Until that policy is relaxed, Firefox has no way to hand the extension the bytes
of a local image on its own: pages still display such images, because the browser
loads them itself, but an export cannot embed them. The export therefore asks for
the folder holding the images, once per document: a file picker is the one local
read the browser always allows, so the selected files are embedded as they are
(original bytes for images, vector SVG kept vector). Nothing is uploaded, no
prompt appears when the regular reads already work, and the choice lasts until
the page is reloaded.

Note that reading an image's pixels through a canvas is not a substitute: the
canvas stays tainted for local files, so no bytes can be recovered that way.

### A web Markdown file still shows as plain text

Refresh the page and confirm the file type is supported. If the server sends unusual content headers, save the file locally and open it from disk.

### Export is unavailable

Check that the document finished rendering. If the browser blocks a download, allow downloads from the extension and retry.

## Related Platforms

- Chrome / Chromium: browser workflow with Chromium extension APIs.
- Microsoft Edge: Edge Add-ons distribution and Edge-managed updates.
- VS Code: editor-side preview and commands.
- Obsidian: vault-native preview and export.
- Mobile: file picker and share workflows on iOS and Android.