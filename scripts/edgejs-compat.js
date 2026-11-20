'use strict';
// Post-install fix-up for running n8n on Edge.js (QuickJS engine).
//
// Edge.js's QuickJS build stops reading a source file at the first raw NUL byte, so a JS file that
// embeds a literal U+0000 (n8n's @n8n/expression-runtime does, inside a template string) fails with
// "SyntaxError: unexpected end of string". Rewriting each raw NUL as the escape `\x00` is
// equivalent inside strings, templates and regexes, and harmless in comments.
// Browser bundles (n8n-editor-ui) are served to browsers, not parsed by Edge.js, so they are skipped.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'node_modules'));
const SKIP_DIRS = new Set(['n8n-editor-ui', '.cache', '.bin']);
const JS_EXT = /\.(c|m)?js$/;
const NUL = Buffer.from([0]);
const ESCAPED = Buffer.from('\\x00');

function* jsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* jsFiles(path.join(dir, entry.name));
    } else if (entry.isFile() && JS_EXT.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

function escapeNul(buf) {
  const parts = [];
  let start = 0;
  for (let i = buf.indexOf(NUL); i !== -1; i = buf.indexOf(NUL, start)) {
    parts.push(buf.subarray(start, i), ESCAPED);
    start = i + 1;
  }
  parts.push(buf.subarray(start));
  return Buffer.concat(parts);
}

if (require.main === module) {
  if (!fs.existsSync(root)) process.exit(0);
  let patched = 0;
  for (const file of jsFiles(root)) {
    const buf = fs.readFileSync(file);
    if (buf.includes(NUL)) {
      fs.writeFileSync(file, escapeNul(buf));
      patched += 1;
      console.log(`edgejs-compat: escaped NUL bytes in ${path.relative(root, file)}`);
    }
  }
  console.log(`edgejs-compat: ${patched} file(s) patched`);
}

module.exports = { escapeNul };
