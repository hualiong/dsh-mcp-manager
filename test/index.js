/**
 * Directory entry for the host-half tests.
 *
 * `node --test test/` is the acceptance command, but the Node test runner
 * (v22+) treats a positional argument as a glob/file pattern and does not
 * recurse into a directory: `node --test test/` resolves `test/` as a module
 * and fails with MODULE_NOT_FOUND. This file is that module: it imports every
 * `*.test.*` sibling so the directory argument runs the whole suite.
 *
 * `node --test "test/**\/*.test.ts"` also works and does not need this file.
 */
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

for (const file of readdirSync(here).sort()) {
  if (file.startsWith('index.')) continue
  if (!file.endsWith('.test.ts') && !file.endsWith('.test.mjs')) continue
  await import(new URL(file, import.meta.url))
}
