import { NextResponse } from 'next/server'
import { resolveOrgId, adminDb } from '@/lib/auth/resolveOrg'

export const runtime     = 'nodejs'
export const maxDuration = 15

const RETELL_API_KEY = process.env.RETELL_API_KEY!
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID ?? 'agent_1e263f2f4c45f24b932b4baf65'

export async function POST() {
  try {
    const organizationId = await resolveOrgId()
    if (!organizationId) return NextResponse.json({ error: 'No organization configured' }, { status: 500 })

    const { data: ic } = await adminDb()
      .from('intelligence_config')
      .select('assistant_config')
      .eq('organization_id', organizationId)
      .single()

    const assistantConfig = (ic?.assistant_config as Record<string, unknown> | null | undefined)
    const agentName = (assistantConfig?.name as string | undefined) ?? 'SUUS'

    const { data: org } = await adminDb()
      .from('organizations')
      .select('naam')
      .eq('id', organizationId)
      .single()
    const orgNaam = org?.naam ?? undefined

    const today = new Date().toLocaleDateString('nl-NL', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Europe/Amsterdam',
    })

    const res = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: RETELL_AGENT_ID,
        metadata: {
          organization_id: organizationId,
          user_naam: process.env.DEMO_USER_NAAM ?? 'Demo gebruiker',
        },
        retell_llm_dynamic_variables: {
          agent_name:       agentName,
          org_naam_display: orgNaam ? ` van ${orgNaam}` : '',
          today,
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[/api/retell/call] Retell error:', err)
      return NextResponse.json({ error: `Retell API error: ${err}` }, { status: 500 })
    }

    const data = await res.json() as { access_token: string; call_id: string }

    return NextResponse.json({
      access_token: data.access_token,
      call_id:      data.call_id,
      orgContext:   { agentName, orgNaam },
    })
  } catch (err) {
    console.error('[/api/retell/call]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
