import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MultiEngine } from './engines'
import { InboxStore } from './store/inbox-store'
import { defaultSmsEngine, SmsEngine } from './numbers/sms-engine'
import { SupportedService } from './numbers/types'

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

// Numbers API: Countries & Free numbers
app.get('/api/numbers/countries', (c) => c.json({ ok: true, countries: defaultSmsEngine.getCountries() }))
app.get('/api/numbers/free', (c) => c.json({ ok: true, numbers: defaultSmsEngine.getFreePublicNumbers() }))

// Numbers API: Request a phone number for WhatsApp / Google / Facebook
app.post('/api/numbers/request', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = (body.service || 'whatsapp') as SupportedService
  const country = body.country || 'id'
  const chatId = body.chatId || 736161596

  try {
    const order = await defaultSmsEngine.requestNumber(service, country, chatId)
    const store = new InboxStore(c.env.EMAILSATY_STORAGE as any)
    await (c.env.EMAILSATY_STORAGE as any).put(`order:${order.orderId}`, JSON.stringify(order), { expirationTtl: 1800 })

    const botToken = c.env.BOT_TOKEN || '8576873952:AAFD919csZ1CWTKZv-fG5v7J8lGzUYCEtI4'
    const notifyText =
      `📱 <b>تم حجز رقم تفعيل جديد!</b>\n\n` +
      `🎯 <b>الخدمة:</b> <code>${service.toUpperCase()}</code>\n` +
      `🌍 <b>الدولة:</b> ${order.country}\n` +
      `📞 <b>الرقم:</b>\n<code>${order.phoneNumber}</code>\n\n` +
      `⏳ <i>أدخل الرقم في التطبيق واطلب كود SMS. سيظهر الكود هنا فوراً.</i>`

    await sendTelegram(botToken, chatId, notifyText)

    return c.json({ ok: true, order })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

// Numbers API: Check SMS status for an active order
app.get('/api/numbers/:orderId/check', async (c) => {
  const orderId = c.req.param('orderId')
  const raw = await (c.env.EMAILSATY_STORAGE as any).get(`order:${orderId}`)
  if (!raw) return c.json({ ok: false, error: 'Order not found or expired' }, 404)

  const order = JSON.parse(raw)
  return c.json({ ok: true, order })
})

// Numbers API: Simulate receiving SMS (for manual/webhook delivery)
app.post('/api/numbers/:orderId/receive', async (c) => {
  const orderId = c.req.param('orderId')
  const body = await c.req.json().catch(() => ({}))
  const smsText = body.text || 'Your WhatsApp code: 492-108'

  const raw = await (c.env.EMAILSATY_STORAGE as any).get(`order:${orderId}`)
  if (!raw) return c.json({ ok: false, error: 'Order not found' }, 404)

  const order = JSON.parse(raw)
  const code = SmsEngine.extractSmsCode(smsText, order.service)

  order.status = 'RECEIVED'
  order.smsCode = code
  order.smsText = smsText
  await (c.env.EMAILSATY_STORAGE as any).put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 1800 })

  const botToken = c.env.BOT_TOKEN || '8576873952:AAFD919csZ1CWTKZv-fG5v7J8lGzUYCEtI4'
  if (order.chatId) {
    const alertText =
      `🎉 <b>تم استلام كود تفعيل SMS!</b>\n\n` +
      `📱 <b>الرقم:</b> <code>${order.phoneNumber}</code>\n` +
      `🎯 <b>الخدمة:</b> <code>${order.service.toUpperCase()}</code>\n\n` +
      (code ? `🔑 <b>كود التفعيل (OTP):</b>\n<code>${code}</code>\n\n` : '') +
      `💬 <b>نص الرسالة:</b>\n${smsText}`

    await sendTelegram(botToken, order.chatId, alertText)
  }

  return c.json({ ok: true, order })
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
      `👋 <b>أهلاً بك في بوت إيميلاتي وأرقام التفعيل (Emailsaty)!</b>\n\n` +
      `⚡ المنظومة المتكاملة للبريد المؤقت النظيف وأرقام تفعيل SMS لواتساب وجوجل.\n\n` +
      `📌 <b>أوامر الإيميلات:</b>\n` +
      `• <code>/new</code> : توليد إيميل معتمد لفيسبوك وجوجل.\n` +
      `• <code>/edu</code> : توليد إيميل جامعي <code>.EDU</code>.\n` +
      `• <code>/inboxes</code> : عرض جميع إيميلاتك السابقة.\n\n` +
      `📱 <b>أوامر أرقام التفعيل:</b>\n` +
      `• <code>/wa</code> : حجز رقم واتساب فوري (شريحة خلوية حقيقية).\n` +
      `• <code>/google</code> : حجز رقم تفعيل حسابات جوجل.\n` +
      `• <code>/free</code> : عرض أرقام مجانية عامة.\n\n` +
      `🌐 <b>لوحة التحكم الشاملة (تطبيق الويب):</b>\n` +
      `https://mmody1334-gif.github.io/emailsaty/`

    await sendTelegram(botToken, chatId, welcome)
    return c.json({ ok: true })
  }

  if (text === '/wa' || text.startsWith('/number whatsapp')) {
    await sendTelegram(botToken, chatId, '⏳ جاري حجز رقم واتساب خلوى نشط (إندونيسيا 99% نجاح)...')
    try {
      const order = await defaultSmsEngine.requestNumber('whatsapp', 'id', chatId)
      await (c.env.EMAILSATY_STORAGE as any).put(`order:${order.orderId}`, JSON.stringify(order), { expirationTtl: 1800 })

      const reply =
        `📱 <b>تم حجز رقم واتساب بنجاح!</b>\n\n` +
        `📞 <b>الرقم:</b>\n<code>${order.phoneNumber}</code>\n` +
        `🌍 <b>الدولة:</b> ${order.country} (${order.dialCode})\n` +
        `⏱️ <b>الصلاحية:</b> 15 دقيقة\n\n` +
        `💡 <i>انسخ الرقم وضعه في واتساب واطلب كود SMS. سيصلك الكود هنا فوراً.</i>`

      await sendTelegram(botToken, chatId, reply)
    } catch (e: any) {
      await sendTelegram(botToken, chatId, `❌ فشل حجز الرقم: ${e.message}`)
    }
    return c.json({ ok: true })
  }

  if (text === '/google' || text.startsWith('/number google')) {
    await sendTelegram(botToken, chatId, '⏳ جاري حجز رقم تفعيل جوجل...')
    try {
      const order = await defaultSmsEngine.requestNumber('google', 'us', chatId)
      await (c.env.EMAILSATY_STORAGE as any).put(`order:${order.orderId}`, JSON.stringify(order), { expirationTtl: 1800 })

      const reply =
        `📱 <b>تم حجز رقم جوجل بنجاح!</b>\n\n` +
        `📞 <b>الرقم:</b>\n<code>${order.phoneNumber}</code>\n` +
        `🌍 <b>الدولة:</b> ${order.country}\n\n` +
        `💡 <i>أدخل الرقم في جوجل وسيصلك كود G-XXXXXX هنا فوراً.</i>`

      await sendTelegram(botToken, chatId, reply)
    } catch (e: any) {
      await sendTelegram(botToken, chatId, `❌ فشل حجز الرقم: ${e.message}`)
    }
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
