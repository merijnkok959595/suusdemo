'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { z } from 'zod'
import { ArrowUp, Mic, MicOff, AudioLines, X, Plus, ImageIcon, Check, MapPin } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { VoiceOrb } from '@/components/ui/voice-orb'
import BriefingCard, { type BriefingData } from '@/components/BriefingCard'
import { MiniCardList, type MiniCardData } from '@/components/ui/MiniCard'
import { buildSetupInstructions, buildActiesInstructions, type VoiceOrgContext } from '@/lib/ai/voice-prompts'

/* ─── Types ────────────────────────────────────────────────────────────────── */

type DemoStage = 'lookup' | 'crm' | 'acties'

type CompanyInfo = {
  name:        string
  address?:    string
  city?:       string
  phone?:      string
  found?:      boolean
  contactNaam?: string
  contactId?:  string
}

type ContactCardData = {
  contactId:   string
  companyName: string | null
  firstName:   string | null
  lastName:    string | null
  city:        string | null
  phone:       string | null
}

type Msg = {
  role:          'user' | 'ai'
  text:          string
  streaming?:    boolean
  image_url?:    string
  briefingData?: BriefingData
  contactsData?: ContactCardData[]
  companyData?:  CompanyInfo
  cards?:        MiniCardData[]
}

type Collected = {
  bedrijfsnaam?: string
  plaatsnaam?:   string
  naam?:         string
  adres?:        string
  telefoon?:     string
  contactId?:    string
  contactNaam?:  string
  crmStatus?:    'found' | 'created'
}

/* ─── Tool execution helper ─────────────────────────────────────────────────── */

async function callVoiceTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch('/api/ai/voice-tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  })
  const { result } = await res.json()
  return result
}

function getField(r: unknown, ...keys: string[]): string | undefined {
  try {
    const obj = typeof r === 'string' ? JSON.parse(r) : r
    for (const key of keys) {
      const val =
        (obj as Record<string, unknown>)?.[key] ??
        (obj as Record<string, Record<string, unknown>>)?.contact?.[key] ??
        (obj as Record<string, Record<string, unknown>>)?.data?.[key]
      if (typeof val === 'string' && val) return val
    }
  } catch { /* ignore */ }
  return undefined
}

/* ─── Tool factories ─────────────────────────────────────────────────────── */

