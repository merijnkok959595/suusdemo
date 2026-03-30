import { Resend } from 'resend'
import { NextRequest } from 'next/server'

const TO_EMAIL = 'merijn@risottini.com'

type Msg = { role: 'user' | 'ai'; text: string }

export async function POST(req: NextRequest) {
  const resend = new Resend(process.env.RESEND_API_KEY)
  try {
    const { msgs, company, duration } = await req.json() as {
      msgs:     Msg[]
      company:  { name?: string; address?: string; contactNaam?: string; found?: boolean } | null
      duration: string
    }

    if (!msgs?.length) return Response.json({ ok: true })

    const today    = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' })
    const subject  = company?.name
      ? `Suus gesprek — ${company.name} — ${new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' })}`
      : `Suus gesprek — ${new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' })}`

    const transcriptHtml = msgs
      .filter(m => m.text?.trim())
      .map(m => `
        <div style="margin-bottom:12px;">
          <span style="font-size:11px;font-weight:700;color:${m.role === 'ai' ? '#6366f1' : '#374151'};text-transform:uppercase;letter-spacing:0.05em;">
            ${m.role === 'ai' ? 'Suus' : 'Jij'}
          </span><br/>
          <span style="font-size:14px;color:#1f2937;line-height:1.6;">${m.text}</span>
        </div>
      `).join('')

    const crmBadge = company?.found !== undefined
      ? `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:${company.found ? '#dcfce7' : '#dbeafe'};color:${company.found ? '#166534' : '#1e40af'};">
          ${company.found ? '✓ Gevonden in CRM' : '+ Aangemaakt in CRM'}
        </span>`
      : ''

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"/></head>
      <body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

          <!-- Header -->
          <div style="background:#18181b;padding:28px 32px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="width:36px;height:36px;border-radius:50%;background:#6366f1;display:flex;align-items:center;justify-content:center;">
                <span style="color:white;font-weight:800;font-size:14px;">S</span>
              </div>
              <div>
                <div style="color:white;font-size:16px;font-weight:700;">Suus AI</div>
                <div style="color:#a1a1aa;font-size:12px;">${today}</div>
              </div>
            </div>
          </div>

          <!-- Company info -->
          ${company?.name ? `
          <div style="padding:20px 32px 0;">
            <div style="background:#f4f4f5;border-radius:12px;padding:16px 20px;">
              <div style="font-size:15px;font-weight:700;color:#18181b;">${company.name}</div>
              ${company.contactNaam ? `<div style="font-size:13px;color:#71717a;margin-top:2px;">${company.contactNaam}</div>` : ''}
              ${company.address    ? `<div style="font-size:12px;color:#a1a1aa;margin-top:4px;">📍 ${company.address}</div>` : ''}
              ${crmBadge ? `<div style="margin-top:8px;">${crmBadge}</div>` : ''}
            </div>
          </div>` : ''}

          <!-- Meta -->
          <div style="padding:16px 32px 0;display:flex;gap:16px;">
            <div style="font-size:12px;color:#a1a1aa;">⏱ Gespreksduur: <strong style="color:#374151;">${duration}</strong></div>
          </div>

          <!-- Transcript -->
          <div style="padding:20px 32px 32px;">
            <div style="font-size:12px;font-weight:600;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:16px;">Transcript</div>
            <div style="background:#f9fafb;border-radius:12px;padding:20px;">
              ${transcriptHtml}
            </div>
          </div>

          <!-- Footer -->
          <div style="border-top:1px solid #f4f4f5;padding:16px 32px;text-align:center;">
            <span style="font-size:11px;color:#a1a1aa;">Suus AI · Automatisch gegenereerd na afloop van het gesprek</span>
          </div>
        </div>
      </body>
      </html>
    `

    await resend.emails.send({
      from:    'Suus AI <onboarding@resend.dev>',
      to:      TO_EMAIL,
      subject,
      html,
    })

    return Response.json({ ok: true })
  } catch (e) {
    console.error('[send-summary]', e)
    return Response.json({ ok: false }, { status: 500 })
  }
}
