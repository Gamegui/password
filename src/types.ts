export type VaultItem = {
  id: string
  title: string
  username: string
  password: string
  url: string
  notes: string
  category: 'login' | 'card' | 'note'
  favorite: boolean
  updatedAt: string
}

export type VaultData = {
  items: VaultItem[]
  createdAt: string
  updatedAt: string
}

export type EncryptedVault = {
  version: 1
  salt: string
  iv: string
  data: string
  iterations: number
  updatedAt: string
}
