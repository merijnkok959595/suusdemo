'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { z } from 'zod'
import { ArrowUp, Mic, MicOff, AudioLines, Phone, MapPin, Building2, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { VoiceOrb } from '@/components/ui/voice-orb'

/* ══════════════════════════════════════════════════════
   2 AGENTS — native SDK handoffs
   setupAgent  →  actiesAgent
   setupAgent: begroeting + google + CRM (éénmalig)
   actiesAgent: alle acties, loopt door de rest van het gesprek
══════════════════════════════════════════════════════ */

type DemoStage = 'lookup' | 'crm' | 'acties'

type CollectedData = {
  bedrijfsnaam?: string
  plaatsnaam?:   string
  naam?:         string   // Google-verified bedrijfsnaam
  adres?:        string
  telefoon?:     string
  contactId?:    string
  contactNaam?:  string   // Voornaam + achternaam uit CRM
  crmStatus?:    'found' | 'created'
}

const TODAY = new Date().toLocaleDateString('nl-NL', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Amsterdam',
})

const BASE_RULES = `Je bent Süüs, de AI sales-assistent — LIVE DEMO.
KRITIEK: Spreek ALTIJD en UITSLUITEND Nederlands, ongeacht de taal van de gebruiker.
KRITIEK: Houd elke respons KORT — maximaal 1–2 zinnen. Geen opsommingen, geen uitleg.
Spreek direct — dit is een gesprek, geen presentatie.

ABSOLUUT VERBODEN:
- Een adres of resultaat zelf bedenken of raden
- Een tool-resultaat voorspellen zonder de tool aan te roepen
- Een contact-ID raden — altijd ophalen via tool
- Vragen wie de gebruiker is of hoe ze heten (de gebruiker is altijd de accountmanager)
- Lead/klant vragen bij contact aanmaken (dat hoort alleen bij bezoek loggen)`

// TODAY wordt onderaan elke instructie toegevoegd zodat de statische prefix gecachet kan worden
const TODAY_LINE = `\nVandaag: ${TODAY}`

