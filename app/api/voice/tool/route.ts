/**
 * Generic voice tool endpoint — called by the Python LiveKit agent.
 * Executes a CRM tool and pushes a mini card to the room's card store.
 *
 * Body: { name, arguments, roomName, call: { metadata: { organization_id } } }
 */
import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/auth/resolveOrg'
import { executeTool } from '@/lib/crm/tools'
import type { CrmContext } from '@/lib/crm/tools'
import { addCard } from '@/lib/retell/card-store'
import type { MiniCardData } from '@/components/ui/MiniCard'

export const runtime     = 'nodejs'
export const maxDuration = 30

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      name?:      string
      arguments?: Record<string, unknown> | string
      roomName?:  string
      call?:      { metadata?: { organization_id?: string } }
    }

    const toolName       = body.name ?? ''
    const roomName       = body.roomName ?? ''
    const organizationId = body.call?.metadata?.organization_id ?? ''

    if (!toolName) {
      return NextResponse.json({ result: 'Missing tool name' }, { status: 400 })
    }

    // Parse args — may arrive as JSON string or object
    let args: Record<string, unknown> = {}
    const rawArgs = body.arguments
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs) } catch { /* use empty */ }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs
    }

    // Resolve org
    let orgId = organizationId
    if (!orgId) {
      const { data } = await adminDb().from('organizations').select('id').limit(1).single()
      orgId = data?.id ?? ''
    }

    const ctx: CrmContext = {
      organizationId: orgId,
      userId:         process.env.DEMO_USER_ID   ?? 'demo',
      userNaam:       process.env.DEMO_USER_NAAM ?? 'Demo gebruiker',
    }

    const result = toolName === 'log_bezoek'
      ? await handleLogBezoek(args, ctx)
      : await executeTool(toolName, args, ctx)

    // Build card — returned to agent for data-channel push AND kept in poll store as fallback
    const card = buildCard(toolName, args, result)
    const key  = roomName || orgId
    if (card && key) addCard(key, card)

    return NextResponse.json({ result, card: card ?? null })
  } catch (err) {
    console.error('[/api/voice/tool]', err)
    return NextResponse.json({ result: `Fout: ${String(err)}` }, { status: 500 })
  }
}

// ─── Card builder ─────────────────────────────────────────────────────────────

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

// ─── log_bezoek composite ─────────────────────────────────────────────────────

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
  const noteBody = [`Bezoek: ${samenvatting}`, producten ? `Producten: ${producten}` : null].filter(Boolean).join('\n')

  try { await executeTool('note_create', { contactId, body: noteBody }, ctx); results.push('notitie opgeslagen') } catch { /* ignore */ }

  if (vervolgActie === 'taak' && vervolgDatum) {
    try { await executeTool('task_create', { contactId, title: 'Follow-up na bezoek', body: samenvatting, dueDate: vervolgDatum }, ctx); results.push('taak aangemaakt') } catch { /* ignore */ }
  } else if (vervolgActie === 'afspraak' && vervolgDatum) {
    try {
      const start = new Date(vervolgDatum)
      const end   = new Date(start.getTime() + 60 * 60 * 1000)
      await executeTool('appointment_create', { contactId, title: 'Vervolgafspraak na bezoek', startTime: start.toISOString(), endTime: end.toISOString(), notes: samenvatting }, ctx)
      results.push('afspraak ingepland')
    } catch { /* ignore */ }
  }

  if (klantType) {
    try { await executeTool('contact_update', { contactId, type: klantType.toLowerCase() === 'klant' ? 'customer' : 'lead' }, ctx); results.push(`contact bijgewerkt naar ${klantType}`) } catch { /* ignore */ }
  }

  return JSON.stringify({ success: true, id: `bezoek-${Date.now()}`, actions: results, message: results.length > 0 ? `Bezoek gelogd: ${results.join(', ')}.` : 'Bezoek gelogd.' })
}
