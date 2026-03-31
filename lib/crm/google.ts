/**
 * Google Places integration — spelling correction + business profile enrichment.
 * Requires GOOGLE_PLACES_API_KEY in env.
 *
 * Also contains:
 *   normalizeSearchQuery()  — deterministic pre-processing (Tier 0)
 *   interpretSearchQuery()  — gpt-4.1-mini LLM fallback (Tier 3, only when DB returns 0)
 */

import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place'

function apiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set')
  return key
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type PlaceResult = {
  place_id:          string
  name:              string
  formatted_address: string
}

type AddressComponent = {
  types:      string[]
  short_name: string
  long_name:  string
}

export type PlaceDetails = {
  name:                       string
  formatted_address:          string
  address_components:         AddressComponent[]
  international_phone_number: string | undefined
  website:                    string | undefined
  opening_hours:              { weekday_text: string[] } | undefined
}

export type GoogleEnrichment = {
  name:         string
  formatted:    string
  address:     string | null
  postalCode:   string | null
  city:         string | null
  country:      string | null
  phone:        string | null
  website:      string | null
  openingHours: string | null
}

// ─── Places Text Search ────────────────────────────────────────────────────

export async function placesTextSearch(query: string): Promise<PlaceResult[]> {
  const url = new URL(`${PLACES_BASE}/textsearch/json`)
  url.searchParams.set('query',    query)
  url.searchParams.set('language', 'nl')
  url.searchParams.set('key',      apiKey())

  const res  = await fetch(url.toString())
  const data = await res.json() as { results?: PlaceResult[]; status: string }

  if (!res.ok || !['OK', 'ZERO_RESULTS'].includes(data.status)) {
    throw new Error(`Google Places search failed: ${data.status}`)
  }
  return data.results ?? []
}

// ─── Places Details ────────────────────────────────────────────────────────

export async function placesDetails(placeId: string): Promise<PlaceDetails | null> {
  const url = new URL(`${PLACES_BASE}/details/json`)
  url.searchParams.set('place_id', placeId)
  url.searchParams.set('fields',   'name,formatted_address,address_components,opening_hours,international_phone_number,website')
  url.searchParams.set('language', 'nl')
  url.searchParams.set('key',      apiKey())

  const res  = await fetch(url.toString())
  const data = await res.json() as { result?: PlaceDetails; status: string }

  if (!res.ok || data.status !== 'OK') return null
  return data.result ?? null
}

// ─── Parse address_components → structured fields ──────────────────────────

export function parseAddressComponents(components: AddressComponent[]): {
  streetNumber: string | null
  route:        string | null
  postalCode:   string | null
  city:         string | null
  country:      string | null
} {
  const get = (type: string) =>
    components.find(c => c.types.includes(type))?.long_name ?? null
  const getShort = (type: string) =>
    components.find(c => c.types.includes(type))?.short_name ?? null

  const streetNumber = get('street_number')
  const route        = get('route')

  return {
    streetNumber,
    route,
    postalCode: get('postal_code'),
    city:       get('locality') ?? get('postal_town'),
    country:    getShort('country'),
  }
}

// ─── Full enrichment pipeline: search → details → parse ───────────────────

export async function enrichFromGoogle(
  query: string,           // e.g. "Bakkerij De Molen Amsterdam"
): Promise<GoogleEnrichment | null> {
  const results = await placesTextSearch(query)
  if (!results.length) return null

  const top     = results[0]
  const details = await placesDetails(top.place_id)
  if (!details) return null

  const addr = parseAddressComponents(details.address_components)

  const address = [addr.route, addr.streetNumber].filter(Boolean).join(' ') || null

  const openingHours = details.opening_hours?.weekday_text?.join('\n') ?? null

  return {
    name:         details.name,
    formatted:    details.formatted_address,
    address,
    postalCode:   addr.postalCode,
    city:         addr.city,
    country:      addr.country,
    phone:        details.international_phone_number ?? null,
    website:      details.website ?? null,
    openingHours,
  }
}

// ─── Spelling correction: return corrected name from Google result[0] ──────

export async function googleSpellingCorrection(query: string): Promise<string | null> {
  try {
    const results = await placesTextSearch(query)
    return results[0]?.name ?? null
  } catch {
    return null
  }
}

// ─── Extract tokens from query for multi-token search ──────────────────────
// Splits on whitespace, keeps tokens ≥3 chars, lowercased.
// City words (known cities) are separated out as cityFilter.

const CITY_WORDS = new Set([
  'amsterdam','rotterdam','utrecht','den haag','eindhoven','groningen','tilburg',
  'almere','breda','nijmegen','enschede','haarlem','arnhem','zaandam','zwolle',
  'maastricht','leiden','dordrecht','zoetermeer','amersfoort','deventer',
  'helmond','alkmaar','venlo','emmen','leeuwarden','apeldoorn',
])

export function parseSearchQuery(raw: string): {
  tokens:     string[]
  cityFilter: string | null
} {
  const words   = raw.toLowerCase().split(/\s+/).filter(w => w.length >= 3)
  const city    = words.find(w => CITY_WORDS.has(w)) ?? null
  const tokens  = words.filter(w => w !== city)
  return { tokens, cityFilter: city }
}

