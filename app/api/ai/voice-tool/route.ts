import { NextResponse } from 'next/server'
import { resolveOrgId } from '@/lib/auth/resolveOrg'
import { executeTool } from '@/lib/crm/tools'
import type { CrmContext } from '@/lib/crm/tools'

export const runtime     = 'nodejs'
export const maxDuration = 30

export async function POST(req: Request) {
  try {
    const organizationId = await resolveOrgId()
    if (!organizationId) return NextResponse.json({ result: { error: 'No organization configured' } }, { status: 500 })

    const { name, args } = await req.json() as { name: string; args: Record<string, unknown> }
    if (!name) return NextResponse.json({ result: { error: 'Missing tool name' } }, { status: 400 })

    const userId   = process.env.DEMO_USER_ID   ?? 'demo'
    const userNaam = process.env.DEMO_USER_NAAM ?? 'Demo gebruiker'

    const ctx: CrmContext = { organizationId, userId, userNaam }

    if (name === 'log_bezoek') {
      return NextResponse.json({ result: await handleLogBezoek(args, ctx) })
    }

    const result = await executeTool(name, args, ctx)
    return NextResponse.json({ result })
  } catch (err) {
    console.error('[/api/ai/voice-tool]', err)
    return NextResponse.json({ result: { error: String(err) } }, { status: 500 })
  }
}

async function handleLogBezoek(
  args: Record<string, unknown>,
  ctx: CrmContext,
): Promise<string> {
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
  } catch (err) {
    console.error('[log_bezoek] note_create failed', err)
  }

  if (vervolgActie === 'taak' && vervolgDatum) {
    try {
      await executeTool('task_create', { contactId, title: 'Follow-up na bezoek', body: samenvatting, dueDate: vervolgDatum }, ctx)
      results.push('taak aangemaakt')
    } catch (err) {
      console.error('[log_bezoek] task_create failed', err)
    }
  } else if (vervolgActie === 'afspraak' && vervolgDatum) {
    try {
      const start = new Date(vervolgDatum)
      const end   = new Date(start.getTime() + 60 * 60 * 1000)
      await executeTool('appointment_create', {
        contactId, title: 'Vervolgafspraak na bezoek',
        startTime: start.toISOString(), endTime: end.toISOString(), notes: samenvatting,
      }, ctx)
      results.push('afspraak ingepland')
    } catch (err) {
      console.error('[log_bezoek] appointment_create failed', err)
    }
  }

  if (klantType) {
    const type = klantType.toLowerCase() === 'klant' ? 'customer' : 'lead'
    try {
      await executeTool('contact_update', { contactId, type }, ctx)
      results.push(`contact bijgewerkt naar ${klantType}`)
    } catch (err) {
      console.error('[log_bezoek] contact_update failed', err)
    }
  }

  return JSON.stringify({
    success: true,
    actions: results,
    message: results.length > 0 ? `Bezoek gelogd: ${results.join(', ')}.` : 'Bezoek gelogd.',
  })
}
