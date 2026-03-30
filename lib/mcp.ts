/**
 * Server-side MCP client — roept Supabase native-mcp Edge Function aan.
 * Gebruik alleen in API routes (niet client-side).
 * Client-side voice tools gaan via /api/suus/tool-call (CORS proxy).
 */

export const MCP_URL =
  `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://fzbkauyubvaonnztzfyb.supabase.co'}/functions/v1/native-mcp`

export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export async function callMcpServer(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const res = await fetch(MCP_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ name, args }),
    })
    const text = await res.text()
    try { return JSON.stringify(JSON.parse(text)) } catch { return text }
  } catch (e) {
    return `Tool fout: ${e instanceof Error ? e.message : String(e)}`
  }
}