const SETUP_INSTRUCTIONS = `${BASE_RULES}

## TAAK: Bedrijf identificeren én contact vastleggen in CRM

# Conversation States
[
  {
    "id": "1_greeting",
    "instructions": [
      "Zeg ALTIJD exact als openingszin: 'Hoi! Ik ben Süüs! Noem de bedrijf- en plaatsnaam, dan help ik je verder.'",
      "Een begroeting zoals 'hallo', 'hoi', 'hey', 'hello' is NOOIT een bedrijfsnaam.",
      "Beide (bedrijfsnaam én plaatsnaam) moeten expliciet zijn voor je verder gaat."
    ],
    "transitions": [{ "next_step": "2_search", "condition": "Zodra je een echte bedrijfsnaam EN plaatsnaam hebt" }]
  },
  {
    "id": "2_search",
    "instructions": [
      "Roep DIRECT google_zoek_adres aan met de bedrijfsnaam en plaatsnaam.",
      "Wacht op het echte resultaat — zeg NIETS voor je het hebt."
    ],
    "transitions": [
      { "next_step": "3_confirm", "condition": "Adres gevonden" },
      { "next_step": "2_search",  "condition": "Niet gevonden — zeg: 'Ik kan dat niet vinden. Kun je het nog eens duidelijk uitspreken? Je mag het ook spellen.' en zoek opnieuw" }
    ]
  },
  {
    "id": "3_confirm",
    "instructions": [
      "Deel het gevonden adres en vraag of het klopt."
    ],
    "transitions": [
      { "next_step": "4_crm",    "condition": "Gebruiker bevestigt dat het klopt" },
      { "next_step": "2_search", "condition": "Klopt niet — roep google_zoek_adres opnieuw aan" }
    ]
  },
  {
    "id": "4_crm",
    "instructions": [
      "Roep DIRECT contact_zoek aan met de bedrijfsnaam en plaatsnaam.",
      "Wacht op het echte resultaat."
    ],
    "transitions": [
      { "next_step": "5_crm_found",   "condition": "Contact gevonden" },
      { "next_step": "5_crm_create",  "condition": "Contact niet gevonden" }
    ]
  },
  {
    "id": "5_crm_found",
    "instructions": [
      "Zeg in één zin wie er gevonden is, bv: 'Ik heb [naam] gevonden in ons systeem.'",
      "Roep DIRECT EN ONMIDDELLIJK transfer_to_acties aan — ZONDER te wachten op gebruikersinput."
    ],
    "transitions": [{ "next_step": "transfer_to_acties", "condition": "Direct na de bevestigingszin" }]
  },
  {
    "id": "5_crm_create_vragen",
    "instructions": [
      "Zeg: 'Dit bedrijf staat nog niet in ons systeem. Ik stel je even een paar vragen.'",
      "Vraag één voor één (wacht steeds op antwoord):",
      "1. Wat is de voornaam van je contactpersoon?",
      "2. Wat is het e-mailadres?",
      "3. Wat is het telefoonnummer?",
      "4. Is dit een lead of een klant? (verplicht)"
    ],
    "transitions": [{ "next_step": "5_crm_create_aanmaken", "condition": "Zodra alle vier vragen beantwoord zijn" }]
  },
  {
    "id": "5_crm_create_aanmaken",
    "instructions": [
      "Roep contact_create aan met: bedrijfsnaam, plaatsnaam, voornaam, email, telefoon én klantType.",
      "Zeg daarna kort: '[naam] aangemaakt als [lead/klant].'",
      "Roep DIRECT EN ONMIDDELLIJK transfer_to_acties aan — ZONDER te wachten op gebruikersinput."
    ],
    "transitions": [{ "next_step": "transfer_to_acties", "condition": "Direct na de bevestigingszin" }]
  }
]

KRITIEK: Na contact gevonden of aangemaakt — roep transfer_to_acties AAN zonder te wachten. Niet pauzeren, niet vragen, gewoon overdragen.
BELANGRIJK: De gebruiker is de accountmanager. Vraag NOOIT wie de gebruiker is of hoe ze heten.${TODAY_LINE}`

const ACTIES_INSTRUCTIONS = `${BASE_RULES}

## TAAK: Acties uitvoeren

Het contact is al gevonden of aangemaakt in de vorige stap — zie de conversatiegeschiedenis.
Gebruik het contactId uit het resultaat van contact_zoek of contact_create voor ALLE tool-aanroepen.
Je hoeft NOOIT opnieuw naar het bedrijf of contactId te vragen — het staat al in de conversatie.

Begroet de overdracht kort, bv: "Wat wil je doen?" of "Waarmee kan ik je helpen?"
Vraag wat de gebruiker wil doen: bezoek loggen, notitie, taak, afspraak, of briefing.
Na elke actie: stel dezelfde vraag opnieuw (geen herstart nodig).

Als de gebruiker een ander bedrijf of contact wil opzoeken: roep DIRECT transfer_to_setup aan.
Voorbeelden: "ik wil een ander contact", "zoek even [bedrijfsnaam]", "we gaan naar [ander bedrijf]".

### Bezoek loggen — vraag één voor één (wacht steeds op antwoord):
1. Samenvatting van het bezoek?
2. Vervolg afspraak of taak nodig? (zo ja: wat en wanneer — stel beide in één zin)
3. Lead of Klant na dit bezoek?
4. Met welke producten werken ze mee?
Roep dan log_bezoek aan met alle antwoorden.

### Overige acties — verzamel alles in één vraag, dan direct uitvoeren:
- Notitie: "Wat wil je noteren?" → note_create
- Taak: "Wat is de taak en wanneer?" → één vraag, wacht op antwoord → task_create
  Als de gebruiker titel én datum in één zin geeft, gebruik dat direct. Vraag NOOIT apart door.
- Afspraak: Als de gebruiker tijdstip al noemt (bv "morgen 12 uur, half uur"), gebruik dat direct → calendar_create
  Alleen als tijdstip ontbreekt: "Wanneer en hoe lang?" → dan calendar_create
  Vraag NOOIT apart naar een "doel" of "titel" — gebruik de context als titel.
- Briefing: geen vraag → contact_briefing direct aanroepen${TODAY_LINE}`

