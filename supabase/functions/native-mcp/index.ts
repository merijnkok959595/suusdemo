/**
 * native-mcp  –  MCP server with all Suzy tools for Retell AI (multi-tenant).
 *
 * MCP JSON-RPC 2.0 over HTTP (streamable transport).
 * Retell registers this as an MCP server and auto-discovers all tools.
 *
 * Multi-tenant routing:
 *   org_id is read from (in order of priority):
 *     1. params.call.dynamic_variables.org_id  (set by /api/ai/call per web call)
 *     2. X-Org-Id request header               (for direct testing)
 *     3. DEFAULT_ORG_ID env var                (single-tenant / dev fallback)
 *
 * Tools:
 *   contact_zoek          – LLM parse → Google Places → Supabase fuzzy search
 *   google_zoek_adres     – Google Places address lookup
 *   contact_briefing      – full contact + notes + tasks
 *   contact_create        – create contact in Supabase
 *   contact_update        – update contact fields
 *   note_create           – add note to contact
 *   task_create           – create task for contact
 *   calendar_get_free_slot – first free agenda slot
 *   calendar_create       – create appointment
 *   get_team_members      – list active team members
 *   log_bezoek            – composite: note + follow-up + contact update
 *
 * Deploy: supabase functions deploy native-mcp --no-verify-jwt
 */

import OpenAI from 'https://deno.land/x/openai@v4.52.0/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY')! })
const G_KEY  = () => Deno.env.get('GOOGLE_MAPS_API_KEY') ?? Deno.env.get('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY') ?? ''

function sb() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

function withTimeout<T>(p: Promise<T>, ms: number, label = ''): Promise<T> {
  return Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error(`Timeout ${ms}ms ${label}`)), ms))])
}

// ── org_id extractor ──────────────────────────────────────────────────────────
function extractOrgId(req: Request, body: Record<string, unknown>): string {
  // 1. From Retell dynamic_variables in tool call params
  try {
    const params = body.params as Record<string, unknown> | undefined
    const callInfo = params?.call as Record<string, unknown> | undefined
    const dynVars = callInfo?.dynamic_variables as Record<string, unknown> | undefined
    if (dynVars?.org_id) return String(dynVars.org_id)
  } catch { /* continue */ }

  // 2. From top-level dynamic_variables (Retell webhook-style)
  try {
    const dynVars = body.dynamic_variables as Record<string, unknown> | undefined
    if (dynVars?.org_id) return String(dynVars.org_id)
  } catch { /* continue */ }

  // 3. Header (for testing)
  const header = req.headers.get('x-org-id')
  if (header) return header

  // 4. Env fallback (dev / single-tenant only — never use in multi-tenant production)
  const fallback = Deno.env.get('DEFAULT_ORG_ID') ?? ''
  if (fallback) console.warn('[native-mcp] WARNING: using DEFAULT_ORG_ID fallback — org_id missing from call context')
  return fallback
}