// ─── Tier 0: normalizeSearchQuery — deterministic STT/text cleanup ─────────
// No API calls. Always runs before any DB query.

const DUTCH_NUMBER_WORDS: Record<string, string> = {
  nul: '0', een: '1', twee: '2', drie: '3', vier: '4', vijf: '5',
  zes: '6', zeven: '7', acht: '8', negen: '9', tien: '10',
  elf: '11', twaalf: '12', dertien: '13', veertien: '14', vijftien: '15',
  zestien: '16', zeventien: '17', achttien: '18', negentien: '19', twintig: '20',
  eenentwintig: '21', tweeëntwintig: '22', drieëntwintig: '23', vierentwintig: '24',
  vijfentwintig: '25', zesentwintig: '26', zevenentwintig: '27', achtentwintig: '28',
  negenentwintig: '29', dertig: '30', eenendertig: '31', tweeëndertig: '32',
  drieëndertig: '33', vierendertig: '34', vijfendertig: '35', zesendertig: '36',
  zevenendertig: '37', achtendertig: '38', negenendertig: '39', veertig: '40',
  eenenveertig: '41', tweeënveertig: '42', drieënveertig: '43', vierenveertig: '44',
  vijfenveertig: '45', zesenveertig: '46', zevenveertig: '47', achtenveertig: '48',
  negenenveertig: '49', vijftig: '50', zestig: '60', zeventig: '70',
  tachtig: '80', negentig: '90', honderd: '100',
}

const LEGAL_FORM_WORDS = new Set([
  'bv', 'nv', 'vof', 'cv', 'bvba', 'sa', 'ltd', 'gmbh', 'inc',
  'holding', 'groep', 'group', 'beheer', 'management',
])

/**
 * Tier 0: Clean up a search query before hitting the database.
 * - Converts Dutch number words to digits ("drieëndertig" → "33")
 * - Strips legal form suffixes from tokens (keeps them for context but deprioritises)
 * - Normalises whitespace and punctuation
 * Returns { normalized: cleaned query string, legalStripped: query without legal forms }
 */
export function normalizeSearchQuery(raw: string): {
  normalized:    string
  legalStripped: string
} {
  // Skip normalization for emails and phone numbers — return as-is
  if (/@/.test(raw) || /^\+?[\d\s\-()]{7,}$/.test(raw.trim())) {
    return { normalized: raw.trim(), legalStripped: raw.trim() }
  }

  let s = raw.trim().toLowerCase()

  // Replace Dutch number words with digits (longest match first)
  const sortedNums = Object.entries(DUTCH_NUMBER_WORDS)
    .sort((a, b) => b[0].length - a[0].length)
  for (const [word, digit] of sortedNums) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit)
  }

  // Normalise punctuation and collapse spaces (not dots in numbers like "33.5")
  s = s.replace(/[,\-_/\\]/g, ' ').replace(/\s+/g, ' ').trim()

  // Build a version without legal form words (better for fuzzy matching)
  const tokens       = s.split(/\s+/)
  const legalStripped = tokens.filter(t => !LEGAL_FORM_WORDS.has(t)).join(' ').trim()

  return { normalized: s, legalStripped: legalStripped || s }
}

// ─── Tier 3: interpretSearchQuery — LLM sub-agent, only on double 0-result ──

export type InterpretedQuery = {
  companyName: string | null
  firstName:   string | null
  city:        string | null
  raw:         string
}

/**
 * Tier 3 fallback: small gpt-4.1-mini call to interpret an ambiguous search query.
 * Only invoked after ILIKE AND pg_trgm both return 0 results.
 * Returns structured fields that can seed a clean retry.
 */
export async function interpretSearchQuery(
  rawQuery:          string,
  googleCorrection?: string | null,
): Promise<InterpretedQuery> {
  const context = googleCorrection && googleCorrection.toLowerCase() !== rawQuery.toLowerCase()
    ? `Google spelling suggestion: "${googleCorrection}"`
    : ''

  try {
    const resp = await openai.chat.completions.create({
      model:       'gpt-4.1-mini',
      temperature: 0,
      max_tokens:  120,
      response_format: { type: 'json_object' },
      messages: [
        {
          role:    'system',
          content: `Extract a structured CRM contact search from a potentially noisy query (speech-to-text errors, Dutch abbreviations, number words already converted to digits).
Return JSON with exactly these keys:
  companyName: string | null  — business/company name only, no legal forms (BV, VOF etc)
  firstName:   string | null  — person first name if present, otherwise null
  city:        string | null  — Dutch city name if present, otherwise null
  raw:         string         — the cleaned-up query you would use to search

Rules:
- Strip legal forms: BV, NV, VOF, Holding, Beheer
- If the query is only a person name (no company), put it in firstName
- Keep numbers as digits
- Output valid JSON only`,
        },
        {
          role:    'user',
          content: `Query: "${rawQuery}"${context ? '\n' + context : ''}`,
        },
      ],
    })

    const parsed = JSON.parse(resp.choices[0].message.content ?? '{}')
    return {
      companyName: parsed.companyName ?? null,
      firstName:   parsed.firstName   ?? null,
      city:        parsed.city        ?? null,
      raw:         parsed.raw         ?? rawQuery,
    }
  } catch {
    return { companyName: null, firstName: null, city: null, raw: rawQuery }
  }
}
