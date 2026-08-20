// Провайдер «Google Drive»: OAuth 2.0 authorization code + PKCE (без client secret)
// и Drive API v3 в скрытой папке приложения (appDataFolder → safekey.vault).
// Токены Google короткоживущие (~1 час) — обновляются тихо в скрытом iframe
// (prompt=none), без повторного ввода пароля, пока активна сессия Google.

import type { EncryptedVault } from './types'
import { ProviderError, base64url, readIntent, request, saveIntent, type OAuthIntent, type ProviderAccount, type RemoteFileMeta, type SyncProvider, UNAUTHORIZED } from './provider'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const DRIVE_ROOT = 'https://www.googleapis.com/drive/v3'
const UPLOAD_ROOT = 'https://www.googleapis.com/upload/drive/v3'
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata'

const CLIENT_ID_KEY = 'safekey.google.clientId'
const TOKEN_KEY = 'safekey.google.token.v1'
const STATE_KEY = 'safekey.oauth.state.google'
const VERIFIER_KEY = 'safekey.oauth.verifier'
const SILENT_STATE_KEY = 'safekey.oauth.silent.state'
const SILENT_VERIFIER_KEY = 'safekey.oauth.silent.verifier'

export const VAULT_FILE = 'safekey.vault'

type StoredToken = { token: string; expiresAt: number; email?: string; name?: string }

export function getClientId(): string {
  const override = localStorage.getItem(CLIENT_ID_KEY)
  return (override || window.SAFEKEY_CONFIG?.GOOGLE_CLIENT_ID || '').trim()
}

export function setClientId(id: string) {
  const value = id.trim()
  if (value) localStorage.setItem(CLIENT_ID_KEY, value)
  else localStorage.removeItem(CLIENT_ID_KEY)
}

const redirectUri = () => location.origin + location.pathname
const getStoredToken = (): StoredToken | null => {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null') } catch { return null }
}
const saveStoredToken = (token: StoredToken) => localStorage.setItem(TOKEN_KEY, JSON.stringify(token))

async function makePkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

function authUrl(params: Record<string, string>) {
  const url = new URL(AUTH_URL)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

/** Обмен code → access_token (публичный клиент PKCE, секрет не нужен). */
async function exchangeCode(code: string, verifier: string): Promise<StoredToken> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: getClientId(),
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri()
      })
    })
  } catch {
    throw new ProviderError('network_error', 0)
  }
  if (!response.ok) {
    // invalid_grant: код истёк/использован — нужен новый вход
    throw new ProviderError('token_exchange_failed', response.status)
  }
  const data = await response.json() as { access_token: string; expires_in: number; id_token?: string }
  const claims = parseIdToken(data.id_token)
  return {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000,
    email: claims?.email,
    name: claims?.name
  }
}

/** JWT id_token → {email, name} (без проверки подписи: она уже сделана Google при выдаче кода). */
function parseIdToken(idToken?: string): { email?: string; name?: string } | null {
  if (!idToken) return null
  try {
    const payload = idToken.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch { return null }
}

/** Тихое обновление в скрытом iframe (prompt=none). Работает, пока активна сессия Google. */
function silentRenew(): Promise<StoredToken> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new ProviderError(UNAUTHORIZED, 401))
      return
    }
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    const state = crypto.randomUUID().replace(/-/g, '')
    const timeout = window.setTimeout(() => { cleanup(); reject(new ProviderError(UNAUTHORIZED, 401)) }, 15000)

    const cleanup = () => {
      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      frame.remove()
    }
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== location.origin) return
      if (event.data?.type !== 'safekey.oauth.iframe') return
      cleanup()
      const url = new URL(String(event.data.href || ''))
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      const gotState = url.searchParams.get('state')
      const verifier = sessionStorage.getItem(SILENT_VERIFIER_KEY)
      sessionStorage.removeItem(SILENT_STATE_KEY)
      sessionStorage.removeItem(SILENT_VERIFIER_KEY)
      if (!code || error || gotState !== state || !verifier) {
        reject(new ProviderError(UNAUTHORIZED, 401))
        return
      }
      try { resolve(await exchangeCode(code, verifier)) }
      catch { reject(new ProviderError(UNAUTHORIZED, 401)) }
    }

    window.addEventListener('message', onMessage)
    void makePkce().then(({ verifier, challenge }) => {
      sessionStorage.setItem(SILENT_STATE_KEY, state)
      sessionStorage.setItem(SILENT_VERIFIER_KEY, verifier)
      frame.src = authUrl({
        client_id: getClientId(),
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'online',
        prompt: 'none'
      })
      document.body.appendChild(frame)
    })
  })
}

