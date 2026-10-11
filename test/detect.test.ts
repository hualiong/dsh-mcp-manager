/**
 * Unit tests for the OAuth capability probe: only a `401` + `Bearer` challenge
 * means OAuth, everything else is plain, and nothing ever throws.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectOAuth } from '../src/detect.ts'

/** Run the probe against one canned response from a stubbed global fetch. */
async function probeResponse(init) {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(null, init)
  try {
    return await detectOAuth('https://mcp.example/mcp')
  } finally {
    globalThis.fetch = original
  }
}

test('detectOAuth reads the status and Bearer challenge, and never throws', async () => {
  assert.equal(await probeResponse({ status: 401, headers: { 'www-authenticate': 'Bearer realm="mcp"' } }), 'oauth')
  // Casing is the server's business, not ours.
  assert.equal(await probeResponse({ status: 401, headers: { 'www-authenticate': 'bearer realm="mcp"' } }), 'oauth')
  // A 401 that does not ask for a Bearer token is not an OAuth endpoint.
  assert.equal(await probeResponse({ status: 401, headers: { 'www-authenticate': 'Basic realm="mcp"' } }), 'plain')
  assert.equal(await probeResponse({ status: 401 }), 'plain')
  assert.equal(await probeResponse({ status: 200 }), 'plain')
  assert.equal(await probeResponse({ status: 405 }), 'plain')
  assert.equal(await probeResponse({ status: 500 }), 'plain')

  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    assert.equal(await detectOAuth('https://mcp.example/mcp'), 'unreachable')
  } finally {
    globalThis.fetch = original
  }
})
