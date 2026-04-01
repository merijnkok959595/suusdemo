import { NextResponse } from 'next/server'
import { popCards } from '@/lib/retell/card-store'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const callId = searchParams.get('callId') ?? ''
  if (!callId) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: popCards(callId) })
}
