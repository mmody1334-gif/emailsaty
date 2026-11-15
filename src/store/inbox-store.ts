import { GeneratedInbox } from '../engines/types'

/**
 * Storage interface compatible with Cloudflare KV and in-memory key-value maps
 */
export interface StorageAdapter {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * In-Memory storage implementation for testing and non-KV environments
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private data = new Map<string, { value: string; expiresAt?: number }>()

  async get(key: string): Promise<string | null> {
    const item = this.data.get(key)
    if (!item) return null
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.data.delete(key)
      return null
    }
    return item.value
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined
    this.data.set(key, { value, expiresAt })
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }
}

export interface StoredUserInbox {
  chatId: string | number
  inbox: GeneratedInbox
  active: boolean
  lastCheckedAt?: number
}

/**
 * Multi-Inbox Store
 * Tracks all active inboxes per Telegram user and globally,
 * guarantees that previously generated inboxes are preserved and monitored.
 */
export class InboxStore {
  constructor(private storage: StorageAdapter) {}

  private userKey(chatId: string | number): string {
    return `user:${chatId}:inboxes`
  }

  private inboxKey(address: string): string {
    return `inbox:${address.toLowerCase()}`
  }

  private deliveredKey(msgId: string): string {
    return `delivered:${msgId}`
  }

  private static readonly ACTIVE_ALL_KEY = 'inboxes:active_all'

  /**
   * Saves a newly generated inbox for a user
   */
  async saveInbox(chatId: string | number, inbox: GeneratedInbox): Promise<void> {
    const address = inbox.address.toLowerCase()
    const stored: StoredUserInbox = {
      chatId,
      inbox,
      active: true,
      lastCheckedAt: Date.now(),
    }

    // 1. Store inbox details
    await this.storage.put(this.inboxKey(address), JSON.stringify(stored))

    // 2. Add to user list
    const userInboxes = await this.getUserInboxes(chatId)
    const exists = userInboxes.some((i) => i.inbox.address.toLowerCase() === address)
    if (!exists) {
      userInboxes.unshift(stored)
      await this.storage.put(this.userKey(chatId), JSON.stringify(userInboxes))
    }

    // 3. Add to global active list
    const allActive = await this.getAllActiveAddresses()
    if (!allActive.includes(address)) {
      allActive.unshift(address)
      await this.storage.put(InboxStore.ACTIVE_ALL_KEY, JSON.stringify(allActive))
    }
  }

  /**
   * Retrieves all inboxes belonging to a Telegram user
   */
  async getUserInboxes(chatId: string | number): Promise<StoredUserInbox[]> {
    const raw = await this.storage.get(this.userKey(chatId))
    if (!raw) return []
    try {
      return JSON.parse(raw) as StoredUserInbox[]
    } catch {
      return []
    }
  }

  /**
   * Retrieves specific inbox by address
   */
  async getInbox(address: string): Promise<StoredUserInbox | null> {
    const raw = await this.storage.get(this.inboxKey(address.toLowerCase()))
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredUserInbox
    } catch {
      return null
    }
  }

  /**
   * Deactivates or deletes an inbox for a user
   */
  async deleteInbox(chatId: string | number, address: string): Promise<boolean> {
    const addr = address.toLowerCase()
    await this.storage.delete(this.inboxKey(addr))

    // Update user list
    const userInboxes = await this.getUserInboxes(chatId)
    const filtered = userInboxes.filter((i) => i.inbox.address.toLowerCase() !== addr)
    await this.storage.put(this.userKey(chatId), JSON.stringify(filtered))

    // Update global list
    const allActive = await this.getAllActiveAddresses()
    const updatedGlobal = allActive.filter((a) => a !== addr)
    await this.storage.put(InboxStore.ACTIVE_ALL_KEY, JSON.stringify(updatedGlobal))

    return true
  }

  /**
   * Returns all active email addresses monitored across the platform
   */
  async getAllActiveAddresses(): Promise<string[]> {
    const raw = await this.storage.get(InboxStore.ACTIVE_ALL_KEY)
    if (!raw) return []
    try {
      return JSON.parse(raw) as string[]
    } catch {
      return []
    }
  }

  /**
   * Message delivery deduplication check
   */
  async isMessageDelivered(msgId: string): Promise<boolean> {
    const val = await this.storage.get(this.deliveredKey(msgId))
    return val !== null
  }

  /**
   * Marks message as delivered with TTL (e.g. 7 days)
   */
  async markMessageDelivered(msgId: string, ttlSeconds = 604800): Promise<void> {
    await this.storage.put(this.deliveredKey(msgId), '1', { expirationTtl: ttlSeconds })
  }
}
