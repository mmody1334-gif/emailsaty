import { EngineProvider, GeneratedInbox, IncomingMessage, MailEngine } from './types'
import { extractVerification, stripHtml } from '../utils/otp'

/**
 * EduMail Engine
 * Specialized engine providing educational and academic domains (.edu, .edu.pl, .ac.id, etc.)
 * for services requiring student/academic verification.
 */
export class EduMailEngine implements MailEngine {
  readonly name: EngineProvider = 'edumail'

  // Default recognized educational and academic domains
  private static readonly DEFAULT_EDU_DOMAINS = [
    'student.edu.pl',
    'campus.edu.vn',
    'univ-student.edu',
    'alumni.edu',
    'edu.ac.id',
  ]

  private static readonly SECMAIL_API = 'https://www.1secmail.com/api/v1/'

  async getDomains(): Promise<string[]> {
    try {
      const res = await fetch(`${EduMailEngine.SECMAIL_API}?action=getDomainList`, {
        headers: { 'User-Agent': 'Emailsaty-EduEngine/1.0' },
      })
      if (res.ok) {
        const domains: string[] = await res.json()
        const edu = domains.filter((d) => d.includes('.edu') || d.includes('.ac.'))
        if (edu.length > 0) return edu
      }
    } catch {
      // Fallback to static educational domains
    }
    return EduMailEngine.DEFAULT_EDU_DOMAINS
  }

  async generateInbox(preferredName?: string, domain?: string): Promise<GeneratedInbox> {
    const domains = await this.getDomains()
    const chosenDomain = domain && domains.includes(domain) ? domain : domains[0]
    const username = preferredName
      ? preferredName.toLowerCase().replace(/[^a-z0-9._-]/g, '')
      : `student_${Math.random().toString(36).substring(2, 9)}`

    const address = `${username}@${chosenDomain}`

    return {
      address,
      provider: this.name,
      id: username,
      createdAt: Date.now(),
      isEdu: true,
    }
  }

  async getMessages(inbox: GeneratedInbox): Promise<IncomingMessage[]> {
    const [login, domain] = inbox.address.split('@')
    if (!login || !domain) return []

    try {
      const url = `${EduMailEngine.SECMAIL_API}?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Emailsaty-EduEngine/1.0' },
      })
      if (!res.ok) return []

      const items: Array<{
        id: number
        from: string
        subject: string
        date: string
      }> = await res.json()

      const messages: IncomingMessage[] = []
      for (const item of items) {
        const full = await this.getMessage(inbox, String(item.id))
        if (full) {
          messages.push(full)
        } else {
          const verification = extractVerification(item.subject)
          messages.push({
            id: String(item.id),
            inboxAddress: inbox.address,
            from: { address: item.from, name: item.from.split('@')[0] },
            subject: item.subject,
            verificationCode: verification.code,
            verificationLink: verification.link,
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
    const [login, domain] = inbox.address.split('@')
    if (!login || !domain) return null

    try {
      const url = `${EduMailEngine.SECMAIL_API}?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(messageId)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Emailsaty-EduEngine/1.0' },
      })
      if (!res.ok) return null

      const data: {
        id: number
        from: string
        subject: string
        date: string
        body: string
        textBody: string
        htmlBody: string
      } = await res.json()

      const text = data.textBody || stripHtml(data.htmlBody || data.body || '')
      const verification = extractVerification(text, data.htmlBody || data.body)

      return {
        id: String(data.id),
        inboxAddress: inbox.address,
        from: { address: data.from, name: data.from.split('@')[0] },
        subject: data.subject || '(بدون عنوان)',
        intro: text.substring(0, 150),
        textBody: text,
        htmlBody: data.htmlBody || data.body,
        verificationCode: verification.code,
        verificationLink: verification.link,
        receivedAt: new Date(data.date).getTime() || Date.now(),
        read: false,
      }
    } catch {
      return null
    }
  }
}
