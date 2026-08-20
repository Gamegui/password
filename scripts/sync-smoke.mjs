// Smoke-тест логики синхронизации без браузера: OAuth-редирект, REST API Диска,
// optimistic concurrency по md5. Компилирует src/{crypto,yandex,sync}.ts через tsc
// и прогоняет их с заглушками браузерных API.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = await mkdtemp(path.join(tmpdir(), 'safekey-smoke-'))

try {
  // tsc нельзя смешивать с корневым tsconfig при явных файлах — пишем свой во временный каталог
  const smokeConfig = {
    compilerOptions: {
      module: 'commonjs', target: 'es2022', esModuleInterop: true,
      skipLibCheck: true, outDir: tmp, rootDir: path.join(root, 'src')
    },
    include: [path.join(root, 'src', 'crypto.ts'), path.join(root, 'src', 'yandex.ts'), path.join(root, 'src', 'sync.ts')]
  }
  await writeFile(path.join(tmp, 'tsconfig.json'), JSON.stringify(smokeConfig))
  execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', tmp], { cwd: root, stdio: 'pipe' })

  // ---- Браузерные заглушки ----
  const store = new Map(), session = new Map()
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
  globalThis.sessionStorage = {
    getItem: k => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => session.set(k, String(v)),
    removeItem: k => session.delete(k)
  }
  let currentHash = ''
  Object.defineProperty(globalThis, 'location', {
    value: {
      origin: 'https://user.github.io', pathname: '/password/', search: '',
      get hash() { return currentHash },
      assign: url => { globalThis.__lastAssign = url }
    },
    writable: true
  })
  globalThis.history = { replaceState: () => { currentHash = '' } }
  globalThis.window = globalThis

  const load = name => import(pathToFileURL(path.join(tmp, name)).href)
  const { encryptVault, decryptVault } = await load('crypto.js')
  const yandex = await load('yandex.js')
  const sync = await load('sync.js')

  // ---- 1. Криптография ----
  const vault = { items: [], createdAt: '2026-01-01', updatedAt: '2026-08-20T10:00:00Z' }
  const blob = await encryptVault(vault, 'master-password-123')
  assert.equal((await decryptVault(blob, 'master-password-123')).updatedAt, '2026-08-20T10:00:00Z')
  await assert.rejects(() => decryptVault(blob, 'wrong'))
  console.log('1. AES-GCM раунд-трип: ok')

  // ---- 2. OAuth implicit redirect ----
  currentHash = '#access_token=TOKEN123&token_type=bearer&expires_in=99999&state=s1'
  session.set('safekey.oauth.state', 's1')
  assert.equal(yandex.readOAuthRedirect().token, 'TOKEN123')
  assert.equal(currentHash, '', 'hash очищен через replaceState')
  assert.equal(sessionStorage.getItem('safekey.oauth.state'), null)
  currentHash = '#access_token=X&state=bad'
  session.set('safekey.oauth.state', 'good')
  assert.equal(yandex.readOAuthRedirect().error, 'state_mismatch')
  assert.equal(yandex.readOAuthRedirect(), null)
  console.log('2. OAuth implicit redirect: ok')

  // ---- 3. URL авторизации ----
  yandex.setClientId('abc123')
  yandex.saveToken('TOK')
  yandex.beginOAuth('sync')
  const u = new URL(globalThis.__lastAssign)
  assert.equal(u.searchParams.get('response_type'), 'token')
  assert.equal(u.searchParams.get('client_id'), 'abc123')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://user.github.io/password/')
  assert.ok(u.searchParams.get('state'))
  console.log('3. URL authorize: ok')

  // ---- 4. Мок REST API Диска ----
  let uploaded = null
  let fileMd5 = 'm1'
  const makeResp = (body, status) => new Response(body === null ? null : JSON.stringify(body), { status: status || 200 })
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/disk/resources?')) {
      if (fileMd5 === null) return makeResp({ message: 'Not Found' }, 404)
      return makeResp({ md5: fileMd5, modified: '2026-08-20T09:00:00Z', size: 100 })
    }
    if (url.includes('/disk/resources/download')) return makeResp({ href: 'https://downloader.disk.yandex.net/signed' })
    if (url.includes('/disk/resources/upload')) return makeResp({ href: 'https://uploader.dsp.yandex.net/put', method: 'PUT' })
    if (url.startsWith('https://downloader')) return makeResp(blob)
    if (url.startsWith('https://uploader')) {
      const body = init && init.body ? init.body : null
      uploaded = body && typeof body.text === 'function' ? await body.text() : String(body)
      fileMd5 = 'm2'
      return makeResp(null, 201)
    }
    if (url.includes('/disk/?')) return makeResp({ user: { login: 'vasya', display_name: 'Вася' } })
    throw new Error('unexpected fetch ' + url)
  }

  fileMd5 = null
  let pull = await sync.pullRemote()
  assert.equal(pull.vault, null); assert.equal(pull.changed, false)
  console.log('4a. Pull без файла на Диске: ok')

  fileMd5 = 'm1'
  pull = await sync.pullRemote()
  assert.equal(pull.changed, true)
  assert.deepEqual(JSON.parse(JSON.stringify(pull.vault)), JSON.parse(JSON.stringify(blob)))
  assert.equal(pull.md5, 'm1')
  console.log('4b. Pull скачивает новый файл: ok')

  sync.markSynced('m1', '2026-08-20T09:00:00Z', 100)
  pull = await sync.pullRemote()
  assert.equal(pull.changed, false, 'md5 совпал — изменений нет')
  console.log('4c. Optimistic concurrency по md5: ok')

  // ---- 5. Подключение аккаунта и push ----
  await sync.connectAccount()
  assert.equal(sync.getSyncState().account.login, 'vasya')
  const nextBlob = await encryptVault({ ...vault, updatedAt: '2026-08-20T12:00:00Z' }, 'master-password-123')
  const state = await sync.pushVault(nextBlob)
  assert.equal(state.lastMd5, 'm2')
  assert.ok(uploaded && uploaded.includes('"salt"'), 'PUT получил зашифрованный JSON')
  console.log('5. Connect + push (upload link -> PUT): ok')

  // ---- 6. Отключение ----
  sync.disconnectSync()
  assert.equal(sync.getSyncState(), null)
  assert.equal(localStorage.getItem('safekey.yandex.token.v1'), null)
  console.log('6. Disconnect: ok')

  console.log('\nВсе smoke-проверки пройдены ✓')
} finally {
  await rm(tmp, { recursive: true, force: true })
}
