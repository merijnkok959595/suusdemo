import { cn } from '@/lib/utils'
import { ArrowDown, ArrowRight, Check, RotateCcw } from 'lucide-react'

/* ─── Building blocks ──────────────────────────────────────────── */

function StepBox({
  icon, title, subtitle, color = 'default', className,
}: {
  icon: string
  title: string
  subtitle?: string
  color?: 'default' | 'blue' | 'green' | 'orange' | 'purple' | 'red'
  className?: string
}) {
  const colors: Record<string, string> = {
    default: 'bg-surface border-border text-primary',
    blue:    'bg-blue-50   border-blue-200  text-blue-800',
    green:   'bg-green-50  border-green-200 text-green-800',
    orange:  'bg-orange-50 border-orange-200 text-orange-800',
    purple:  'bg-violet-50 border-violet-200 text-violet-800',
    red:     'bg-red-50    border-red-200   text-red-800',
  }
  return (
    <div className={cn(
      'flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-card w-full',
      colors[color], className,
    )}>
      <span className="text-[18px] leading-none mt-0.5 flex-shrink-0">{icon}</span>
      <div>
        <p className="text-[13px] font-semibold leading-tight">{title}</p>
        {subtitle && <p className="text-[11px] mt-0.5 opacity-70 leading-snug">{subtitle}</p>}
      </div>
    </div>
  )
}

function Arrow({ dir = 'down', label }: { dir?: 'down' | 'right'; label?: string }) {
  return (
    <div className={cn(
      'flex items-center justify-center gap-1 text-muted',
      dir === 'down' ? 'flex-col my-1' : 'flex-row mx-1',
    )}>
      {label && <span className="text-[10px] font-medium text-muted">{label}</span>}
      {dir === 'down'
        ? <ArrowDown size={14} strokeWidth={2} />
        : <ArrowRight size={14} strokeWidth={2} />}
    </div>
  )
}

function Branch({ label, color, children }: {
  label: string
  color?: 'green' | 'orange'
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1 w-full">
      <div className={cn(
        'text-[10px] font-bold px-2 py-0.5 rounded-full',
        color === 'green'  ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700',
      )}>{label}</div>
      {children}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">{children}</p>
  )
}

function ReturnArrow() {
  return (
    <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted font-medium">
      <RotateCcw size={11} />
      terug naar hoofdmenu
    </div>
  )
}

