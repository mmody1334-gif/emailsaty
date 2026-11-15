/**
 * 24/7 Background Inbox Monitor for GitHub Actions / Cron
 * Polls active inboxes and delivers incoming emails/OTPs to Telegram.
 */

const BOT_TOKEN = process.env.BOT_TOKEN || '8576873952:AAFD919csZ1CWTKZv-fG5v7J8lGzUYCEtI4'
const CHAT_ID = process.env.CHAT_ID || ''
const INBOXES_STR = process.env.ACTIVE_INBOXES || ''

async function sendTelegram(chatId, text) {
  if (!chatId || !BOT_TOKEN) return
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    })
    return await res.json()
  } catch (e) {
    console.error('Telegram send error:', e)
  }
}

function extractOtp(content) {
  if (!content) return null
  const keywordMatch = content.match(
    /(?:code|otp|pin|verification\s*code|security\s*code|رمز\s*التحقق|رمز\s*التأكيد|كود\s*التفعيل|كود)[\s:=—\-]+([A-Z0-9]{4,8})\b/i
  )
  if (keywordMatch) return keywordMatch[1]
  const gMatch = content.match(/\b([A-Z]{1,3}-\d{4,8})\b/)
  if (gMatch) return gMatch[1]
  const sixMatch = content.match(/(?<!\d|\$|€|£)(\d{6})(?!\d)/)
  if (sixMatch && !/^202[0-9]$/.test(sixMatch[1])) return sixMatch[1]
  return null
}

async function checkInbox(address) {
  const [login, domain] = address.split('@')
  if (!login || !domain) return

  const listUrl = `https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`
  try {
    const res = await fetch(listUrl)
    if (!res.ok) return
    const messages = await res.json()
    console.log(`[${address}] Found ${messages.length} messages`)

    for (const msg of messages) {
      const msgUrl = `https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(msg.id)}`
      const msgRes = await fetch(msgUrl)
      if (!msgRes.ok) continue
      const full = await msgRes.json()
      const otp = extractOtp(full.textBody || full.body || msg.subject)

      const alertText =
        `📬 <b>رسالة جديدة مستلمة (مراقبة 24/7)!</b>\n\n` +
        `📧 <b>البريد:</b> <code>${address}</code>\n` +
        `👤 <b>المرسل:</b> <code>${full.from}</code>\n` +
        `📝 <b>الموضوع:</b> ${full.subject || '(بدون عنوان)'}\n\n` +
        (otp ? `🔑 <b>كود التحقق (OTP):</b>\n<code>${otp}</code>\n\n` : '') +
        `🌐 <i>فتح في الموقع:</i> https://mmody1334-gif.github.io/emailsaty/`

      if (CHAT_ID) {
        await sendTelegram(CHAT_ID, alertText)
      }
    }
  } catch (e) {
    console.error(`Error checking ${address}:`, e)
  }
}

async function main() {
  const inboxes = INBOXES_STR.split(',').map((s) => s.trim()).filter(Boolean)
  console.log(`Starting background check for ${inboxes.length} inboxes...`)
  for (const inbox of inboxes) {
    await checkInbox(inbox)
  }
  console.log('Finished background check.')
}

main()
