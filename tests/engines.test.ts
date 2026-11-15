import { describe, it, expect, vi } from 'vitest'
import { extractVerification } from '../src/utils/otp'
import { OneSecMailEngine } from '../src/engines/onesec'
import { EduMailEngine } from '../src/engines/edumail'
import { MultiEngine } from '../src/engines/index'

describe('OTP & Verification Code Extraction', () => {
  it('extracts English explicit verification code', () => {
    const text = 'Your verification code is: 849201. Please do not share it.'
    const result = extractVerification(text)
    expect(result.code).toBe('849201')
  })

  it('extracts Arabic verification code', () => {
    const text = 'مرحباً بك، رمز التحقق الخاص بك هو 593104 صالح لمدة 10 دقائق.'
    const result = extractVerification(text)
    expect(result.code).toBe('593104')
  })

  it('extracts prefixed Google / Discord style OTP', () => {
    const text = 'Your Google verification code is G-482910'
    const result = extractVerification(text)
    expect(result.code).toBe('G-482910')
  })

  it('extracts verification link from email', () => {
    const text = 'Click here to confirm: https://example.com/auth/verify?token=abc123xyz'
    const result = extractVerification(text)
    expect(result.link).toBe('https://example.com/auth/verify?token=abc123xyz')
  })

  it('ignores standard year strings like 2026', () => {
    const text = 'Copyright 2026 Company Inc. All rights reserved. Code: 7381'
    const result = extractVerification(text)
    expect(result.code).toBe('7381')
  })
})

describe('1secmail Engine', () => {
  it('generates inbox with default domains', async () => {
    const engine = new OneSecMailEngine()
    const inbox = await engine.generateInbox('testuser')
    expect(inbox.address).toContain('testuser@')
    expect(inbox.provider).toBe('onesec')
    expect(inbox.createdAt).toBeGreaterThan(0)
  })
})

describe('EduMail Engine', () => {
  it('generates inbox with educational domain and marks isEdu', async () => {
    const engine = new EduMailEngine()
    const inbox = await engine.generateInbox('ahmed_student')
    expect(inbox.address).toContain('ahmed_student@')
    expect(inbox.provider).toBe('edumail')
    expect(inbox.isEdu).toBe(true)
  })
})

describe('MultiEngine Aggregator', () => {
  it('routes isEdu option to edumail engine', async () => {
    const multi = new MultiEngine()
    const inbox = await multi.createInbox({ isEdu: true, preferredName: 'student123' })
    expect(inbox.isEdu).toBe(true)
    expect(inbox.provider).toBe('edumail')
  })

  it('routes standard option to mailtm or fallback to onesec', async () => {
    const multi = new MultiEngine()
    const inbox = await multi.createInbox({ provider: 'onesec', preferredName: 'normaluser' })
    expect(inbox.provider).toBe('onesec')
    expect(inbox.address).toContain('normaluser@')
  })
})