/* ─── Page ─────────────────────────────────────────────────────── */
export default function FlowPage() {
  return (
    <div className="flex-1 overflow-y-auto bg-bg">
      <div className="max-w-[680px] mx-auto px-4 py-6">

        <h1 className="text-[18px] font-bold text-primary mb-1">Demo flow</h1>
        <p className="text-[13px] text-muted mb-6">Hoe Süüs een sales gesprek verloopt — stap voor stap.</p>

        {/* ── 1. Start ─────────────────────────────────────────── */}
        <SectionLabel>1 · Start</SectionLabel>
        <StepBox icon="👋" title='Begroeting' subtitle='"Hoi! Ik ben Süüs. Met welk bedrijf en welke plaats kan ik je helpen?"' color="purple" />
        <Arrow />

        {/* ── 2. Google ─────────────────────────────────────────── */}
        <SectionLabel>2 · Bedrijf zoeken</SectionLabel>
        <StepBox icon="🔍" title="google_zoek_adres" subtitle="Zoekt bedrijfsnaam + plaatsnaam op via Google Places" color="blue" />
        <Arrow />

        <div className="grid grid-cols-2 gap-3 w-full mb-1">
          <Branch label="✓ Gevonden" color="green">
            <StepBox icon="📍" title="Resultaat tonen" subtitle='"Ik heb [naam] gevonden op [adres]. Klopt dat?"' color="green" />
            <Arrow dir="down" label="JA" />
            <StepBox icon="✓" title="Bevestigd" subtitle="Ga naar CRM check" color="green" />
          </Branch>
          <Branch label="✗ Niet gevonden" color="orange">
            <StepBox icon="❓" title="Opnieuw vragen" subtitle='"Kun je naam of stad controleren?"' color="orange" />
            <Arrow dir="down" label="opnieuw" />
            <StepBox icon="🔁" title="google_zoek_adres" subtitle="Herhaal zoekactie" color="orange" />
          </Branch>
        </div>

        <Arrow />

        {/* ── 3. CRM ────────────────────────────────────────────── */}
        <SectionLabel>3 · CRM check</SectionLabel>
        <StepBox icon="🗂" title="contact_zoek" subtitle="Zoekt het bedrijf op in het CRM" color="blue" />
        <Arrow />

        <div className="grid grid-cols-2 gap-3 w-full mb-1">
          <Branch label="✓ Gevonden" color="green">
            <StepBox icon="👤" title="Contact gevonden" subtitle='"[naam] staat al in het CRM."' color="green" />
          </Branch>
          <Branch label="✗ Nieuw" color="orange">
            <StepBox icon="➕" title="contact_create" subtitle="Maakt nieuw contact aan" color="orange" />
            <Arrow />
            <StepBox icon="✓" title="Aangemaakt" subtitle='"[naam] staat nu in het CRM."' color="green" />
          </Branch>
        </div>

        <Arrow />

        {/* ── 4. Hoofdmenu ──────────────────────────────────────── */}
        <SectionLabel>4 · Hoofdmenu</SectionLabel>
        <StepBox
          icon="📋"
          title="Hoofdmenu"
          subtitle='"Wat wil je doen? Bezoek loggen, notitie, taak, afspraak of briefing?"'
          color="purple"
        />
        <Arrow />

        {/* ── 5. Acties ─────────────────────────────────────────── */}
        <SectionLabel>5 · Acties</SectionLabel>

        <div className="grid grid-cols-1 gap-2.5">

          {/* Bezoek loggen */}
          <div className="border border-border rounded-2xl bg-surface shadow-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-violet-50 border-b border-violet-100">
              <span className="text-[16px]">🚶</span>
              <span className="text-[13px] font-semibold text-violet-800">Bezoek loggen</span>
              <span className="ml-auto text-[10px] font-medium text-violet-500 bg-white px-2 py-0.5 rounded-full border border-violet-200">multi-vraag flow</span>
            </div>
            <div className="px-4 py-3 flex flex-col gap-1.5">
              {[
                'Wat is de samenvatting van het bezoek?',
                'Is er een vervolg afspraak of taak nodig?',
                'Is dit bedrijf Lead of Klant na dit bezoek?',
                'Met welke producten werken ze mee?',
              ].map((q, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[10px] font-bold text-violet-700">{i + 1}</span>
                  </div>
                  <p className="text-[12px] text-secondary leading-snug">{q}</p>
                </div>
              ))}
              <div className="mt-1 pt-1.5 border-t border-border flex items-center gap-2">
                <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-md font-mono">log_bezoek</span>
                <span className="text-[11px] text-muted">→ CRM update</span>
                <Check size={12} className="text-green-500 ml-auto" />
              </div>
            </div>
          </div>

          {/* 4 quick actions */}
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { icon: '📝', label: 'Notitie',  q: 'Wat wil je noteren?',         tool: 'note_create'     },
              { icon: '✅', label: 'Taak',     q: 'Wat en wanneer?',             tool: 'task_create'     },
              { icon: '📅', label: 'Afspraak', q: 'Wanneer wil je afspreken?',   tool: 'calendar_create' },
              { icon: '📖', label: 'Briefing', q: 'Altijd — geen vraag nodig',   tool: 'contact_briefing' },
            ].map(({ icon, label, q, tool }) => (
              <div key={tool} className="border border-border rounded-xl bg-surface shadow-card overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-2 bg-active border-b border-border">
                  <span className="text-[14px]">{icon}</span>
                  <span className="text-[12px] font-semibold text-primary">{label}</span>
                </div>
                <div className="px-3 py-2.5 flex flex-col gap-1.5">
                  <p className="text-[11px] text-secondary italic">{q}</p>
                  <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded-md font-mono w-fit">{tool}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <ReturnArrow />
        <Arrow />

        {/* ── 6. Afsluiten ──────────────────────────────────────── */}
        <SectionLabel>6 · Afsluiten</SectionLabel>
        <StepBox icon="👋" title="Gesprek afsluiten" subtitle='"Bedankt! Tot de volgende keer. Doei!"' color="green" />

        <div className="mt-8 p-4 rounded-2xl bg-surface border border-border">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted mb-3">Tools overzicht</p>
          <div className="flex flex-wrap gap-1.5">
            {[
              'google_zoek_adres',
              'contact_zoek',
              'contact_create',
              'contact_update',
              'contact_briefing',
              'note_create',
              'task_create',
              'calendar_create',
              'log_bezoek',
            ].map(t => (
              <span key={t} className="text-[11px] font-mono bg-active text-primary px-2 py-1 rounded-lg border border-border">{t}</span>
            ))}
          </div>
        </div>

        <div className="h-8" />
      </div>
    </div>
  )
}
