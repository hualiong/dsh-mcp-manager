/**
 * Unit tests for the L2 visibility matrix persistence: exceptions-only
 * storage, atomic replacement, the missing-file default, and the cleanup
 * the `remove` endpoint relies on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  POLICY_FILE_NAME,
  dropServerFromPolicy,
  loadPolicy,
  policyPathOf,
  setPresetVisible,
} from '../src/policy.ts'

/** A fresh profile directory holding only what the test writes there. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-policy-'))
  return { dir, file: join(dir, POLICY_FILE_NAME) }
}

const read = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

test('the sidecar sits next to the patch layer it describes', () => {
  assert.equal(
    policyPathOf(join('/profiles', 'web', 'cordis.patch.yml')),
    join('/profiles', 'web', POLICY_FILE_NAME),
  )
})

test('a missing file is the empty matrix', () => {
  const { file } = scratch()
  assert.deepEqual(loadPolicy(file), {})
  assert.equal(existsSync(file), false, 'reading must not create the file')
})

test('a corrupt or foreign-shaped file degrades to the empty matrix', () => {
  const { file } = scratch()
  writeFileSync(file, '{ not json')
  assert.deepEqual(loadPolicy(file), {})
  writeFileSync(file, '[]')
  assert.deepEqual(loadPolicy(file), {})
  writeFileSync(file, '"visible"')
  assert.deepEqual(loadPolicy(file), {})
  // Junk the reader cannot key on is dropped, and the next write repairs the file.
  writeFileSync(file, '{"srv": "nope", "": {"p": false}, "ok": {"": false, "p2": false}}')
  assert.deepEqual(loadPolicy(file), { ok: { p2: false } })
})

test('hand-stated defaults are normalized away and keys come out sorted', () => {
  const { file } = scratch()
  writeFileSync(
    file,
    JSON.stringify({ 'z-server': { 'z-preset': false, 'a-preset': true }, 'a-server': { p: true } }),
  )
  const policy = loadPolicy(file)
  assert.deepEqual(policy, { 'z-server': { 'z-preset': false } })
  assert.deepEqual(Object.keys(policy), ['z-server'])
  assert.deepEqual(Object.keys(policy['z-server']), ['z-preset'])
})

test('setPresetVisible stores exceptions only', () => {
  const { file } = scratch()
  const policy = setPresetVisible(file, 'srv', 'p1', false)
  assert.deepEqual(policy, { srv: { p1: false } })
  assert.deepEqual(read(file), { srv: { p1: false } })
  assert.deepEqual(loadPolicy(file), { srv: { p1: false } })
})

test('a visible flip deletes the cell, and an empty row goes with it', () => {
  const { file } = scratch()
  setPresetVisible(file, 'srv', 'p1', false)
  setPresetVisible(file, 'srv', 'p2', false)
  assert.deepEqual(loadPolicy(file), { srv: { p1: false, p2: false } })

  setPresetVisible(file, 'srv', 'p1', true)
  assert.deepEqual(loadPolicy(file), { srv: { p2: false } }, 'only the survivor stays')

  setPresetVisible(file, 'srv', 'p2', true)
  assert.deepEqual(loadPolicy(file), {}, 'an empty row is not stored')
  assert.deepEqual(read(file), {}, 'the file keeps the matrix, not the row')
})

test('setting an already-stated visibility does not touch the file', () => {
  const { file } = scratch()
  setPresetVisible(file, 'srv', 'p1', false)
  // Stamp the sidecar 5s in the past before watching its mtime: on a fast CI
  // filesystem the whole test can land inside one timestamp quantum (Linux
  // runner, 2026-11-12 v0.2.0), where "the mtime moved" is no witness at all.
  // An old stamp cannot collide with "now" at any granularity, and both
  // directions of the assertion stay meaningful (a rewrite bug still moves it).
  const past = (Date.now() - 5000) / 1000
  utimesSync(file, past, past)
  const before = statSync(file).mtimeMs

  // The default holds without a cell: asking for `true` on an absent cell is a no-op.
  const { file: fresh } = scratch()
  setPresetVisible(fresh, 'srv', 'p1', true)
  assert.equal(existsSync(fresh), false, 'a no-op must not create the sidecar')

  setPresetVisible(file, 'srv', 'p1', false)
  assert.equal(statSync(file).mtimeMs, before, 'a repeated exception must not rewrite the file')

  // And `true` on an existing `false` writes, once.
  setPresetVisible(file, 'srv', 'p1', true)
  assert.notEqual(statSync(file).mtimeMs, before)
  assert.deepEqual(loadPolicy(file), {})
})

test('writes land atomically: tmp plus rename, no leftovers', () => {
  const { dir, file } = scratch()
  setPresetVisible(file, 'srv-a', 'p1', false)
  setPresetVisible(file, 'srv-b', 'p1', false)
  const names = readdirSync(dir)
  assert.deepEqual(names, [POLICY_FILE_NAME], 'the temp file was renamed, not left behind')
  assert.deepEqual(loadPolicy(file), { 'srv-a': { p1: false }, 'srv-b': { p1: false } })
  // Sorted keys serialize stably — the snapshot comparison depends on it.
  assert.deepEqual(Object.keys(read(file) as object), ['srv-a', 'srv-b'])
})

test('empty or junk ids are never stored', () => {
  const { file } = scratch()
  const before = setPresetVisible(file, 'srv', 'p1', false)
  assert.deepEqual(setPresetVisible(file, '', 'p1', false), before)
  assert.deepEqual(setPresetVisible(file, 'srv', '', false), before)
  assert.deepEqual(loadPolicy(file), { srv: { p1: false } })
})

test('dropServerFromPolicy removes the row and ignores orphans', () => {
  const { file } = scratch()
  setPresetVisible(file, 'gone', 'p1', false)
  setPresetVisible(file, 'kept', 'p1', false)

  const after = dropServerFromPolicy(file, 'gone')
  assert.deepEqual(after, { kept: { p1: false } })
  assert.deepEqual(loadPolicy(file), { kept: { p1: false } })

  // An id the matrix never mentioned: not rewritten, and never created.
  const before = readFileSync(file, 'utf8')
  dropServerFromPolicy(file, 'never-existed')
  assert.equal(readFileSync(file, 'utf8'), before)

  const { file: missing } = scratch()
  dropServerFromPolicy(missing, 'any')
  assert.equal(existsSync(missing), false)
})
