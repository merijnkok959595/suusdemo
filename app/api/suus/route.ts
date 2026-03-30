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
                // Returns text, not JSON. Parse the Tag: line.
                // Format: Tag: [google: naam=X|adres=Y|stad=Z|postcode=P|tel=T]
                const tagMatch = result.match(/Tag:\s*\[google:([^\]]+)\]/)
                if (tagMatch) {
                  const pairs: Record<string, string> = {}
                  tagMatch[1].split('|').forEach(pair => {
                    const [k, ...v] = pair.split('=')
                    if (k && v.length) pairs[k.trim()] = v.join('=').trim()
                  })
                  if (pairs.naam)     companyState.name    = pairs.naam
                  if (pairs.adres)    companyState.address = pairs.adres
                  if (pairs.stad)     companyState.city    = pairs.stad
                  if (pairs.tel)      companyState.phone   = pairs.tel
                }
              }
              if (tc.name === 'contact_zoek') {
                try {
                  const parsed  = JSON.parse(result)
                  const contact = parsed?.contact
                  if (parsed?.found && contact) {
                    companyState.found       = true
                    companyState.contactNaam = contact.naam || undefined
                    if (!companyState.name)    companyState.name    = contact.bedrijf || undefined
                    if (!companyState.address) companyState.address = contact.adres   || undefined
                    if (!companyState.city)    companyState.city    = contact.stad    || undefined
                    if (!companyState.phone)   companyState.phone   = contact.telefoon || undefined
                  } else if (parsed?.found === false) {
                    companyState.found = false
                    if (!companyState.name) companyState.name = parsed.bedrijf_gezocht || undefined
                  }
                } catch { /* ignore */ }
              }
              if (tc.name === 'contact_create') {
                try {
                  const p = JSON.parse(result)
                  companyState.found       = false
                  companyState.contactNaam = p.first_name ?? p.firstName ?? undefined
                  if (!companyState.name)  companyState.name = p.company_name ?? p.companyName ?? undefined
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
