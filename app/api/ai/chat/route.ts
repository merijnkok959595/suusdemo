import { runAgentStream } from '@/lib/ai/agent'
import type { AgentContext } from '@/lib/ai/system-prompt'
import type { CrmContext } from '@/lib/crm/tools'
import { resolveOrgId } from '@/lib/auth/resolveOrg'
import { ChatRequestSchema } from '@/lib/schemas'
import { createLogger } from '@/lib/logger'
import { z } from 'zod'

const ImageAttachmentSchema = z.object({ base64: z.string(), mimeType: z.string() })
type ImageAttachment = z.infer<typeof ImageAttachmentSchema>

export async function POST(req: Request) {
  const log = createLogger({ event: 'ai-chat' })

  try {
    const raw    = await req.json()
    const parsed = ChatRequestSchema.safeParse(raw)
    if (!parsed.success) return new Response('Invalid request body', { status: 400 })

    const { message, session_id } = parsed.data
    const images: ImageAttachment[] | undefined = parsed.data.images
      ? (parsed.data.images as unknown[])
          .map(i => ImageAttachmentSchema.safeParse(i))
          .filter(r => r.success)
          .map(r => (r as { success: true; data: ImageAttachment }).data)
      : undefined
    if (!message?.trim() && !images?.length) return new Response('Missing message', { status: 400 })
    const safeMessage = message?.trim() || '(zie bijgevoegde afbeelding)'

    const organizationId = await resolveOrgId()
    if (!organizationId) return new Response('No organization configured', { status: 500 })

    const naam    = process.env.DEMO_USER_NAAM ?? 'Demo gebruiker'
    const userId  = process.env.DEMO_USER_ID  ?? 'demo'
    const functie = process.env.DEMO_USER_FUNCTIE ?? undefined

    log.info('Chat request', { orgId: organizationId, session_id })

    const agentCtx: AgentContext = { naam, functie, surface: 'web' }
    const crmCtx: CrmContext     = { organizationId, userId, userNaam: naam }

    return await runAgentStream({
      sessionId:      session_id ?? userId,
      organizationId,
      userMessage:    safeMessage,
      agentCtx,
      crmCtx,
      images,
    })
  } catch (err) {
    log.error('Unhandled error in ai/chat', { error: err instanceof Error ? err.message : String(err) })
    return new Response('Internal error', { status: 500 })
  }
}
