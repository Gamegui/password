// Общий интерфейс облака-хранилища для синхронизации. SafeKey работает с любым
// провайдером, который умеет хранить один файл и отдавать его md5/метаданные.

import type { EncryptedVault } from './types'

export type ProviderId = 'yandex' | 'google'

export type ProviderAccount = { login: string; displayName: string }
export type RemoteFileMeta = { md5: string; modified: string; size: number }
export type OAuthIntent = 'connect' | 'sync'

export interface SyncProvider {
  readonly id: ProviderId
  readonly title: string
  /** Настроен ли ClientID (его задают в app-config.js или в интерфейсе). */
  isConfigured(): boolean
  /** Редирект на страницу входа провайдера. */
  login(intent: OAuthIntent): void
  /**
   * Обработка возврата после OAuth (токен в фрагменте/параметрах или ошибка).
   * Возвращает intent, с которым начинали, либо null, если возврата не было.
   */
  completeRedirect(): Promise<{ intent: OAuthIntent } | { error: string } | null>
  /** Токен есть и (для Google) попытка тихого обновления перед запросами. */
  ensureFreshToken(): Promise<void>
  /** Метаданные сейфа; null — файла ещё нет. */
  fileMeta(): Promise<RemoteFileMeta | null>
  /** Скачать сейф; null — файла нет. */
  download(): Promise<{ vault: EncryptedVault; meta: RemoteFileMeta } | null>
  /** Загрузить сейф (перезапись). */
  upload(vault: EncryptedVault): Promise<RemoteFileMeta>
  /** Аккаунт владельца токена. */
  account(): Promise<ProviderAccount>
  /** Отзыв токена (best effort) и локальная очистка. */
  disconnect(): Promise<void>
}

export class ProviderError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export const NETWORK_ERROR = 'network_error'
export const UNAUTHORIZED = 'unauthorized'

/** Общий для провайдеров intent входа: откуда начинали — подключение сейфа или синхронизация. */
const INTENT_KEY = 'safekey.oauth.intent'
export const saveIntent = (intent: OAuthIntent) => sessionStorage.setItem(INTENT_KEY, intent)
export const readIntent = (): OAuthIntent | null => {
  const value = sessionStorage.getItem(INTENT_KEY)
  sessionStorage.removeItem(INTENT_KEY)
  return value === 'connect' || value === 'sync' ? value : null
}

/** Аккуратный fetch с единообразной обработкой сетевых ошибок и 401. */
export async function request(url: string, init: RequestInit, authHeader: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { ...init, headers: { Authorization: authHeader, ...(init.headers || {}) } })
  } catch {
    throw new ProviderError(NETWORK_ERROR, 0)
  }
  if (response.status === 401) throw new ProviderError(UNAUTHORIZED, 401)
  return response
}

export const base64url = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach(byte => binary += String.fromCharCode(byte))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
