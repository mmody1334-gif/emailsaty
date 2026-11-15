import type { GeneratedInbox, IncomingMessage, MailEngine } from './types'
import { extractVerification, stripHtml } from '../utils/otp'

const BASE_URL = 'https://api.mail.tm'

export class MailTmEngine implements MailEngine {
  readonly name = 'mailtm'

  async getDomains(): Promise<string[]> {
    try {
      const res = await fetch(`${BASE_URL}/domains`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return []
      const data: any = await res.json()
      const list = data['hydra:member'] || data.member || []
      return list.map((item: any) => item.domain).filter(Boolean)
    } catch {
      return []
    }
  }

  async generateInbox(preferredName?: string, domainChoice?: string): Promise<GeneratedInbox> {
    const domains = await this.getDomains()
    const domain = domainChoice || domains[0] || 'vmani.com'
    const cleanPrefix = (preferredName || `usr${Math.random().toString(36).substring(2, 9)}`)
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
    const address = `${cleanPrefix}@${domain}`
    const password = `P@ss${Math.random().toString(36).substring(2, 10)}!${Date.now()}`

    // 1. Create account
    const createRes = await fetch(`${BASE_URL}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ address, password }),
    })

    if (!createRes.ok && createRes.status !== 422) {
      throw new Error(`Failed to create mail.tm account: ${createRes.status}`)
    }

    // 2. Obtain token
    const tokenRes = await fetch(`${BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ address, password }),
    })

    if (!tokenRes.ok) {
      throw new Error(`Failed to authenticate mail.tm: ${tokenRes.status}`)
    }

    const tokenData: any = await tokenRes.json()
    const token = tokenData.token
    const id = tokenData.id

    return {
      address,
      provider: 'mailtm',
      token,
      password,
      id,
      createdAt: Date.now(),
      isEdu: domain.includes('edu') || domain.includes('ac.'),
    }
  }

  async getMessages(inbox: GeneratedInbox): Promise<IncomingMessage[]> {
    if (!inbox.token) return []
    try {
      const res = await fetch(`${BASE_URL}/messages`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${inbox.token}`,
        },
      })
      if (!res.ok) return []
      const data: any = await res.json()
      const list = data['hydra:member'] || data.member || []

      const messages: IncomingMessage[] = []
      for (const item of list) {
        const fullMsg = await this.getMessage(inbox, item.id)
        if (fullMsg) {
          messages.push(fullMsg)
        } else {
          // Fallback minimal mapping
          const text = item.intro || ''
          const { code, link } = extractVerification(text)
          messages.push({
            id: item.id,
            inboxAddress: inbox.address,
            from: {
              address: item.from?.address || '',
              name: item.from?.name || '',
            },
            subject: item.subject || 'بدون عنوان',
            intro: item.intro,
            textBody: text,
            verificationCode: code,
            verificationLink: link,
            receivedAt: new Date(item.createdAt).getTime() || Date.now(),
            read: Boolean(item.seen),
          })
        }
      }

      return messages
    } catch {
      return []
    }
  }

  async getMessage(inbox: GeneratedInbox, messageId: string): Promise<IncomingMessage | null> {
    if (!inbox.token) return null
    try {
      const res = await fetch(`${BASE_URL}/messages/${messageId}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${inbox.token}`,
        },
      })
      if (!res.ok) return null
      const data: any = await res.json()

      const text = data.text || stripHtml(data.html?.[0] || '')
      const html = Array.isArray(data.html) ? data.html.join('') : data.html || ''
      const { code, link } = extractVerification(text, html)

      return {
        id: data.id,
        inboxAddress: inbox.address,
        from: {
          address: data.from?.address || '',
          name: data.from?.name || '',
        },
        subject: data.subject || 'بدون عنوان',
        intro: data.intro || text.slice(0, 120),
        textBody: text,
        htmlBody: html,
        verificationCode: code,
        verificationLink: link,
        receivedAt: new Date(data.createdAt).getTime() || Date.now(),
        read: Boolean(data.seen),
      }
    } catch {
      return null
    }
  }

  async deleteMessage(inbox: GeneratedInbox, messageId: string): Promise<boolean> {
    if (!inbox.token) return false
    try {
      const res = await fetch(`${BASE_URL}/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${inbox.token}` },
      })
      return res.status === 204 || res.ok
    } catch {
      return false
    }
  }
}
