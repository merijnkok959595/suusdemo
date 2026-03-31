import { NextResponse } from 'next/server'
import { resolveOrgId, adminDb } from '@/lib/auth/resolveOrg'

export const runtime     = 'nodejs'
export const maxDuration = 15

export async function POST() {
  try {
    const organizationId = await resolveOrgId()
    if (!organizationId) return NextResponse.json({ error: 'No organization configured' }, { status: 500 })

    // Pull per-org AI config for agent name + voice
    const { data: ic } = await adminDb()
      .from('intelligence_config')
      .select('assistant_config')
      .eq('organization_id', organizationId)
      .single()

    const assistantConfig = (ic?.assistant_config as Record<string, unknown> | null | undefined)
    const agentName = (assistantConfig?.name as string | undefined) ?? 'SUUS'
    const voice     = (assistantConfig?.voice as string | undefined) ?? 'coral'

    const { data: org } = await adminDb()
      .from('organizations')
      .select('naam')
      .eq('id', organizationId)
      .single()
    const orgNaam = org?.naam ?? undefined

    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type:  'realtime',
          model: 'gpt-4o-realtime-preview',
          audio: { output: { voice } },
        },
      }),
    })

    const data = await res.json() as {
      value?:         string
      client_secret?: { value: string }
      error?:         unknown
    }

    const ephemeralKey = data.value ?? data.client_secret?.value
    if (!ephemeralKey) {
      console.error('[/api/ai/call] Realtime session creation failed:', data)
      return NextResponse.json({ error: 'Failed to create Realtime session' }, { status: 500 })
    }

    return NextResponse.json({
      client_secret: { value: ephemeralKey },
      orgContext: { agentName, voice, orgNaam },
    })
  } catch (err) {
    console.error('[/api/ai/call]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
