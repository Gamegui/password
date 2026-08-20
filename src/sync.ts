// Синхронизация без собственного сервера: зашифрованный сейф хранится
// в папке приложения SafeKey на Яндекс Диске (app:/safekey.vault).
// Состояние синхронизации — только этот браузер + токен Яндекса.

import type { EncryptedVault } from './types'
import { downloadVault, dropToken, fetchFileMeta, fetchAccount, uploadVault } from './yandex'

export type SyncState = {
  account: { login: string; displayName: string }
  lastSync: string    // когда последний раз сходились с Диском
  lastMd5: string     // md5 файла при последней успешной синхронизации
  fileModified: string // время изменения файла на Диске (для показа)
  fileSize: number
}

const STATE_KEY = 'safekey.sync.v2'

export const getSyncState = (): SyncState | null => {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch { return null }
}
export const setSyncState = (state: SyncState) => localStorage.setItem(STATE_KEY, JSON.stringify(state))
export const clearSyncState = () => localStorage.removeItem(STATE_KEY)

/** Привязка токена к аккаунту: вызывается после успешного OAuth. */
export async function connectAccount(): Promise<SyncState> {
  const account = await fetchAccount()
  const state: SyncState = { account, lastSync: '', lastMd5: '', fileModified: '', fileSize: 0 }
  setSyncState(state)
  return state
}

export type PullResult = {
  vault: EncryptedVault | null // null — сейфа на Диске ещё нет
  md5: string
  modified: string
  changed: boolean // Диск отличается от последней синхронизации
}

/** Проверяет Диск и при изменении скачивает сейф. */
export async function pullRemote(): Promise<PullResult> {
  const meta = await fetchFileMeta()
  const state = getSyncState()
  if (!meta) return { vault: null, md5: '', modified: '', changed: Boolean(state?.lastMd5) }
  const changed = !state || meta.md5 !== state.lastMd5
  if (!changed) {
    return { vault: null, md5: meta.md5, modified: meta.modified, changed: false }
  }
  const remote = await downloadVault()
  return { vault: remote?.vault || null, md5: remote?.meta.md5 || meta.md5, modified: meta.modified, changed: true }
}

/** Отправляет сейф на Диск и запоминает его md5 как точку синхронизации. */
export async function pushVault(vault: EncryptedVault): Promise<SyncState> {
  const meta = await uploadVault(vault)
  const state = getSyncState()
  const next: SyncState = {
    account: state?.account || { login: 'yandex', displayName: 'Яндекс' },
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
    account: state?.account || { login: 'yandex', displayName: 'Яндекс' },
    lastSync: new Date().toISOString(),
    lastMd5: md5,
    fileModified: modified,
    fileSize: size
  }
  setSyncState(next)
  return next
}

/** Полное отключение: забываем токен и состояние. */
export function disconnectSync() {
  dropToken()
  clearSyncState()
}