type DriveFile = { id: string; name: string; md5Checksum?: string; modifiedTime?: string; size?: string }
const toMeta = (file: DriveFile): RemoteFileMeta => ({
  md5: file.md5Checksum || '',
  modified: file.modifiedTime || '',
  size: Number(file.size || 0)
})

export const googleProvider: SyncProvider = {
  id: 'google',
  title: 'Google Drive',

  isConfigured: () => Boolean(getClientId()),

  login(intent: OAuthIntent) {
    const clientId = getClientId()
    if (!clientId) throw new ProviderError('client_id_missing', 0)
    const state = crypto.randomUUID().replace(/-/g, '')
    sessionStorage.setItem(STATE_KEY, state)
    saveIntent(intent)
    void makePkce().then(({ verifier, challenge }) => {
      sessionStorage.setItem(VERIFIER_KEY, verifier)
      location.assign(authUrl({
        client_id: clientId,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'online',
        prompt: 'select_account'
      }))
    })
  },

  /** После возврата с accounts.google.com код лежит в ?code=...&state=... */
  async completeRedirect() {
    const params = new URLSearchParams(location.search)
    if (!params.has('code') && !params.has('error')) return null
    const code = params.get('code')
    const error = params.get('error')
    const gotState = params.get('state')
    history.replaceState(null, '', location.pathname)
    const intent = readIntent()
    const expected = sessionStorage.getItem(STATE_KEY)
    const verifier = sessionStorage.getItem(VERIFIER_KEY)
    sessionStorage.removeItem(STATE_KEY)
    sessionStorage.removeItem(VERIFIER_KEY)
    if (error) return { error: error === 'access_denied' ? 'access_denied' : 'oauth_error' }
    if (!code || !verifier || (expected && gotState !== expected)) return { error: 'state_mismatch' }
    try {
      saveStoredToken(await exchangeCode(code, verifier))
    } catch {
      return { error: 'token_exchange_failed' }
    }
    return { intent: intent || 'sync' }
  },

  async ensureFreshToken() {
    const stored = getStoredToken()
    if (!stored) throw new ProviderError(UNAUTHORIZED, 401)
    if (Date.now() < stored.expiresAt) return
    saveStoredToken(await silentRenew())
  },

  async fileMeta(): Promise<RemoteFileMeta | null> {
    await googleProvider.ensureFreshToken()
    const stored = getStoredToken()!
    const query = encodeURIComponent(`name = '${VAULT_FILE}'`)
    const response = await request(
      `${DRIVE_ROOT}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,md5Checksum,modifiedTime,size)`,
      {}, `Bearer ${stored.token}`
    )
    if (!response.ok) throw new ProviderError(await driveErrorMessage(response), response.status)
    const data = await response.json() as { files: DriveFile[] }
    const file = data.files?.find(f => f.name === VAULT_FILE)
    return file ? toMeta(file) : null
  },

  async download() {
    await googleProvider.ensureFreshToken()
    const stored = getStoredToken()!
    const query = encodeURIComponent(`name = '${VAULT_FILE}'`)
    const listResponse = await request(
      `${DRIVE_ROOT}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,md5Checksum,modifiedTime,size)`,
      {}, `Bearer ${stored.token}`
    )
    if (!listResponse.ok) throw new ProviderError(await driveErrorMessage(listResponse), listResponse.status)
    const data = await listResponse.json() as { files: DriveFile[] }
    const file = data.files?.find(f => f.name === VAULT_FILE)
    if (!file) return null
    const response = await request(`${DRIVE_ROOT}/files/${file.id}?alt=media`, {}, `Bearer ${stored.token}`)
    if (!response.ok) throw new ProviderError(await driveErrorMessage(response), response.status)
    const meta = toMeta(file)
    return { vault: await parseVault(response), meta }
  },

  async upload(vault: EncryptedVault) {
    await googleProvider.ensureFreshToken()
    const stored = getStoredToken()!
    let fileId: string | null = null
    const query = encodeURIComponent(`name = '${VAULT_FILE}'`)
    const listResponse = await request(
      `${DRIVE_ROOT}/files?spaces=appDataFolder&q=${query}&fields=files(id,name)`,
      {}, `Bearer ${stored.token}`
    )
    if (!listResponse.ok) throw new ProviderError(await driveErrorMessage(listResponse), listResponse.status)
    const files = (await listResponse.json() as { files: DriveFile[] }).files
    fileId = files?.find(f => f.name === VAULT_FILE)?.id || null

    if (!fileId) {
      // первый запуск: создаём файл в appDataFolder
      const createResponse = await request(`${DRIVE_ROOT}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: VAULT_FILE, parents: ['appDataFolder'] })
      }, `Bearer ${stored.token}`)
      if (!createResponse.ok) throw new ProviderError(await driveErrorMessage(createResponse), createResponse.status)
      fileId = ((await createResponse.json()) as DriveFile).id
    }

    const uploadResponse = await request(
      `${UPLOAD_ROOT}/files/${fileId}?uploadType=media&fields=id,md5Checksum,modifiedTime,size`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: JSON.stringify(vault)
      },
      `Bearer ${stored.token}`
    )
    if (!uploadResponse.ok) throw new ProviderError(await driveErrorMessage(uploadResponse), uploadResponse.status)
    return toMeta(await uploadResponse.json() as DriveFile)
  },

  async account(): Promise<ProviderAccount> {
    const stored = getStoredToken()
    if (stored?.email) return { login: stored.email, displayName: stored.name || stored.email }
    try {
      await googleProvider.ensureFreshToken()
      const token = getStoredToken()!
      const response = await request(`${DRIVE_ROOT}/about?fields=user(emailAddress,displayName)`, {}, `Bearer ${token.token}`)
      if (response.ok) {
        const data = await response.json() as { user?: { emailAddress?: string; displayName?: string } }
        if (data.user?.emailAddress) return { login: data.user.emailAddress, displayName: data.user.displayName || data.user.emailAddress }
      }
    } catch { /* не критично */ }
    return { login: 'google', displayName: 'Google' }
  },

  async disconnect() {
    const stored = getStoredToken()
    localStorage.removeItem(TOKEN_KEY)
    if (!stored) return
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(stored.token)}`, { method: 'POST' })
    } catch { /* отзыв недоступен — токен удалён локально */ }
  }
}

async function driveErrorMessage(response: Response) {
  const body = await response.json().catch(() => ({}))
  return body?.error?.message || `drive_error_${response.status}`
}

/** Разбор файла сейфа: проверяем обязательные поля контейнера. */
function parseVault(response: Response): Promise<EncryptedVault> {
  return response.text().then(text => {
    const vault = JSON.parse(text) as EncryptedVault
    if (!vault || typeof vault.data !== 'string' || typeof vault.salt !== 'string' || typeof vault.iv !== 'string') {
      throw new ProviderError('vault_file_corrupted', 0)
    }
    return vault
  }).catch(error => {
    if (error instanceof ProviderError) throw error
    throw new ProviderError('vault_file_corrupted', 0)
  })
}
