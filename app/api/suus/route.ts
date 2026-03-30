import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources'

export const runtime     = 'nodejs'
export const maxDuration = 60

const NATIVE_MCP_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/native-mcp`
  : 'https://fzbkauyubvaonnztzfyb.supabase.co/functions/v1/native-mcp'

const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

const SYSTEM = `Je bent Suus, de AI sales-assistent. Je helpt accountmanagers met hun CRM.
Spreek altijd Nederlands. Houd antwoorden bondig tenzij een briefing gevraagd wordt.
Gebruik tools om echte data op te halen — nooit raden of verzinnen.
De gebruiker is altijd de accountmanager.`

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'contact_zoek',
      description: 'Zoek een contact in het CRM op bedrijfsnaam en optioneel plaatsnaam.',
      parameters: { type: 'object', properties: { bedrijfsnaam: { type: 'string' }, plaatsnaam: { type: 'string' } }, required: ['bedrijfsnaam'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_briefing',
      description: 'Volledige briefing van een contact: notities, taken, afspraken, classificatie.',
      parameters: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_create',
      description: 'Maak een nieuw contact aan in het CRM.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string' }, city: { type: 'string' },
          first_name:   { type: 'string' }, email: { type: 'string' },
          phone:        { type: 'string' }, type: { type: 'string', enum: ['lead', 'customer'] },
        },
        required: ['company_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_update',
      description: 'Wijzig velden van een contact.',
      parameters: { type: 'object', properties: { contactId: { type: 'string' }, company_name: { type: 'string' }, type: { type: 'string', enum: ['lead', 'customer'] } }, required: ['contactId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'note_create',
      description: 'Notitie toevoegen aan een contact.',
      parameters: { type: 'object', properties: { contactId: { type: 'string' }, body: { type: 'string' } }, required: ['contactId', 'body'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_create',
      description: 'Taak aanmaken voor een contact.',
      parameters: { type: 'object', properties: { contactId: { type: 'string' }, title: { type: 'string' }, dueDate: { type: 'string' } }, required: ['contactId', 'title'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_create',
      description: 'Afspraak aanmaken voor een contact.',
      parameters: { type: 'object', properties: { contactId: { type: 'string' }, title: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' } }, required: ['contactId', 'title', 'startTime'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_zoek_adres',
      description: 'Zoek bedrijfsadres via Google Places.',
      parameters: { type: 'object', properties: { bedrijfsnaam: { type: 'string' }, plaatsnaam: { type: 'string' } }, required: ['bedrijfsnaam'] },
    },
  },
]

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const res = await fetch(NATIVE_MCP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}` },
      body:    JSON.stringify({ name, args }),
    })
    const text = await res.text()
    try { return JSON.stringify(JSON.parse(text)) } catch { return text }
  } catch (e) {
    return `Tool fout: ${e instanceof Error ? e.message : String(e)}`
  }
}

export async function POST(req: Request) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  try {
    const { message } = await req.json() as { message: string }
    if (!message?.trim()) return new Response('Missing message', { status: 400 })

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system',  content: SYSTEM },
      { role: 'user',    content: message },
    ]

    const encoder = new TextEncoder()
    let briefingPayload: string | null = null
    let contactsPayload: string | null = null

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Agentic loop — max 5 iterations
          for (let i = 0; i < 5; i++) {
            const response = await openai.chat.completions.create({
              model:       'gpt-4.1',
              messages,
              tools:       TOOLS,
              tool_choice: 'auto',
              stream:      true,
            })

            let fullText        = ''
            const toolCalls: Record<string, { name: string; args: string }> = {}

            for await (const chunk of response) {
              const delta = chunk.choices[0]?.delta

              // Stream text
              if (delta?.content) {
                fullText += delta.content
                controller.enqueue(encoder.encode(delta.content))
              }

              // Accumulate tool calls
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const id = tc.id ?? Object.keys(toolCalls).at(-1) ?? `tc_${i}`
                  if (!toolCalls[id]) toolCalls[id] = { name: '', args: '' }
                  if (tc.function?.name)      toolCalls[id].name += tc.function.name
                  if (tc.function?.arguments) toolCalls[id].args += tc.function.arguments
                }
              }
            }

            // No tool calls → done
            if (Object.keys(toolCalls).length === 0) break

            // Execute tools
            messages.push({ role: 'assistant', content: fullText || null, tool_calls: Object.entries(toolCalls).map(([id, tc]) => ({
              id, type: 'function' as const, function: { name: tc.name, arguments: tc.args },
            })) })

            for (const [id, tc] of Object.entries(toolCalls)) {
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(tc.args || '{}') } catch { /* ignore */ }
              const result = await callTool(tc.name, args)

              // Capture briefing data for card rendering
              if (tc.name === 'contact_briefing') {
                try { briefingPayload = JSON.stringify(JSON.parse(result)) } catch { /* ignore */ }
              }
              // Capture contact search results for cards
              if (tc.name === 'contact_zoek') {
                try {
                  const parsed = JSON.parse(result)
                  const contacts = parsed?.contacts ?? (parsed?.contact ? [parsed.contact] : null)
                  if (contacts?.length) contactsPayload = JSON.stringify({ contacts })
                } catch { /* ignore */ }
              }

              messages.push({ role: 'tool', tool_call_id: id, content: result })
            }
          }

          // Append structured payloads as markers (parsed by client)
          if (briefingPayload) controller.enqueue(encoder.encode(`\n__BRIEFING__:${briefingPayload}`))
          if (contactsPayload) controller.enqueue(encoder.encode(`\n__CONTACTS__:${contactsPayload}`))

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
