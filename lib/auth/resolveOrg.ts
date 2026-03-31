/**
 * Demo resolveOrg — no auth, always returns DEMO_ORG_ID from env.
 * This is a simplified version for the SUUS Demo (no Stripe/auth required).
 */

import { createAdminClient } from '@/utils/supabase/admin'

export const adminDb = createAdminClient

export async function resolveOrgId(): Promise<string | null> {
  const envOrgId = process.env.DEMO_ORG_ID
  if (envOrgId) return envOrgId

  // Fallback: return the first org in the database
  try {
    const { data } = await adminDb()
      .from('organizations')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .single()
    return data?.id ?? null
  } catch {
    return null
  }
}
