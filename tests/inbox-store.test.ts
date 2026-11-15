import { describe, it, expect, beforeEach } from 'vitest'
import { InboxStore, MemoryStorageAdapter } from '../src/store/inbox-store'
import { GeneratedInbox } from '../src/engines/types'

describe('InboxStore (Multi-Inbox State Machine)', () => {
  let store: InboxStore
  let memory: MemoryStorageAdapter

  beforeEach(() => {
    memory = new MemoryStorageAdapter()
    store = new InboxStore(memory)
  })

  it('saves and preserves multiple inboxes for the same user', async () => {
    const chatId = 123456789
    const inbox1: GeneratedInbox = {
      address: 'user1@1secmail.com',
      provider: 'onesec',
      createdAt: Date.now(),
    }
    const inbox2: GeneratedInbox = {
      address: 'user2_edu@student.edu.pl',
      provider: 'edumail',
      createdAt: Date.now(),
      isEdu: true,
    }

    await store.saveInbox(chatId, inbox1)
    await store.saveInbox(chatId, inbox2)

    const userInboxes = await store.getUserInboxes(chatId)
    expect(userInboxes.length).toBe(2)
    // Most recent first
    expect(userInboxes[0].inbox.address).toBe('user2_edu@student.edu.pl')
    expect(userInboxes[1].inbox.address).toBe('user1@1secmail.com')

    // Both remain retrievable independently
    const check1 = await store.getInbox('user1@1secmail.com')
    const check2 = await store.getInbox('user2_edu@student.edu.pl')
    expect(check1).not.toBeNull()
    expect(check2).not.toBeNull()
    expect(check1?.chatId).toBe(chatId)
    expect(check2?.chatId).toBe(chatId)
  })

  it('tracks global active addresses for cron polling', async () => {
    await store.saveInbox(100, {
      address: 'box1@mail.tm',
      provider: 'mailtm',
      createdAt: Date.now(),
    })
    await store.saveInbox(200, {
      address: 'box2@student.edu.pl',
      provider: 'edumail',
      createdAt: Date.now(),
      isEdu: true,
    })

    const all = await store.getAllActiveAddresses()
    expect(all).toContain('box1@mail.tm')
    expect(all).toContain('box2@student.edu.pl')
  })

  it('deletes an inbox cleanly from user and global lists', async () => {
    const chatId = 999
    await store.saveInbox(chatId, {
      address: 'delete_me@onesecmail.com',
      provider: 'onesec',
      createdAt: Date.now(),
    })

    let inboxes = await store.getUserInboxes(chatId)
    expect(inboxes.length).toBe(1)

    await store.deleteInbox(chatId, 'delete_me@onesecmail.com')

    inboxes = await store.getUserInboxes(chatId)
    expect(inboxes.length).toBe(0)

    const all = await store.getAllActiveAddresses()
    expect(all).not.toContain('delete_me@onesecmail.com')
  })

  it('deduplicates message delivery using delivery markers', async () => {
    const msgId = 'msg_random_hash_9821'

    expect(await store.isMessageDelivered(msgId)).toBe(false)
    await store.markMessageDelivered(msgId)
    expect(await store.isMessageDelivered(msgId)).toBe(true)
  })
})
