import type { EncryptedVault, VaultData } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach(byte => binary += String.fromCharCode(byte))
  return btoa(binary)
}

const fromBase64 = (value: string) => {
  const binary = atob(value)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptVault(vault: VaultData, password: string, existingSalt?: string): Promise<EncryptedVault> {
  const salt = existingSalt ? fromBase64(existingSalt) : crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const iterations = 600_000
  const key = await deriveKey(password, salt, iterations)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(vault)))
  return {
    version: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
    iterations,
    updatedAt: new Date().toISOString()
  }
}

export async function decryptVault(encrypted: EncryptedVault, password: string): Promise<VaultData> {
  const key = await deriveKey(password, fromBase64(encrypted.salt), encrypted.iterations)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(encrypted.iv) },
    key,
    fromBase64(encrypted.data)
  )
  return JSON.parse(decoder.decode(plaintext)) as VaultData
}

export function generatePassword(length = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-=?'
  const random = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(random, n => chars[n % chars.length]).join('')
}

export const strength = (password: string) => {
  let score = Math.min(2, password.length / 8)
  if (/[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  return Math.min(4, Math.floor(score))
}
