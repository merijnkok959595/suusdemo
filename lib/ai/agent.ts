import OpenAI from 'openai'
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionUserMessageParam,
} from 'openai/resources'
import { createClient } from '@supabase/supabase-js'
import { CRM_TOOLS, executeTool, type CrmContext } from '@/lib/crm/tools'
import { buildContextHeader, type AgentContext } from '@/lib/ai/system-prompt'
import { buildOrgContext } from '@/lib/ai/buildSystemPrompt'

const openai      = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL       = 'gpt-4.1'
const HISTORY_LIMIT = 15

// Cache per org — 60 s TTL so settings changes take effect within a minute
const promptCache = new Map<string, { ts: number; systemPrompt: string; tools: ChatCompletionTool[] }>()
const CACHE_TTL_MS = 60_000

async function loadOrgContext(organizationId: string) {
  const cached = promptCache.get(organizationId)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached
  const ctx = await buildOrgContext(organizationId)
  promptCache.set(organizationId, { ts: Date.now(), ...ctx })
  return ctx
}

function adminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// ─── History ───────────────────────────────────────────────────────────────

type DbMessage = {
  role:         string
  content:      string | null
  tool_call_id: string | null
  tool_calls:   unknown
}

async function loadHistory(
  sessionId:      string,
  organizationId: string,
): Promise<ChatCompletionMessageParam[]> {
  if (!organizationId) return []
  try {
    const { data } = await adminSupabase()
      .from('chat_messages')
      .select('role, content, tool_call_id, tool_calls')
      .eq('session_id', sessionId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)

    if (!data?.length) return []

    const raw = (data as DbMessage[]).reverse().map(r => {
      if (r.role === 'tool') {
        return { role: 'tool' as const, content: r.content ?? '', tool_call_id: r.tool_call_id ?? '' }
      }
      if (r.role === 'assistant' && r.tool_calls) {
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: r.tool_calls as ChatCompletionAssistantMessageParam['tool_calls'],
        }
      }
      return { role: r.role as 'user' | 'assistant', content: r.content ?? '' }
    })

    // Sanitize: OpenAI requires every tool message to follow an assistant+tool_calls
    // message, and every assistant+tool_calls must be followed by tool messages.
    // Orphaned messages (from failed saves before migration 040) would cause a 400.
    const sanitized: ChatCompletionMessageParam[] = []
    for (let i = 0; i < raw.length; i++) {
      const msg = raw[i]
      if (msg.role === 'tool') {
        const prev = sanitized[sanitized.length - 1]
        // Drop tool message if not preceded by an assistant tool_calls message
        if (!prev || prev.role !== 'assistant' || !(prev as { tool_calls?: unknown }).tool_calls) continue
      }
      if (msg.role === 'assistant' && (msg as { tool_calls?: unknown }).tool_calls) {
        // Drop assistant tool_calls if not followed by at least one tool message
        const next = raw[i + 1]
        if (!next || next.role !== 'tool') continue
      }
      sanitized.push(msg)
    }
    return sanitized
  } catch (err) {
    console.error('[agent] loadHistory failed', err)
    return []
  }
}

async function saveMessage(
  sessionId:      string,
  organizationId: string,
  surface:        AgentContext['surface'],
  role:           'user' | 'assistant' | 'tool',
  content:        string,
  toolCallId?:    string,
) {
  if (!organizationId) return
  try {
    await adminSupabase().from('chat_messages').insert({
      session_id:      sessionId,
      organization_id: organizationId,
      surface,
      role,
      content,
      tool_call_id:    toolCallId ?? null,
    })
  } catch (err) {
    console.error('[agent] saveMessage failed', err)
  }
}

async function saveToolCallMessage(
  sessionId:      string,
  organizationId: string,
  surface:        AgentContext['surface'],
  toolCalls:      NonNullable<ChatCompletionAssistantMessageParam['tool_calls']>,
) {
  if (!organizationId) return
  try {
    await adminSupabase().from('chat_messages').insert({
      session_id:      sessionId,
      organization_id: organizationId,
      surface,
      role:      'assistant',
      content:   null,
      tool_calls: toolCalls,
    })
  } catch (err) {
    console.error('[agent] saveToolCallMessage failed', err)
  }
}


// ─── Build user content (text + optional images) ──────────────────────────

type ImageAttachment = { base64: string; mimeType: string }

function buildUserContent(
  text:    string,
  images?: ImageAttachment[],
): ChatCompletionUserMessageParam['content'] {
  if (!images?.length) return text
  return [
    { type: 'text', text },
    ...images.map(img => ({
      type:      'image_url' as const,
      image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'high' as const },
    })),
  ]
}

// ─── Non-streaming — voice / WhatsApp ─────────────────────────────────────

