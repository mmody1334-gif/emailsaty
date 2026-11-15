/**
 * Smart OTP & Verification Link Extractor
 * High-precision regex engine to detect verification codes and confirmation URLs
 * in English and Arabic emails.
 */

export interface ExtractedVerification {
  code?: string
  link?: string
}

const OTP_PATTERNS = [
  // Explicit code keywords: "code: 123456", "OTP: 492019", "كود التحقق: 849201"
  /(?:code|otp|pin|verification\s*code|security\s*code|رمز\s*التحقق|رمز\s*التأكيد|كود\s*التفعيل|كود)[\s:=—\-]+([A-Z0-9]{4,8})\b/i,
  // Prefixed formats: G-123456, FB-12345
  /\b([A-Z]{1,3}-\d{4,8})\b/,
  // 6-digit standalone numbers commonly used by Google, Telegram, OpenAI, GitHub, Discord, Twitter
  /(?<!\d|\$|€|£)(\d{6})(?!\d)/,
  // 4, 5, or 8 digit numbers in standalone context
  /(?<!\d)(\d{4,5}|\d{8})(?!\d)/,
]

const LINK_PATTERNS = [
  /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|validation|token=|auth\/verify|email_confirm)[^\s"'<>]*/i,
]

export function extractVerification(text: string, html?: string): ExtractedVerification {
  const content = `${text || ''} ${stripHtml(html || '')}`
  let code: string | undefined
  let link: string | undefined

  for (const pattern of OTP_PATTERNS) {
    const match = content.match(pattern)
    if (match && match[1]) {
      const candidate = match[1].trim()
      // Skip common year strings e.g. 2024, 2025, 2026, 2027
      if (/^202[0-9]$/.test(candidate)) continue
      code = candidate
      break
    }
  }

  for (const pattern of LINK_PATTERNS) {
    const match = content.match(pattern)
    if (match && match[0]) {
      link = match[0].trim()
      break
    }
  }

  return { code, link }
}

export function stripHtml(html: string): string {
  if (!html) return ''
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}