function makeSetupTools(
  collected: Collected,
  companyMsg: (info: CompanyInfo) => void,
  stageSet:   (s: DemoStage) => void,
) {
  return [
    tool({
      name: 'contact_enrich',
      description: `Zoek bedrijfsadres via Google Places. Verplicht aanroepen — nooit raden.
Geef query als "bedrijfsnaam plaatsnaam", bijv. "Risottini Amsterdam".`,
      parameters: z.object({
        query: z.string().describe('Bedrijfsnaam + plaatsnaam'),
      }),
      execute: async (args) => {
        stageSet('lookup')
        Object.assign(collected, { bedrijfsnaam: args.query })
        const result = await callVoiceTool('contact_enrich', args as Record<string, unknown>)
        let parsed: Record<string, unknown> | null = null
        try { parsed = typeof result === 'string' ? JSON.parse(result) : result as Record<string, unknown> } catch { /* ignore */ }
        const naam     = (parsed?.name as string | undefined) ?? collected.bedrijfsnaam
        const adres    = parsed?.address as string | undefined
        const telefoon = parsed?.phone as string | undefined
        Object.assign(collected, { naam, adres, telefoon })
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),

    tool({
      name: 'contact_search',
      description: 'Zoek een contact op in het CRM. Verplicht aanroepen — nooit raden.',
      parameters: z.object({
        query: z.string().describe('Bedrijfsnaam + stad'),
      }),
      execute: async (args) => {
        stageSet('crm')
        const result = await callVoiceTool('contact_search', args as Record<string, unknown>)
        const s      = typeof result === 'string' ? result : JSON.stringify(result)
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(s) } catch { /* ignore */ }
        const found    = !!(parsed && Number(parsed.count) > 0)
        const contacts = parsed?.contacts as Record<string, unknown>[] | undefined
        const first    = contacts?.[0]
        const contactId   = (first?.id ?? first?.contactId) as string | undefined
        const contactNaam = first?.naam as string | undefined
        const bedrijf     = first?.bedrijf as string | undefined
        if (contactId) Object.assign(collected, { contactId, crmStatus: found ? 'found' : undefined, contactNaam })
        if (found && first) {
          companyMsg({
            name:        bedrijf ?? collected.naam ?? args.query,
            address:     collected.adres,
            city:        first.stad as string | undefined,
            phone:       (first.phone as string | undefined) ?? collected.telefoon,
            contactNaam,
            found:       true,
            contactId,
          })
        }
        return s
      },
    }),

    tool({
      name: 'contact_create',
      description: 'Maak een nieuw contact aan in het CRM.',
      parameters: z.object({
        companyName: z.string(),
        city:        z.string().optional(),
        firstName:   z.string().optional(),
        email:       z.string().optional(),
        phone:       z.string().optional(),
        type:        z.enum(['lead', 'customer']),
      }),
      execute: async (args) => {
        const result    = await callVoiceTool('contact_create', args as Record<string, unknown>)
        const contactId = getField(result, 'id', 'contactId')
        if (contactId) Object.assign(collected, { contactId, crmStatus: 'created' })
        companyMsg({
          name:        args.companyName,
          city:        args.city,
          contactNaam: args.firstName,
          found:       false,
          contactId,
        })
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),
  ]
}

function makeActiesTools(
  collected: Collected,
  cardMsg: (card: MiniCardData) => void,
) {
  return [
    tool({
      name: 'contact_briefing',
      description: 'Geeft volledige briefing van een contact: notities, taken, afspraken.',
      parameters: z.object({ contactId: z.string() }),
      execute: async (args) => {
        const result = await callVoiceTool('contact_briefing', args as Record<string, unknown>)
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),

    tool({
      name: 'contact_update',
      description: 'Wijzig velden van een bestaand contact.',
      parameters: z.object({
        contactId:   z.string(),
        companyName: z.string().optional(),
        type:        z.enum(['lead', 'customer']).optional(),
      }),
      execute: async (args) => {
        const result = await callVoiceTool('contact_update', args as Record<string, unknown>)
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),

    tool({
      name: 'note_create',
      description: 'Voeg een notitie toe aan een contact.',
      parameters: z.object({ contactId: z.string(), body: z.string() }),
      execute: async (args) => {
        const result = await callVoiceTool('note_create', args as Record<string, unknown>)
        const parsed = typeof result === 'string' ? (() => { try { return JSON.parse(result) } catch { return null } })() : result
        if (parsed?.success && parsed?.id) {
          const raw     = String(args.body)
          const snippet = (raw.charAt(0).toUpperCase() + raw.slice(1)).slice(0, 60) + (raw.length > 60 ? '…' : '')
          cardMsg({ type: 'note', id: parsed.id, title: snippet, contactId: String(args.contactId), subtitle: collected.contactNaam })
        }
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),

    tool({
      name: 'task_create',
      description: 'Maak een taak aan voor een contact.',
      parameters: z.object({
        contactId: z.string(),
        title:     z.string(),
        body:      z.string().optional(),
        dueDate:   z.string().describe('ISO 8601 datum'),
      }),
      execute: async (args) => {
        const result = await callVoiceTool('task_create', args as Record<string, unknown>)
        const parsed = typeof result === 'string' ? (() => { try { return JSON.parse(result) } catch { return null } })() : result
        if (parsed?.success && parsed?.id) {
          const due = args.dueDate ? new Date(String(args.dueDate)).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : undefined
          cardMsg({ type: 'task', id: parsed.id, title: String(args.title), contactId: String(args.contactId), subtitle: collected.contactNaam, meta: due })
        }
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),

    tool({
      name: 'appointment_create',
      description: 'Plan een afspraak voor een contact.',
      parameters: z.object({
        contactId: z.string(),
        title:     z.string(),
        startTime: z.string().describe('ISO 8601'),
        endTime:   z.string().describe('ISO 8601'),
        notes:     z.string().optional(),
      }),
      execute: async (args) => {
        const result = await callVoiceTool('appointment_create', args as Record<string, unknown>)
        const parsed = typeof result === 'string' ? (() => { try { return JSON.parse(result) } catch { return null } })() : result
        if (parsed?.success && parsed?.id) {
          const when = args.startTime ? new Date(String(args.startTime)).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : undefined
          cardMsg({ type: 'appointment', id: parsed.id, title: String(args.title), contactId: String(args.contactId), subtitle: collected.contactNaam, meta: when })
        }
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),

    tool({
      name: 'log_bezoek',
      description: 'Log een salesbezoek: notitie + vervolg-taak/afspraak + contact update.',
      parameters: z.object({
        contactId:    z.string(),
        samenvatting: z.string(),
        vervolgActie: z.string().optional(),
        vervolgDatum: z.string().optional(),
        klantType:    z.enum(['Lead', 'Klant']).optional(),
        producten:    z.string().optional(),
      }),
      execute: async (args) => {
        const result = await callVoiceTool('log_bezoek', args as Record<string, unknown>)
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),

    tool({
      name: 'team_member_list',
      description: 'Haal actieve teamleden op.',
      parameters: z.object({}),
      execute: async (args) => {
        const result = await callVoiceTool('team_member_list', args as Record<string, unknown>)
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
    }),
  ]
}

/* ─── Agents ─────────────────────────────────────────────────────────────── */

function createAgents(
  orgCtx:      VoiceOrgContext,
  setupTools:  ReturnType<typeof tool>[],
  actiesTools: ReturnType<typeof tool>[],
) {
  const actiesAgent: RealtimeAgent = new RealtimeAgent({
    name: 'acties',
    handoffDescription: 'Agent voor alle CRM-acties: bezoek loggen, notitie, taak, afspraak, briefing.',
    instructions: buildActiesInstructions(orgCtx),
    tools: actiesTools,
    handoffs: [],
  })

  const setupAgent = new RealtimeAgent({
    name: 'setup',
    handoffDescription: 'Initiële agent: bedrijf identificeren via Google en contact vastleggen in CRM.',
    instructions: buildSetupInstructions(orgCtx),
    tools: setupTools,
    handoffs: [actiesAgent],
  })

  ;(actiesAgent.handoffs as RealtimeAgent[]).push(setupAgent)
  return setupAgent
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

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
  const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)) }
  w(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true)
  w(8, 'WAVE'); w(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, decoded.sampleRate, true)
  view.setUint32(28, decoded.sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  w(36, 'data'); view.setUint32(40, dataLen, true)
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
  return <span className="inline-block w-[7px] h-[1.1em] bg-copy rounded-[2px] align-middle animate-[thinkPulse_1s_ease-in-out_infinite] opacity-70" />
}

function ContactSelectorCards({
  contacts, onSelect,
}: {
  contacts: ContactCardData[]
  onSelect: (c: ContactCardData) => void
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 max-w-[420px]">
      {contacts.map(c => {
        const name = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact'
        const sub  = c.companyName ? [c.firstName, c.lastName].filter(Boolean).join(' ') : null
        return (
          <div key={c.contactId} className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-border-app bg-surface hover:bg-active transition-colors">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-copy truncate">{name}</div>
              {(sub || c.city) && (
                <div className="text-[11px] text-copy-muted truncate">{[sub, c.city].filter(Boolean).join(' · ')}</div>
              )}
            </div>
            <button
              onClick={() => onSelect(c)}
              className="px-2.5 py-1 text-[11px] font-semibold bg-copy text-white rounded-lg border-none cursor-pointer hover:bg-black transition-colors flex-shrink-0"
            >
              Gebruik
            </button>
          </div>
        )
      })}
    </div>
  )
}

const DEFAULT_SUGGESTIONS = [
  'Hoeveel contacten heb ik?',
  'Zoek contact: Risottini Amsterdam',
  'Maak een nieuw contact aan',
  'Briefing voor [bedrijfsnaam]',
]

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function SuusPage() {
  const [msgs,         setMsgs]         = useState<Msg[]>([])
  const [input,        setInput]        = useState('')
  const [sessionId]                     = useState(() => crypto.randomUUID())
  const [callStatus,   setCallStatus]   = useState<'idle' | 'connecting' | 'active'>('idle')
  const [agentTalking, setAgentTalking] = useState(false)
  const [userTalking,  setUserTalking]  = useState(false)
  const [muted,        setMuted]        = useState(false)
  const [demoStage,    setDemoStage]    = useState<DemoStage>('lookup')
  const [company,      setCompany]      = useState<CompanyInfo | null>(null)
  const [attachOpen,   setAttachOpen]   = useState(false)
  const [pendingImage, setPendingImage] = useState<{ url: string; base64: string } | null>(null)
  const [dictating,    setDictating]    = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [greetingDone, setGreetingDone] = useState(false)
  const [callError,    setCallError]    = useState<string | null>(null)
  const agentPhoto = '/suus.jpg'

  const sessionRef           = useRef<RealtimeSession | null>(null)
  const greetingDoneRef      = useRef(false)
  const greetingTriggeredRef = useRef(false)
  const streamingRef         = useRef(false)
  const streamingTextRef     = useRef('')
  const userStreamRef        = useRef(false)
  const userStreamTextRef    = useRef('')
  const localStreamRef       = useRef<MediaStream | null>(null)
  const callAnalyserRef      = useRef<AnalyserNode | null>(null)
  const callAudioCtxRef      = useRef<AudioContext | null>(null)
  const callAnimFrameRef     = useRef<number>(0)
  const callBarsRef          = useRef<(HTMLDivElement | null)[]>([])
  const dictRecorderRef      = useRef<MediaRecorder | null>(null)
  const dictAnalyserRef      = useRef<AnalyserNode | null>(null)
  const dictAudioCtxRef      = useRef<AudioContext | null>(null)
  const dictAnimFrameRef     = useRef<number>(0)
  const dictBarsRef          = useRef<(HTMLDivElement | null)[]>([])
  const imageInputRef        = useRef<HTMLInputElement>(null)
  const attachRef            = useRef<HTMLDivElement>(null)
  const bottomRef            = useRef<HTMLDivElement>(null)
  const textareaRef          = useRef<HTMLTextAreaElement>(null)

  const timer = useCallTimer(callStatus === 'active')

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let prevH = vv.height
    const onResize = () => {
      const delta = prevH - vv.height; prevH = vv.height
      if (callStatus !== 'idle') return
      if (delta > 150) bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [callStatus])

  useEffect(() => {
    if (!attachOpen) return
    const h = (e: MouseEvent) => {
      if (attachRef.current && !attachRef.current.contains(e.target as Node)) setAttachOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [attachOpen])

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

  /* ── Visualizer ─────────────────────────────────────────────────────────── */

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

  /* ── Voice call ─────────────────────────────────────────────────────────── */

  function stopCall() {
    try { (sessionRef.current as RealtimeSession & { close?: () => void }).close?.() } catch { /* ignore */ }
    sessionRef.current = null
    localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null
    stopVisualizer()
    streamingRef.current = false; streamingTextRef.current = ''
    userStreamRef.current = false; userStreamTextRef.current = ''
    greetingDoneRef.current = false; setGreetingDone(false)
    greetingTriggeredRef.current = false
    setCallStatus('idle'); setAgentTalking(false); setUserTalking(false); setMuted(false)
    setDemoStage('lookup'); setCompany(null)
    setMsgs(p => p.map(m => m.streaming ? { ...m, streaming: false } : m))
  }

  async function toggleCall() {
    if (callStatus !== 'idle') { stopCall(); return }

    setCallStatus('connecting'); setCallError(null)
    try {
      const tokenRes = await fetch('/api/ai/call', { method: 'POST' })
      if (!tokenRes.ok) throw new Error('Kon gesprek niet starten')

      const { client_secret, orgContext, error } = await tokenRes.json() as {
        client_secret?: { value: string }
        orgContext?: { agentName?: string; voice?: string; orgNaam?: string }
        error?: string
      }
      if (!client_secret?.value) throw new Error(error ?? 'No client secret')

      const voiceOrgCtx: VoiceOrgContext = {
        agentName: orgContext?.agentName,
        orgNaam:   orgContext?.orgNaam,
      }

      const collected: Collected = {}

      const companyMsg = (info: CompanyInfo) =>
        setMsgs(p => [...p, { role: 'ai', text: '', companyData: info, streaming: false }])

      const cardMsg = (card: MiniCardData) =>
        setMsgs(p => {
          const last = p[p.length - 1]
          if (last?.role === 'ai' && last.cards)
            return [...p.slice(0, -1), { ...last, cards: [...last.cards, card] }]
          return [...p, { role: 'ai', text: '', cards: [card], streaming: false }]
        })

      const setupAgent = createAgents(
        voiceOrgCtx,
        makeSetupTools(collected, companyMsg, setDemoStage),
        makeActiesTools(collected, cardMsg),
      )

      const session = new RealtimeSession(setupAgent, {
        model: 'gpt-4o-realtime-preview',
        config: {
          outputModalities: ['audio'],
          audio: {
            input: {
              transcription:  { model: 'gpt-4o-transcribe', language: 'nl' },
              turnDetection: {
                type: 'server_vad', threshold: 0.7,
                prefixPaddingMs: 300, silenceDurationMs: 1000,
              },
            },
            output: { voice: (orgContext?.voice ?? 'coral') as 'coral' },
          },
        },
      })

      // Agent handoff
      session.on('agent_handoff', (_ctx: unknown, _from: unknown, toAgent: { name?: string }) => {
        const agentName = toAgent?.name ?? ''
        if (agentName === 'acties') {
          setDemoStage('acties')
        } else if (agentName === 'setup') {
          Object.keys(collected).forEach(k => delete (collected as Record<string, unknown>)[k])
          setDemoStage('lookup'); setCompany(null)
        }
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.transport.on('*', (ev: any) => {
        switch (ev.type) {
          case 'session.updated':
            if (!greetingTriggeredRef.current) {
              greetingTriggeredRef.current = true
              session.transport.sendEvent({ type: 'response.create' })
            }
            break

          case 'input_audio_buffer.speech_started': setUserTalking(true);  break
          case 'input_audio_buffer.speech_stopped': setUserTalking(false); break
          case 'response.output_audio.delta':       setAgentTalking(true); break
          case 'response.output_audio.done':        setAgentTalking(false); break
          case 'response.done':
            setAgentTalking(false)
            if (!greetingDoneRef.current) {
              greetingDoneRef.current = true
              setGreetingDone(true)
              session.transport.sendEvent({
                type: 'session.update',
                session: {
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.7,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 1000,
                  },
                },
              })
            }
            break

          case 'response.output_audio_transcript.delta': {
            const delta: string = ev.delta ?? ''
            if (!streamingRef.current) {
              streamingRef.current = true; streamingTextRef.current = delta
              setMsgs(p => [...p, { role: 'ai', text: delta, streaming: true }])
            } else {
              streamingTextRef.current += delta
              const text = streamingTextRef.current
              setMsgs(p => {
                const next = [...p]; const i = next.findLastIndex(m => m.role === 'ai' && m.streaming)
                if (i >= 0) next[i] = { ...next[i], text }; return next
              })
            }
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            break
          }

          case 'response.output_audio_transcript.done':
            streamingRef.current = false; streamingTextRef.current = ''
            setMsgs(p => p.map(m => m.role === 'ai' && m.streaming ? { ...m, streaming: false } : m))
            break

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
                const next = [...p]
                const last = next.findLastIndex(m => m.role === 'user')
                if (last >= 0 && next[last].streaming) {
                  next[last] = { role: 'user', text: t, streaming: false }
                } else {
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
      greetingDoneRef.current = false; setGreetingDone(false)
      greetingTriggeredRef.current = false
      setCallStatus('active')

      // Disable VAD during greeting — re-enabled after first response.done
      session.transport.sendEvent({
        type: 'session.update',
        session: {
          voice:                     (orgContext?.voice ?? 'coral') as 'coral',
          instructions:              'Spreek ALTIJD en UITSLUITEND Nederlands, ongeacht de taal van de gebruiker of van tool-resultaten.',
          input_audio_transcription: { model: 'gpt-4o-transcribe', language: 'nl' },
          turn_detection:            null,
          temperature:               0.6,
        },
      })

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        localStreamRef.current = stream; startVisualizer(stream)
      } catch { /* visualizer optional */ }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setCallError(msg); setTimeout(() => setCallError(null), 8000)
      setCallStatus('idle')
    }
  }

  function toggleMute() {
    const s = sessionRef.current; if (!s) return
    const next = !muted; s.mute(next); setMuted(next)
  }

  /* ── Dictation ──────────────────────────────────────────────────────────── */

  function stopDictVisualizer() {
    cancelAnimationFrame(dictAnimFrameRef.current)
    dictAnalyserRef.current = null
    dictAudioCtxRef.current?.close(); dictAudioCtxRef.current = null
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
        const blobType  = mr.mimeType || mimeType || 'audio/webm'
        const blob      = new Blob(allChunks, { type: blobType })
        let finalBlob   = blob, fileName = 'recording.webm'
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
          const res = await fetch('/api/ai/transcribe', { method: 'POST', body: fd })
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
    dictRecorderRef.current?.stop(); dictRecorderRef.current = null; setDictating(false)
  }

  function cancelDictate() {
    if (dictRecorderRef.current) {
      dictRecorderRef.current.ondataavailable = null
      dictRecorderRef.current.onstop = null
      dictRecorderRef.current.stop()
      dictRecorderRef.current = null
    }
    stopDictVisualizer(); setDictating(false); setTranscribing(false)
  }

  function onImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const r = new FileReader()
    r.onload = ev => { const url = ev.target?.result as string; setPendingImage({ url, base64: url }) }
    r.readAsDataURL(file)
    e.target.value = ''; setAttachOpen(false)
  }

  function resizeTextarea() {
    const el = textareaRef.current; if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  /* ── Text chat ──────────────────────────────────────────────────────────── */

  const sendMessage = useCallback(async (text: string, imageUrl?: string) => {
    if (!text.trim() && !imageUrl) return
    setInput(''); setPendingImage(null); setTimeout(resizeTextarea, 0)

    setMsgs(p => [...p,
      { role: 'user', text, image_url: imageUrl },
      { role: 'ai',   text: '', streaming: true },
    ])

    try {
      const res = await fetch('/api/ai/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message:    text || '(afbeelding)',
          session_id: sessionId,
          images:     imageUrl ? [{ base64: imageUrl.split(',')[1], mimeType: 'image/jpeg' }] : undefined,
        }),
      })
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(`${res.status}: ${errText}`)
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let full = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        full += decoder.decode(value, { stream: true })

        const briefingMatch = full.match(/\n__BRIEFING__:(.+)/)
        const contactsMatch = full.match(/\n__CONTACTS__:(.+)/)
        const cardsMatch    = full.match(/\n__CARDS__:(.+)/)

        if (cardsMatch) {
          const vis = full.replace(/\n__CARDS__:.+/, '').trim()
          try {
            const parsed = JSON.parse(cardsMatch[1]) as MiniCardData[]
            setMsgs(p => p.map((m, i) => i === p.length - 1
              ? { ...m, text: vis, cards: parsed, streaming: false } : m))
          } catch { setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, text: full } : m)) }
        } else if (briefingMatch) {
          const vis = full.replace(/\n__BRIEFING__:.+/, '').trim()
          try {
            const parsed = JSON.parse(briefingMatch[1]) as BriefingData
            setMsgs(p => p.map((m, i) => i === p.length - 1
              ? { ...m, text: vis, briefingData: parsed, streaming: false } : m))
          } catch { setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, text: vis } : m)) }
        } else if (contactsMatch) {
          const vis = full.replace(/\n__CONTACTS__:.+/, '').trim()
          try {
            const parsed = JSON.parse(contactsMatch[1]) as { contacts: ContactCardData[] }
            setMsgs(p => p.map((m, i) => i === p.length - 1
              ? { ...m, text: vis, contactsData: parsed.contacts, streaming: false } : m))
          } catch { setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, text: full } : m)) }
        } else {
          setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, text: full } : m))
        }
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
      setMsgs(p => p.map((m, i) => i === p.length - 1 ? { ...m, streaming: false } : m))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMsgs(p => p.map((m, i) => i === p.length - 1
        ? { ...m, text: `Er ging iets mis: ${msg}`, streaming: false } : m))
    }
  }, [sessionId])

  const hasContent   = !!(input.trim() || pendingImage)
  const callIsActive = callStatus !== 'idle'

  function orbState() {
    if (callStatus === 'connecting') return 'connecting' as const
    if (agentTalking) return 'speaking' as const
    if (userTalking)  return 'listening' as const
    return 'idle' as const
  }

  /* ── Render ─────────────────────────────────────────────────────────────── */
  return (
    <div className="flex flex-col bg-bg overflow-hidden" style={{ height: 'calc(100svh - var(--nav-height, 64px))' }}>

      {/* Message feed */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [scrollbar-color:theme(colors.border-app)_transparent]">
        <div className="max-w-[720px] mx-auto w-full px-4 sm:px-6 pt-14 pb-4 flex flex-col">

          {/* Empty state */}
          {msgs.length === 0 && (
            <div className="flex flex-col items-center gap-5 pt-16 pb-8 animate-fade-up">
              <VoiceOrb state={callIsActive ? orbState() : 'idle'} size={100} imageSrc={agentPhoto} />
              <div className="text-center">
                <h2 className="text-[22px] font-bold tracking-tight text-copy mb-1 max-sm:text-lg">
                  Hoi! Ik ben SUUS.
                </h2>
                <p className="text-[13px] text-copy-muted">
                  {callIsActive
                    ? (callStatus === 'connecting' ? 'Verbinden…' : agentTalking ? 'SUUS spreekt…' : !greetingDone ? 'SUUS spreekt…' : userTalking ? 'Luisteren…' : 'Zeg iets…')
                    : 'Stel een vraag, stuur een foto of start een gesprek'}
                </p>
              </div>
              {!callIsActive && (
                <div className="grid grid-cols-2 gap-2 w-full max-w-[420px]">
                  {DEFAULT_SUGGESTIONS.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(s)}
                      className="px-3.5 py-2.5 rounded-[10px] border border-border-app bg-surface text-xs font-medium text-copy text-left leading-snug transition-colors hover:bg-active"
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
            <div key={i} className="py-2">
              {m.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="max-w-[75%] max-sm:max-w-[85%]">
                    <p className="text-[11px] font-bold text-copy mb-1 text-right">Jij</p>
                    <div className="text-[14.5px] leading-[1.6] text-copy-muted whitespace-pre-wrap break-words bg-white px-5 py-3 rounded-[22px]">
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
                    <p className="text-[11px] font-bold text-copy mb-1">SUUS</p>

                    {/* Company / contact card inline */}
                    {m.companyData && !m.streaming && (
                      <div className="mb-2">
                        <MiniCardList cards={[{
                          type:      m.companyData.found ? 'contact_found' : 'contact_created',
                          id:        m.companyData.contactId ?? '',
                          title:     m.companyData.name,
                          subtitle:  m.companyData.contactNaam,
                          meta:      [m.companyData.address, m.companyData.city].filter(Boolean).join(', ') || undefined,
                          contactId: m.companyData.contactId,
                        }]} />
                      </div>
                    )}

                    {m.text ? (
                      <div className="text-[14.5px] leading-[1.6] text-copy-muted">
                        {m.streaming ? (
                          <p className="whitespace-pre-wrap break-words">{m.text}<TypingDots /></p>
                        ) : (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              p:      ({children}) => <p className="mb-2 last:mb-0">{children}</p>,
                              strong: ({children}) => <strong className="font-semibold text-copy">{children}</strong>,
                              em:     ({children}) => <em className="italic">{children}</em>,
                              ul:     ({children}) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
                              ol:     ({children}) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
                              li:     ({children}) => <li className="leading-[1.6]">{children}</li>,
                              h1:     ({children}) => <h1 className="text-[15px] font-bold mb-1.5 mt-2 text-copy">{children}</h1>,
                              h2:     ({children}) => <h2 className="text-[14.5px] font-semibold mb-1 mt-2 text-copy">{children}</h2>,
                              h3:     ({children}) => <h3 className="text-[14px] font-semibold mb-1 mt-1.5 text-copy">{children}</h3>,
                              code:   ({children}) => <code className="bg-black/6 rounded px-1 py-0.5 text-[13px] font-mono">{children}</code>,
                              a:      ({href, children}) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline underline-offset-2">{children}</a>,
                            }}
                          >
                            {m.text}
                          </ReactMarkdown>
                        )}
                      </div>
                    ) : m.streaming ? (
                      <TypingDots />
                    ) : null}

                    {/* Action cards */}
                    {m.cards && m.cards.length > 0 && !m.streaming && (
                      <MiniCardList cards={m.cards} />
                    )}

                    {/* Briefing card */}
                    {m.briefingData && !m.streaming && (
                      <div className="mt-2.5">
                        <BriefingCard data={m.briefingData} />
                      </div>
                    )}

                    {/* Contact selector */}
                    {m.contactsData && m.contactsData.length > 0 && !m.streaming && (
                      <ContactSelectorCards
                        contacts={m.contactsData}
                        onSelect={c => {
                          const name = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'contact'
                          sendMessage(`Gebruik contact ${name} (contactId: ${c.contactId})`)
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Image preview */}
      {pendingImage && (
        <div className="max-w-[720px] mx-auto px-4 pb-1.5 flex items-center gap-2">
          <div className="relative inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pendingImage.url} alt="preview" className="h-11 w-11 object-cover rounded-lg border border-border-app" />
            <button
              onClick={() => setPendingImage(null)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center border-none cursor-pointer"
            >
              <X size={9} />
            </button>
          </div>
          <span className="text-[11px] text-copy-muted">Afbeelding bijgevoegd</span>
        </div>
      )}

      {/* Input bar */}
      <div className="px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 flex-shrink-0">
        <div className="max-w-[760px] mx-auto">

          {(dictating || transcribing) && !callIsActive ? (
            <div className="flex items-center gap-3 px-4 py-4 border border-border-app rounded-[28px] bg-surface shadow-[0_2px_12px_rgba(0,0,0,.07),0_0_0_1px_rgba(0,0,0,.03)]">
              <div className="flex-1 flex items-center justify-center gap-[3px] h-9 overflow-hidden">
                {Array.from({ length: 48 }, (_, idx) => (
                  <div
                    key={idx}
                    ref={el => { dictBarsRef.current[idx] = el }}
                    className={cn('w-[3px] rounded-full origin-center transition-[height] duration-75',
                      transcribing ? 'bg-copy-muted/40' : 'bg-copy')}
                    style={{ height: '3px' }}
                  />
                ))}
              </div>
              <button onClick={cancelDictate} title="Annuleer"
                className="w-9 h-9 rounded-full flex items-center justify-center text-copy-muted hover:text-red-500 transition-colors border-none bg-transparent cursor-pointer">
                <X size={18} strokeWidth={2} />
              </button>
              <button onClick={stopDictate} disabled={transcribing} title="Stop en transcribeer"
                className="w-9 h-9 rounded-full bg-copy text-white flex items-center justify-center hover:opacity-85 transition-opacity disabled:opacity-40 flex-shrink-0 border-none cursor-pointer">
                <Check size={16} strokeWidth={2.5} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-4 py-4 border border-border-app rounded-[28px] bg-surface shadow-[0_2px_12px_rgba(0,0,0,.07),0_0_0_1px_rgba(0,0,0,.03)] hover:shadow-[0_4px_18px_rgba(0,0,0,.1)] transition-shadow">

              <input ref={imageInputRef} type="file" accept="image/*" onChange={onImageFile} className="hidden" />
              <div className="relative flex-shrink-0" ref={attachRef}>
                {attachOpen && (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 bg-surface border border-border-app rounded-[12px] shadow-panel overflow-hidden min-w-[140px] z-50">
                    <button
                      className="flex items-center gap-2 px-3.5 py-2.5 text-xs font-medium text-copy w-full hover:bg-active transition-colors border-none bg-transparent cursor-pointer"
                      onClick={() => imageInputRef.current?.click()}
                    >
                      <ImageIcon size={13} className="text-copy-muted" /> Afbeelding
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setAttachOpen(p => !p)}
                  title="Bijlage"
                  className={cn('w-8 h-8 rounded-full flex items-center justify-center text-copy-muted hover:text-copy transition-colors border-none bg-transparent cursor-pointer', pendingImage && 'text-copy')}
                >
                  <Plus size={22} strokeWidth={1.5} />
                </button>
              </div>

              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => { setInput(e.target.value); resizeTextarea() }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input, pendingImage?.base64) } }}
                placeholder="Vraag SUUS iets..."
                rows={1}
                autoComplete="off"
                autoCorrect="on"
                spellCheck={false}
                className="flex-1 resize-none border-none bg-transparent text-[16px] text-copy outline-none leading-[1.55] max-h-40 overflow-y-auto p-0 font-[inherit] placeholder:text-copy-muted"
              />

              <div className="flex items-center gap-2 flex-shrink-0">
                {callIsActive ? (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={toggleMute}
                      className={cn(
                        'w-8 h-8 rounded-full flex items-center justify-center transition-colors border-none bg-transparent cursor-pointer',
                        muted ? 'bg-red-100 text-red-500' : 'text-copy-muted hover:text-copy',
                      )}
                    >
                      {muted ? <MicOff size={15} /> : <Mic size={15} />}
                    </button>
                    <VoiceOrb state={orbState()} size={28} imageSrc={agentPhoto} />
                    <button
                      onClick={stopCall}
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
                    <button onClick={startDictate} title="Dicteer bericht"
                      className="w-9 h-9 rounded-full flex items-center justify-center text-copy-muted hover:text-copy transition-colors border-none bg-transparent cursor-pointer">
                      <Mic size={20} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => { if (hasContent) sendMessage(input, pendingImage?.base64); else toggleCall() }}
                      title={hasContent ? 'Versturen (Enter)' : 'Gesprek starten'}
                      className="w-9 h-9 rounded-full bg-copy text-white flex items-center justify-center hover:opacity-85 transition-opacity border-none cursor-pointer"
                    >
                      {hasContent ? <ArrowUp size={17} strokeWidth={2.5} /> : <AudioLines size={17} strokeWidth={2} />}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {callError && (
            <div className="flex items-start gap-2 mx-1 mt-2 px-3 py-2 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-[12px] leading-snug">
              <span className="mt-[1px] shrink-0">⚠️</span>
              <span className="flex-1">
                <span className="font-semibold">Fout — </span>
                {callError.includes('getUserMedia') || callError.includes('NotAllowed')
                  ? 'Microfoon toegang geweigerd. Geef toestemming in je browserinstellingen.'
                  : 'Er ging iets mis. Probeer opnieuw of meld dit aan de beheerder.'}
              </span>
              <button onClick={() => setCallError(null)} className="shrink-0 text-red-400 hover:text-red-600 mt-[1px] bg-transparent border-none cursor-pointer">
                <X size={13} strokeWidth={2.5} />
              </button>
            </div>
          )}

          <p className="text-center text-[11px] text-copy-muted/60 mt-2">SUUS kan fouten maken. Controleer altijd belangrijke informatie.</p>
        </div>
      </div>
    </div>
  )
}
