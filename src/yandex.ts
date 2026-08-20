// Клиент Яндекс Диска: OAuth (implicit flow) + REST API папки приложения.
// Никакого собственного бэкенда не нужно: браузер общается с Диском напрямую,
// сейф уходит в облако уже зашифрованным (см. crypto.ts).

import type { EncryptedVault } from './types'

const AUTH_URL = 'https://oauth.yandex.ru/authorize'
const API_ROOT = 'https://cloud-api.yandex.net/v1'
const CLIENT_ID_KEY = 'safekey.yandex.clientId'
const TOKEN_KEY = 'safekey.yandex.token.v1'
const STATE_KEY = 'safekey.oauth.state'
const INTENT_KEY = 'safekey.oauth.intent'
export const VAULT_FILE = 'safekey.vault'
export const VAULT_PATH = `app:/${VAULT_FILE}` // папка приложения: Диск → «Приложения/<SafeKey>»

export type YandexAccount = { login: string; displayName: string }
export type OAuthResult = { token: string } | { error: string }
export type RemoteFileMeta = { md5: string; modified: string; size: number }

declare global {
  interface Window { SAFEKEY_CONFIG?: { YANDEX_CLIENT_ID?: string } }
}

export class YandexApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

/* ---------- ClientID (публичный, не секрет) ---------- */

export function getClientId(): string {
  const override = localStorage.getItem(CLIENT_ID_KEY)
  return (override || window.SAFEKEY_CONFIG?.YANDEX_CLIENT_ID || '').trim()
}

export function setClientId(id: string) {
  const value = id.trim()
  if (value) localStorage.setItem(CLIENT_ID_KEY, value)
  else localStorage.removeItem(CLIENT_ID_KEY)
}

/* ---------- OAuth implicit flow ---------- */

const redirectUri = () => location.origin + location.pathname

/** Редиректит на страницу разрешения доступа Яндекса. Текущий URL должен быть
 *  зарегистрирован как Redirect URI приложения на oauth.yandex.ru. */
export function beginOAuth(intent: 'connect' | 'sync') {
  const clientId = getClientId()
  if (!clientId) throw new YandexApiError('client_id_missing', 0)
  const state = crypto.randomUUID().replace(/-/g, '')
  sessionStorage.setItem(STATE_KEY, state)
  sessionStorage.setItem(INTENT_KEY, intent)
  const url = new URL(AUTH_URL)
  url.searchParams.set('response_type', 'token')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('force_confirm', 'true')
  url.searchParams.set('state', state)
  location.assign(url.toString())
}

/** Разбирает #access_token=... после возврата с oauth.yandex.ru. Вызывать один раз при загрузке. */
export function readOAuthRedirect(): OAuthResult | null {
  const hash = location.hash
  if (!hash.startsWith('#access_token') && !hash.startsWith('#error')) return null
  const params = new URLSearchParams(hash.slice(1))
  history.replaceState(null, '', location.pathname + location.search)
  const expected = sessionStorage.getItem(STATE_KEY)
  const got = params.get('state')
  if (expected && got && expected !== got) return { error: 'state_mismatch' }
  sessionStorage.removeItem(STATE_KEY)
  const token = params.get('access_token')
  if (!token) return { error: params.get('error') || 'oauth_error' }
  return { token }
}

export function getOAuthIntent(): 'connect' | 'sync' | null {
  const value = sessionStorage.getItem(INTENT_KEY)
  sessionStorage.removeItem(INTENT_KEY)
  return value === 'connect' || value === 'sync' ? value : null
}

/* ---------- Хранение токена ---------- */

const getToken = () => localStorage.getItem(TOKEN_KEY)
export const hasToken = () => Boolean(getToken())
export const saveToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)
export const dropToken = () => localStorage.removeItem(TOKEN_KEY)

/* ---------- REST API Диска ---------- */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  if (!token) throw new YandexApiError('unauthorized', 401)
  let response: Response
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: { Authorization: `OAuth ${token}`, ...(init?.headers || {}) }
    })
  } catch {
    // Сетевая ошибка или блокировка запроса (CORS/расширение/офлайн)
    throw new YandexApiError('network_error', 0)
  }
  if (response.status === 401) throw new YandexApiError('unauthorized', 401)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new YandexApiError(body.message || `disk_error_${response.status}`, response.status)
  }
  return response.json() as Promise<T>
}

/** Данные аккаунта владельца токена (для отображения «с кем синхронизируемся»). */
export async function fetchAccount(): Promise<YandexAccount> {
  const data = await api<{ user?: { login?: string; display_name?: string } }>('/disk/?fields=user.login,user.display_name')
  return { login: data.user?.login || 'yandex', displayName: data.user?.display_name || data.user?.login || 'Яндекс' }
}

/** Метаданные сейфа на Диске. null — файла ещё нет. */
export async function fetchFileMeta(): Promise<RemoteFileMeta | null> {
  try {
    return await api<RemoteFileMeta>(`/disk/resources?path=${encodeURIComponent(VAULT_PATH)}&fields=md5,modified,size`)
  } catch (error) {
    if (error instanceof YandexApiError && error.status === 404) return null
    throw error
  }
}

/** Скачивает зашифрованный сейф из папки приложения. null — сейфа на Диске ещё нет. */
export async function downloadVault(): Promise<{ vault: EncryptedVault; meta: RemoteFileMeta } | null> {
  const link = await api<{ href: string }>(`/disk/resources/download?path=${encodeURIComponent(VAULT_PATH)}`)
  let response: Response
  try {
    response = await fetch(link.href)
  } catch {
    throw new YandexApiError('network_error', 0)
  }
  if (!response.ok) throw new YandexApiError(`download_error_${response.status}`, response.status)
  const text = await response.text()
  let vault: EncryptedVault
  try {
    vault = JSON.parse(text) as EncryptedVault
  } catch {
    throw new YandexApiError('vault_file_corrupted', 0)
  }
  if (!vault || typeof vault.data !== 'string' || typeof vault.salt !== 'string' || typeof vault.iv !== 'string') {
    throw new YandexApiError('vault_file_corrupted', 0)
  }
  const meta = await fetchFileMeta()
  return { vault, meta: meta || { md5: '', modified: '', size: text.length } }
}

/** Загружает зашифрованный сейф в папку приложения (перезапись + новые md5). */
export async function uploadVault(vault: EncryptedVault): Promise<RemoteFileMeta> {
  const link = await api<{ href: string; method: string }>(
    `/disk/resources/upload?path=${encodeURIComponent(VAULT_PATH)}&overwrite=true`
  )
  let response: Response
  try {
    response = await fetch(link.href, {
      method: link.method || 'PUT',
      body: new Blob([JSON.stringify(vault)], { type: 'application/octet-stream' })
    })
  } catch {
    throw new YandexApiError('network_error', 0)
  }
  if (!response.ok) throw new YandexApiError(`upload_error_${response.status}`, response.status)
  const meta = await fetchFileMeta()
  return meta || { md5: '', modified: new Date().toISOString(), size: 0 }
}

/** Отзывает токен (best effort — при ошибке просто забываем его локально). */
export async function revokeToken() {
  const token = getToken()
  const clientId = getClientId()
  dropToken()
  if (!token || !clientId) return
  try {
    await fetch('https://oauth.yandex.ru/revoke_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, access_token: token })
    })
  } catch { /* страница отзыва недоступна — токен удалён локально */ }
}
