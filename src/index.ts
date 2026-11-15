import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MultiEngine } from './engines'
import { InboxStore } from './store/inbox-store'

export interface Env {
  EMAILSATY_STORAGE: KVNamespace
  BOT_TOKEN?: string
  PUBLIC_BASE_URL?: string
}

const app = new Hono<{ Bindings: Env }>()
const multiEngine = new MultiEngine()

// Enable CORS for GitHub Pages and all origins
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Helper: Telegram Client
async function sendTelegram(botToken: string, chatId: string | number, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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

// 1. Health check
app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }))

app.get('/debug-create', async (c) => {
  try {
    const inbox = await multiEngine.getEngine('mailtm').generateInbox()
    return c.json({ ok: true, inbox })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message, stack: err.stack })
  }
})

// 2. API: Create Inbox (Server-side Mail.tm & EduMail generation without CORS limits)
app.post('/api/inbox/create', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const isEdu = Boolean(body.isEdu)
  const preferredName = body.preferredName
  const chatId = body.chatId || 736161596

  try {
    const inbox = await multiEngine.createInbox({ isEdu, preferredName })
    const store = new InboxStore(c.env.EMAILSATY_STORAGE as any)
    await store.saveInbox(chatId, inbox)

    return c.json({ ok: true, inbox })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

// 3. API: Check Messages for an inbox
app.get('/api/inbox/:address/messages', async (c) => {
  const address = c.req.param('address')
  const store = new InboxStore(c.env.EMAILSATY_STORAGE as any)
  const stored = await store.getInbox(address)

  if (!stored) {
    return c.json({ ok: false, error: 'Inbox not found' }, 404)
  }

  try {
    const messages = await multiEngine.checkMessages(stored.inbox)
    const botToken = c.env.BOT_TOKEN || '8576873952:AAFD919csZ1CWTKZv-fG5v7J8lGzUYCEtI4'

    // Push new messages to Telegram
    for (const msg of messages) {
      const delivered = await store.isMessageDelivered(msg.id)
      if (!delivered) {
        await store.markMessageDelivered(msg.id)
        const text =
          `📬 <b>رسالة جديدة مستلمة!</b>\n\n` +
          `📧 <b>البريد:</b> <code>${address}</code>\n` +
          `👤 <b>المرسل:</b> <code>${msg.from.address}</code>\n` +
          `📝 <b>الموضوع:</b> ${msg.subject || '(بدون عنوان)'}\n\n` +
          (msg.verificationCode ? `🔑 <b>كود التحقق (OTP):</b>\n<code>${msg.verificationCode}</code>\n\n` : '') +
          `🌐 <i>فتح في الموقع:</i> https://mmody1334-gif.github.io/emailsaty/`

        await sendTelegram(botToken, stored.chatId, text)
      }
    }

    return c.json({ ok: true, messages })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

// 4. Telegram Webhook: Handles /start, /new, /edu, /inboxes
app.post('/telegram/webhook', async (c) => {
  const update = await c.req.json().catch(() => ({}))
  const message = update.message
  if (!message || !message.text) return c.json({ ok: true })

  const chatId = message.chat.id
  const text = message.text.trim()
  const botToken = c.env.BOT_TOKEN || '8576873952:AAFD919csZ1CWTKZv-fG5v7J8lGzUYCEtI4'
  const store = new InboxStore(c.env.EMAILSATY_STORAGE as any)

  if (text === '/start' || text === '/help') {
    const welcome =
      `👋 <b>أهلاً بك في بوت إيميلاتي (Emailsaty)!</b>\n\n` +
      `⚡ يمكنك إنشاء بريد مؤقت فوري ونظيف يقبله فيسبوك وجوجل وإنستاجرام.\n\n` +
      `📌 <b>الأوامر المتاحة:</b>\n` +
      `• <code>/new</code> : توليد إيميل عشوائي جديد معتمد وموثق.\n` +
      `• <code>/edu</code> : توليد إيميل جامعي <code>.EDU</code> للتحقق الطلابي.\n` +
      `• <code>/inboxes</code> : عرض جميع إيميلاتك السابقة المحفوظة.\n` +
      `• <code>/check</code> : فحص صندوق الوارد الآن.\n\n` +
      `🌐 <b>لوحة التحكم المباشرة (GitHub Pages):</b>\n` +
      `https://mmody1334-gif.github.io/emailsaty/`

    await sendTelegram(botToken, chatId, welcome)
    return c.json({ ok: true })
  }

  if (text === '/new' || text === '/random') {
    await sendTelegram(botToken, chatId, '⏳ جاري توليد إيميل نظيف ومعتمد...')
    try {
      const inbox = await multiEngine.createInbox({ isEdu: false })
      await store.saveInbox(chatId, inbox)

      const reply =
        `✅ <b>تم إنشاء البريد بنجاح!</b>\n\n` +
        `📧 <b>عنوانك الجديد:</b>\n<code>${inbox.address}</code>\n\n` +
        `💡 <i>انسخ البريد واستخدمه للتسجيل في فيسبوك أو جوجل. سيصلك كود التحقق هنا فوراً.</i>`

      await sendTelegram(botToken, chatId, reply)
    } catch (e: any) {
      await sendTelegram(botToken, chatId, `❌ تعذر التوليد حالياً: ${e.message}`)
    }
    return c.json({ ok: true })
  }

  if (text === '/edu') {
    await sendTelegram(botToken, chatId, '🎓 جاري توليد إيميل جامعي .EDU...')
    try {
      const inbox = await multiEngine.createInbox({ isEdu: true })
      await store.saveInbox(chatId, inbox)

      const reply =
        `🎓 <b>تم إنشاء البريد الجامعي بنجاح!</b>\n\n` +
        `📧 <b>عنوانك الطلابي:</b>\n<code>${inbox.address}</code>\n\n` +
        `💡 <i>صالح للتخفيضات والتحقق الطلابي. ستصلك الأكواد هنا فوراً.</i>`

      await sendTelegram(botToken, chatId, reply)
    } catch (e: any) {
      await sendTelegram(botToken, chatId, `❌ تعذر التوليد: ${e.message}`)
    }
    return c.json({ ok: true })
  }

  if (text === '/inboxes') {
    const list = await store.getUserInboxes(chatId)
    if (list.length === 0) {
      await sendTelegram(botToken, chatId, '📭 ليس لديك إيميلات نشطة حالياً. اطلب <code>/new</code> لإنشاء إيميل.')
      return c.json({ ok: true })
    }

    let msg = `📬 <b>إيميلاتك النشطة المحفوظة (${list.length}):</b>\n\n`
    list.forEach((item, idx) => {
      msg += `${idx + 1}. <code>${item.inbox.address}</code> ${item.inbox.isEdu ? '🎓' : ''}\n`
    })
    msg += `\n⚡ يتم فحص جميع هذه الإيميلات تلقائياً 24/7.`

    await sendTelegram(botToken, chatId, msg)
    return c.json({ ok: true })
  }

  if (text === '/check') {
    await sendTelegram(botToken, chatId, '🔄 جاري فحص الوارد لجميع إيميلاتك...')
    const list = await store.getUserInboxes(chatId)
    let foundNew = false

    for (const item of list) {
      const messages = await multiEngine.checkMessages(item.inbox)
      for (const msg of messages) {
        const delivered = await store.isMessageDelivered(msg.id)
        if (!delivered) {
          foundNew = true
          await store.markMessageDelivered(msg.id)
          const alertText =
            `📬 <b>رسالة مستلمة!</b>\n\n` +
            `📧 <b>البريد:</b> <code>${item.inbox.address}</code>\n` +
            `👤 <b>المرسل:</b> <code>${msg.from.address}</code>\n` +
            `📝 <b>الموضوع:</b> ${msg.subject || '(بدون عنوان)'}\n\n` +
            (msg.verificationCode ? `🔑 <b>كود التحقق (OTP):</b>\n<code>${msg.verificationCode}</code>\n\n` : '')

          await sendTelegram(botToken, chatId, alertText)
        }
      }
    }

    if (!foundNew) {
      await sendTelegram(botToken, chatId, '📭 لم تصل رسائل جديدة بعد. جاري المراقبة المستمرة...')
    }
    return c.json({ ok: true })
  }

  return c.json({ ok: true })
})

// 5. Cloudflare Cron Trigger (Runs 24/7 every minute)
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const store = new InboxStore(env.EMAILSATY_STORAGE as any)
    const botToken = env.BOT_TOKEN || '8576873952:AAFD919csZ1CWTKZv-fG5v7J8lGzUYCEtI4'
    const activeAddresses = await store.getAllActiveAddresses()

    for (const address of activeAddresses) {
      ctx.waitUntil((async () => {
        const item = await store.getInbox(address)
        if (!item) return
        try {
          const messages = await multiEngine.checkMessages(item.inbox)
          for (const msg of messages) {
            const delivered = await store.isMessageDelivered(msg.id)
            if (!delivered) {
              await store.markMessageDelivered(msg.id)
              const text =
                `📬 <b>رسالة جديدة مستلمة (مراقبة 24/7)!</b>\n\n` +
                `📧 <b>البريد:</b> <code>${address}</code>\n` +
                `👤 <b>المرسل:</b> <code>${msg.from.address}</code>\n` +
                `📝 <b>الموضوع:</b> ${msg.subject || '(بدون عنوان)'}\n\n` +
                (msg.verificationCode ? `🔑 <b>كود التحقق (OTP):</b>\n<code>${msg.verificationCode}</code>\n\n` : '') +
                `🌐 <i>فتح في الموقع:</i> https://mmody1334-gif.github.io/emailsaty/`

              await sendTelegram(botToken, item.chatId, text)
            }
          }
        } catch {
          // Continue monitoring next inbox
        }
      })())
    }
  },
}
