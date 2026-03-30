/**
 * sip-webhook — OpenAI Realtime SIP trunking handler
 *
 * Flow:
 *   Twilio SIP trunk → OpenAI SIP endpoint → this webhook fires
 *   → accept call with SUUS config
 *   → open WebSocket to handle tool calls server-side
 *   → tools proxied to native-mcp Edge Function
 *
 * Deploy: supabase functions deploy sip-webhook --no-verify-jwt
 * Webhook URL: https://<project>.supabase.co/functions/v1/sip-webhook
 */

// Geen externe WebSocket library nodig — gebruik native Deno WebSocket
// Deno 2.x ondersteunt headers als derde argument (undocumented extension)

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!
const ANON_KEY       = Deno.env.get('SUPABASE_ANON_KEY')!
const DEFAULT_ORG_ID = Deno.env.get('DEFAULT_ORG_ID') ?? ''
const MCP_URL        = `${SUPABASE_URL}/functions/v1/native-mcp`

const TODAY = new Date().toLocaleDateString('nl-NL', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Amsterdam',
})

// ── Instructions ──────────────────────────────────────────────────────────────
// Volledige flow in één agent — geen SDK handoffs nodig voor SIP
// Stage-transitie via session.update nadat contact gevonden/aangemaakt is

const SETUP_INSTRUCTIONS = `Je bent Suus, de AI sales-assistent.
KRITIEK: Spreek ALTIJD en UITSLUITEND Nederlands, ongeacht de taal van de gebruiker.
KRITIEK: Houd elke respons KORT — maximaal 1–2 zinnen. Geen opsommingen, geen uitleg.
Spreek direct — dit is een gesprek, geen presentatie.

ABSOLUUT VERBODEN:
- Een adres of resultaat zelf bedenken of raden
- Een tool-resultaat voorspellen zonder de tool aan te roepen
- Een contact-ID raden — altijd ophalen via tool
- Vragen wie de gebruiker is of hoe ze heten (de gebruiker is altijd de accountmanager)
- Lead/klant vragen bij contact aanmaken (alleen bij bezoek loggen)

## TAAK: Bedrijf identificeren én contact vastleggen

# Conversation States
[
  {
    "id": "1_greeting",
    "instructions": [
      "Zeg ALTIJD exact als openingszin: 'Hoi! Ik ben Suus! Noem de bedrijf- en plaatsnaam, dan help ik je verder.'",
      "Een begroeting zoals 'hallo', 'hoi', 'hey', 'hello' is NOOIT een bedrijfsnaam."
    ],
    "transitions": [{ "next_step": "2_search", "condition": "Zodra je een echte bedrijfsnaam EN plaatsnaam hebt" }]
  },
  {
    "id": "2_search",
    "instructions": [
      "Roep DIRECT google_zoek_adres aan. Wacht op het echte resultaat — zeg NIETS voor je het hebt."
    ],
    "transitions": [
      { "next_step": "3_confirm", "condition": "Adres gevonden" },
      { "next_step": "2_search",  "condition": "Niet gevonden — zeg: 'Ik kan dat niet vinden. Kun je het nogmaals uitspreken of spellen?' en zoek opnieuw" }
    ]
  },
  {
    "id": "3_confirm",
    "instructions": ["Deel het gevonden adres en vraag of het klopt."],
    "transitions": [
      { "next_step": "4_crm",    "condition": "Gebruiker bevestigt" },
      { "next_step": "2_search", "condition": "Klopt niet — roep google_zoek_adres opnieuw aan" }
    ]
  },
  {
    "id": "4_crm",
    "instructions": ["Roep DIRECT contact_zoek aan. Wacht op het echte resultaat."],
    "transitions": [
      { "next_step": "5_crm_found",          "condition": "Contact gevonden" },
      { "next_step": "5_crm_create_vragen",  "condition": "Contact niet gevonden" }
    ]
  },
  {
    "id": "5_crm_found",
    "instructions": [
      "Zeg kort wie gevonden is.",
      "Ga direct naar het actiemenu — vraag wat de gebruiker wil doen."
    ]
  },
  {
    "id": "5_crm_create_vragen",
    "instructions": [
      "Zeg: 'Dit bedrijf staat nog niet in ons systeem. Ik stel je even een paar vragen.'",
      "Vraag één voor één: 1) Voornaam contactpersoon? 2) E-mailadres? 3) Telefoonnummer? 4) Lead of klant?"
    ],
    "transitions": [{ "next_step": "5_crm_create_aanmaken", "condition": "Alle vier vragen beantwoord" }]
  },
  {
    "id": "5_crm_create_aanmaken",
    "instructions": [
      "Roep contact_create aan met alle ingevulde velden.",
      "Bevestig kort en ga naar het actiemenu."
    ]
  }
]

Vandaag: ${TODAY}`

