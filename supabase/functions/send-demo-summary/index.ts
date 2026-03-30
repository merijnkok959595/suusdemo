/**
 * send-demo-summary
 *
 * Retell post-call webhook → parse transcript + analysis → email via Resend
 * Triggered automatically after every SUUS-Demo call ends.
 */

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const TO_EMAIL       = 'merijn@risottini.com'
const FROM_EMAIL     = 'SUUS Demo <onboarding@resend.dev>'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }

  // Retell sends { event: "call_ended", call: {...} }
  const call = (body.call ?? body) as Record<string, unknown>

  const callId      = String(call.call_id       ?? '—')
  const agentId     = String(call.agent_id      ?? '—')
  const startTs     = call.start_timestamp ? new Date(Number(call.start_timestamp)).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—'
  const durationMs  = Number(call.duration_ms ?? 0)
  const durationStr = durationMs ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s` : '—'
  const fromNumber  = String(call.from_number ?? call.from_phone_number ?? 'web demo')

  // Analysis
  const analysis    = (call.call_analysis ?? {}) as Record<string, unknown>
  const summary     = String(analysis.call_summary       ?? 'Geen samenvatting beschikbaar.')
  const sentiment   = String(analysis.user_sentiment     ?? '—')
  const successful  = analysis.call_successful != null ? (analysis.call_successful ? '✅ Ja' : '❌ Nee') : '—'

  // Transcript
  const transcriptRaw = call.transcript ?? ''
  const transcript    = typeof transcriptRaw === 'string' ? transcriptRaw : JSON.stringify(transcriptRaw, null, 2)

  // Format transcript nicely: "Agent: ..." / "User: ..."
  const transcriptFormatted = transcript
    .split('\n')
    .filter((l: string) => l.trim())
    .map((l: string) => {
      if (l.startsWith('Agent:'))   return `<p><strong style="color:#6c47ff">SUUS:</strong> ${l.slice(6).trim()}</p>`
      if (l.startsWith('User:'))    return `<p><strong>Prospect:</strong> ${l.slice(5).trim()}</p>`
      return `<p>${l}</p>`
    })
    .join('')

  const html = `
<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">

    <!-- Header -->
    <div style="background:#6c47ff;padding:24px 32px">
      <h1 style="color:#fff;margin:0;font-size:22px">🎤 SUUS Demo Samenvatting</h1>
      <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:14px">${startTs}</p>
    </div>

    <!-- Meta -->
    <div style="padding:24px 32px;border-bottom:1px solid #eee">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 0;color:#888;width:140px">Beller</td><td style="padding:4px 0">${fromNumber}</td></tr>
        <tr><td style="padding:4px 0;color:#888">Gespreksduur</td><td style="padding:4px 0">${durationStr}</td></tr>
        <tr><td style="padding:4px 0;color:#888">Succesvol</td><td style="padding:4px 0">${successful}</td></tr>
        <tr><td style="padding:4px 0;color:#888">Sentiment</td><td style="padding:4px 0">${sentiment}</td></tr>
        <tr><td style="padding:4px 0;color:#888">Call ID</td><td style="padding:4px 0;font-size:12px;color:#aaa">${callId}</td></tr>
      </table>
    </div>

    <!-- Samenvatting -->
    <div style="padding:24px 32px;border-bottom:1px solid #eee">
      <h2 style="margin:0 0 12px;font-size:16px;color:#333">📝 Samenvatting</h2>
      <p style="margin:0;color:#444;line-height:1.6;font-size:14px">${summary}</p>
    </div>

    <!-- Transcript -->
    <div style="padding:24px 32px">
      <h2 style="margin:0 0 16px;font-size:16px;color:#333">💬 Transcript</h2>
      <div style="font-size:13px;line-height:1.7;color:#444">${transcriptFormatted || '<p style="color:#aaa">Geen transcript beschikbaar.</p>'}</div>
    </div>

    <!-- Footer -->
    <div style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#aaa">SUUS AI Sales Assistent · Agent ${agentId}</p>
    </div>

  </div>
</body>
</html>`

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [TO_EMAIL],
      subject: `SUUS Demo — ${startTs} (${durationStr})`,
      html,
    }),
  })

  if (!emailRes.ok) {
    const err = await emailRes.text()
    console.error('[send-demo-summary] Resend error:', err)
    return new Response(JSON.stringify({ ok: false, error: err }), { status: 500, headers: CORS })
  }

  console.log('[send-demo-summary] Email verzonden naar', TO_EMAIL)
  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
