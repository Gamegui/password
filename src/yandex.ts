// Провайдер «Яндекс Диск»: OAuth implicit flow (response_type=token) +
// REST API папки приложения (app:/safekey.vault). Авторизация: заголовок `OAuth`.

import type { EncryptedVault } from './types'
import { ProviderError, readIntent, request, saveIntent, type OAuthIntent, type ProviderAccount, type RemoteFileMeta, type SyncProvider, UNAUTHORIZED } from './provider'

const AUTH_URL = 'https://oauth.yandex.ru/authorize'
const REVOKE_URL = 'https://oauth.yandex.ru/revoke_token'
const API_ROOT = 'https://cloud-api.yandex.net/v1'
const CLIENT_ID_KEY = 'safekey.yandex.clientId'
const TOKEN_KEY = 'safekey.yandex.token.v1'
const STATE_KEY = 'safekey.oauth.state.yandex'
export const VAULT_FILE = 'safekey.vault'
export const VAULT_PATH = `app:/${VAULT_FILE}` // Диск → «Приложения/<SafeKey>»

declare global {
  interface Window { SAFEKEY_CONFIG?: { YANDEX_CLIENT_ID?: string; GOOGLE_CLIENT_ID?: string } }
}

export function getClientId(): string {
  const override = localStorage.getItem(CLIENT_ID_KEY)
  return (override || window.SAFEKEY_CONFIG?.YANDEX_CLIENT_ID || '').trim()
}

export function setClientId(id: string) {
  const value = id.trim()
  if (value) localStorage.setItem(CLIENT_ID_KEY, value)
  else localStorage.removeItem(CLIENT_ID_KEY)
}

const redirectUri = () => location.origin + location.pathname
const getToken = () => localStorage.getItem(TOKEN_KEY)

export const yandexProvider: SyncProvider = {
  id: 'yandex',
  title: 'Яндекс Диск',

  isConfigured: () => Boolean(getClientId()),

  login(intent: OAuthIntent) {
    const clientId = getClientId()
    if (!clientId) throw new ProviderError('client_id_missing', 0)
    const state = crypto.randomUUID().replace(/-/g, '')
    sessionStorage.setItem(STATE_KEY, state)
    saveIntent(intent)
    const url = new URL(AUTH_URL)
    url.searchParams.set('response_type', 'token')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('force_confirm', 'true')
    url.searchParams.set('state', state)
    location.assign(url.toString())
  },

  /** После возврата с oauth.yandex.ru токен лежит в #access_token=... */
  async completeRedirect() {
    const hash = location.hash
    if (!hash.startsWith('#access_token') && !hash.startsWith('#error')) return null
    const params = new URLSearchParams(hash.slice(1))
    history.replaceState(null, '', location.pathname + location.search)
    const intent = readIntent()
    const expected = sessionStorage.getItem(STATE_KEY)
    const got = params.get('state')
    if (expected && got && expected !== got) return { error: 'state_mismatch' }
    sessionStorage.removeItem(STATE_KEY)
    const token = params.get('access_token')
    if (!token) return { error: params.get('error') || 'oauth_error' }
    localStorage.setItem(TOKEN_KEY, token)
    return intent ? { intent } : { intent: 'sync' }
  },

  async ensureFreshToken() {
    if (!getToken()) throw new ProviderError(UNAUTHORIZED, 401)
    // токены Диска долгоживущие — обновление не требуется
  },

  async fileMeta(): Promise<RemoteFileMeta | null> {
    const response = await request(
      `${API_ROOT}/disk/resources?path=${encodeURIComponent(VAULT_PATH)}&fields=md5,modified,size`,
      {}, `OAuth ${getToken()}`
    )
    if (response.status === 404) return null
    if (!response.ok) throw new ProviderError(await diskErrorMessage(response), response.status)
    return response.json()
  },

  async download() {
    const linkResponse = await request(
      `${API_ROOT}/disk/resources/download?path=${encodeURIComponent(VAULT_PATH)}`,
      {}, `OAuth ${getToken()}`
    )
    if (!linkResponse.ok) {
      if (linkResponse.status === 404) return null
      throw new ProviderError(await diskErrorMessage(linkResponse), linkResponse.status)
    }
    const link = await linkResponse.json() as { href: string }
    let response: Response
    try {
      response = await fetch(link.href)
    } catch {
      throw new ProviderError('network_error', 0)
    }
    if (!response.ok) throw new ProviderError(`download_error_${response.status}`, response.status)
    return { vault: await parseVault(response), meta: await yandexProvider.fileMeta() || { md5: '', modified: '', size: 0 } }
  },

  async upload(vault: EncryptedVault) {
    const linkResponse = await request(
      `${API_ROOT}/disk/resources/upload?path=${encodeURIComponent(VAULT_PATH)}&overwrite=true`,
      {}, `OAuth ${getToken()}`
    )
    if (!linkResponse.ok) throw new ProviderError(await diskErrorMessage(linkResponse), linkResponse.status)
    const link = await linkResponse.json() as { href: string; method: string }
    let response: Response
    try {
      response = await fetch(link.href, {
        method: link.method || 'PUT',
        body: new Blob([JSON.stringify(vault)], { type: 'application/octet-stream' })
      })
    } catch {
      throw new ProviderError('network_error', 0)
    }
    if (!response.ok) throw new ProviderError(`upload_error_${response.status}`, response.status)
    return await yandexProvider.fileMeta() || { md5: '', modified: new Date().toISOString(), size: 0 }
  },

  async account(): Promise<ProviderAccount> {
    const response = await request(`${API_ROOT}/disk/?fields=user.login,user.display_name`, {}, `OAuth ${getToken()}`)
    if (!response.ok) throw new ProviderError(await diskErrorMessage(response), response.status)
    const data = await response.json() as { user?: { login?: string; display_name?: string } }
    return { login: data.user?.login || 'yandex', displayName: data.user?.display_name || data.user?.login || 'Яндекс' }
  },

  async disconnect() {
    const token = getToken()
    const clientId = getClientId()
    localStorage.removeItem(TOKEN_KEY)
    if (!token || !clientId) return
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, access_token: token })
      })
    } catch { /* страница отзыва недоступна — токен удалён локально */ }
  }
}

/** Разбор файла сейфа: проверяем обязательные поля контейнера. */
async function diskErrorMessage(response: Response) {
  const body = await response.json().catch(() => ({}))
  return body.message || `disk_error_${response.status}`
}

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
