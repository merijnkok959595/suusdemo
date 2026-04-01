import { NextResponse } from 'next/server'
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
import { resolveOrgId, adminDb } from '@/lib/auth/resolveOrg'

export const runtime     = 'nodejs'
export const maxDuration = 10

export async function POST() {
  // Read inside handler so hot-reload / env changes always pick up the latest values
  const LIVEKIT_URL        = process.env.LIVEKIT_URL!
  const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY!
  const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!

  try {
    const organizationId = await resolveOrgId()
    if (!organizationId) {
      return NextResponse.json({ error: 'No organization configured' }, { status: 500 })
    }

    // Room name is unique per call — org + timestamp
    const roomName = `suus-${organizationId.slice(0, 8)}-${Date.now()}`
    const identity = `user-${Date.now()}`

    // Mint participant token
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl:  '2h',
    })
    at.addGrant({
      room:         roomName,
      roomJoin:     true,
      canPublish:   true,
      canSubscribe: true,
    })
    const token = await at.toJwt()

    // Pass orgId to the agent via room metadata (agent reads ctx.room.metadata)
    const svc = new RoomServiceClient(
      LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://'),
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
    )
    await svc.createRoom({
      name:     roomName,
      metadata: organizationId,
    })

    // Explicitly dispatch the agent — required when agent runs on Railway
    // (no LiveKit Cloud auto-dispatch). The duplicate-agent guard in agent.py
    // handles the case where auto-dispatch is also active.
    const dispatch = new AgentDispatchClient(
      LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://'),
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
    )
    await dispatch.createDispatch(roomName, 'agent')

    return NextResponse.json({
      // New shape expected by @livekit/components-react LiveKitRoom
      server_url:        LIVEKIT_URL,
      participant_token: token,
      // Keep legacy fields for backward compat
      token,
      roomName,
      url: LIVEKIT_URL,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/livekit/token]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
