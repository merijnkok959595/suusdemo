import { NextResponse } from 'next/server'

export const runtime     = 'nodejs'
export const maxDuration = 30

const NATIVE_MCP_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/native-mcp`
  : 'https://fzbkauyubvaonnztzfyb.supabase.co/functions/v1/native-mcp'

export async function POST(req: Request) {
  try {
    const { name, args } = await req.json() as { name: string; args: Record<string, unknown> }

    const res = await fetch(NATIVE_MCP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, args }),
    })

    const text = await res.text()
    let result: unknown
    try { result = JSON.parse(text) } catch { result = text }

    return NextResponse.json({ result })
  } catch (err) {
    console.error('[tool-call]', err)
    return NextResponse.json({ result: { error: String(err) } }, { status: 500 })
  }
}
