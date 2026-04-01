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

    // Build card — returned to agent which pushes it via LiveKit data channel
    const card = buildCard(toolName, args, result, ctx.userNaam)

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
  userNaam?: string,
): MiniCardData | null {
  try {
    const parsed = JSON.parse(result)

    // Contact context injected by agent
    const companyName    = String(args._companyName    ?? '')
    const contactAddress = String(args._contactAddress ?? '')
    const contactId      = String(args.contactId       ?? '')
    const isPersonal     = !contactId   // no contact = personal action

    // For personal cards: show user's name; for CRM: show company
    const entityTitle    = isPersonal ? (userNaam ?? 'Persoonlijk') : (companyName || contactId)
    const entityMeta     = isPersonal ? undefined : (contactAddress || undefined)

    switch (name) {
      case 'contact_search': {
        if (!parsed?.contacts?.length) return null
        const c = parsed.contacts[0]
        const addr = [c.adres, c.stad].filter(Boolean).join(', ') || undefined
        return {
          type: 'contact_found',
          id: c.id ?? '',
          title: c.bedrijf ?? c.naam ?? 'Contact',
          subtitle: c.naam ?? undefined,
          meta: addr,
          contactId: c.id ?? '',
        }
      }
      case 'contact_create': {
        if (!parsed?.success) return null
        return {
          type: 'contact_created',
          id: parsed.id ?? '',
          title: String(args.companyName ?? ''),
          subtitle: String(args.firstName ?? '') || undefined,
          meta: String(args.city ?? '') || undefined,
          contactId: parsed.id ?? '',
        }
      }
      case 'note_create': {
        if (!parsed?.success) return null
        const raw     = String(args.body ?? '')
        const snippet = (raw.charAt(0).toUpperCase() + raw.slice(1)).slice(0, 55) + (raw.length > 55 ? '…' : '')
        return {
          type: 'note',
          id: parsed.id ?? '',
          title: entityTitle,
          subtitle: snippet,
          meta: entityMeta,
          contactId,
        }
      }
      case 'task_create': {
        if (!parsed?.success) return null
        const due = args.dueDate
          ? new Date(String(args.dueDate)).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : undefined
        return {
          type: 'task',
          id: parsed.id ?? '',
          title: entityTitle,
          subtitle: String(args.title ?? ''),
          meta: entityMeta ?? due,
          contactId,
        }
      }
      case 'appointment_create': {
        if (!parsed?.success) return null
        const when = args.startTime
          ? new Date(String(args.startTime)).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : undefined
        return {
          type: 'appointment',
          id: parsed.id ?? '',
          title: entityTitle,
          subtitle: String(args.title ?? ''),
          meta: entityMeta ?? when,
          contactId,
        }
      }
      case 'log_bezoek': {
        if (!parsed?.success) return null
        const details: { label: string; value: string }[] = []
        if (args.samenvatting)         details.push({ label: 'Uitkomst',         value: String(args.samenvatting).slice(0, 80) })
        if (args.klantType)            details.push({ label: 'Type',             value: String(args.klantType) })
        if (args.groothandel)          details.push({ label: 'Groothandel',      value: String(args.groothandel) })
        if (args.producten)            details.push({ label: 'Producten',        value: String(args.producten) })
        if (args.vervolgActie && args.vervolgActie !== 'geen') {
          const vervolg = args.vervolgDatum
            ? `${args.vervolgActie} — ${new Date(String(args.vervolgDatum)).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}`
            : String(args.vervolgActie)
          details.push({ label: 'Vervolg',           value: vervolg })
        }
        if (args.pos_materiaal     != null) details.push({ label: 'POS materiaal',      value: args.pos_materiaal      ? 'Ja' : 'Nee' })
        if (args.korting_afspraken != null) details.push({ label: 'Kortingafspraken',   value: args.korting_afspraken  ? 'Ja' : 'Nee' })
        return {
          type: 'bezoek',
          id: parsed.id ?? `bezoek-${Date.now()}`,
          title: String(args.companyName ?? (companyName || contactId)),
          meta: contactAddress || undefined,
          contactId,
          details,
        }
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
