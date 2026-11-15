export type EngineProvider = 'mailtm' | 'onesec' | 'edumail' | 'cloudflare'

export interface GeneratedInbox {
  address: string
  provider: EngineProvider
  token?: string
  password?: string
  id?: string
  createdAt: number
  expiresAt?: number
  isEdu?: boolean
}

export interface IncomingMessage {
  id: string
  inboxAddress: string
  from: {
    address: string
    name?: string
  }
  subject: string
  intro?: string
  textBody?: string
  htmlBody?: string
  verificationCode?: string
  verificationLink?: string
  receivedAt: number
  read: boolean
}

export interface MailEngine {
  readonly name: EngineProvider
  getDomains(): Promise<string[]>
  generateInbox(preferredName?: string, domain?: string): Promise<GeneratedInbox>
  getMessages(inbox: GeneratedInbox): Promise<IncomingMessage[]>
  getMessage(inbox: GeneratedInbox, messageId: string): Promise<IncomingMessage | null>
  deleteMessage?(inbox: GeneratedInbox, messageId: string): Promise<boolean>
  deleteInbox?(inbox: GeneratedInbox): Promise<boolean>
}
