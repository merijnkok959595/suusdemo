/**
 * Retell Custom LLM — WebSocket handler.
 *
 * Protocol (per Retell docs):
 *  IN  call_details      → store callId / orgId / userNaam
 *  IN  response_required → run agent turn, stream text back
 *  IN  reminder_required → same as response_required (user was silent)
 *  IN  ping_pong         → echo timestamp back
 *  OUT { response_id, content, content_complete }
 *
 * Tool calls are executed server-side (never exposed to Retell).
 * Mini cards are pushed to card-store so the frontend polling loop picks them up.
 */

import type { WebSocket } from 'ws'
import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources'
import { buildOrgContext } from '@/lib/ai/buildSystemPrompt'
import { buildContextHeader } from '@/lib/ai/system-prompt'
import { executeTool } from '@/lib/crm/tools'
import type { CrmContext } from '@/lib/crm/tools'
import { addCard } from '@/lib/retell/card-store'
import type { MiniCardData } from '@/components/ui/MiniCard'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL  = 'gpt-4.1'

// ─── Protocol types ────────────────────────────────────────────────────────

type RetellCall = {
  call_id:   string
  metadata?: { organization_id?: string; user_naam?: string }
  retell_llm_dynamic_variables?: Record<string, string>
}

type RetellTranscriptItem = { role: 'agent' | 'user'; content: string }

type RetellIncoming =
  | { interaction_type: 'call_details';      call: RetellCall }
  | { interaction_type: 'response_required'; transcript: RetellTranscriptItem[]; response_id: number; call: RetellCall }
  | { interaction_type: 'reminder_required'; transcript: RetellTranscriptItem[]; response_id: number; call: RetellCall }
  | { interaction_type: 'ping_pong';         timestamp: number }

// ─── Connection handler ────────────────────────────────────────────────────

export function handleRetellLLM(ws: WebSocket): void {
  let callId   = ''
  let orgId    = process.env.DEMO_ORG_ID ?? ''
  let userNaam = process.env.DEMO_USER_NAAM ?? 'Demo gebruiker'

  let currentAbort: AbortController | null = null

  ws.on('message', async (raw) => {
    let msg: RetellIncoming
    try { msg = JSON.parse(raw.toString()) as RetellIncoming } catch { return }

    if (msg.interaction_type === 'ping_pong') {
      ws.send(JSON.stringify({ interaction_type: 'ping_pong', timestamp: msg.timestamp }))
      return
    }

    if (msg.interaction_type === 'call_details') {
      callId   = msg.call.call_id
      orgId    = msg.call.metadata?.organization_id    ?? process.env.DEMO_ORG_ID  ?? ''
      userNaam = msg.call.metadata?.user_naam          ?? process.env.DEMO_USER_NAAM ?? 'Demo gebruiker'
      console.log(`[retell/llm] connected  callId=${callId}  orgId=${orgId}`)
      return
    }

    if (
      msg.interaction_type === 'response_required' ||
      msg.interaction_type === 'reminder_required'
    ) {
      // Barge-in: abort the previous in-flight turn
      if (currentAbort) { currentAbort.abort(); currentAbort = null }

      const abort = new AbortController()
      currentAbort = abort

      const { response_id: responseId, transcript } = msg

      runTurn(ws, { responseId, transcript, callId, orgId, userNaam, abort: abort.signal })
        .catch((err) => {
          if ((err as Error)?.name === 'AbortError') return
          console.error('[retell/llm] runTurn error:', err)
          try {
            ws.send(JSON.stringify({
              response_id: responseId, content: 'Sorry, er is iets misgegaan.', content_complete: true,
            }))
          } catch { /* ws closed */ }
        })
    }
  })

  ws.on('close', () => {
    currentAbort?.abort()
    console.log(`[retell/llm] closed  callId=${callId}`)
  })

  ws.on('error', (err) => {
    console.error('[retell/llm] ws error:', err)
    currentAbort?.abort()
  })
}

// ─── Per-turn agent loop ───────────────────────────────────────────────────

