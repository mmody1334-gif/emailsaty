import { describe, it, expect } from 'vitest'
import { SmsEngine, defaultSmsEngine } from '../src/numbers/sms-engine'

describe('SmsEngine (SMS & Phone Numbers)', () => {
  it('extracts WhatsApp 6-digit code with dash', () => {
    const text = 'Your WhatsApp code: 829-104. Do not share this code.'
    const code = SmsEngine.extractSmsCode(text, 'whatsapp')
    expect(code).toBe('829-104')
  })

  it('extracts Google G-XXXXXX verification code', () => {
    const text = 'G-492015 is your Google verification code.'
    const code = SmsEngine.extractSmsCode(text, 'google')
    expect(code).toBe('G-492015')
  })

  it('extracts Facebook 5-digit code', () => {
    const text = 'FB-58291 is your Facebook confirmation code'
    const code = SmsEngine.extractSmsCode(text, 'facebook')
    expect(code).toBe('58291')
  })

  it('requests a number for WhatsApp in Indonesia with high success rate', async () => {
    const order = await defaultSmsEngine.requestNumber('whatsapp', 'id', 736161596)
    expect(order.service).toBe('whatsapp')
    expect(order.country).toBe('إندونيسيا')
    expect(order.dialCode).toBe('+62')
    expect(order.phoneNumber).toContain('+62')
    expect(order.status).toBe('PENDING')
    expect(order.expiresAt).toBeGreaterThan(Date.now())
  })

  it('provides verified free public numbers', () => {
    const free = defaultSmsEngine.getFreePublicNumbers()
    expect(free.length).toBeGreaterThan(0)
    expect(free[0].number).toBeDefined()
  })
})
