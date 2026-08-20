// Smoke-тест синхронизации без браузера: OAuth-редиректы Яндекса и Google,
// REST API обоих облаков, optimistic concurrency по md5. Компилирует
// src/{crypto,provider,yandex,gdrive,sync}.ts через tsc и прогоняет их
// с заглушками браузерных API.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = await mkdtemp(path.join(tmpdir(), 'safekey-smoke-'))

try {
  const smokeConfig = {
    compilerOptions: {
      module: 'commonjs', target: 'es2022', esModuleInterop: true,
      skipLibCheck: true, outDir: tmp, rootDir: path.join(root, 'src')
    },
    include: ['crypto.ts', 'provider.ts', 'yandex.ts', 'gdrive.ts', 'sync.ts'].map(f => path.join(root, 'src', f))
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
  let currentSearch = ''
  Object.defineProperty(globalThis, 'location', {
    value: {
      origin: 'https://user.github.io', pathname: '/password/',
      get hash() { return currentHash },
      get search() { return currentSearch },
      assign: url => { globalThis.__lastAssign = url }
    },
    writable: true
  })
  globalThis.history = { replaceState: () => { currentHash = ''; currentSearch = '' } }
  globalThis.window = globalThis

  const load = name => import(pathToFileURL(path.join(tmp, name)).href)
  const { encryptVault, decryptVault } = await load('crypto.js')
  const { yandexProvider } = await load('yandex.js')
  const { googleProvider } = await load('gdrive.js')
  const sync = await load('sync.js')

  // ---- 1. Криптография ----
  const vault = { items: [], createdAt: '2026-01-01', updatedAt: '2026-08-20T10:00:00Z' }
  const blob = await encryptVault(vault, 'master-password-123')
  assert.equal((await decryptVault(blob, 'master-password-123')).updatedAt, '2026-08-20T10:00:00Z')
  await assert.rejects(() => decryptVault(blob, 'wrong'))
  console.log('1. AES-GCM раунд-трип: ok')

  // ---- 2. Яндекс: OAuth implicit redirect ----
  yandexProvider.isConfigured === undefined && assert.fail('нет isConfigured')
  localStorage.setItem('safekey.yandex.clientId', 'ya-client')
  yandexProvider.login('sync')
  const yaUrl = new URL(globalThis.__lastAssign)
  assert.equal(yaUrl.searchParams.get('response_type'), 'token')
  assert.equal(yaUrl.searchParams.get('client_id'), 'ya-client')
  assert.equal(yaUrl.searchParams.get('redirect_uri'), 'https://user.github.io/password/')
  const yaState = sessionStorage.getItem('safekey.oauth.state.yandex')

  currentHash = `#access_token=TOKEN123&token_type=bearer&expires_in=99999&state=${yaState}`
  const yaResult = await yandexProvider.completeRedirect()
  assert.equal(yaResult.intent, 'sync')
  assert.equal(currentHash, '', 'hash очищен через replaceState')
  assert.equal(localStorage.getItem('safekey.yandex.token.v1'), 'TOKEN123')

  currentHash = `#access_token=X&state=bad`
  sessionStorage.setItem('safekey.oauth.state.yandex', 'good')
  assert.equal((await yandexProvider.completeRedirect()).error, 'state_mismatch')
  assert.equal(await yandexProvider.completeRedirect(), null)
  console.log('2. Яндекс OAuth implicit: ok')

  // ---- 3. Google: PKCE + authorization code ----
  localStorage.setItem('safekey.google.clientId', 'g-client')
  googleProvider.login('connect')
  await new Promise(r => setTimeout(r, 20)) // login() асинхронно готовит PKCE
  const gUrl = new URL(globalThis.__lastAssign)
  assert.equal(gUrl.searchParams.get('response_type'), 'code')
  assert.equal(gUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(gUrl.searchParams.get('scope').includes('drive.appdata'))
  const gVerifier = sessionStorage.getItem('safekey.oauth.verifier')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(gVerifier))
  const expectedChallenge = Buffer.from(digest).toString('base64url')
  assert.equal(gUrl.searchParams.get('code_challenge'), expectedChallenge, 'code_challenge = S256(verifier)')
  const gState = sessionStorage.getItem('safekey.oauth.state.google')

  // мок обмена code → token
  const idToken = 'h.' + Buffer.from(JSON.stringify({ email: 'user@gmail.com', name: 'User' })).toString('base64url') + '.s'
  let googleExchanged = null
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(String(init.body))
      assert.equal(body.get('client_id'), 'g-client')
      assert.equal(body.get('code_verifier'), gVerifier)
      assert.equal(body.get('grant_type'), 'authorization_code')
      googleExchanged = body.get('code')
      return new Response(JSON.stringify({ access_token: 'G-TOKEN-1', expires_in: 3600, id_token: idToken }), { status: 200 })
    }
    throw new Error('unexpected fetch ' + url)
  }
  currentSearch = `?code=G-CODE&state=${gState}`
  const gResult = await googleProvider.completeRedirect()
  assert.equal(gResult.intent, 'connect')
  assert.equal(googleExchanged, 'G-CODE')
  assert.equal(currentSearch, '', 'query очищен через replaceState')
  const gTok = JSON.parse(localStorage.getItem('safekey.google.token.v1'))
  assert.equal(gTok.token, 'G-TOKEN-1')
  assert.equal(gTok.email, 'user@gmail.com')
  const account = await googleProvider.account()
  assert.equal(account.login, 'user@gmail.com')
  console.log('3. Google PKCE + обмен кода: ok')

  // ---- 4. Google Drive API (мок) + sync ----
  let driveFile = null // { id, md5, content }
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const auth = init && init.headers ? init.headers.Authorization || (init.headers.authorization && init.headers.authorization) : null
    const json = (body, status) => new Response(JSON.stringify(body), { status: status || 200 })
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json({ access_token: 'G-TOKEN-2', expires_in: 3600 })
    }
    if (url.includes('www.googleapis.com/drive/v3/files?')) {
      return json({ files: driveFile ? [{ id: 'f1', name: 'safekey.vault', md5Checksum: driveFile.md5, modifiedTime: '2026-08-20T09:00:00Z', size: String(driveFile.content ? driveFile.content.length : 0) }] : [] })
    }
    if (url.includes('alt=media')) {
      return new Response(driveFile ? driveFile.content : '', { status: driveFile ? 200 : 404 })
    }
    if (url.includes('www.googleapis.com/drive/v3/files') && (init && init.method) === 'POST') {
      driveFile = { id: 'f1', md5: '', content: null }
      return json({ id: 'f1', name: 'safekey.vault' })
    }
    if (url.includes('/upload/drive/v3/files/f1')) {
      const body = init && init.body ? init.body : ''
      driveFile = { id: 'f1', md5: 'g-md5-1', content: body && typeof body.text === 'function' ? await body.text() : String(body) }
      return json({ id: 'f1', md5Checksum: 'g-md5-1', modifiedTime: '2026-08-20T11:00:00Z', size: String(driveFile.content.length) })
    }
    if (url.includes('/drive/v3/about')) {
      return json({ user: { emailAddress: 'user@gmail.com', displayName: 'User' } })
    }
    throw new Error('unexpected fetch ' + url + ' ' + JSON.stringify({ auth: Boolean(auth) }))
  }

  // подключаем Google как активное облако
  const gState2 = await sync.connectAccount('google')
  assert.equal(gState2.provider, 'google')
  assert.equal(gState2.account.login, 'user@gmail.com')

  // файла ещё нет → push создаёт и загружает
  let pull = await sync.pullRemote()
  assert.equal(pull.vault, null); assert.equal(pull.changed, false)
  const pushed = await sync.pushVault(blob)
  assert.equal(pushed.lastMd5, 'g-md5-1')
  assert.equal(driveFile.content, JSON.stringify(blob), 'в облако ушёл зашифрованный контейнер')

  // файл не менялся → changed=false
  pull = await sync.pullRemote()
  assert.equal(pull.changed, false)
  console.log('4a. Google Drive: create + upload + md5-сверка: ok')

  // файл изменился с другого устройства → скачивание
  const otherBlob = await encryptVault({ ...vault, updatedAt: '2026-08-20T12:00:00Z' }, 'other-master')
  driveFile = { id: 'f1', md5: 'g-md5-2', content: JSON.stringify(otherBlob) }
  pull = await sync.pullRemote()
  assert.equal(pull.changed, true)
  assert.deepEqual(pull.vault, otherBlob)
  sync.markSynced('g-md5-2', '2026-08-20T12:00:00Z', 0)
  console.log('4b. Google Drive: скачивание изменённого файла: ok')

  // ---- 5. Истёкший токен Google → 401 без документа (нет iframe) ----
  const tok = JSON.parse(localStorage.getItem('safekey.google.token.v1'))
  tok.expiresAt = Date.now() - 1000
  localStorage.setItem('safekey.google.token.v1', JSON.stringify(tok))
  await assert.rejects(() => googleProvider.ensureFreshToken(), e => e.status === 401)
  console.log('5. Истёкший Google-токен → 401: ok')

  // ---- 6. Возврат к Яндексу: активный провайдер переключается состоянием ----
  localStorage.setItem('safekey.yandex.token.v1', 'YA-TOKEN')
  let yaCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('cloud-api.yandex.net')) { yaCalls++; return realFetch(input) }
    return realFetch(input)
  }
  const yandexDisk = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('cloud-api.yandex.net/v1/disk/')) { yaCalls++; return new Response(JSON.stringify({ user: { login: 'vasya', display_name: 'Вася' } })) }
    return yandexDisk(input, init)
  }
  const yaState2 = await sync.connectAccount('yandex')
  assert.equal(yaState2.provider, 'yandex')
  assert.ok(yaCalls > 0, 'запросы пошли в API Яндекса')
  console.log('6. Переключение провайдера через состояние: ok')

  // ---- 7. Отключение ----
  await sync.disconnectSync()
  assert.equal(sync.getSyncState(), null)
  assert.equal(localStorage.getItem('safekey.yandex.token.v1'), null)
  console.log('7. Disconnect: ok')

  console.log('\nВсе smoke-проверки пройдены ✓')
} finally {
  await rm(tmp, { recursive: true, force: true })
}