async function runTurn(
  ws:   WebSocket,
  opts: {
    responseId: number
    transcript: RetellTranscriptItem[]
    callId:     string
    orgId:      string
    userNaam:   string
    abort:      AbortSignal
  },
): Promise<void> {
  const { responseId, transcript, callId, orgId, userNaam, abort } = opts
  const WS_OPEN = 1

  const send = (content: string, complete: boolean) => {
    if (abort.aborted || ws.readyState !== WS_OPEN) return
    try { ws.send(JSON.stringify({ response_id: responseId, content, content_complete: complete })) }
    catch { /* ws closed */ }
  }

  // Load org system prompt + filtered tools (cached 60 s)
  const orgCtx = await buildOrgContext(orgId)
  if (abort.aborted) return

  // Context header injects: vandaag/morgen dates, user name, surface=voice
  const ctxHeader = buildContextHeader({ naam: userNaam, surface: 'voice' })

  // Convert Retell transcript → OpenAI messages.
  // Inject context header only into the last user message.
  const lastUserIdx = transcript.reduce((acc, t, i) => t.role === 'user' ? i : acc, -1)

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: orgCtx.systemPrompt },
    ...transcript.map((t, i) => ({
      role:    (t.role === 'agent' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: (t.role === 'user' && i === lastUserIdx) ? ctxHeader + t.content : t.content,
    })),
  ]

  const ctx: CrmContext = {
    organizationId: orgId,
    userId:         process.env.DEMO_USER_ID ?? 'demo',
    userNaam,
  }

  // Agent loop — tool calls happen here, text streams back to Retell
  let iterations = 0
  while (iterations < 15) {
    if (abort.aborted) return
    iterations++

    let stream
    try {
      stream = await openai.chat.completions.create({
        model: MODEL, messages, tools: orgCtx.tools, tool_choice: 'auto',
        temperature: 0, max_tokens: 1024, stream: true,
      }, { signal: abort })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      throw err
    }

    type ToolAcc = { id: string; name: string; args: string }
    const toolAcc: Record<number, ToolAcc> = {}
    let finishReason: string | null = null

    try {
      for await (const chunk of stream) {
        if (abort.aborted) return
        const choice = chunk.choices[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta
        if (delta.content) send(delta.content, false)

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolAcc[idx]) toolAcc[idx] = { id: '', name: '', args: '' }
            if (tc.id)                  toolAcc[idx].id    = tc.id
            if (tc.function?.name)      toolAcc[idx].name += tc.function.name
            if (tc.function?.arguments) toolAcc[idx].args += tc.function.arguments
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      throw err
    }

    if (finishReason === 'tool_calls') {
      const calls = Object.values(toolAcc)
      const toolCallsMsg = calls.map(tc => ({
        id: tc.id, type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      }))
      messages.push({ role: 'assistant', content: null, tool_calls: toolCallsMsg })

      for (const tc of calls) {
        if (abort.aborted) return
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.args) } catch { /* ignore */ }
        console.log(`[retell/llm] → ${tc.name}`, args)

        const result = tc.name === 'log_bezoek'
          ? await handleLogBezoek(args, ctx)
          : await executeTool(tc.name, args, ctx)

        console.log(`[retell/llm] ← ${tc.name}`, result.slice(0, 200))
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })

        const card = buildCard(tc.name, args, result)
        if (card && callId) addCard(callId, card)
      }
      continue
    }

    break
  }

  send('', true) // signal content_complete → Retell starts TTS
}

// ─── Card builder ──────────────────────────────────────────────────────────

