// Синхронизация без собственного сервера: зашифрованный сейф хранится в облаке,
// которое выбирает пользователь (Яндекс Диск или Google Drive). Состояние —
// только этот браузер + OAuth-токен выбранного провайдера.

import type { EncryptedVault } from './types'
import { yandexProvider } from './yandex'
import { googleProvider } from './gdrive'
import type { OAuthIntent, ProviderId, SyncProvider } from './provider'

export const providers: Record<ProviderId, SyncProvider> = { yandex: yandexProvider, google: googleProvider }
export type { ProviderId }

export type SyncState = {
  provider: ProviderId
  account: { login: string; displayName: string }
  lastSync: string     // когда последний раз сходились с облаком
  lastMd5: string      // md5 файла при последней успешной синхронизации
  fileModified: string // время изменения файла в облаке (для показа)
  fileSize: number
}

const STATE_KEY = 'safekey.sync.v3'
const LEGACY_KEYS = ['safekey.sync.v2']

export const getSyncState = (): SyncState | null => {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch { return null }
}
export const setSyncState = (state: SyncState) => {
  LEGACY_KEYS.forEach(key => localStorage.removeItem(key))
  localStorage.setItem(STATE_KEY, JSON.stringify(state))
}
export const clearSyncState = () => {
  LEGACY_KEYS.forEach(key => localStorage.removeItem(key))
  localStorage.removeItem(STATE_KEY)
}
export const activeProvider = (): SyncProvider | null => {
  const state = getSyncState()
  return state ? providers[state.provider] : null
}

/** Начало входа: редирект на страницу выбранного облака. */
export function beginLogin(providerId: ProviderId, intent: OAuthIntent) {
  providers[providerId].login(intent)
}

/** Возврат с OAuth (Яндекс — токен во фрагменте, Google — код в query). */
export async function completeOAuthRedirect(): Promise<{ provider: ProviderId; intent: OAuthIntent } | { provider: ProviderId; error: string } | null> {
  for (const provider of [yandexProvider, googleProvider]) {
    const result = await provider.completeRedirect()
    if (!result) continue
    if ('error' in result) return { provider: provider.id, error: result.error }
    return { provider: provider.id, intent: result.intent }
  }
  return null
}

/** Привязка к аккаунту: вызывается после успешного OAuth. */
export async function connectAccount(providerId: ProviderId): Promise<SyncState> {
  const provider = providers[providerId]
  const account = await provider.account()
  const state: SyncState = { provider: providerId, account, lastSync: '', lastMd5: '', fileModified: '', fileSize: 0 }
  setSyncState(state)
  return state
}

export type PullResult = {
  vault: EncryptedVault | null // null — сейфа в облаке ещё нет
  md5: string
  modified: string
  changed: boolean // облако отличается от последней синхронизации
}

/** Проверяет облако и при изменении скачивает сейф. */
export async function pullRemote(): Promise<PullResult> {
  const provider = activeProvider()
  if (!provider) throw new Error('not_configured')
  const meta = await provider.fileMeta()
  const state = getSyncState()
  if (!meta) return { vault: null, md5: '', modified: '', changed: Boolean(state?.lastMd5) }
  const changed = !state || meta.md5 !== state.lastMd5
  if (!changed) return { vault: null, md5: meta.md5, modified: meta.modified, changed: false }
  const remote = await provider.download()
  return { vault: remote?.vault || null, md5: remote?.meta.md5 || meta.md5, modified: meta.modified, changed: true }
}

/** Отправляет сейф в облако и запоминает md5 как точку синхронизации. */
export async function pushVault(vault: EncryptedVault): Promise<SyncState> {
  const provider = activeProvider()
  if (!provider) throw new Error('not_configured')
  const meta = await provider.upload(vault)
  const state = getSyncState()
  const next: SyncState = {
    provider: state?.provider || 'yandex',
    account: state?.account || { login: 'cloud', displayName: 'Облако' },
    lastSync: new Date().toISOString(),
    lastMd5: meta.md5,
    fileModified: meta.modified,
    fileSize: meta.size
  }
  setSyncState(next)
  return next
}

/** Запоминает точку синхронизации после скачивания удалённой версии. */
export function markSynced(md5: string, modified: string, size: number): SyncState {
  const state = getSyncState()
  const next: SyncState = {
    provider: state?.provider || 'yandex',
    account: state?.account || { login: 'cloud', displayName: 'Облако' },
    lastSync: new Date().toISOString(),
    lastMd5: md5,
    fileModified: modified,
    fileSize: size
  }
  setSyncState(next)
  return next
}

/** Полное отключение: отзыв токена провайдера + очистка состояния. */
export async function disconnectSync() {
  const provider = activeProvider()
  clearSyncState()
  if (provider) await provider.disconnect()
}
