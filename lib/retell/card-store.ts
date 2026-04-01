import type { MiniCardData } from '@/components/ui/MiniCard'

// In-memory store keyed by Retell call_id.
// Fine for demo — for production use Supabase Realtime instead.
const store = new Map<string, MiniCardData[]>()

export function addCard(callId: string, card: MiniCardData): void {
  const existing = store.get(callId) ?? []
  store.set(callId, [...existing, card])
}

export function popCards(callId: string): MiniCardData[] {
  const cards = store.get(callId) ?? []
  store.delete(callId)
  return cards
}

export function hasCards(callId: string): boolean {
  return (store.get(callId)?.length ?? 0) > 0
}