function buildCard(
  name:   string,
  args:   Record<string, unknown>,
  result: string,
): MiniCardData | null {
  try {
    const parsed = JSON.parse(result)
    switch (name) {
      case 'contact_search': {
        if (!parsed?.contacts?.length) return null
        const c = parsed.contacts[0]
        return { type: 'contact_found', id: c.id ?? '', title: c.bedrijf ?? c.naam ?? 'Contact', subtitle: c.naam ?? undefined, meta: c.stad ?? undefined, contactId: c.id ?? '' }
      }
      case 'contact_create': {
        if (!parsed?.success) return null
        return { type: 'contact_created', id: parsed.id ?? '', title: String(args.companyName ?? ''), subtitle: String(args.firstName ?? '') || undefined, meta: String(args.city ?? '') || undefined, contactId: parsed.id ?? '' }
      }
      case 'note_create': {
        if (!parsed?.success) return null
        const raw = String(args.body ?? '')
        const snippet = (raw.charAt(0).toUpperCase() + raw.slice(1)).slice(0, 60) + (raw.length > 60 ? '…' : '')
        return { type: 'note', id: parsed.id ?? '', title: snippet, contactId: String(args.contactId ?? '') }
      }
      case 'task_create': {
        if (!parsed?.success) return null
        const due = args.dueDate ? new Date(String(args.dueDate)).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : undefined
        return { type: 'task', id: parsed.id ?? '', title: String(args.title ?? ''), contactId: String(args.contactId ?? ''), meta: due }
      }
      case 'appointment_create': {
        if (!parsed?.success) return null
        const when = args.startTime ? new Date(String(args.startTime)).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : undefined
        return { type: 'appointment', id: parsed.id ?? '', title: String(args.title ?? ''), contactId: String(args.contactId ?? ''), meta: when }
      }
      case 'log_bezoek': {
        if (!parsed?.success) return null
        return { type: 'note', id: `bezoek-${Date.now()}`, title: `Bezoek: ${String(args.samenvatting ?? '').slice(0, 55)}…`, contactId: String(args.contactId ?? '') }
      }
      default: return null
    }
  } catch { return null }
}

// ─── log_bezoek composite handler ─────────────────────────────────────────

async function handleLogBezoek(args: Record<string, unknown>, ctx: CrmContext): Promise<string> {
  const contactId    = String(args.contactId ?? '')
  const samenvatting = String(args.samenvatting ?? '')
  const producten    = args.producten    ? String(args.producten)    : undefined
  const klantType    = args.klantType    ? String(args.klantType)    : undefined
  const vervolgActie = String(args.vervolgActie ?? 'geen')
  const vervolgDatum = args.vervolgDatum ? String(args.vervolgDatum) : undefined

  if (!contactId || !samenvatting) {
    return JSON.stringify({ success: false, error: 'contactId en samenvatting zijn verplicht' })
  }

  const results: string[] = []
  const noteBody = [
    `Bezoek: ${samenvatting}`,
    producten ? `Producten: ${producten}` : null,
  ].filter(Boolean).join('\n')

  try {
    await executeTool('note_create', { contactId, body: noteBody }, ctx)
    results.push('notitie opgeslagen')
  } catch { /* ignore */ }

  if (vervolgActie === 'taak' && vervolgDatum) {
    try {
      await executeTool('task_create', { contactId, title: 'Follow-up na bezoek', body: samenvatting, dueDate: vervolgDatum }, ctx)
      results.push('taak aangemaakt')
    } catch { /* ignore */ }
  } else if (vervolgActie === 'afspraak' && vervolgDatum) {
    try {
      const start = new Date(vervolgDatum)
      const end   = new Date(start.getTime() + 60 * 60 * 1000)
      await executeTool('appointment_create', { contactId, title: 'Vervolgafspraak na bezoek', startTime: start.toISOString(), endTime: end.toISOString(), notes: samenvatting }, ctx)
      results.push('afspraak ingepland')
    } catch { /* ignore */ }
  }

  if (klantType) {
    try {
      await executeTool('contact_update', { contactId, type: klantType.toLowerCase() === 'klant' ? 'customer' : 'lead' }, ctx)
      results.push(`contact bijgewerkt naar ${klantType}`)
    } catch { /* ignore */ }
  }

  return JSON.stringify({
    success: true,
    id:      `bezoek-${Date.now()}`,
    actions: results,
    message: results.length > 0 ? `Bezoek gelogd: ${results.join(', ')}.` : 'Bezoek gelogd.',
  })
}
