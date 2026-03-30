import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources'
import { callMcpServer } from '@/lib/mcp'
import { CHAT_TOOLS } from '@/lib/suus-tools'
import { CHAT_SYSTEM } from '@/lib/suus-prompts'

export const runtime     = 'nodejs'
export const maxDuration = 60

export async function POST(req: Request) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  try {
    const { message, history } = await req.json() as {
      message: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }
    if (!message?.trim()) return new Response('Missing message', { status: 400 })

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: CHAT_SYSTEM },
      ...(history ?? []),
      { role: 'user',   content: message },
    ]

    const encoder = new TextEncoder()
    let briefingPayload: string | null = null
    let contactsPayload: string | null = null
    // Tracks company data across tool calls (Google → CRM)
    const companyState: { name?: string; address?: string; city?: string; phone?: string; found?: boolean; contactNaam?: string } = {}

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Agentic loop — max 5 iterations
          for (let i = 0; i < 5; i++) {
            const response = await openai.chat.completions.create({
              model:       'gpt-4.1',
              messages,
              tools:       CHAT_TOOLS,
              tool_choice: 'auto',
              stream:      true,
            })

            let fullText = ''
            const toolCalls: Record<string, { name: string; args: string }> = {}

            for await (const chunk of response) {
              const delta = chunk.choices[0]?.delta

              if (delta?.content) {
                fullText += delta.content
                controller.enqueue(encoder.encode(delta.content))
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const id = tc.id ?? Object.keys(toolCalls).at(-1) ?? `tc_${i}`
                  if (!toolCalls[id]) toolCalls[id] = { name: '', args: '' }
                  if (tc.function?.name)      toolCalls[id].name += tc.function.name
                  if (tc.function?.arguments) toolCalls[id].args += tc.function.arguments
                }
              }
            }

            if (Object.keys(toolCalls).length === 0) break

            messages.push({
              role: 'assistant',
              content: fullText || null,
              tool_calls: Object.entries(toolCalls).map(([id, tc]) => ({
                id, type: 'function' as const, function: { name: tc.name, arguments: tc.args },
              })),
            })

            for (const [id, tc] of Object.entries(toolCalls)) {
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(tc.args || '{}') } catch { /* ignore */ }

              const result = await callMcpServer(tc.name, args)

              if (tc.name === 'contact_briefing') {
                try { briefingPayload = JSON.stringify(JSON.parse(result)) } catch { /* ignore */ }
              }
              if (tc.name === 'google_zoek_adres') {
                try {
                  const p = JSON.parse(result)
                  if (p?.naam || p?.name)    companyState.name    = p.naam ?? p.name
                  if (p?.adres || p?.address) companyState.address = p.adres ?? p.address
                  if (p?.city || p?.stad)     companyState.city    = p.city ?? p.stad
                  if (p?.telefoon || p?.phone) companyState.phone  = p.telefoon ?? p.phone
                } catch { /* ignore */ }
              }
              if (tc.name === 'contact_zoek') {
                try {
                  const parsed   = JSON.parse(result)
                  const contacts = parsed?.contacts ?? (parsed?.contact ? [parsed.contact] : null)
                  if (contacts?.length) contactsPayload = JSON.stringify({ contacts })
                  // Enrich company state with CRM data
                  const first = contacts?.[0] ?? parsed?.contact
                  if (first) {
                    companyState.found       = parsed?.found !== false
                    companyState.contactNaam = [first.firstName, first.lastName].filter(Boolean).join(' ') || first.naam || undefined
                    if (!companyState.name)  companyState.name = first.companyName ?? first.company_name ?? companyState.name
                    if (!companyState.city)  companyState.city = first.city ?? undefined
                  }
                } catch { /* ignore */ }
              }
              if (tc.name === 'contact_create') {
                try {
                  const p = JSON.parse(result)
                  companyState.found       = false
                  companyState.contactNaam = p.firstName ?? p.first_name ?? undefined
                  if (!companyState.name)  companyState.name = p.companyName ?? p.company_name ?? undefined
                } catch { /* ignore */ }
              }

              messages.push({ role: 'tool', tool_call_id: id, content: result })
            }
          }

          if (companyState.name) controller.enqueue(encoder.encode(`\n__COMPANY__:${JSON.stringify(companyState)}`))
          if (briefingPayload)  controller.enqueue(encoder.encode(`\n__BRIEFING__:${briefingPayload}`))
          if (contactsPayload)  controller.enqueue(encoder.encode(`\n__CONTACTS__:${contactsPayload}`))

        } catch (e) {
          controller.enqueue(encoder.encode('Er ging iets mis. Probeer opnieuw.'))
          console.error('[chat]', e)
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
    })
  } catch (e) {
    console.error('[chat route]', e)
    return new Response('Internal error', { status: 500 })
  }
}
