import fs from 'fs';
import path from 'path';

// Base directory for the project
const ROOT_DIR = path.join(import.meta.dirname, '../..');

// Directories to scan for i18n keys
const SCAN_DIRS = {
  // Shared core code
  src: path.join(ROOT_DIR, 'src'),
  // Platform-specific TypeScript code
  chrome: path.join(ROOT_DIR, 'chrome/src'),
  chromeRoot: path.join(ROOT_DIR, 'chrome'), // For manifest.json
  firefox: path.join(ROOT_DIR, 'firefox'), // src/ plus manifest.json
  vscode: path.join(ROOT_DIR, 'vscode/src'),
  mobileSrc: path.join(ROOT_DIR, 'mobile/src'),
  // Flutter/Dart code
  flutter: path.join(ROOT_DIR, 'mobile/lib'),
};

/**
 * Recursively scans code for i18n key usages.
 *
 * Supported call sites / patterns:
 * - translate(key)
 * - chrome.i18n.getMessage('key')
 * - data-i18n="key"
 * - data-i18n-attr="attr:key,attr:key"
 * - __MSG_key__ (manifest)
 * - localization.t('key')
 * - localization.translate('key')
 *
 * Notes:
 * - Intentionally does NOT use full-text search fallbacks.
 * - Only extracts static string literal keys.
 */
export function findI18nKeysInCode() {
  const keysUsedInCode = new Set();
  const keysUsedInHTML = new Set();
  const keysUsedInDart = new Set();

  function addResolvedVariableKey(variableKeyMap, variableName) {
    const values = variableKeyMap.get(variableName);
    if (!values) return;
    for (const value of values) {
      keysUsedInCode.add(value);
    }
  }

  function scanJSFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const variableKeyMap = new Map();

      const directAssignmentPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = directAssignmentPattern.exec(content)) !== null) {
        variableKeyMap.set(match[1], [match[2]]);
      }

      const ternaryAssignmentPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
      while ((match = ternaryAssignmentPattern.exec(content)) !== null) {
        variableKeyMap.set(match[1], [match[2], match[3]]);
      }

      // Match t('key'), tf('key', ...), translate('key')
      const translatePattern = /\b(?:t|tf|translate)\s*\(\s*['"]([^'"]+)['"]/g;
      while ((match = translatePattern.exec(content)) !== null) {
        keysUsedInCode.add(match[1]);
      }

      const i18nPattern = /(?:chrome|browser)\.i18n\??\.getMessage\s*\(\s*['"]([^'"]+)['"]/g;
      while ((match = i18nPattern.exec(content)) !== null) {
        keysUsedInCode.add(match[1]);
      }

      const variableI18nPattern = /(?:chrome|browser)\.i18n\??\.getMessage\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
      while ((match = variableI18nPattern.exec(content)) !== null) {
        addResolvedVariableKey(variableKeyMap, match[1]);
      }

      const bracketAccessPattern = /\bmessages\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
      while ((match = bracketAccessPattern.exec(content)) !== null) {
        keysUsedInCode.add(match[1]);
      }

      const variableBracketAccessPattern = /\bmessages\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g;
      while ((match = variableBracketAccessPattern.exec(content)) !== null) {
        addResolvedVariableKey(variableKeyMap, match[1]);
      }
    } catch {
      // Ignore unreadable files
    }
  }

  function scanHTMLFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');

      const i18nPattern = /data-i18n\s*=\s*["']([^"']+)["']/g;
      const i18nAttrPattern = /data-i18n-attr\s*=\s*["']([^"']+)["']/g;
      let match;
      while ((match = i18nPattern.exec(content)) !== null) {
        keysUsedInHTML.add(match[1]);
      }

      while ((match = i18nAttrPattern.exec(content)) !== null) {
        const entries = match[1].split(',');
        for (const entry of entries) {
          const separatorIndex = entry.indexOf(':');
          if (separatorIndex === -1) {
            continue;
          }

          const key = entry.slice(separatorIndex + 1).trim();
          if (key) {
            keysUsedInHTML.add(key);
          }
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  function scanManifestFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');

      const msgPattern = /__MSG_([A-Za-z0-9_@.-]+?)__/g;
      let match;
      while ((match = msgPattern.exec(content)) !== null) {
        keysUsedInCode.add(match[1]);
      }
    } catch {
      // Ignore unreadable files
    }
  }

  function scanDartFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');

      const tPattern = /localization\.t\s*\(\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = tPattern.exec(content)) !== null) {
        keysUsedInDart.add(match[1]);
      }

      const translatePattern = /localization\.translate\s*\(\s*['"]([^'"]+)['"]/g;
      while ((match = translatePattern.exec(content)) !== null) {
        keysUsedInDart.add(match[1]);
      }
    } catch {
      // Ignore unreadable files
    }
  }

  function shouldSkipDirName(dirName) {
    return dirName === '_locales' || dirName === 'node_modules' || dirName === 'dist' || dirName === '.git' || dirName === 'build';
  }

  function scanDirectory(dir, extensions) {
    try {
      const files = fs.readdirSync(dir);

      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          if (!shouldSkipDirName(file)) {
            scanDirectory(fullPath, extensions);
          }
          continue;
        }

        if (!stat.isFile()) continue;

        if (file === 'manifest.json') {
          scanManifestFile(fullPath);
          continue;
        }

        const ext = path.extname(file);
        if (!extensions.includes(ext)) continue;

        if (ext === '.js' || ext === '.ts') {
          scanJSFile(fullPath);
        } else if (ext === '.html') {
          scanHTMLFile(fullPath);
        } else if (ext === '.dart') {
          scanDartFile(fullPath);
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  // Scan TypeScript/JavaScript directories
  const tsDirs = [SCAN_DIRS.src, SCAN_DIRS.chrome, SCAN_DIRS.chromeRoot, SCAN_DIRS.firefox, SCAN_DIRS.vscode, SCAN_DIRS.mobileSrc];
  for (const dir of tsDirs) {
    if (fs.existsSync(dir)) {
      scanDirectory(dir, ['.js', '.ts', '.html']);
    }
  }

  // Scan Flutter/Dart directory
  if (fs.existsSync(SCAN_DIRS.flutter)) {
    scanDirectory(SCAN_DIRS.flutter, ['.dart']);
  }

  const allUsedKeys = new Set([...keysUsedInCode, ...keysUsedInHTML, ...keysUsedInDart]);

  return {
    all: allUsedKeys,
    inJS: keysUsedInCode,
    inHTML: keysUsedInHTML,
    inDart: keysUsedInDart
  };
}
