#!/usr/bin/env node
/**
 * Cross-platform copy helper for CDK NodejsFunction bundling.
 *
 * Replaces `mkdir -p` + `cp -R` (POSIX-only, fails on Windows cmd.exe) and `xcopy`
 * (Windows-only, runs out of memory on the @prisma engine binaries).
 *
 * Usage: node infra/scripts/bundle-copy.cjs <src> <dst>
 *   - Creates dst's parent dirs as needed
 *   - Recursively copies src -> dst
 *   - Idempotent: if dst already exists, overwrites
 *
 * Node 16+ has fs.cpSync built-in — no deps.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function main() {
  const [, , src, dst] = process.argv;
  if (!src || !dst) {
    console.error('usage: bundle-copy.cjs <src> <dst>');
    process.exit(2);
  }
  if (!fs.existsSync(src)) {
    // Some bundling steps reference optional source dirs (e.g. .prisma when prisma generate
    // hasn't run yet). Skip cleanly rather than failing the whole bundle.
    console.warn('bundle-copy: src does not exist, skipping:', src);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
  console.log('bundle-copy:', src, '->', dst);
}

main();
