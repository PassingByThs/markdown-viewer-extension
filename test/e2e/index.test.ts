/**
 * Installed Chrome extension E2E entry point.
 *
 * This suite intentionally runs under Node.js' native test runner. The
 * browser is driven directly by Playwright; no model-backed browser agent is
 * involved in test execution.
 *
 * Run with `npm run test:e2e` after building the extension.
 *
 * The npm script passes `--test-concurrency=1`: every file in this group
 * drives a real browser, and node:test would otherwise run the files in
 * parallel processes. The suites must stay sequential — they share no state
 * (each launches its own temp profile), but their render waits are already
 * tuned for the single-tenant timing of the old single-process fibjs entry,
 * and CPU contention has been observed to turn a first render into the
 * documented cold-start stall. `--test-concurrency=2`/`3` is a valid local
 * experiment, not a default.
 */

import '../suites/extension-e2e/index.js';
