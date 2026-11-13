// Sends email over SMTP, set up with environment variables:
//   SMTP_URL (such as smtps://user:pass@smtp.example.com), or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   MAIL_FROM, the sender (such as "Jigsaw <jigsaw@example.com>")
// Without any of them, mail is printed to the server log instead, which is enough to try things locally.
import nodemailer from 'nodemailer'

function transport() {
  const env = process.env
  if (env.SMTP_URL) return nodemailer.createTransport(env.SMTP_URL)
  if (!env.SMTP_HOST) return null
  const port = Number(env.SMTP_PORT) || 587
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
  })
}

export function createMailer() {
  const smtp = transport()
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'jigsaw@localhost'
  return {
    // Whether mail really goes out, rather than to the server log.
    sent: !!smtp,
    // Resolves once sent; never rejects, since a failed email shouldn't fail what caused it.
    send: async ({ to, subject, text }: { to: string; subject: string; text: string }) => {
      if (!smtp) return console.log(`[mail] to ${to}: ${subject}\n${text}\n`)
      try {
        await smtp.sendMail({ from, to, subject, text })
      } catch (e) {
        console.error(`[mail] could not send to ${to}: ${(e as Error).message}`)
      }
    },
  }
}
