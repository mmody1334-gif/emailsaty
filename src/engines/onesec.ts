import type { GeneratedInbox, IncomingMessage, MailEngine } from './types'
import { extractVerification, stripHtml } from '../utils/otp'

const BASE_URL = 'https://www.1secmail.com/api/v1/'

export class OneSecMailEngine implements MailEngine {
  readonly name = 'onesec'

  async getDomains(): Promise<string[]> {
    try {
      const res = await fetch(`${BASE_URL}?action=getDomainList`)
      if (!res.ok) return ['1secmail.com', '1secmail.net', '1secmail.org']
      const list: string[] = await res.json()
      return Array.isArray(list) && list.length ? list : ['1secmail.com']
    } catch {
      return ['1secmail.com', '1secmail.net', '1secmail.org']
    }
  }

  async generateInbox(preferredName?: string, domainChoice?: string): Promise<GeneratedInbox> {
    const domains = await this.getDomains()
    const domain = domainChoice || domains[Math.floor(Math.random() * domains.length)] || '1secmail.com'
    const cleanPrefix = (preferredName || `tmp${Math.random().toString(36).substring(2, 9)}`)
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
    const address = `${cleanPrefix}@${domain}`

    return {
      address,
      provider: 'onesec',
      createdAt: Date.now(),
      isEdu: domain.includes('edu') || domain.includes('ac.'),
    }
  }

  private parseAddress(address: string): { login: string; domain: string } {
    const parts = address.split('@')
    return {
      login: parts[0] || '',
      domain: parts[1] || '1secmail.com',
    }
  }

  async getMessages(inbox: GeneratedInbox): Promise<IncomingMessage[]> {
    const { login, domain } = this.parseAddress(inbox.address)
    if (!login || !domain) return []

    try {
      const res = await fetch(`${BASE_URL}?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`)
      if (!res.ok) return []
      const list: any[] = await res.json()
      if (!Array.isArray(list)) return []

      const messages: IncomingMessage[] = []
      for (const item of list) {
        const fullMsg = await this.getMessage(inbox, String(item.id))
        if (fullMsg) {
          messages.push(fullMsg)
        } else {
          messages.push({
            id: String(item.id),
            inboxAddress: inbox.address,
            from: {
              address: item.from || '',
              name: item.from || '',
            },
            subject: item.subject || 'بدون عنوان',
            receivedAt: new Date(item.date).getTime() || Date.now(),
            read: false,
          })
        }
      }

      return messages
    } catch {
      return []
    }
  }

  async getMessage(inbox: GeneratedInbox, messageId: string): Promise<IncomingMessage | null> {
    const { login, domain } = this.parseAddress(inbox.address)
    if (!login || !domain) return null

    try {
      const res = await fetch(
        `${BASE_URL}?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(messageId)}`,
      )
      if (!res.ok) return null
      const data: any = await res.json()

      const text = data.textBody || stripHtml(data.body || data.htmlBody || '')
      const html = data.htmlBody || data.body || ''
      const { code, link } = extractVerification(text, html)

      return {
        id: String(data.id),
        inboxAddress: inbox.address,
        from: {
          address: data.from || '',
          name: data.from || '',
        },
        subject: data.subject || 'بدون عنوان',
        intro: text.slice(0, 120),
        textBody: text,
        htmlBody: html,
        verificationCode: code,
        verificationLink: link,
        receivedAt: new Date(data.date).getTime() || Date.now(),
        read: true,
      }
    } catch {
      return null
    }
  }
}
