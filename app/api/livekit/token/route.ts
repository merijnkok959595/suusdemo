import { NextResponse } from 'next/server'
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
import { resolveOrgId, adminDb } from '@/lib/auth/resolveOrg'

export const runtime     = 'nodejs'
export const maxDuration = 10

export async function POST() {
  const LIVEKIT_URL        = process.env.LIVEKIT_URL!
  const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY!
  const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!

  console.log('[token] START — url:', LIVEKIT_URL, '| key:', LIVEKIT_API_KEY?.slice(0, 6))

  try {
    const organizationId = await resolveOrgId()
    console.log('[token] orgId:', organizationId)
    if (!organizationId) {
      return NextResponse.json({ error: 'No organization configured' }, { status: 500 })
    }

    const roomName = `suus-${organizationId.slice(0, 8)}-${Date.now()}`
    const identity = `user-${Date.now()}`
    console.log('[token] room:', roomName)

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '2h' })
    at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true })
    const token = await at.toJwt()
    console.log('[token] JWT minted OK')

    const httpUrl = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://')

    const svc = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    await svc.createRoom({ name: roomName, metadata: organizationId })
    console.log('[token] room created OK')

    const dispatch = new AgentDispatchClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    try {
      const d = await dispatch.createDispatch(roomName, 'suus')
      console.log('[token] dispatch OK — id:', d.id)
    } catch (dispatchErr) {
      console.error('[token] dispatch FAILED:', dispatchErr)
      // Don't block the call — agent may still join via auto-dispatch
    }

    return NextResponse.json({
      server_url:        LIVEKIT_URL,
      participant_token: token,
      token,
      roomName,
      url: LIVEKIT_URL,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[token] FATAL:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
