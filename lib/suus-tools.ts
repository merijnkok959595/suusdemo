/**
 * Gedeelde tool-definities voor Suus.
 * - CHAT_TOOLS  → gebruikt door /api/suus/route.ts (gpt-4.1 text chat)
 * - normalizers → gebruikt door zowel voice (page.tsx) als text (route.ts)
 *
 * Voice tools (RealtimeAgent tool() wrappers) staan in app/suus/page.tsx
 * omdat ze Zod schemas + client-side execute functies bevatten.
 */

import type { ChatCompletionTool } from 'openai/resources'

// ── Normalizers ────────────────────────────────────────────────────────────────

/** Zet gesproken email-dictatie om naar geldig email-adres. */
export function normalizeEmail(raw?: string): string | undefined {
  if (!raw) return undefined
  return raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/apenstaartje|apostaatje|apestaartje|at\b/g, '@')
    .replace(/\bpunt\b/g, '.')
    .replace(/\bstreepje\b/g, '-')
    .replace(/\bunderscore\b|laag\s*streepje/g, '_')
    .replace(/[^a-z0-9@._\-+]/g, '')
}

/** Verwijdert spaties/streepjes uit gesproken telefoonnummers. */
export function normalizePhone(raw?: string): string | undefined {
  if (!raw) return undefined
  const digits = raw.replace(/[^\d+]/g, '')
  return digits || undefined
}

// ── Helper ─────────────────────────────────────────────────────────────────────

/** Gestandaardiseerde JSON-schema parameter helper. */
function param(description: string, required: string[], properties: Record<string, { type: string; description?: string; enum?: string[] }>) {
  return { type: 'object', description, properties, required } as const
}

// ── Chat tool definitions (OpenAI ChatCompletion format) ──────────────────────

export const CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name:        'google_zoek_adres',
      description: 'Zoek bedrijfsadres via Google Places. Verplicht — nooit raden. Geef ALLEEN bedrijfsnaam + plaatsnaam, geen voorzetsels.',
      parameters:  param('Google Places zoekopdracht', ['bedrijfsnaam'], {
        bedrijfsnaam: { type: 'string', description: 'Alleen de bedrijfsnaam, geen "in", "uit", "te"' },
        plaatsnaam:   { type: 'string', description: 'Alleen de plaatsnaam' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'contact_zoek',
      description: 'Zoek een contact in het CRM op bedrijfsnaam en optioneel plaatsnaam.',
      parameters:  param('CRM contact zoekopdracht', ['bedrijfsnaam'], {
        bedrijfsnaam: { type: 'string' },
        plaatsnaam:   { type: 'string' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'contact_briefing',
      description: 'Volledige CRM briefing: notities, taken, afspraken, classificatie.',
      parameters:  param('Briefing ophalen', ['contactId'], {
        contactId: { type: 'string' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'contact_create',
      description: 'Maak een nieuw contact aan in het CRM.',
      parameters:  param('Nieuw contact', ['company_name'], {
        company_name: { type: 'string' },
        city:         { type: 'string' },
        first_name:   { type: 'string' },
        email:        { type: 'string' },
        phone:        { type: 'string' },
        type:         { type: 'string', enum: ['lead', 'customer'] },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'contact_update',
      description: 'Wijzig velden van een bestaand contact.',
      parameters:  param('Contact update', ['contactId'], {
        contactId:    { type: 'string' },
        company_name: { type: 'string' },
        type:         { type: 'string', enum: ['lead', 'customer'] },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'note_create',
      description: 'Notitie toevoegen aan een contact.',
      parameters:  param('Notitie', ['contactId', 'body'], {
        contactId: { type: 'string' },
        body:      { type: 'string' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'task_create',
      description: 'Taak aanmaken voor een contact.',
      parameters:  param('Taak', ['contactId', 'title'], {
        contactId: { type: 'string' },
        title:     { type: 'string' },
        dueDate:   { type: 'string', description: 'ISO 8601 datum' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'calendar_create',
      description: 'Afspraak aanmaken voor een contact.',
      parameters:  param('Afspraak', ['contactId', 'title', 'startTime'], {
        contactId: { type: 'string' },
        title:     { type: 'string' },
        startTime: { type: 'string', description: 'ISO 8601' },
        endTime:   { type: 'string', description: 'ISO 8601' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'log_bezoek',
      description: 'Log een salesbezoek: notitie + vervolg-taak/afspraak + contact update.',
      parameters:  param('Bezoek log', ['contactId'], {
        contactId:     { type: 'string' },
        samenvatting:  { type: 'string' },
        vervolgActie:  { type: 'string', enum: ['taak', 'afspraak', 'geen'] },
        vervolgDatum:  { type: 'string' },
        klantType:     { type: 'string', enum: ['Lead', 'Klant'] },
        producten:     { type: 'string' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name:        'get_team_members',
      description: 'Actieve teamleden ophalen.',
      parameters:  { type: 'object', properties: {} },
    },
  },
]
