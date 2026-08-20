import type { EncryptedVault } from './types'

export type SyncConfig = { vaultId: string; token: string; revision: number; lastSync?: string }
const CONFIG_KEY = 'safekey.sync.v1'

export const getSyncConfig = (): SyncConfig | null => {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null') } catch { return null }
}
export const setSyncConfig = (config: SyncConfig) => localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
export const clearSyncConfig = () => localStorage.removeItem(CONFIG_KEY)
const headers = (token?: string) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) })

async function parse(response: Response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || 'sync_error'), { status: response.status, data })
  return data
}

export async function createCloud(blob: EncryptedVault, deviceName: string): Promise<SyncConfig> {
  const data = await parse(await fetch('/api/sync/create', { method: 'POST', headers: headers(), body: JSON.stringify({ blob, deviceName }) }))
  const config = { vaultId: data.vaultId, token: data.token, revision: data.revision, lastSync: new Date().toISOString() }
  setSyncConfig(config)
  return config
}

export async function pushCloud(blob: EncryptedVault, config = getSyncConfig()) {
  if (!config) throw new Error('not_configured')
  const data = await parse(await fetch(`/api/sync/${config.vaultId}`, { method: 'PUT', headers: headers(config.token), body: JSON.stringify({ blob, revision: config.revision }) }))
  const next = { ...config, revision: data.revision, lastSync: data.updatedAt }
  setSyncConfig(next)
  return next
}

export async function pullCloud(config = getSyncConfig()): Promise<{ blob: EncryptedVault; config: SyncConfig; devices: Array<{id:string;name:string;lastSeen:string}> }> {
  if (!config) throw new Error('not_configured')
  const data = await parse(await fetch(`/api/sync/${config.vaultId}`, { headers: headers(config.token) }))
  const next = { ...config, revision: data.revision, lastSync: data.updatedAt }
  setSyncConfig(next)
  return { blob: data.blob, config: next, devices: data.devices || [] }
}

export async function createPairCode(config = getSyncConfig()) {
  if (!config) throw new Error('not_configured')
  return parse(await fetch(`/api/sync/${config.vaultId}/pair`, { method: 'POST', headers: headers(config.token) })) as Promise<{ code: string; expiresAt: number }>
}

export async function claimPairCode(code: string, deviceName: string) {
  const data = await parse(await fetch('/api/pair/claim', { method: 'POST', headers: headers(), body: JSON.stringify({ code, deviceName }) }))
  const config = { vaultId: data.vaultId, token: data.token, revision: data.revision, lastSync: new Date().toISOString() }
  setSyncConfig(config)
  return { blob: data.blob as EncryptedVault, config }
}