/* ══════════════════════════════════════════════════════
   SHARED STATE — module-level, groeit door alle stages
══════════════════════════════════════════════════════ */

const _collected: CollectedData = {}

const _bridge = {
  stage:   null as null | ((s: DemoStage) => void),
  company: null as null | ((info: Partial<CompanyInfo>) => void),
}

/* ══════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════ */

async function callMcp(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch('/api/suus/tool-call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  })
  const { result } = await res.json()
  return result
}

function getField(r: unknown, ...keys: string[]): string | undefined {
  try {
    const obj = typeof r === 'string' ? JSON.parse(r) : r
    for (const key of keys) {
      const val = (obj as Record<string, unknown>)?.[key]
        ?? (obj as Record<string, Record<string, unknown>>)?.contact?.[key]
        ?? (obj as Record<string, Record<string, unknown>>)?.data?.[key]
      if (typeof val === 'string' && val) return val
    }
  } catch { /* ignore */ }
  return undefined
}

/* ══════════════════════════════════════════════════════
   TOOLS — gegroepeerd per agent
══════════════════════════════════════════════════════ */

const google_zoek_adres_tool = tool({
  name: 'google_zoek_adres',
  description: `Zoek bedrijfsadres via Google Places. Verplicht aanroepen — nooit raden.
Parameters:
- bedrijfsnaam: ALLEEN de bedrijfsnaam, geen voorzetsels ("uit", "in", "te", "van")
- plaatsnaam: ALLEEN de plaatsnaam, geen voorzetsels

Voorbeelden:
- "risottini uit amsterdam" → bedrijfsnaam="risottini", plaatsnaam="Amsterdam"
- "bakker en zonen in rotterdam" → bedrijfsnaam="bakker en zonen", plaatsnaam="Rotterdam"`,
  parameters: z.object({ bedrijfsnaam: z.string(), plaatsnaam: z.string().optional() }),
  execute: async (args) => {
    _bridge.stage?.('lookup')
    _bridge.company?.({ name: args.bedrijfsnaam, city: args.plaatsnaam })
    Object.assign(_collected, { bedrijfsnaam: args.bedrijfsnaam, plaatsnaam: args.plaatsnaam })

    const result = await callMcp('google_zoek_adres', args as Record<string, unknown>)

    const naam     = getField(result, 'naam', 'name') ?? args.bedrijfsnaam
    const adres    = getField(result, 'adres', 'address')
    const telefoon = getField(result, 'telefoon', 'phone')

    Object.assign(_collected, { naam, adres, telefoon })
    _bridge.company?.({ name: naam, address: adres })

    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const contact_zoek_tool = tool({
  name: 'contact_zoek',
  description: 'Zoek een contact op in het CRM. Verplicht aanroepen — nooit raden.',
  parameters: z.object({ bedrijfsnaam: z.string(), plaatsnaam: z.string().optional() }),
  execute: async (args) => {
    _bridge.stage?.('crm')
    const result = await callMcp('contact_zoek', args as Record<string, unknown>)
    const s      = typeof result === 'string' ? result : JSON.stringify(result)

    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(s) } catch { /* ignore */ }

    const found       = parsed?.found === true || parsed?.contact !== undefined
    const contactId   = getField(result, 'id', 'contactId', 'contact_id')
    const contactNaam = getField(result, 'naam', 'name')

    if (contactId) Object.assign(_collected, { contactId, crmStatus: found ? 'found' : undefined, contactNaam })
    if (found) _bridge.company?.({ found: true, contactNaam })

    return s
  },
})

const contact_create_tool = tool({
  name: 'contact_create',
  description: 'Maak een nieuw contact aan in het CRM.',
  parameters: z.object({
    bedrijfsnaam: z.string(),
    plaatsnaam:   z.string().optional(),
    voornaam:     z.string().optional(),
    email:        z.string().optional(),
    telefoon:     z.string().optional(),
    klantType:    z.enum(['Lead', 'Klant']),
  }),
  execute: async (args) => {
    // Map naar veldnamen die de Edge Function verwacht
    const payload: Record<string, unknown> = {
      company_name: args.bedrijfsnaam,
      city:         args.plaatsnaam,
      first_name:   args.voornaam,
      email:        args.email,
      phone:        args.telefoon,
      type:         args.klantType === 'Klant' ? 'customer' : 'lead',
    }
    const result    = await callMcp('contact_create', payload)
    const contactId = getField(result, 'id', 'contactId')
    if (contactId) Object.assign(_collected, { contactId, crmStatus: 'created' })
    _bridge.company?.({ found: false })
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const contact_briefing_tool = tool({
  name: 'contact_briefing',
  description: 'Geeft volledige briefing van een contact.',
  parameters: z.object({ contactId: z.string() }),
  execute: async (args) => {
    const result = await callMcp('contact_briefing', args as Record<string, unknown>)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const contact_update_tool = tool({
  name: 'contact_update',
  description: 'Wijzig velden van een bestaand contact.',
  parameters: z.object({
    contactId: z.string(), bedrijfsnaam: z.string().optional(),
    klantType: z.enum(['Lead', 'Klant']).optional(),
  }),
  execute: async (args) => {
    const result = await callMcp('contact_update', args as Record<string, unknown>)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const note_create_tool = tool({
  name: 'note_create',
  description: 'Voeg een notitie toe aan een contact.',
  parameters: z.object({ contactId: z.string(), body: z.string() }),
  execute: async (args) => {
    const result = await callMcp('note_create', args as Record<string, unknown>)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const task_create_tool = tool({
  name: 'task_create',
  description: 'Maak een taak aan voor een contact.',
  parameters: z.object({ contactId: z.string(), title: z.string(), body: z.string().optional(), dueDate: z.string() }),
  execute: async (args) => {
    const result = await callMcp('task_create', args as Record<string, unknown>)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const calendar_create_tool = tool({
  name: 'calendar_create',
  description: 'Plan een afspraak voor een contact.',
  parameters: z.object({
    contactId: z.string(), title: z.string(),
    startTime: z.string(), endTime: z.string(), notes: z.string().optional(),
  }),
  execute: async (args) => {
    const result = await callMcp('calendar_create', args as Record<string, unknown>)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const log_bezoek_tool = tool({
  name: 'log_bezoek',
  description: 'Log een salesbezoek: notitie + vervolg-taak + contact update.',
  parameters: z.object({
    contactId: z.string(), samenvatting: z.string(),
    vervolgActie: z.string().optional(), vervolgDatum: z.string().optional(),
    klantType: z.enum(['Lead', 'Klant']).optional(), producten: z.string().optional(),
  }),
  execute: async (args) => {
    const result = await callMcp('log_bezoek', args as Record<string, unknown>)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

const get_team_members_tool = tool({
  name: 'get_team_members',
  description: 'Haal teamleden op.',
  parameters: z.object({}),
  execute: async (args) => {
    const result = await callMcp('get_team_members', args as Record<string, unknown>)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})

/* ══════════════════════════════════════════════════════
   2 AGENTS met native handoffs
   actiesAgent eerst definieren (geen circulaire deps nodig)
══════════════════════════════════════════════════════ */

const actiesAgent = new RealtimeAgent({
  name: 'acties',
  handoffDescription: 'Agent voor alle CRM-acties: bezoek loggen, notitie, taak, afspraak, briefing.',
  instructions: ACTIES_INSTRUCTIONS,
  tools: [
    contact_briefing_tool,
    contact_update_tool,
    note_create_tool,
    task_create_tool,
    calendar_create_tool,
    log_bezoek_tool,
    get_team_members_tool,
  ],
  handoffs: [],
})

const setupAgent = new RealtimeAgent({
  name: 'setup',
  handoffDescription: 'Initiële agent: bedrijf identificeren via Google en contact vastleggen in CRM.',
  instructions: SETUP_INSTRUCTIONS,
  tools: [google_zoek_adres_tool, contact_zoek_tool, contact_create_tool],
  handoffs: [actiesAgent],
})

// Circulaire handoff: actiesAgent kan terug naar setupAgent voor nieuw contact
;(actiesAgent.handoffs as RealtimeAgent[]).push(setupAgent)

/* ══════════════════════════════════════════════════════
   UI TYPES & COMPONENTS
══════════════════════════════════════════════════════ */

type CompanyInfo = { name: string; address?: string; city?: string; phone?: string; found?: boolean; contactNaam?: string }
type Msg = { role: 'user' | 'ai'; text: string; streaming?: boolean }

function useCallTimer(active: boolean) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!active) { setSecs(0); return }
    const id = setInterval(() => setSecs(s => s + 1), 1000)
    return () => clearInterval(id)
  }, [active])
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
}

function TypingDots() {
  return <span className="inline-block w-[7px] h-[1.1em] bg-primary rounded-[2px] align-middle animate-[thinkPulse_1s_ease-in-out_infinite] opacity-70" />
}

function CompanyCard({ info, stage }: { info: CompanyInfo | null; stage: DemoStage }) {
  if (!info?.name || stage === 'lookup') return null
  return (
    <div className="mx-4 mb-2 animate-fade-up">
      <div className="max-w-[720px] mx-auto">
        <div className="flex items-start gap-3 px-4 py-3 bg-surface border border-border rounded-[14px] shadow-card">
          <div className="w-9 h-9 rounded-[10px] bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Building2 size={17} className="text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[14px] font-semibold text-primary">{info.name}</p>
              {info.found !== undefined && (
                <span className={cn(
                  'text-[10px] font-semibold px-2 py-0.5 rounded-full',
                  info.found ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700',
                )}>
                  {info.found ? '✓ Gevonden in CRM' : '+ Aangemaakt in CRM'}
                </span>
              )}
            </div>
            {info.contactNaam && (
              <p className="text-[12px] text-secondary font-medium mt-0.5">{info.contactNaam}</p>
            )}
            {(info.address || info.city) && (
              <div className="flex items-center gap-1 mt-0.5">
                <MapPin size={11} className="text-muted flex-shrink-0" />
                <p className="text-[12px] text-muted truncate">
                  {[info.address, info.city].filter(Boolean).join(', ')}
                </p>
              </div>
            )}
          </div>
          {stage === 'crm' && <Loader2 size={16} className="text-muted animate-spin flex-shrink-0 mt-1" />}
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════
   PAGE
══════════════════════════════════════════════════════ */
export default function SuusPage() {
  const [msgs,         setMsgs]         = useState<Msg[]>([])
  const [input,        setInput]        = useState('')
  const [callStatus,   setCallStatus]   = useState<'idle' | 'connecting' | 'active'>('idle')
  const [agentTalking, setAgentTalking] = useState(false)
  const [userTalking,  setUserTalking]  = useState(false)
  const [muted,        setMuted]        = useState(false)
  const [demoStage,    setDemoStage]    = useState<DemoStage>('lookup')
  const [company,      setCompany]      = useState<CompanyInfo | null>(null)

  const sessionRef        = useRef<RealtimeSession | null>(null)
  const streamingRef      = useRef(false)
  const streamingTextRef  = useRef('')
  const userStreamRef     = useRef(false)
  const userStreamTextRef = useRef('')
  const bottomRef         = useRef<HTMLDivElement>(null)
  const textareaRef       = useRef<HTMLTextAreaElement>(null)
  const callBarsRef       = useRef<(HTMLDivElement | null)[]>([])
  const callAnalyserRef   = useRef<AnalyserNode | null>(null)
  const callAudioCtxRef   = useRef<AudioContext | null>(null)
  const callAnimFrameRef  = useRef<number>(0)
  const localStreamRef    = useRef<MediaStream | null>(null)
  const timer             = useCallTimer(callStatus === 'active')

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  /* Wire bridge into component */
  useEffect(() => {
    _bridge.stage   = (s) => setDemoStage(s)
    _bridge.company = (info) => setCompany(prev => ({ ...(prev ?? { name: '' }), ...info }))
    return () => { _bridge.stage = null; _bridge.company = null }
  }, [])

  /* Visualizer */
  function startVisualizer(stream: MediaStream) {
    const ctx = new AudioContext(); callAudioCtxRef.current = ctx
    const an  = ctx.createAnalyser(); an.fftSize = 32; an.smoothingTimeConstant = 0.8
    ctx.createMediaStreamSource(stream).connect(an)
    callAnalyserRef.current = an
    const data = new Uint8Array(an.frequencyBinCount)
    function draw() {
      if (!callAnalyserRef.current) return
      callAnalyserRef.current.getByteFrequencyData(data)
      callBarsRef.current.forEach((bar, i) => {
        if (!bar) return
        const v = data[Math.min(Math.floor(i / 3 * data.length / 2), data.length - 1)] / 255
        bar.style.height = `${3 + v * 13}px`
      })
      callAnimFrameRef.current = requestAnimationFrame(draw)
    }
    draw()
  }

  function stopVisualizer() {
    cancelAnimationFrame(callAnimFrameRef.current)
    callAnalyserRef.current = null
    callAudioCtxRef.current?.close(); callAudioCtxRef.current = null
  }

  /* Call */
  async function toggleCall() {
    if (sessionRef.current) {
      try { (sessionRef.current as RealtimeSession & { close?: () => void }).close?.() } catch { /* ignore */ }
      sessionRef.current = null
      localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null
      stopVisualizer()
      streamingRef.current = false; streamingTextRef.current = ''
      userStreamRef.current = false; userStreamTextRef.current = ''
      Object.keys(_collected).forEach(k => delete (_collected as Record<string, unknown>)[k])
      setCallStatus('idle'); setAgentTalking(false); setUserTalking(false); setMuted(false)
      setDemoStage('lookup'); setCompany(null); setMsgs([])
      return
    }

    setCallStatus('connecting')
    try {
      const tokenRes = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const { client_secret, error } = await tokenRes.json() as { client_secret?: { value: string }; error?: string }
      if (!client_secret?.value) throw new Error(error ?? 'No client secret')

      const session = new RealtimeSession(setupAgent, {
        model: 'gpt-4o-realtime-preview-2025-06-03',
        config: {
          outputModalities: ['audio'],
          audio: {
            input: {
              transcription: { model: 'gpt-4o-transcribe' },
              turnDetection: {
                type: 'server_vad', threshold: 0.5,
                prefixPaddingMs: 300, silenceDurationMs: 900,
              },
            },
            output: { voice: 'shimmer' },
          },
        },
      })

      /* Agent handoff → update UI stage */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.on('agent_handoff', (data: any) => {
        try {
          const history   = data?.context?.history ?? []
          const lastMsg   = history[history.length - 1]
          const agentName = (lastMsg?.name ?? '').replace(/^transfer_to_/, '')
          if (agentName === 'acties') {
            setDemoStage('acties')
            _bridge.stage?.('acties')
          } else if (agentName === 'setup') {
            // Nieuw contact — reset UI en _collected
            Object.keys(_collected).forEach(k => delete (_collected as Record<string, unknown>)[k])
            setDemoStage('lookup')
            setCompany(null)
            _bridge.stage?.('lookup')
          }
        } catch { /* ignore */ }
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.transport.on('*', (ev: any) => {
        switch (ev.type) {

          /* ── VAD ── */
          case 'input_audio_buffer.speech_started': setUserTalking(true);  break
          case 'input_audio_buffer.speech_stopped': setUserTalking(false); break
          case 'response.output_audio.delta':       setAgentTalking(true);  break
          case 'response.output_audio.done':
          case 'response.done':                     setAgentTalking(false); break

          /* ── Agent streaming transcript ── */
          case 'response.output_audio_transcript.delta': {
            const delta: string = ev.delta ?? ''
            if (!streamingRef.current) {
              streamingRef.current = true; streamingTextRef.current = delta
              setMsgs(p => [...p, { role: 'ai', text: delta, streaming: true }])
            } else {
              streamingTextRef.current += delta
              const text = streamingTextRef.current
              setMsgs(p => {
                const next = [...p]; const i = next.findLastIndex(m => m.role === 'ai')
                if (i >= 0) next[i] = { ...next[i], text }; return next
              })
            }
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            break
          }
          case 'response.output_audio_transcript.done':
            streamingRef.current = false; streamingTextRef.current = ''
            setMsgs(p => p.map((m, i) => i === p.length - 1 && m.role === 'ai' ? { ...m, streaming: false } : m))
            break

          /* ── User streaming transcript ── */
          case 'conversation.item.input_audio_transcription.delta': {
            const delta: string = ev.delta ?? ''
            if (!userStreamRef.current) {
              userStreamRef.current = true; userStreamTextRef.current = delta
              setMsgs(p => [...p, { role: 'user', text: delta, streaming: true }])
            } else {
              userStreamTextRef.current += delta
              const text = userStreamTextRef.current
              setMsgs(p => {
                const next = [...p]; const i = next.findLastIndex(m => m.role === 'user')
                if (i >= 0 && next[i].streaming) next[i] = { ...next[i], text }; return next
              })
            }
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            break
          }
          case 'conversation.item.input_audio_transcription.completed': {
            const t: string = ev.transcript?.trim() ?? ''
            userStreamRef.current = false; userStreamTextRef.current = ''
            if (t) {
              setMsgs(p => {
                const next  = [...p]
                const last  = next.findLastIndex(m => m.role === 'user')
                if (last >= 0 && next[last].streaming) {
                  next[last] = { role: 'user', text: t, streaming: false }
                } else if (t) {
                  next.push({ role: 'user', text: t })
                }
                return next
              })
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            }
            break
          }
        }
      })

      await session.connect({ apiKey: client_secret.value })
      sessionRef.current = session
      setCallStatus('active')

      // Stuur transcription config + trigger eerste begroeting
      setTimeout(() => {
        session.transport.sendEvent({
          type: 'session.update',
          session: { input_audio_transcription: { model: 'gpt-4o-transcribe' } },
        })
        setTimeout(() => session.transport.sendEvent({ type: 'response.create' }), 100)
      }, 300)

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        localStreamRef.current = stream; startVisualizer(stream)
      } catch { /* visualizer optional */ }

    } catch (err) {
      console.error('[voice]', err); setCallStatus('idle')
    }
  }

  function toggleMute() {
    const s = sessionRef.current; if (!s) return
    const next = !muted; s.mute(next); setMuted(next)
  }

  /* Text chat */
  function resizeTextarea() {
    const el = textareaRef.current; if (!el) return
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return
    setInput(''); setTimeout(resizeTextarea, 0)
    setMsgs(p => [...p, { role: 'user', text }, { role: 'ai', text: '', streaming: true }])
    try {
      const res = await fetch('/api/suus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) })
      if (!res.ok || !res.body) throw new Error()
      const reader = res.body.getReader(); const dec = new TextDecoder(); let full = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        full += dec.decode(value, { stream: true })
        setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, text: full } : m))
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
      setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, streaming: false } : m))
    } catch {
      setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, text: 'Er ging iets mis.', streaming: false } : m))
    }
  }, [])

  const hasContent   = !!input.trim()
  const callIsActive = callStatus !== 'idle'

  /* Render */
  return (
    <div className="flex flex-col bg-bg flex-1 overflow-hidden">

      {/* Call bar */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border flex-shrink-0">
        <span className="text-[12px] text-muted font-medium">
          {callIsActive ? (agentTalking ? 'Süüs spreekt…' : userTalking ? 'Luistert…' : 'Gesprek actief') : 'Spraak-demo'}
        </span>
        <button
          onClick={toggleCall}
          className={cn(
            'inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-semibold rounded-full transition-all',
            callIsActive ? 'bg-red-500/10 text-red-500 hover:bg-red-500/15' : 'bg-primary text-white hover:opacity-85',
          )}
        >
          <Phone size={13} strokeWidth={2} />
          {callStatus === 'connecting' ? 'Verbinden…' : callIsActive ? `Ophangen  ${timer}` : 'Bellen'}
        </button>
      </div>

      {/* Company card */}
      <div className="flex-shrink-0 pt-2">
        <CompanyCard info={company} stage={demoStage} />
      </div>

      {/* Message feed */}
      <div className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:theme(colors.border)_transparent]">
        <div className="max-w-[680px] mx-auto px-4 pt-4 pb-4 flex flex-col max-sm:px-3">

          {msgs.length === 0 && callIsActive && (
            <div className="flex flex-col items-center gap-3 pt-8 pb-4 animate-fade-up">
              <VoiceOrb
                state={callStatus === 'connecting' ? 'connecting' : agentTalking ? 'speaking' : userTalking ? 'listening' : 'idle'}
                size={72}
              />
              <p className="text-[13px] text-muted">
                {callStatus === 'connecting' ? 'Verbinden…' : agentTalking ? 'Süüs spreekt…' : userTalking ? 'Luisteren…' : 'Zeg iets…'}
              </p>
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className="py-1 animate-msg-in">
              {m.role === 'user' ? (
                <div className="flex justify-end">
                  <div className={cn(
                    'text-[14px] leading-[1.65] max-w-[75%] whitespace-pre-wrap break-words px-3.5 py-2 rounded-2xl shadow-card',
                    m.streaming ? 'text-muted bg-active' : 'text-[#0d0d0d] bg-white',
                  )}>
                    {m.text}{m.streaming && <TypingDots />}
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 items-start max-w-[85%]">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[9px] font-black text-primary">S</span>
                  </div>
                  <div className="text-[14px] leading-[1.65] text-[#1a1a1a]">
                    {m.streaming ? (
                      <span className="whitespace-pre-wrap break-words">{m.text}<TypingDots /></span>
                    ) : (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p:      ({children}) => <p className="mb-1.5 last:mb-0">{children}</p>,
                          strong: ({children}) => <strong className="font-semibold">{children}</strong>,
                          ul:     ({children}) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>,
                          li:     ({children}) => <li>{children}</li>,
                        }}
                      >{m.text}</ReactMarkdown>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 flex-shrink-0 border-t border-border">
        <div className="max-w-[680px] mx-auto">
          <div className="flex items-center gap-2 px-4 py-3 border border-border rounded-[24px] bg-surface shadow-[0_2px_12px_rgba(0,0,0,.06)]">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); resizeTextarea() }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) } }}
              placeholder="Stel een vraag of bel SUUS…"
              rows={1}
              className="flex-1 resize-none border-none bg-transparent text-[15px] text-primary outline-none leading-[1.5] max-h-32 overflow-y-auto p-0 font-[inherit] placeholder:text-muted"
            />
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {callIsActive && (
                <>
                  <VoiceOrb
                    state={callStatus === 'connecting' ? 'connecting' : agentTalking ? 'speaking' : userTalking ? 'listening' : 'idle'}
                    size={24}
                  />
                  <button
                    onClick={toggleMute}
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center transition-colors',
                      muted ? 'bg-red-100 text-red-500' : 'text-muted hover:text-primary',
                    )}
                  >
                    {muted ? <MicOff size={14} /> : <Mic size={14} />}
                  </button>
                  <button onClick={toggleCall} className="flex items-center gap-1.5 pl-2.5 pr-3 h-8 bg-[#007AFF] text-white rounded-full text-[12px] font-semibold hover:opacity-90">
                    <div className="flex items-center gap-[2px]">
                      {[0,1,2].map(i => (
                        <div key={i} ref={el => { callBarsRef.current[i] = el }}
                          className="w-[2.5px] rounded-full bg-white transition-[height] duration-75" style={{ height: '3px' }} />
                      ))}
                    </div>
                    {timer}
                  </button>
                </>
              )}
              {!callIsActive && (
                <button
                  onClick={() => { if (hasContent) sendMessage(input); else toggleCall() }}
                  className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center hover:opacity-85 transition-opacity"
                >
                  {hasContent ? <ArrowUp size={16} strokeWidth={2.5} /> : <AudioLines size={16} strokeWidth={2} />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
