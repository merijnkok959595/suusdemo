'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { z } from 'zod'
import { ArrowUp, Mic, MicOff, AudioLines, Phone, MapPin, Building2, Loader2, X, Plus, ImageIcon, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { VoiceOrb } from '@/components/ui/voice-orb'
import BriefingCard, { type BriefingData } from '@/components/BriefingCard'
import { ExternalLink } from 'lucide-react'
import { normalizeEmail, normalizePhone } from '@/lib/suus-tools'
import { SETUP_INSTRUCTIONS, ACTIES_INSTRUCTIONS } from '@/lib/suus-prompts'

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


/* ══════════════════════════════════════════════════════
   SHARED STATE — module-level, groeit door alle stages
══════════════════════════════════════════════════════ */

const _collected: CollectedData = {}

const _bridge = {
  stage:      null as null | ((s: DemoStage) => void),
  company:    null as null | ((info: Partial<CompanyInfo>) => void),
  companyMsg: null as null | ((info: CompanyInfo) => void),  // injects card into chat
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
    if (found) {
      _bridge.company?.({ found: true, contactNaam })
      // Inject company card into chat — delayed so session handoff isn't blocked
      setTimeout(() => {
        const card: CompanyInfo = {
          name:        getField(result, 'bedrijf', 'company_name', 'companyName') ?? _collected.naam ?? args.bedrijfsnaam,
          address:     getField(result, 'adres', 'address') ?? _collected.adres,
          city:        getField(result, 'stad', 'city') ?? args.plaatsnaam,
          phone:       getField(result, 'telefoon', 'phone') ?? _collected.telefoon,
          contactNaam,
          found:       true,
        }
        _bridge.companyMsg?.(card)
      }, 0)
    }

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
      email:        normalizeEmail(args.email),
      phone:        normalizePhone(args.telefoon),
      type:         args.klantType === 'Klant' ? 'customer' : 'lead',
    }
    const result    = await callMcp('contact_create', payload)
    const contactId = getField(result, 'id', 'contactId')
    if (contactId) Object.assign(_collected, { contactId, crmStatus: 'created' })
    _bridge.company?.({ found: false })
    setTimeout(() => {
      const card: CompanyInfo = {
        name:        args.bedrijfsnaam,
        city:        args.plaatsnaam,
        contactNaam: args.voornaam,
        found:       false,
      }
      _bridge.companyMsg?.(card)
    }, 0)
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
type ContactCardData = { contactId: string; companyName: string | null; firstName: string | null; lastName: string | null; city: string | null; phone: string | null }
type Msg = { role: 'user' | 'ai'; text: string; streaming?: boolean; image_url?: string; briefingData?: BriefingData; contactsData?: ContactCardData[]; companyData?: CompanyInfo }

/* ── WAV encoder (PCM 16-bit mono) ──────────────────────────────────────── */
function encodeWav(decoded: AudioBuffer): ArrayBuffer {
  const samples = decoded.getChannelData(0)
  const pcm     = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i]  = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const dataLen = pcm.byteLength
  const buf     = new ArrayBuffer(44 + dataLen)
  const view    = new DataView(buf)
  const write   = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true)
  write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, decoded.sampleRate, true)
  view.setUint32(28, decoded.sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, dataLen, true)
  new Int16Array(buf, 44).set(pcm)
  return buf
}

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
const SUGGESTIONS = [
  'Risottini in Amsterdam',
  'Bezoek loggen',
  'Taak aanmaken',
  'Briefing opvragen',
]

