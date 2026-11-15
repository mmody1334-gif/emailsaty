import { EngineProvider, GeneratedInbox, IncomingMessage, MailEngine } from './types'
import { MailTmEngine } from './mailtm'
import { OneSecMailEngine } from './onesec'
import { EduMailEngine } from './edumail'

export * from './types'
export * from './mailtm'
export * from './onesec'
export * from './edumail'

/**
 * MultiEngine Aggregator
 * Coordinates multiple underlying disposable email providers,
 * handles automatic fallback, domain discovery, and inbox polling.
 */
export class MultiEngine {
  private engines: Map<EngineProvider, MailEngine> = new Map()

  constructor() {
    this.engines.set('mailtm', new MailTmEngine())
    this.engines.set('onesec', new OneSecMailEngine())
    this.engines.set('edumail', new EduMailEngine())
  }

  getEngine(provider: EngineProvider): MailEngine {
    const engine = this.engines.get(provider)
    if (!engine) {
      throw new Error(`Engine provider not found: ${provider}`)
    }
    return engine
  }

  /**
   * Retrieves all available domains categorized by provider and tier (Standard vs Edu)
   */
  async getAllDomains(): Promise<{
    provider: EngineProvider
    domains: string[]
    isEdu?: boolean
  }[]> {
    const results: { provider: EngineProvider; domains: string[]; isEdu?: boolean }[] = []

    for (const [provider, engine] of this.engines.entries()) {
      try {
        const domains = await engine.getDomains()
        results.push({
          provider,
          domains,
          isEdu: provider === 'edumail',
        })
      } catch {
        // Continue with available providers
      }
    }

    return results
  }

  /**
   * Generates a new inbox using the best available provider or a specific one
   */
  async createInbox(options?: {
    provider?: EngineProvider
    preferredName?: string
    domain?: string
    isEdu?: boolean
  }): Promise<GeneratedInbox> {
    const provider: EngineProvider = options?.isEdu
      ? 'edumail'
      : options?.provider || 'mailtm'

    try {
      const engine = this.getEngine(provider)
      return await engine.generateInbox(options?.preferredName, options?.domain)
    } catch (err) {
      // Fallback to 1secmail if primary provider fails
      if (provider !== 'onesec') {
        const fallback = this.getEngine('onesec')
        return await fallback.generateInbox(options?.preferredName)
      }
      throw err
    }
  }

  /**
   * Checks messages for a given inbox
   */
  async checkMessages(inbox: GeneratedInbox): Promise<IncomingMessage[]> {
    const engine = this.engines.get(inbox.provider) || this.getEngine('onesec')
    return await engine.getMessages(inbox)
  }

  /**
   * Reads a single full message
   */
  async getMessage(inbox: GeneratedInbox, messageId: string): Promise<IncomingMessage | null> {
    const engine = this.engines.get(inbox.provider) || this.getEngine('onesec')
    return await engine.getMessage(inbox, messageId)
  }
}

export const defaultMultiEngine = new MultiEngine()
