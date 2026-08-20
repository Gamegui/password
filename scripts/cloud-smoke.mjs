import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const port = 18987
const temp = await mkdtemp(path.join(tmpdir(), 'safekey-test-'))
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), SAFEKEY_DATA_FILE: path.join(temp, 'cloud.json') },
  stdio: ['ignore', 'pipe', 'pipe']
})

const base = `http://127.0.0.1:${port}`
const waitForServer = async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Server did not start')
}
const json = async (url, options = {}) => {
  const response = await fetch(`${base}${url}`, options)
  const body = await response.json()
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`)
  return body
}
const auth = token => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` })

try {
  await waitForServer()
  const blob = { version: 1, salt: 'c2FsdA==', iv: 'aXY=', data: 'Y2lwaGVy', iterations: 600000, updatedAt: new Date().toISOString() }
  const created = await json('/api/sync/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blob, deviceName: 'Test PC' }) })
  assert.equal(created.revision, 1)

  const pulled = await json(`/api/sync/${created.vaultId}`, { headers: auth(created.token) })
  assert.deepEqual(pulled.blob, blob)

  const paired = await json(`/api/sync/${created.vaultId}/pair`, { method: 'POST', headers: auth(created.token), body: '{}' })
  assert.match(paired.code, /^\d{6}$/)
  const claimed = await json('/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: paired.code, deviceName: 'Test phone' }) })
  assert.notEqual(claimed.token, created.token, 'Each device must receive an independent token')

  blob.data = 'bmV3LWNpcGhlcg=='
  blob.updatedAt = new Date(Date.now() + 1000).toISOString()
  const pushed = await json(`/api/sync/${created.vaultId}`, { method: 'PUT', headers: auth(claimed.token), body: JSON.stringify({ blob, revision: 1 }) })
  assert.equal(pushed.revision, 2)

  const conflictResponse = await fetch(`${base}/api/sync/${created.vaultId}`, { method: 'PUT', headers: auth(created.token), body: JSON.stringify({ blob, revision: 1 }) })
  assert.equal(conflictResponse.status, 409)
  console.log('SafeKey cloud smoke test passed: create, pull, pair, push and conflict protection')
} finally {
  server.kill('SIGTERM')
  await rm(temp, { recursive: true, force: true })
}