const ACTIES_INSTRUCTIONS = `Je bent Suus, de AI sales-assistent.
KRITIEK: Spreek ALTIJD en UITSLUITEND Nederlands.
KRITIEK: Houd elke respons KORT — maximaal 1–2 zinnen.

Het contact is vastgelegd — gebruik het contactId uit de conversatiegeschiedenis voor alle tool-aanroepen.
Vraag wat de gebruiker wil doen: bezoek loggen, notitie, taak, afspraak, of briefing.
Na elke actie: stel dezelfde vraag opnieuw.

### Bezoek loggen — vraag één voor één:
1. Samenvatting van het bezoek?
2. Vervolg afspraak of taak nodig? (zo ja: wat en wanneer)
3. Lead of Klant na dit bezoek?
4. Met welke producten werken ze mee?
Roep dan log_bezoek aan.

### Overige acties:
- Notitie: "Wat wil je noteren?" → note_create
- Taak: "Wat is de taak en wanneer?" → task_create (één vraag, niet opsplitsen)
- Afspraak: gebruik tijdstip direct als al genoemd → calendar_create (nooit apart naar doel vragen)
- Briefing: direct → contact_briefing

Als de gebruiker een ander bedrijf wil opzoeken: zeg "Noem de bedrijf- en plaatsnaam." en roep google_zoek_adres aan.

Vandaag: ${TODAY}`

