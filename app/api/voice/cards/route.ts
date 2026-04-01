/**
 * Mini card polling endpoint for LiveKit voice calls.
 * GET  ?roomName=xxx   — frontend polls for new cards
 * The Python agent pushes cards indirectly via /api/voice/tool.
 */
import { NextResponse } from 'next/server'
import { popCards } from '@/lib/retell/card-store'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const roomName = searchParams.get('roomName') ?? ''
  if (!roomName) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: popCards(roomName) })
}
