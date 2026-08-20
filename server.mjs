import express from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = process.env.SAFEKEY_DATA_FILE || path.join(__dirname, 'data', 'cloud.json')
const DATA_DIR = path.dirname(DATA_FILE)
const PORT = Number(process.env.PORT || 8787)
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production')
const app = express()

app.disable('x-powered-by')
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}))
app.use(express.json({ limit: '2mb' }))
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))

let db = { vaults: {}, pairings: {} }
try { db = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')) } catch { /* first run */ }

let saveChain = Promise.resolve()
function persist() {
  saveChain = saveChain.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const temp = `${DATA_FILE}.tmp`
    await fs.writeFile(temp, JSON.stringify(db), { mode: 0o600 })
    await fs.rename(temp, DATA_FILE)
  })
  return saveChain
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
const cleanPairings = () => {
  const now = Date.now()
  for (const [code, pairing] of Object.entries(db.pairings)) if (pairing.expiresAt < now) delete db.pairings[code]
}
const authorized = (req, vault) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token || !vault) return false
  const candidate = Buffer.from(sha256(token))
  const hashes = vault.tokenHashes || (vault.tokenHash ? [vault.tokenHash] : [])
  return hashes.some(hash => {
    const expected = Buffer.from(hash)
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
  })
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'SafeKey Sync' }))

app.post('/api/sync/create', async (req, res) => {
  const { blob, deviceName = 'Новое устройство' } = req.body || {}
  if (!blob?.data || !blob?.iv || !blob?.salt) return res.status(400).json({ error: 'invalid_encrypted_vault' })
  const vaultId = crypto.randomUUID()
  const token = randomToken()
  db.vaults[vaultId] = { tokenHashes: [sha256(token)], blob, revision: 1, updatedAt: new Date().toISOString(), devices: [{ id: crypto.randomUUID(), name: String(deviceName).slice(0, 80), lastSeen: new Date().toISOString() }] }
  await persist()
  res.status(201).json({ vaultId, token, revision: 1 })
})

app.get('/api/sync/:vaultId', (req, res) => {
  const vault = db.vaults[req.params.vaultId]
  if (!authorized(req, vault)) return res.status(401).json({ error: 'unauthorized' })
  res.set('Cache-Control', 'no-store').json({ blob: vault.blob, revision: vault.revision, updatedAt: vault.updatedAt, devices: vault.devices })
})

app.put('/api/sync/:vaultId', async (req, res) => {
  const vault = db.vaults[req.params.vaultId]
  if (!authorized(req, vault)) return res.status(401).json({ error: 'unauthorized' })
  const { blob, revision } = req.body || {}
  if (!blob?.data || !Number.isInteger(revision)) return res.status(400).json({ error: 'invalid_request' })
  if (revision !== vault.revision) return res.status(409).json({ error: 'revision_conflict', revision: vault.revision, updatedAt: vault.updatedAt })
  vault.blob = blob
  vault.revision++
  vault.updatedAt = new Date().toISOString()
  await persist()
  res.json({ revision: vault.revision, updatedAt: vault.updatedAt })
})

app.post('/api/sync/:vaultId/pair', async (req, res) => {
  cleanPairings()
  const vault = db.vaults[req.params.vaultId]
  if (!authorized(req, vault)) return res.status(401).json({ error: 'unauthorized' })
  let code
  do { code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0') } while (db.pairings[code])
  db.pairings[code] = { vaultId: req.params.vaultId, expiresAt: Date.now() + 10 * 60 * 1000 }
  await persist()
  res.status(201).json({ code, expiresAt: db.pairings[code].expiresAt })
})

app.post('/api/pair/claim', rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
  cleanPairings()
  const code = String(req.body?.code || '').replace(/\D/g, '')
  const pairing = db.pairings[code]
  if (!pairing) return res.status(404).json({ error: 'invalid_or_expired_code' })
  const vault = db.vaults[pairing.vaultId]
  const token = randomToken()
  vault.tokenHashes = vault.tokenHashes || (vault.tokenHash ? [vault.tokenHash] : [])
  vault.tokenHashes.push(sha256(token))
  delete vault.tokenHash
  vault.devices.push({ id: crypto.randomUUID(), name: String(req.body?.deviceName || 'Новое устройство').slice(0, 80), lastSeen: new Date().toISOString() })
  delete db.pairings[code]
  await persist()
  res.set('Cache-Control', 'no-store').json({ vaultId: pairing.vaultId, token, blob: vault.blob, revision: vault.revision })
})

if (isProduction) {
  app.use(express.static(path.join(__dirname, 'dist')))
  app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')))
}

app.use((err, _req, res, _next) => {
  console.error(err?.message || 'Server error')
  res.status(500).json({ error: 'server_error' })
})

app.listen(PORT, '0.0.0.0', () => console.log(`SafeKey Sync listening on http://0.0.0.0:${PORT}`))