// ── Dutch number normaliser ───────────────────────────────────────────────────
const NL: [RegExp, string][] = [
  [/\bnul\b/gi,'0'],[/\één\b|\béén\b|\been\b/gi,'1'],[/\btwee\b/gi,'2'],[/\bdrie\b/gi,'3'],[/\bvier\b/gi,'4'],
  [/\bvijf\b/gi,'5'],[/\bzes\b/gi,'6'],[/\bzeven\b/gi,'7'],[/\bacht\b/gi,'8'],[/\bnegen\b/gi,'9'],
  [/\btien\b/gi,'10'],[/\belf\b/gi,'11'],[/\btwaalf\b/gi,'12'],[/\bdertien\b/gi,'13'],[/\bveertien\b/gi,'14'],
  [/\bvijftien\b/gi,'15'],[/\bzestien\b/gi,'16'],[/\bzeventien\b/gi,'17'],[/\bachttien\b/gi,'18'],[/\bnegentien\b/gi,'19'],
  [/\btwintig\b/gi,'20'],[/\bdertig\b/gi,'30'],[/\bveertig\b/gi,'40'],[/\bvijftig\b/gi,'50'],
  [/\bzestig\b/gi,'60'],[/\bzeventig\b/gi,'70'],[/\btachtig\b/gi,'80'],[/\bnegentig\b/gi,'90'],[/\bhonderd\b/gi,'100'],
]
function normalise(q: string): string {
  let s = q
  for (const [re, d] of NL) s = s.replace(re, d)
  s = s.replace(/\b(\d+)\s+(\d+)\b/g, '$1$2')
  s = s.replace(/\s+(van\s+de[rnm]?|van\s+het|van\s+'t|van|de[rnm]?|het|'t)\s+/gi, ' ')
  return s.trim()
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════════════════════

async function tool_contact_zoek(args: Record<string, unknown>, orgId: string): Promise<string> {
  if (!orgId) return JSON.stringify({ found: false, reden: 'Geen org_id beschikbaar.' })

  const rawBedrijf = normalise(String(args.bedrijfsnaam ?? args.query ?? '').trim())
  const rawStad    = String(args.plaatsnaam ?? args.city ?? '').trim()
  if (!rawBedrijf) return JSON.stringify({ found: false, reden: 'Geen bedrijfsnaam opgegeven.' })

  // ── Step 1: LLM parse — normalise name + extract city ──────────────────────
  let bedrijf = rawBedrijf
  let stad    = rawStad
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4.1-nano', temperature: 0, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Normaliseer een Nederlandse bedrijfsnaam voor CRM-zoeken. Zet gesproken getallen om naar cijfers. Strip beleefdheden en STT-artefacten. Antwoord: {"bedrijf":"gecorrigeerde naam","stad":"plaatsnaam of null"}' },
        { role: 'user',   content: `Bedrijfsnaam: "${rawBedrijf}"${rawStad ? `\nPlaatsnaam: "${rawStad}"` : ''}` },
      ],
    })
    const p = JSON.parse(r.choices[0].message.content ?? '{}')
    bedrijf = p.bedrijf?.trim() || rawBedrijf
    stad    = p.stad?.trim()    || rawStad
  } catch { /* fallback to raw */ }

  // ── Step 2: Google Places — STT correction + reference address ─────────────
  let googleNaam  = bedrijf
  let googleAdres = ''
  let googleStad  = stad
  try {
    const q = stad ? `${bedrijf} ${stad}` : bedrijf
    const gRes = await withTimeout(
      fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': G_KEY(), 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.addressComponents' },
        body: JSON.stringify({ textQuery: q, languageCode: 'nl', regionCode: 'NL', maxResultCount: 3 }),
      }).then(r => r.json()) as Promise<{ places?: Array<Record<string, unknown>> }>,
      4500, 'google',
    )
    const places = (gRes.places ?? []).slice(0, 3)
    if (places.length) {
      type AC = { longText?: string; types?: string[] }
      const candidates = places.map((p, i) => `${i}: ${(p.displayName as { text?: string } | undefined)?.text ?? ''} — ${p.formattedAddress ?? ''}`).join('\n')
      const m = await openai.chat.completions.create({
        model: 'gpt-4.1-nano', temperature: 0, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'STT-correctie: kies de beste Google-match. JSON: {"match":true,"index":0,"name":"officiële naam"} of {"match":false}.' },
          { role: 'user',   content: `Gezocht: "${bedrijf}"${stad ? ` in ${stad}` : ''}\nGoogle:\n${candidates}` },
        ],
      })
      const v = JSON.parse(m.choices[0].message.content ?? '{}')
      if (v.match) {
        const idx = Number(v.index ?? 0)
        const pl  = places[idx] ?? places[0]
        const comps = (pl.addressComponents ?? []) as AC[]
        const get   = (t: string) => comps.find(c => c.types?.includes(t))?.longText ?? ''
        googleNaam  = String(v.name ?? (pl.displayName as { text?: string } | undefined)?.text ?? bedrijf).trim()
        googleAdres = `${get('route')} ${get('street_number')}`.trim()
        googleStad  = get('locality') || get('administrative_area_level_2') || stad
      }
    }
  } catch { /* continue with parsed name */ }

  // ── Step 3: Supabase full-text search ─────────────────────────────────────
  const searches = [googleNaam, googleNaam !== bedrijf ? bedrijf : null].filter(Boolean) as string[]
  const results: Array<Record<string, unknown>> = []
  for (const q of searches) {
    const { data } = await sb()
      .from('contacts')
      .select('id, company_name, first_name, last_name, address, city, postcode, phone, email, type')
      .eq('organization_id', orgId)
      .or(`company_name.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
      .limit(10)
    for (const c of data ?? []) {
      if (!results.find(r => r.id === c.id)) results.push(c as Record<string, unknown>)
    }
  }

  // City pre-filter
  let candidates = results
  if (googleStad && candidates.length > 1) {
    const sl       = googleStad.toLowerCase()
    const filtered = candidates.filter(c => { const cl = String(c.city ?? '').toLowerCase(); return cl.includes(sl) || sl.includes(cl.slice(0, 4)) })
    if (filtered.length > 0) candidates = filtered
  }

  if (candidates.length === 0) return JSON.stringify({ found: false, bedrijf_gezocht: googleNaam, stad_gezocht: googleStad || null })

  // ── Step 4: LLM final pick ─────────────────────────────────────────────────
  let best = candidates[0]
  if (candidates.length > 1) {
    try {
      const rows = candidates.slice(0, 8).map((c, i) => {
        const cn = [c.first_name, c.last_name].filter(Boolean).join(' ')
        return `${i}: ${c.company_name ?? cn} | stad: ${c.city ?? '—'} | adres: ${c.address ?? '—'}`
      }).join('\n')
      const pick = await openai.chat.completions.create({
        model: 'gpt-4.1-nano', temperature: 0, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Kies het BESTE overeenkomende contact (fuzzy naam + stad + adres). {"match":true,"index":0} of {"match":false}.' },
          { role: 'user',   content: `Gezocht: "${googleNaam}"${googleStad ? ` in ${googleStad}` : ''}${googleAdres ? `\nGoogle adres: ${googleAdres}` : ''}\n\nKandidaten:\n${rows}` },
        ],
      })
      const pv = JSON.parse(pick.choices[0].message.content ?? '{}')
      if (!pv.match) return JSON.stringify({ found: false, bedrijf_gezocht: googleNaam, stad_gezocht: googleStad || null })
      best = candidates[Number(pv.index ?? 0)] ?? candidates[0]
    } catch { /* fallback to first */ }
  }

  const cn   = [best.first_name, best.last_name].filter(Boolean).join(' ')
  const adres = [best.address, best.postcode, best.city].filter(Boolean).join(', ') || googleAdres || null
  return JSON.stringify({
    found: true,
    contact: {
      contact_id: String(best.id ?? ''),
      bedrijf:    String(best.company_name ?? cn ?? googleNaam),
      naam:       cn || null,
      adres,
      stad:       String(best.city ?? googleStad ?? ''),
      telefoon:   best.phone ?? null,
      email:      best.email ?? null,
    },
    bron: googleNaam !== rawBedrijf ? `CRM (gecorrigeerd: "${rawBedrijf}" → "${googleNaam}")` : 'CRM',
  })
}

function normalizeQuery(s: string): string {
  return s
    .trim()
    .replace(/\b(uit|in|te|van|de|het|een)\s+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function tool_google_zoek_adres(args: Record<string, unknown>): Promise<string> {
  const naam   = normalizeQuery(String(args.bedrijfsnaam ?? ''))
  const plaats = normalizeQuery(String(args.plaatsnaam   ?? ''))
  const q      = plaats ? `${naam} ${plaats}` : naam
  const gRes   = await withTimeout(
    fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': G_KEY(), 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.addressComponents,places.internationalPhoneNumber,places.websiteUri' },
      body: JSON.stringify({ textQuery: q, languageCode: 'nl', regionCode: 'NL', maxResultCount: 5 }),
    }).then(r => r.json()) as Promise<{ places?: Array<Record<string, unknown>> }>,
    8000, 'google-adres',
  )
  const places = (gRes.places ?? []).slice(0, 5)
  if (!places.length) return `[BRON: niet gevonden] Geen adres voor "${q}". Maak contact aan zonder adres.`
  const list = places.map((p, i) => `${i}: ${(p.displayName as { text?: string } | undefined)?.text ?? ''} — ${p.formattedAddress ?? ''}`).join('\n')
  const m = await openai.chat.completions.create({
    model: 'gpt-4.1-nano', temperature: 0, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: 'Kies beste Google Places resultaat. Input komt van spraak-naar-tekst — accepteer fonetisch vergelijkbare namen als match (bijv. "risotini" ≈ "risottini"). JSON: {"match":true,"index":n} of {"match":false}.' }, { role: 'user', content: `Zoekopdracht: "${q}"\n${list}` }],
  })
  let v: Record<string, unknown> = { match: false }
  try { v = JSON.parse(m.choices[0].message.content ?? '{}') } catch { /* ignore */ }
  if (!v.match) return `[BRON: niet gevonden] Geen betrouwbaar adres voor "${q}".`
  const p     = places[Number(v.index ?? 0)] ?? places[0]
  type AC     = { longText?: string; types?: string[] }
  const comps = (p.addressComponents ?? []) as AC[]
  const get   = (t: string) => comps.find(c => c.types?.includes(t))?.longText ?? ''
  const name2 = (p.displayName as { text?: string } | undefined)?.text ?? naam
  const street = `${get('route')} ${get('street_number')}`.trim()
  const city2  = get('locality') || get('administrative_area_level_2') || plaats
  const postal = get('postal_code')
  const tel    = String(p.internationalPhoneNumber ?? '')
  const site   = String(p.websiteUri ?? '')
  return `[BRON: Google] ${name2} — ${street}, ${postal} ${city2}${tel ? ` | ${tel}` : ''}${site ? ` | ${site}` : ''}\nTag: [google: naam=${name2}|adres=${street}|stad=${city2}|postcode=${postal}${tel ? `|tel=${tel}` : ''}${site ? `|website=${site}` : ''}]`
}

async function tool_contact_briefing(args: Record<string, unknown>, orgId: string): Promise<string> {
  const id = String(args.contactId ?? '')
  const [contactRes, notesRes, tasksRes, appsRes] = await Promise.all([
    sb().from('contacts').select('*').eq('id', id).eq('organization_id', orgId).single(),
    sb().from('notes').select('body, created_at').eq('contact_id', id).eq('organization_id', orgId).order('created_at', { ascending: false }).limit(5),
    sb().from('tasks').select('title, due_date, completed').eq('contact_id', id).eq('organization_id', orgId).eq('completed', false).limit(5),
    sb().from('appointments').select('title, start_time, status').eq('contact_id', id).eq('organization_id', orgId).gte('start_time', new Date().toISOString()).order('start_time').limit(3),
  ])
  const c = contactRes.data
  if (!c) return 'Contact niet gevonden.'
  const cn = [c.first_name, c.last_name].filter(Boolean).join(' ')
  const parts = [
    `Bedrijf: ${c.company_name ?? '—'}`,
    `Naam: ${cn || '—'}`,
    `Type: ${c.type ?? '—'}`,
    `Tel: ${c.phone ?? '—'}`,
    `Email: ${c.email ?? '—'}`,
    `Adres: ${[c.address, c.postcode, c.city].filter(Boolean).join(', ') || '—'}`,
  ]
  const notes = (notesRes.data ?? []).slice(0, 3).map(n => `- ${String(n.body ?? '').substring(0, 100)}`)
  if (notes.length) parts.push(`Notities:\n${notes.join('\n')}`)
  const tasks = (tasksRes.data ?? []).map(t => `- ${t.title}${t.due_date ? ` (${new Date(t.due_date).toLocaleDateString('nl-NL')})` : ''}`)
  if (tasks.length) parts.push(`Open taken:\n${tasks.join('\n')}`)
  const apps = (appsRes.data ?? []).map(a => `- ${a.title ?? 'Afspraak'} op ${new Date(a.start_time).toLocaleDateString('nl-NL')}`)
  if (apps.length) parts.push(`Komende afspraken:\n${apps.join('\n')}`)
  return parts.join('\n')
}

async function tool_contact_create(args: Record<string, unknown>, orgId: string): Promise<string> {
  if (!orgId) return 'Configuratiefout: geen org_id beschikbaar.'
  const row: Record<string, unknown> = { organization_id: orgId }
  for (const f of ['company_name', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'postcode', 'type', 'source']) {
    if (args[f]) row[f] = args[f]
  }
  const { data, error } = await sb().from('contacts').insert(row).select('id, company_name, first_name').single()
  if (error || !data) return `Fout bij aanmaken: ${error?.message ?? 'onbekend'}`
  const nm = data.company_name ?? data.first_name ?? 'Contact'
  return `Contact aangemaakt: ${nm} (ID: ${data.id})`
}

async function tool_contact_update(args: Record<string, unknown>, orgId: string): Promise<string> {
  const { contactId, ...fields } = args
  const allowed = ['company_name', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'postcode', 'type']
  const patch: Record<string, unknown> = {}
  for (const f of allowed) { if (fields[f] !== undefined) patch[f] = fields[f] }
  const { data, error } = await sb().from('contacts').update(patch).eq('id', contactId).eq('organization_id', orgId).select('company_name, first_name').single()
  if (error) return `Fout bij bijwerken: ${error.message}`
  return `Contact bijgewerkt: ${data?.company_name ?? data?.first_name ?? contactId}`
}

async function tool_note_create(args: Record<string, unknown>, orgId: string): Promise<string> {
  const { error } = await sb().from('notes').insert({
    organization_id: orgId,
    contact_id:      String(args.contactId ?? ''),
    body:            String(args.body ?? ''),
    created_by:      args.userId ? String(args.userId) : null,
    ghl_id:          crypto.randomUUID(), // required unique field
  })
  if (error) return `Fout bij aanmaken notitie: ${error.message}`
  return 'Notitie aangemaakt.'
}

async function tool_task_create(args: Record<string, unknown>, orgId: string): Promise<string> {
  const { error } = await sb().from('tasks').insert({
    organization_id: orgId,
    contact_id:      String(args.contactId ?? ''),
    title:           String(args.title ?? ''),
    due_date:        args.dueDate ?? new Date(Date.now() + 86400000).toISOString(),
    assigned_to:     args.assignedTo ?? null,
    completed:       false,
  })
  if (error) return `Fout bij aanmaken taak: ${error.message}`
  return 'Taak aangemaakt.'
}

async function tool_calendar_get_free_slot(args: Record<string, unknown>, orgId: string): Promise<string> {
  const start = String(args.startDate ?? new Date().toISOString().split('T')[0])
  const end   = String(args.endDate   ?? new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0])
  const { data } = await sb()
    .from('appointments')
    .select('start_time, end_time')
    .eq('organization_id', orgId)
    .gte('start_time', `${start}T00:00:00Z`)
    .lte('start_time', `${end}T23:59:59Z`)
    .eq('status', 'confirmed')
    .order('start_time')
  const booked = (data ?? []).map(a => ({ start: new Date(a.start_time).getTime(), end: new Date(a.end_time ?? a.start_time).getTime() + 3600000 }))
  // Find first 1-hour slot on business days 09:00-17:00
  const slot_ms = 3600000
  let cursor    = new Date(`${start}T09:00:00+02:00`).getTime()
  const endMs   = new Date(`${end}T17:00:00+02:00`).getTime()
  while (cursor < endMs) {
    const d = new Date(cursor)
    const h = d.getHours()
    if (d.getDay() === 0 || d.getDay() === 6) { cursor += 86400000; continue }
    if (h < 9) { cursor = new Date(d.toDateString() + ' 09:00:00').getTime(); continue }
    if (h >= 17) { cursor += 86400000 - (h - 9) * 3600000; continue }
    const overlap = booked.some(b => cursor < b.end && cursor + slot_ms > b.start)
    if (!overlap) {
      const fmt = (ms: number) => new Date(ms).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
      return `Eerste vrije slot: ${fmt(cursor)} — ${fmt(cursor + slot_ms)}`
    }
    cursor += slot_ms
  }
  return 'Geen vrije slots gevonden in de opgegeven periode.'
}

async function tool_calendar_create(args: Record<string, unknown>, orgId: string): Promise<string> {
  const { error } = await sb().from('appointments').insert({
    organization_id: orgId,
    contact_id:      String(args.contactId ?? ''),
    title:           String(args.title ?? 'Afspraak'),
    start_time:      String(args.startTime ?? ''),
    end_time:        args.endTime ? String(args.endTime) : null,
    assigned_to:     args.assignedTo ?? null,
    status:          'confirmed',
  })
  if (error) return `Fout bij aanmaken afspraak: ${error.message}`
  return 'Afspraak aangemaakt.'
}

// contact_create_volledig — legacy flow tool: create contact with custom fields
async function tool_contact_create_volledig(args: Record<string, unknown>, orgId: string): Promise<string> {
  if (!orgId) return 'Configuratiefout: geen org_id beschikbaar.'
  const row: Record<string, unknown> = { organization_id: orgId }
  const map: Array<[string, string]> = [
    ['companyName', 'company_name'], ['firstName', 'first_name'], ['lastName', 'last_name'],
    ['phone', 'phone'], ['city', 'city'], ['address1', 'address'], ['postalCode', 'postcode'],
  ]
  for (const [from, to] of map) { if (args[from]) row[to] = args[from] }
  if (args.klant_type) row.type = args.klant_type === 'Klant' ? 'customer' : 'lead'
  const customFields: Record<string, unknown> = {}
  if (args.groothandel)       customFields.groothandel       = args.groothandel
  if (args.pos_materiaal)     customFields.pos_materiaal     = args.pos_materiaal
  if (args.kortingsafspraken) customFields.kortingsafspraken = args.kortingsafspraken
  if (args.producten)         customFields.producten         = args.producten
  if (Object.keys(customFields).length) row.custom_fields = customFields
  const { data, error } = await sb().from('contacts').insert(row).select('id, company_name, first_name').single()
  if (error || !data) return `Fout bij aanmaken: ${error?.message ?? 'onbekend'}`
  return `Contact aangemaakt: ${data.company_name ?? data.first_name ?? 'Contact'} (ID: ${data.id})`
}

// agenda_bekijken — legacy flow tool: list appointments for a given Dutch date reference
async function tool_agenda_bekijken(args: Record<string, unknown>, orgId: string): Promise<string> {
  const raw = String(args.datum ?? 'vandaag').toLowerCase().trim()
  const now = new Date()
  const NL_DAYS: Record<string, number> = { 'maandag': 1, 'dinsdag': 2, 'woensdag': 3, 'donderdag': 4, 'vrijdag': 5, 'zaterdag': 6, 'zondag': 0 }
  let target = new Date(now)
  if (raw === 'vandaag') { /* keep today */ }
  else if (raw === 'morgen') { target.setDate(target.getDate() + 1) }
  else if (raw === 'overmorgen') { target.setDate(target.getDate() + 2) }
  else if (NL_DAYS[raw] !== undefined) {
    const diff = (NL_DAYS[raw] - now.getDay() + 7) % 7 || 7
    target.setDate(target.getDate() + diff)
  } else {
    const parsed = new Date(raw)
    if (!isNaN(parsed.getTime())) target = parsed
  }
  const dateStr = target.toISOString().split('T')[0]
  const { data } = await sb()
    .from('appointments')
    .select('title, start_time, end_time, assigned_to, status')
    .eq('organization_id', orgId)
    .gte('start_time', `${dateStr}T00:00:00Z`)
    .lte('start_time', `${dateStr}T23:59:59Z`)
    .order('start_time')
  if (!data?.length) return `Geen afspraken op ${dateStr}.`
  const fmt = (t: string) => new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
  return data.map(a => `${fmt(a.start_time)}${a.end_time ? `–${fmt(a.end_time)}` : ''} ${a.title ?? 'Afspraak'}${a.assigned_to ? ` (${a.assigned_to})` : ''}`).join('\n')
}

async function tool_log_bezoek(args: Record<string, unknown>, orgId: string): Promise<string> {
  const contactId = String(args.contactId ?? '')
  if (!contactId) return 'Fout: contactId is verplicht.'

  const results: string[] = []

  // 1. Note with visit summary
  if (args.notitie) {
    const { error } = await sb().from('notes').insert({
      organization_id: orgId,
      contact_id:      contactId,
      body:            String(args.notitie),
      ghl_id:          crypto.randomUUID(),
    })
    if (error) results.push(`Notitie fout: ${error.message}`)
    else results.push('Notitie opgeslagen.')
  }

  // 2. Follow-up task or appointment
  const type  = String(args.vervolgactie_type ?? 'geen')
  const titel = String(args.vervolgactie_titel ?? 'Vervolgafspraak')
  const datum = args.vervolgactie_datum ? String(args.vervolgactie_datum) : null

  if (type === 'taak' && datum) {
    const { error } = await sb().from('tasks').insert({
      organization_id: orgId,
      contact_id:      contactId,
      title:           titel,
      due_date:        datum,
      completed:       false,
    })
    if (error) results.push(`Taak fout: ${error.message}`)
    else results.push('Taak aangemaakt.')
  } else if (type === 'afspraak' && datum) {
    const { error } = await sb().from('appointments').insert({
      organization_id: orgId,
      contact_id:      contactId,
      title:           titel,
      start_time:      datum,
      end_time:        args.vervolgactie_eind ? String(args.vervolgactie_eind) : null,
      status:          'confirmed',
    })
    if (error) results.push(`Afspraak fout: ${error.message}`)
    else results.push('Afspraak aangemaakt.')
  }

  // 3. Update contact type (klant/lead) + custom fields
  const patch: Record<string, unknown> = {}
  if (args.klant_type) patch.type = args.klant_type === 'Klant' ? 'customer' : 'lead'

  const customFields: Record<string, unknown> = {}
  if (args.groothandel)       customFields.groothandel       = args.groothandel
  if (args.pos_materiaal)     customFields.pos_materiaal     = args.pos_materiaal
  if (args.kortingsafspraken) customFields.kortingsafspraken = args.kortingsafspraken
  if (args.producten)         customFields.producten         = args.producten

  if (Object.keys(customFields).length > 0 || Object.keys(patch).length > 0) {
    // Merge into existing custom_fields
    const { data: existing } = await sb().from('contacts').select('custom_fields').eq('id', contactId).eq('organization_id', orgId).single()
    patch.custom_fields = { ...(existing?.custom_fields ?? {}), ...customFields }
    const { error } = await sb().from('contacts').update(patch).eq('id', contactId).eq('organization_id', orgId)
    if (error) results.push(`Contact update fout: ${error.message}`)
    else results.push('Contact bijgewerkt.')
  }

  return results.length ? results.join(' ') : 'Bezoek opgeslagen.'
}

async function tool_get_team_members(orgId: string): Promise<string> {
  const { data } = await sb()
    .from('team_members')
    .select('id, naam, functie')
    .eq('organization_id', orgId)
    .eq('active', true)
  if (!data?.length) return 'Geen teamleden gevonden.'
  return data.map((m: { id: string; naam: string; functie?: string }) => `${m.naam}${m.functie ? ` (${m.functie})` : ''} — ID: ${m.id}`).join('\n')
}

async function tool_get_caller_info(args: Record<string, unknown>, orgId: string): Promise<string> {
  const phone = String(args.phone ?? args.from_number ?? '').trim()
  if (!phone) {
    return JSON.stringify({
      found: false,
      reason: 'Geen telefoonnummer beschikbaar. Dit is normaal bij een web demo.',
    })
  }

  const { data } = await sb()
    .from('contacts')
    .select('id, company_name, first_name, last_name, phone, email, city')
    .eq('organization_id', orgId)
    .ilike('phone', `%${phone}%`)
    .limit(1)

  const contact = data?.[0]
  if (!contact) {
    return JSON.stringify({
      found: false,
      phone,
    })
  }

  return JSON.stringify({
    found: true,
    contact: {
      contact_id: contact.id,
      company_name: contact.company_name ?? null,
      first_name: contact.first_name ?? null,
      last_name: contact.last_name ?? null,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      city: contact.city ?? null,
    },
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP TOOL DEFINITIONS
// ══════════════════════════════════════════════════════════════════════════════
const MCP_TOOLS = [
  { name: 'contact_zoek', description: 'Zoek een klant/bedrijf in het CRM. STT-correctie via Google Places. Geeft 1 contact terug (found:true) of niet gevonden (found:false). ALTIJD aanroepen zodra een bedrijfsnaam wordt genoemd.', inputSchema: { type: 'object', properties: { bedrijfsnaam: { type: 'string', description: 'Naam van het bedrijf — spreektaal automatisch omgezet' }, plaatsnaam: { type: 'string', description: 'Stad of plaatsnaam (optioneel maar sterk aanbevolen)' } }, required: ['bedrijfsnaam'] } },
  { name: 'google_zoek_adres', description: 'Zoek het adres + telefoonnummer van een bedrijf via Google Places. Gebruik voor nieuwe contacten.', inputSchema: { type: 'object', properties: { bedrijfsnaam: { type: 'string' }, plaatsnaam: { type: 'string' } }, required: ['bedrijfsnaam'] } },
  { name: 'contact_briefing', description: 'Volledige briefing van een contact: gegevens, recente notities, open taken en komende afspraken.', inputSchema: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact UUID' } }, required: ['contactId'] } },
  { name: 'contact_create', description: 'Maak een nieuw contact aan. Alleen company_name is verplicht. Vraag nooit om telefoon of email.', inputSchema: { type: 'object', properties: { company_name: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' }, city: { type: 'string' }, address: { type: 'string' }, postcode: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, type: { type: 'string', enum: ['lead', 'customer'] }, source: { type: 'string' } }, required: ['company_name'] } },
  { name: 'contact_update', description: 'Velden van een bestaand contact bijwerken.', inputSchema: { type: 'object', properties: { contactId: { type: 'string' }, company_name: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, address: { type: 'string' }, city: { type: 'string' }, type: { type: 'string', enum: ['lead', 'customer'] } }, required: ['contactId'] } },
  { name: 'note_create', description: 'Notitie toevoegen aan een contact.', inputSchema: { type: 'object', properties: { contactId: { type: 'string' }, body: { type: 'string', description: 'Inhoud van de notitie' }, userId: { type: 'string', description: 'Team member ID (optioneel)' } }, required: ['contactId', 'body'] } },
  { name: 'task_create', description: 'Taak of herinnering aanmaken voor een contact.', inputSchema: { type: 'object', properties: { contactId: { type: 'string' }, title: { type: 'string' }, dueDate: { type: 'string', description: 'ISO datum bijv. 2025-04-18T10:00:00Z' }, assignedTo: { type: 'string', description: 'Team member ID (optioneel)' } }, required: ['contactId', 'title'] } },
  { name: 'calendar_get_free_slot', description: 'Eerste vrije agendaslot ophalen (automatisch berekend uit bestaande afspraken).', inputSchema: { type: 'object', properties: { startDate: { type: 'string', description: 'YYYY-MM-DD (standaard: vandaag)' }, endDate: { type: 'string', description: 'YYYY-MM-DD (standaard: 7 dagen)' } }, required: [] } },
  { name: 'calendar_create', description: 'Afspraak aanmaken.', inputSchema: { type: 'object', properties: { contactId: { type: 'string' }, title: { type: 'string' }, startTime: { type: 'string', description: 'ISO datetime' }, endTime: { type: 'string', description: 'ISO datetime' }, assignedTo: { type: 'string' } }, required: ['contactId', 'title', 'startTime'] } },
  { name: 'get_team_members', description: 'Actieve teamleden ophalen (naam, functie, ID).', inputSchema: { type: 'object', properties: {} } },
  { name: 'log_bezoek', description: 'Sla een volledig bezoek op: notitie, vervolgactie (taak of afspraak), klant/lead status, POS materiaal, kortingsafspraken, groothandel en producten. Roep aan zodra alle bezoekinfo verzameld is.', inputSchema: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact UUID (verplicht)' }, notitie: { type: 'string', description: 'Samenvatting van het bezoek' }, vervolgactie_type: { type: 'string', enum: ['taak', 'afspraak', 'geen'], description: 'Type vervolgactie' }, vervolgactie_titel: { type: 'string', description: 'Titel van de taak of afspraak' }, vervolgactie_datum: { type: 'string', description: 'ISO datum/tijd voor vervolgactie' }, vervolgactie_eind: { type: 'string', description: 'Eindtijd afspraak (ISO)' }, klant_type: { type: 'string', enum: ['Klant', 'Lead'], description: 'Is dit een klant of lead?' }, pos_materiaal: { type: 'string', enum: ['Ja', 'Nee'], description: 'POS materiaal geplaatst?' }, kortingsafspraken: { type: 'string', enum: ['Ja', 'Nee'], description: 'Kortingsafspraken gemaakt?' }, groothandel: { type: 'string', description: 'Naam van de groothandel' }, producten: { type: 'string', description: 'Producten als komma-gescheiden tekst' } }, required: ['contactId'] } },
]

// ══════════════════════════════════════════════════════════════════════════════
// DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════
async function callTool(name: string, args: Record<string, unknown>, orgId: string): Promise<string> {
  console.log(`[native-mcp] tool=${name} org=${orgId}`, JSON.stringify(args).slice(0, 150))
  switch (name) {
    case 'contact_zoek':           return await tool_contact_zoek(args, orgId)
    case 'google_zoek_adres':      return await tool_google_zoek_adres(args)
    case 'contact_briefing':       return await tool_contact_briefing(args, orgId)
    case 'contact_create':         return await tool_contact_create(args, orgId)
    case 'contact_update':         return await tool_contact_update(args, orgId)
    case 'note_create':            return await tool_note_create(args, orgId)
    case 'task_create':            return await tool_task_create(args, orgId)
    case 'calendar_get_free_slot': return await tool_calendar_get_free_slot(args, orgId)
    case 'calendar_create':        return await tool_calendar_create(args, orgId)
    case 'get_team_members':       return await tool_get_team_members(orgId)
    case 'log_bezoek':             return await tool_log_bezoek(args, orgId)
    // Legacy flow tool aliases
    case 'contact_create_volledig': return await tool_contact_create_volledig(args, orgId)
    case 'agenda_bekijken':         return await tool_agenda_bekijken(args, orgId)
    case 'get_caller_info':         return await tool_get_caller_info(args, orgId)
    default: return `Onbekende tool: ${name}`
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP JSON-RPC HTTP HANDLER
// ══════════════════════════════════════════════════════════════════════════════
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  if (req.method === 'GET') {
    return Response.json({ ok: true, service: 'native-mcp', tools: MCP_TOOLS.map(t => t.name) }, { headers: CORS })
  }

  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }
  console.log('[native-mcp] REQUEST:', JSON.stringify(body).slice(0, 600))

  const orgId  = extractOrgId(req, body)
  const id     = body.id ?? null
  const method = String(body.method ?? '')

  // Retell webhook-style direct call (body has 'name' but no 'method')
  if (!method && body.name) {
    // Retell conversation-flow sends args under 'args' key (not 'arguments')
    let rawArgs: unknown = body.args ?? body.arguments ?? body.parameters ?? {}
    let safety = 0
    while (typeof rawArgs === 'string' && safety++ < 5) { try { rawArgs = JSON.parse(rawArgs) } catch { rawArgs = {}; break } }
    if (typeof rawArgs !== 'object' || rawArgs === null) rawArgs = {}
    // Last resort: top-level body keys
    if (Object.keys(rawArgs as object).length === 0) {
      const SKIP = new Set(['name', 'args', 'call', 'dynamic_variables', 'llm_id', 'version', 'tool_call_id'])
      const topLevel: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(body)) {
        if (!SKIP.has(k)) topLevel[k] = v
      }
      if (Object.keys(topLevel).length) rawArgs = topLevel
    }
    const result = await callTool(String(body.name), rawArgs as Record<string, unknown>, orgId)
    return Response.json({ result }, { headers: CORS })
  }

  const ok  = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result }, { headers: CORS })
  const err = (code: number, msg: string) => Response.json({ jsonrpc: '2.0', id, error: { code, message: msg } }, { headers: CORS })

  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'suus-crm', version: '1.0.0' },
        })

      case 'tools/list':
        return ok({ tools: MCP_TOOLS })

      case 'tools/call': {
        if (!orgId) return err(-32600, 'org_id ontbreekt — toegang geweigerd')
        const params   = (body.params ?? {}) as Record<string, unknown>
        // Retell sends name at params.name (MCP spec) — also handle top-level body.name fallback
        const toolName = String(params.name ?? body.name ?? '')
        let rawArgs: unknown = params.arguments ?? params.input ?? body.arguments ?? {}
        let safety = 0
        while (typeof rawArgs === 'string' && safety++ < 5) { try { rawArgs = JSON.parse(rawArgs) } catch { rawArgs = {}; break } }
        if (typeof rawArgs !== 'object' || rawArgs === null) rawArgs = {}
        if (!toolName) return err(-32602, 'name is required')
        const result = await callTool(toolName, rawArgs as Record<string, unknown>, orgId)
        console.log(`[native-mcp] result (${toolName}):`, result.slice(0, 200))
        return ok({ content: [{ type: 'text', text: result }] })
      }

      case 'notifications/initialized':
        return ok({})

      default:
        return err(-32601, `Method not found: ${method}`)
    }
  } catch (e) {
    console.error('[native-mcp] error:', e)
    return err(-32603, e instanceof Error ? e.message : String(e))
  }
})