export async function runAgent(opts: {
  sessionId:      string
  organizationId: string
  userMessage:    string
  agentCtx:       AgentContext
  crmCtx:         CrmContext
  images?:        ImageAttachment[]
}): Promise<string> {
  const { sessionId, organizationId, userMessage, agentCtx, crmCtx, images } = opts

  await saveMessage(sessionId, organizationId, agentCtx.surface, 'user', userMessage)

  const [history, orgCtx] = await Promise.all([
    loadHistory(sessionId, organizationId),
    loadOrgContext(organizationId),
  ])
  const prior = history.slice(0, -1)

  // Non-streaming: keep the manual OpenAI loop for voice/WhatsApp
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: orgCtx.systemPrompt },
    ...prior as ChatCompletionMessageParam[],
    { role: 'user', content: buildUserContent(buildContextHeader(agentCtx) + userMessage, images) },
  ]

  let finalText = ''
  let iterations = 0
  while (iterations < 15) {
    iterations++
    const response = await openai.chat.completions.create({
      model: MODEL, messages, tools: orgCtx.tools, tool_choice: 'auto', temperature: 0, max_tokens: 2048,
    })
    const choice = response.choices[0]
    const msg    = choice.message
    messages.push(msg as ChatCompletionMessageParam)

    if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
      // Persist tool-call message so the next turn has full context
      await saveToolCallMessage(sessionId, organizationId, agentCtx.surface, msg.tool_calls)

      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
        const result = await executeTool(tc.function.name, args, crmCtx)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
        // Persist tool result so the next turn can read contact IDs etc.
        await saveMessage(sessionId, organizationId, agentCtx.surface, 'tool', result, tc.id)
      }
      continue
    }
    finalText = msg.content ?? ''
    break
  }

  await saveMessage(sessionId, organizationId, agentCtx.surface, 'assistant', finalText)
  return finalText
}

// ─── Real token streaming — web chat ──────────────────────────────────────
// Uses OpenAI's native SSE streaming directly.
// Tool calls run non-streaming (blocking); the final text response streams token by token.

export async function runAgentStream(opts: {
  sessionId:      string
  organizationId: string
  userMessage:    string
  agentCtx:       AgentContext
  crmCtx:         CrmContext
  images?:        ImageAttachment[]
}): Promise<Response> {
  const { sessionId, organizationId, userMessage, agentCtx, crmCtx, images } = opts

  await saveMessage(sessionId, organizationId, agentCtx.surface, 'user', userMessage)

  const [history, orgCtx] = await Promise.all([
    loadHistory(sessionId, organizationId),
    loadOrgContext(organizationId),
  ])
  const prior = history.slice(0, -1)

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: orgCtx.systemPrompt },
    ...prior,
    { role: 'user', content: buildUserContent(buildContextHeader(agentCtx) + userMessage, images) },
  ]

  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let fullText  = ''
        let iterations = 0

        try {
          while (iterations < 15) {
            iterations++

            // Single streaming call — handles both tool calls and final text
            const stream = await openai.chat.completions.create({
              model: MODEL, messages, tools: orgCtx.tools, tool_choice: 'auto',
              temperature: 0, max_tokens: 2048, stream: true,
            })

            // Accumulate tool call deltas (streamed in pieces)
            type ToolAcc = { id: string; name: string; args: string }
            const toolAcc: Record<number, ToolAcc> = {}
            let finishReason: string | null = null

            for await (const chunk of stream) {
              const choice = chunk.choices[0]
              if (!choice) continue
              if (choice.finish_reason) finishReason = choice.finish_reason

              const delta = choice.delta

              // Stream text tokens immediately to client
              if (delta.content) {
                fullText += delta.content
                controller.enqueue(encoder.encode(delta.content))
              }

              // Accumulate tool call fragments
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0
                  if (!toolAcc[idx]) toolAcc[idx] = { id: '', name: '', args: '' }
                  if (tc.id)                  toolAcc[idx].id   = tc.id
                  if (tc.function?.name)      toolAcc[idx].name += tc.function.name
                  if (tc.function?.arguments) toolAcc[idx].args += tc.function.arguments
                }
              }
            }

            if (finishReason === 'tool_calls') {
              // Build assistant message with tool calls, then execute each
              const calls = Object.values(toolAcc)
              const toolCallsMsg = calls.map(tc => ({
                id: tc.id, type: 'function' as const,
                function: { name: tc.name, arguments: tc.args },
              }))
              messages.push({ role: 'assistant', content: null, tool_calls: toolCallsMsg })
              // Persist tool-call message so the next turn has full context
              await saveToolCallMessage(sessionId, organizationId, agentCtx.surface, toolCallsMsg)

              for (const tc of calls) {
                let args: Record<string, unknown> = {}
                try { args = JSON.parse(tc.args) } catch { /* ignore */ }
                console.log(`[agent] → ${tc.name}`, args)
                const result = await executeTool(tc.name, args, crmCtx)
                console.log(`[agent] ← ${tc.name}`, result.slice(0, 300))
                messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
                // Persist tool result — critical for multi-turn: stores contact UUIDs etc.
                await saveMessage(sessionId, organizationId, agentCtx.surface, 'tool', result, tc.id)
              }
              continue // next iteration → streaming final text
            }

            break // stop = stop or length reached
          }

          await saveMessage(sessionId, organizationId, agentCtx.surface, 'assistant', fullText)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[agent] runAgentStream error:', msg)
          // Send graceful error to client if we haven't sent any text yet
          if (!fullText) {
            controller.enqueue(encoder.encode('Sorry, er ging iets mis aan mijn kant. Probeer het opnieuw.'))
          }
        }

        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } },
  )
}