// ── Tool definitions (OpenAI Realtime format) ─────────────────────────────────
const SUUS_TOOLS = [
  {
    type: 'function', name: 'google_zoek_adres',
    description: 'Zoek bedrijfsadres via Google Places. Verplicht aanroepen — nooit raden. bedrijfsnaam en plaatsnaam ZONDER voorzetsels (geen "uit", "in", "te").',
    parameters: { type: 'object', properties: { bedrijfsnaam: { type: 'string' }, plaatsnaam: { type: 'string' } }, required: ['bedrijfsnaam'] },
  },
  {
    type: 'function', name: 'contact_zoek',
    description: 'Zoek een contact op in het CRM. Verplicht aanroepen — nooit raden.',
    parameters: { type: 'object', properties: { bedrijfsnaam: { type: 'string' }, plaatsnaam: { type: 'string' } }, required: ['bedrijfsnaam'] },
  },
  {
    type: 'function', name: 'contact_create',
    description: 'Maak een nieuw contact aan in het CRM.',
    parameters: { type: 'object', properties: { company_name: { type: 'string' }, city: { type: 'string' }, first_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, type: { type: 'string', enum: ['lead', 'customer'] } }, required: ['company_name'] },
  },
  {
    type: 'function', name: 'contact_briefing',
    description: 'Volledige briefing van een contact.',
    parameters: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
  },
  {
    type: 'function', name: 'contact_update',
    description: 'Wijzig velden van een bestaand contact.',
    parameters: { type: 'object', properties: { contactId: { type: 'string' }, company_name: { type: 'string' }, type: { type: 'string', enum: ['lead', 'customer'] } }, required: ['contactId'] },
  },
  {
    type: 'function', name: 'note_create',
    description: 'Notitie toevoegen aan een contact.',
    parameters: { type: 'object', properties: { contactId: { type: 'string' }, body: { type: 'string' } }, required: ['contactId', 'body'] },
  },
  {
    type: 'function', name: 'task_create',
    description: 'Taak aanmaken voor een contact.',
    parameters: { type: 'object', properties: { contactId: { type: 'string' }, title: { type: 'string' }, dueDate: { type: 'string' } }, required: ['contactId', 'title'] },
  },
  {
    type: 'function', name: 'calendar_create',
    description: 'Afspraak aanmaken voor een contact.',
    parameters: { type: 'object', properties: { contactId: { type: 'string' }, title: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' } }, required: ['contactId', 'title', 'startTime'] },
  },
  {
    type: 'function', name: 'log_bezoek',
    description: 'Log een salesbezoek: notitie + vervolg + contact update.',
    parameters: { type: 'object', properties: { contactId: { type: 'string' }, notitie: { type: 'string' }, vervolgactie_type: { type: 'string', enum: ['taak', 'afspraak', 'geen'] }, vervolgactie_titel: { type: 'string' }, vervolgactie_datum: { type: 'string' }, klant_type: { type: 'string', enum: ['Klant', 'Lead'] }, producten: { type: 'string' } }, required: ['contactId'] },
  },
  {
    type: 'function', name: 'get_team_members',
    description: 'Actieve teamleden ophalen.',
    parameters: { type: 'object', properties: {} },
  },
]

// ── Tool executor ─────────────────────────────────────────────────────────────
async function callTool(name: string, args: Record<string, unknown>, orgId: string): Promise<string> {
  try {
    const res = await fetch(MCP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'x-org-id': orgId },
      body:    JSON.stringify({ name, args }),
    })
    if (!res.ok) return `Tool fout: HTTP ${res.status}`
    const { result } = await res.json()
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (e) {
    return `Tool fout: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── WebSocket call handler ────────────────────────────────────────────────────
// Deno native WebSocket — geen externe library nodig
// Deno 2.x ondersteunt headers als tweede argument (WebSocketInit)
async function handleCall(callId: string, orgId: string): Promise<void> {
  console.log(`[sip] handleCall start: callId=${callId} orgId=${orgId}`)

  // @ts-ignore — Deno 2.x extension: WebSocketInit als tweede argument
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${callId}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
  )

  const pendingCalls = new Map<string, { name: string; args: string }>()
  let crmDone = false

  function send(obj: unknown) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  }

  return new Promise((resolve) => {
    ws.onopen = () => {
      console.log('[sip] WebSocket connected')
      send({ type: 'response.create' })
    }

    ws.onmessage = async (event: MessageEvent) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)) }
      catch { return }

      switch (msg.type as string) {

        case 'response.output_item.added': {
          const item = msg.item as Record<string, unknown> | undefined
          if (item?.type === 'function_call') {
            pendingCalls.set(item.call_id as string, { name: item.name as string, args: '' })
          }
          break
        }

        case 'response.function_call_arguments.delta': {
          const p = pendingCalls.get(msg.call_id as string)
          if (p) p.args += (msg.delta as string) ?? ''
          break
        }

        case 'response.function_call_arguments.done': {
          const call = pendingCalls.get(msg.call_id as string)
          if (!call) break
          pendingCalls.delete(msg.call_id as string)

          let args: Record<string, unknown> = {}
          try { args = JSON.parse(call.args || '{}') } catch { /* ignore */ }

          console.log(`[sip] tool call: ${call.name}`, JSON.stringify(args).slice(0, 120))
          const result = await callTool(call.name, args, orgId)
          console.log(`[sip] tool result (${call.name}):`, result.slice(0, 120))

          send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: msg.call_id, output: result },
          })

          // Stage transition: na contact_zoek / contact_create → stuur acties instructies
          if (!crmDone && (call.name === 'contact_zoek' || call.name === 'contact_create')) {
            try {
              const parsed = JSON.parse(result)
              const found  = parsed?.found === true || parsed?.contact !== undefined
              if (found || call.name === 'contact_create') {
                crmDone = true
                setTimeout(() => send({
                  type:    'session.update',
                  session: { instructions: ACTIES_INSTRUCTIONS },
                }), 600)
              }
            } catch { /* ignore */ }
          }

          send({ type: 'response.create' })
          break
        }

        case 'error':
          console.error('[sip] Realtime error:', JSON.stringify(msg))
          break
      }
    }

    ws.onclose = () => { console.log('[sip] WebSocket closed'); resolve() }
    ws.onerror = (e: Event) => { console.error('[sip] ws error:', e); resolve() }
  })
}

// ── HTTP handler ──────────────────────────────────────────────────────────────
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }

  console.log('[sip-webhook] event:', body.type)

  if (body.type === 'realtime.call.incoming') {
    const data   = body.data as { call_id: string; sip_headers?: Array<{ name: string; value: string }> }
    const callId = data.call_id
    const orgId  = DEFAULT_ORG_ID

    console.log(`[sip-webhook] incoming call: ${callId}`)

    // Accept the call
    const acceptRes = await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/accept`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:                      'realtime',
        model:                     'gpt-4o-realtime-preview',
        instructions:              SETUP_INSTRUCTIONS,
        tools:                     SUUS_TOOLS,
        input_audio_transcription: { model: 'gpt-4o-transcribe' },
      }),
    })

    if (!acceptRes.ok) {
      const err = await acceptRes.text()
      console.error('[sip-webhook] accept failed:', err)
      return new Response('Accept failed', { status: 500, headers: CORS })
    }

    console.log('[sip-webhook] call accepted, starting WebSocket handler')

    // Handle call in background — retourneer 200 direct
    handleCall(callId, orgId).catch(e => console.error('[sip] unhandled error:', e))
  }

  return new Response('OK', { status: 200, headers: CORS })
})
