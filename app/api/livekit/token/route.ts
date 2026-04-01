import { NextResponse } from 'next/server'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { resolveOrgId, adminDb } from '@/lib/auth/resolveOrg'

export const runtime     = 'nodejs'
export const maxDuration = 10

const LIVEKIT_URL        = process.env.LIVEKIT_URL!
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY!
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!

export async function POST() {
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

    return NextResponse.json({
      token,
      roomName,
      url: LIVEKIT_URL,
    })
  } catch (err) {
    console.error('[/api/livekit/token]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