export default function SuusPage() {
  const [msgs,         setMsgs]         = useState<Msg[]>([])
  const [input,        setInput]        = useState('')
  const [callStatus,   setCallStatus]   = useState<'idle' | 'connecting' | 'active'>('idle')
  const [agentTalking, setAgentTalking] = useState(false)
  const [userTalking,  setUserTalking]  = useState(false)
  const [muted,        setMuted]        = useState(false)
  const [demoStage,    setDemoStage]    = useState<DemoStage>('lookup')
  const [company,      setCompany]      = useState<CompanyInfo | null>(null)
  const [agentPhoto]                    = useState<string>('/suus.jpg')
  const [dictating,      setDictating]      = useState(false)
  const [transcribing,   setTranscribing]   = useState(false)
  const [pendingImage,   setPendingImage]   = useState<{ url: string; base64: string } | null>(null)
  const [attachOpen,     setAttachOpen]     = useState(false)

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
  const dictRecorderRef   = useRef<MediaRecorder | null>(null)
  const dictAnalyserRef   = useRef<AnalyserNode | null>(null)
  const dictAudioCtxRef   = useRef<AudioContext | null>(null)
  const dictAnimFrameRef  = useRef<number>(0)
  const dictBarsRef       = useRef<(HTMLDivElement | null)[]>([])
  const imageInputRef     = useRef<HTMLInputElement>(null)
  const attachRef         = useRef<HTMLDivElement>(null)
  const timer             = useCallTimer(callStatus === 'active')

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  /* Close attach dropdown on outside click */
  useEffect(() => {
    if (!attachOpen) return
    const h = (e: MouseEvent) => {
      if (attachRef.current && !attachRef.current.contains(e.target as Node)) setAttachOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [attachOpen])

  /* Paste image from clipboard */
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'))
      if (!item) return
      const file = item.getAsFile(); if (!file) return
      const r = new FileReader()
      r.onload = ev => { const url = ev.target?.result as string; setPendingImage({ url, base64: url }) }
      r.readAsDataURL(file)
    }
    window.addEventListener('paste', h)
    return () => window.removeEventListener('paste', h)
  }, [])

  /* Wire bridge into component */
  useEffect(() => {
    _bridge.stage      = (s) => setDemoStage(s)
    _bridge.company    = (info) => setCompany(prev => ({ ...(prev ?? { name: '' }), ...info }))
    _bridge.companyMsg = (info) => setMsgs(p => [...p, { role: 'ai', text: '', companyData: info }])
    return () => { _bridge.stage = null; _bridge.company = null; _bridge.companyMsg = null }
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
    if (sessionRef.current || callStatus === 'active') {
      try { (sessionRef.current as RealtimeSession & { close?: () => void }).close?.() } catch { /* ignore */ }
      sessionRef.current = null
      localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null
      stopVisualizer()
      streamingRef.current = false; streamingTextRef.current = ''
      userStreamRef.current = false; userStreamTextRef.current = ''

      // Stuur summary email
      const snapMsgs    = msgs.filter(m => m.text?.trim())
      const snapCompany = company
      const snapTimer   = timer
      if (snapMsgs.length > 0) {
        fetch('/api/send-summary', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ msgs: snapMsgs, company: snapCompany, duration: snapTimer }),
        }).catch(() => {/* fire and forget */})
      }

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
        model: 'gpt-realtime-1.5',
        config: {
          outputModalities: ['audio'],
          audio: {
            input: {
              transcription: { model: 'gpt-4o-transcribe', language: 'nl' },
              turnDetection: {
                type: 'server_vad', threshold: 0.5,
                prefixPaddingMs: 300, silenceDurationMs: 900,
              },
            },
            output: { voice: 'marin' },
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
          session: { input_audio_transcription: { model: 'gpt-4o-transcribe', language: 'nl' } },
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

  /* Dictation */
  function stopDictVisualizer() {
    cancelAnimationFrame(dictAnimFrameRef.current)
    dictAnalyserRef.current = null
    dictAudioCtxRef.current?.close()
    dictAudioCtxRef.current = null
  }

  async function startDictate() {
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioCtx = new AudioContext()
      dictAudioCtxRef.current = audioCtx
      const source   = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      dictAnalyserRef.current = analyser
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const allChunks: Blob[] = []

      const drawBars = () => {
        if (!dictAnalyserRef.current) return
        dictAnalyserRef.current.getByteFrequencyData(dataArray)
        dictBarsRef.current.forEach((bar, i) => {
          if (!bar) return
          const v = dataArray[Math.min(Math.floor((i / dictBarsRef.current.length) * dataArray.length), dataArray.length - 1)] / 255
          bar.style.height = `${3 + v * 30}px`
        })
        dictAnimFrameRef.current = requestAnimationFrame(drawBars)
      }
      drawBars()

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')  ? 'audio/mp4' : ''
      const mr = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128000 })
      mr.ondataavailable = e => { if (e.data.size > 0) allChunks.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blobType   = mr.mimeType || mimeType || 'audio/webm'
        const blob       = new Blob(allChunks, { type: blobType })
        let finalBlob    = blob, fileName = 'recording.webm'
        try {
          const ab      = await blob.arrayBuffer()
          const decoded = await audioCtx.decodeAudioData(ab)
          const wavBuf  = encodeWav(decoded)
          finalBlob = new Blob([wavBuf], { type: 'audio/wav' }); fileName = 'recording.wav'
        } catch { /* fallback */ }
        stopDictVisualizer()
        setTranscribing(true)
        try {
          const fd  = new FormData(); fd.append('audio', finalBlob, fileName)
          const res = await fetch('/api/transcribe', { method: 'POST', body: fd })
          const data = await res.json() as { text?: string }
          if (data.text) {
            setInput(prev => prev ? `${prev} ${data.text}` : data.text!)
            setTimeout(resizeTextarea, 0)
            textareaRef.current?.focus()
          }
        } catch { /* ignore */ } finally { setTranscribing(false) }
      }
      mr.start(100); dictRecorderRef.current = mr; setDictating(true)
    } catch { alert('Microfoon toegang vereist.') }
  }

  function stopDictate() {
    dictRecorderRef.current?.stop()
    dictRecorderRef.current = null
    setDictating(false)
  }

  function cancelDictate() {
    if (dictRecorderRef.current) {
      dictRecorderRef.current.ondataavailable = null
      dictRecorderRef.current.onstop = null
      dictRecorderRef.current.stop()
      dictRecorderRef.current = null
    }
    stopDictVisualizer()
    setDictating(false); setTranscribing(false)
  }

  function onImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const r = new FileReader()
    r.onload = ev => { const url = ev.target?.result as string; setPendingImage({ url, base64: url }) }
    r.readAsDataURL(file)
    e.target.value = ''; setAttachOpen(false)
  }

  /* Text chat */
  function resizeTextarea() {
    const el = textareaRef.current; if (!el) return
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  const sendMessage = useCallback(async (text: string, imageUrl?: string) => {
    if (!text.trim() && !imageUrl) return
    setInput(''); setPendingImage(null); setTimeout(resizeTextarea, 0)
    setMsgs(p => [...p, { role: 'user', text, image_url: imageUrl }, { role: 'ai', text: '', streaming: true }])
    try {
      const res = await fetch('/api/suus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text || '(afbeelding)' }) })
      if (!res.ok || !res.body) throw new Error()
      const reader = res.body.getReader(); const dec = new TextDecoder(); let full = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        full += dec.decode(value, { stream: true })

        const briefingMatch = full.match(/\n__BRIEFING__:(.+)/)
        const contactsMatch = full.match(/\n__CONTACTS__:(.+)/)
        const companyMatch  = full.match(/\n__COMPANY__:(.+)/)

        // Strip all markers for display
        const visText = full
          .replace(/\n__BRIEFING__:.+/, '')
          .replace(/\n__CONTACTS__:.+/, '')
          .replace(/\n__COMPANY__:.+/, '')
          .trim()

        const extra: Partial<Msg> = {}
        if (briefingMatch) { try { extra.briefingData  = JSON.parse(briefingMatch[1]) as BriefingData } catch { /* ignore */ } }
        if (contactsMatch)  { try { extra.contactsData = (JSON.parse(contactsMatch[1]) as { contacts: ContactCardData[] }).contacts } catch { /* ignore */ } }
        if (companyMatch)   { try { extra.companyData  = JSON.parse(companyMatch[1]) as CompanyInfo } catch { /* ignore */ } }

        const hasMarker = briefingMatch || contactsMatch || companyMatch
        setMsgs(p => p.map((m, i) => i === p.length - 1
          ? { ...m, text: visText, ...extra, streaming: hasMarker ? false : m.streaming }
          : m,
        ))
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
      setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, streaming: false } : m))
    } catch {
      setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, text: 'Er ging iets mis.', streaming: false } : m))
    }
  }, [])

  const hasContent   = !!(input.trim() || pendingImage)
  const callIsActive = callStatus !== 'idle'

  function orbState() {
    if (callStatus === 'connecting') return 'connecting' as const
    if (agentTalking) return 'speaking' as const
    if (userTalking)  return 'listening' as const
    return 'idle' as const
  }

  /* Render */
  return (
    <div className="flex flex-col bg-bg flex-1 overflow-hidden" style={{ height: 'calc(100svh - var(--nav-height, 0px))' }}>

      {/* ── Top pill button ── */}
      <div className="flex-shrink-0 px-4 pt-3 pb-1">
        <div className="max-w-[760px] mx-auto flex justify-end">
          <button
            onClick={toggleCall}
            className={cn(
              'inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-medium rounded-full transition-all shadow-sm',
              callIsActive
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-primary text-white hover:opacity-85',
            )}
          >
            <Phone size={13} strokeWidth={2} />
            {callStatus === 'connecting' ? 'Verbinden…' : callIsActive ? `Ophangen ${timer}` : 'Bellen'}
          </button>
        </div>
      </div>


      {/* ── Message feed ── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [scrollbar-color:theme(colors.border)_transparent]">
        <div className="max-w-[720px] mx-auto w-full px-4 sm:px-6 pt-8 pb-4 flex flex-col">

          {/* Empty state */}
          {msgs.length === 0 && (
            <div className="flex flex-col items-center gap-5 pt-16 pb-8 animate-fade-up">
              <VoiceOrb state={callIsActive ? orbState() : 'idle'} size={100} imageSrc={agentPhoto} />
              <div className="text-center">
                <h2 className="text-[22px] font-bold tracking-tight text-primary mb-1 max-sm:text-lg">
                  Hoi! Ik ben Suus.
                </h2>
                <p className="text-[13px] text-muted">
                  {callIsActive
                    ? (callStatus === 'connecting' ? 'Verbinden…' : agentTalking ? 'Suus spreekt…' : userTalking ? 'Luisteren…' : 'Zeg iets…')
                    : 'Start een gesprek of typ een vraag'}
                </p>
              </div>
              {!callIsActive && (
                <div className="grid grid-cols-2 gap-2 w-full max-w-[420px]">
                  {SUGGESTIONS.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(s)}
                      className="px-3.5 py-2.5 rounded-[10px] border border-border bg-surface text-xs font-medium text-primary text-left leading-snug transition-colors hover:bg-active"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Messages */}
          {msgs.map((m, i) => (
            <div key={i} className="py-2 animate-msg-in">
              {m.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="max-w-[75%] max-sm:max-w-[85%]">
                    <p className="text-[11px] font-bold text-primary mb-1 text-right">Jij</p>
                    <div className="text-[14.5px] leading-[1.6] text-muted whitespace-pre-wrap break-words bg-white px-5 py-3 rounded-[22px] shadow-card">
                      {m.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.image_url} alt="bijlage" className="max-w-[200px] max-h-[150px] rounded-lg object-cover block mb-1.5" />
                      )}
                      {m.text}{m.streaming && <TypingDots />}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex gap-3 items-start">
                  <div className="flex-shrink-0 mt-0.5">
                    <VoiceOrb state={m.streaming ? orbState() : 'idle'} size={28} imageSrc={agentPhoto} />
                  </div>
                  <div className="min-w-0 max-w-[520px]">
                    <p className="text-[11px] font-bold text-primary mb-1">Suus</p>
                    {m.text && (
                      <div className="text-[14.5px] leading-[1.6] text-[#1a1a1a]">
                        {m.streaming ? (
                          <span className="whitespace-pre-wrap break-words">{m.text}<TypingDots /></span>
                        ) : (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              p:      ({children}) => <p className="mb-2 last:mb-0">{children}</p>,
                              strong: ({children}) => <strong className="font-semibold text-primary">{children}</strong>,
                              ul:     ({children}) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
                              ol:     ({children}) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
                              li:     ({children}) => <li className="leading-[1.6]">{children}</li>,
                            }}
                          >{m.text}</ReactMarkdown>
                        )}
                      </div>
                    )}
                    {!m.text && m.streaming && <TypingDots />}

                    {/* Inline company card (text chat result) */}
                    {m.companyData && !m.streaming && (
                      <div className="mt-2.5 max-w-[420px]">
                        <div className="flex items-start gap-3 px-4 py-3 bg-surface border border-border rounded-[14px] shadow-card">
                          <div className="w-9 h-9 rounded-[10px] bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Building2 size={17} className="text-primary" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[14px] font-semibold text-primary">{m.companyData.name}</span>
                              {m.companyData.found !== undefined && (
                                <span className={cn(
                                  'text-[10px] font-semibold px-2 py-0.5 rounded-full',
                                  m.companyData.found ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
                                )}>
                                  {m.companyData.found ? '✓ Gevonden in CRM' : '+ Aangemaakt in CRM'}
                                </span>
                              )}
                            </div>
                            {m.companyData.contactNaam && (
                              <p className="text-[12px] text-secondary font-medium mt-0.5">{m.companyData.contactNaam}</p>
                            )}
                            {(m.companyData.address || m.companyData.city) && (
                              <div className="flex items-center gap-1 mt-1">
                                <MapPin size={11} className="text-muted flex-shrink-0" />
                                <span className="text-[12px] text-muted">
                                  {[m.companyData.address, m.companyData.city].filter(Boolean).join(', ')}
                                </span>
                              </div>
                            )}
                            {m.companyData.phone && (
                              <p className="text-[11px] text-muted mt-0.5">{m.companyData.phone}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Briefing card */}
                    {m.briefingData && !m.streaming && (
                      <div className="mt-2.5">
                        <BriefingCard data={m.briefingData} />
                      </div>
                    )}

                    {/* Contact selector cards */}
                    {m.contactsData && m.contactsData.length > 0 && !m.streaming && (
                      <div className="mt-2 flex flex-col gap-1.5 max-w-[420px]">
                        {m.contactsData.map(c => {
                          const name = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact'
                          const sub  = c.companyName ? [c.firstName, c.lastName].filter(Boolean).join(' ') : null
                          return (
                            <div key={c.contactId} className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-border bg-surface hover:bg-active transition-colors">
                              <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-semibold text-primary truncate">{name}</div>
                                {(sub || c.city) && (
                                  <div className="text-[11px] text-muted truncate">{[sub, c.city].filter(Boolean).join(' · ')}</div>
                                )}
                              </div>
                              <button
                                onClick={() => sendMessage(`Briefing voor ${name} (contactId: ${c.contactId})`)}
                                className="px-2.5 py-1 text-[11px] font-semibold bg-primary text-white rounded-lg border-none cursor-pointer hover:opacity-85 transition-opacity flex-shrink-0"
                              >
                                Briefing
                              </button>
                              <ExternalLink size={12} className="text-muted flex-shrink-0" />
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Image preview ── */}
      {pendingImage && (
        <div className="max-w-[760px] mx-auto px-4 pb-1.5 flex items-center gap-2">
          <div className="relative inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pendingImage.url} alt="preview" className="h-11 w-11 object-cover rounded-lg border border-border" />
            <button
              onClick={() => setPendingImage(null)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center border-none cursor-pointer"
            >
              <X size={9} />
            </button>
          </div>
          <span className="text-[11px] text-muted">Afbeelding bijgevoegd</span>
        </div>
      )}

      {/* ── Input bar ── */}
      <div className="px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 flex-shrink-0 border-t border-border">
        <div className="max-w-[760px] mx-auto">

          {(dictating || transcribing) && !callIsActive ? (
            /* Waveform bar during dictation */
            <div className="flex items-center gap-3 px-4 py-4 border border-border rounded-[28px] bg-surface shadow-[0_2px_12px_rgba(0,0,0,.07)]">
              <div className="flex-1 flex items-center justify-center gap-[2px] h-9 overflow-hidden">
                {Array.from({ length: 72 }, (_, i) => (
                  <div
                    key={i}
                    ref={el => { dictBarsRef.current[i] = el }}
                    className={cn('w-[3px] rounded-full origin-center transition-[height] duration-75',
                      transcribing ? 'bg-muted/40' : 'bg-primary')}
                    style={{ height: '3px' }}
                  />
                ))}
              </div>
              <button onClick={cancelDictate} title="Annuleer"
                className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:text-red-500 transition-colors flex-shrink-0 border-none bg-transparent cursor-pointer">
                <X size={18} strokeWidth={2} />
              </button>
              <button onClick={stopDictate} disabled={transcribing} title="Stop en transcribeer"
                className="w-9 h-9 rounded-full bg-primary text-white flex items-center justify-center hover:opacity-85 transition-opacity disabled:opacity-40 flex-shrink-0 border-none cursor-pointer">
                <Check size={16} strokeWidth={2.5} />
              </button>
            </div>
          ) : (
            /* Normal input pill */
            <div className="flex items-center gap-3 px-4 py-4 border border-border rounded-[28px] bg-surface shadow-[0_2px_12px_rgba(0,0,0,.07),0_0_0_1px_rgba(0,0,0,.03)] hover:shadow-[0_4px_18px_rgba(0,0,0,.1)] transition-shadow">

              {/* Paperclip / attach */}
              <input ref={imageInputRef} type="file" accept="image/*" onChange={onImageFile} className="hidden" />
              <div className="relative flex-shrink-0" ref={attachRef}>
                {attachOpen && (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 bg-surface border border-border rounded-[12px] shadow-[0_4px_20px_rgba(0,0,0,.12)] overflow-hidden min-w-[140px] z-50">
                    <button
                      className="flex items-center gap-2 px-3.5 py-2.5 text-xs font-medium text-primary w-full hover:bg-active transition-colors border-none bg-transparent cursor-pointer"
                      onClick={() => imageInputRef.current?.click()}
                    >
                      <ImageIcon size={13} className="text-muted" /> Afbeelding
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setAttachOpen(p => !p)}
                  title="Bijlage"
                  className={cn('w-8 h-8 rounded-full flex items-center justify-center text-muted hover:text-primary transition-colors border-none bg-transparent cursor-pointer', pendingImage && 'text-primary')}
                >
                  <Plus size={22} strokeWidth={1.5} />
                </button>
              </div>

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => { setInput(e.target.value); resizeTextarea() }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input, pendingImage?.base64) } }}
                placeholder="Vraag Suus iets…"
                rows={1}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 resize-none border-none bg-transparent text-[16px] text-primary outline-none leading-[1.55] max-h-40 overflow-y-auto p-0 font-[inherit] placeholder:text-muted"
              />

              {/* Right icons */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {callIsActive ? (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={toggleMute}
                      className={cn(
                        'w-8 h-8 rounded-full flex items-center justify-center transition-colors border-none bg-transparent cursor-pointer',
                        muted ? 'bg-red-100 text-red-500' : 'text-muted hover:text-primary',
                      )}
                    >
                      {muted ? <MicOff size={15} /> : <Mic size={15} />}
                    </button>
                    <VoiceOrb state={orbState()} size={28} imageSrc={agentPhoto} />
                    <button
                      onClick={toggleCall}
                      className="inline-flex items-center gap-2 pl-3 pr-4 h-9 bg-[#007AFF] text-white rounded-full hover:opacity-90 transition-opacity border-none cursor-pointer"
                    >
                      <div className="flex items-center gap-[2.5px]">
                        {[0, 1, 2].map(j => (
                          <div
                            key={j}
                            ref={el => { callBarsRef.current[j] = el }}
                            className="w-[3px] rounded-full bg-white transition-[height] duration-75"
                            style={{ height: (agentTalking || userTalking) ? `${6 + j * 4}px` : '3px' }}
                          />
                        ))}
                      </div>
                      <span className="text-[13px] font-semibold">
                        {callStatus === 'connecting' ? 'Verbinden…' : `Ophangen ${timer}`}
                      </span>
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={startDictate}
                      title="Dicteer bericht"
                      className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:text-primary transition-colors border-none bg-transparent cursor-pointer"
                    >
                      <Mic size={20} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => { if (hasContent) sendMessage(input, pendingImage?.base64); else toggleCall() }}
                      title={hasContent ? 'Versturen (Enter)' : 'Gesprek starten'}
                      className="w-9 h-9 rounded-full bg-primary text-white flex items-center justify-center hover:opacity-85 transition-opacity border-none cursor-pointer"
                    >
                      {hasContent ? <ArrowUp size={17} strokeWidth={2.5} /> : <AudioLines size={17} strokeWidth={2} />}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          <p className="text-center text-[11px] text-muted mt-2 opacity-60 tracking-tight">
            Suus kan fouten maken. Controleer altijd belangrijke informatie.
          </p>
        </div>
      </div>
    </div>
  )
}
