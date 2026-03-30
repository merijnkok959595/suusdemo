'use client'

import { FileText, CheckSquare, Calendar, Phone, MapPin, TrendingUp, User } from 'lucide-react'

const MONO = "'SF Mono','Fira Code',monospace"

const LABEL_META: Record<string, { bg: string; text: string; border: string; title: string }> = {
  A: { bg: 'rgba(220,38,38,0.08)',  text: '#DC2626', border: 'rgba(220,38,38,0.2)',  title: 'Top prospect'    },
  B: { bg: 'rgba(217,119,6,0.08)',  text: '#D97706', border: 'rgba(217,119,6,0.2)',  title: 'Goede kans'      },
  C: { bg: 'rgba(37,99,235,0.08)',  text: '#2563EB', border: 'rgba(37,99,235,0.2)',  title: 'Gemiddeld'       },
  D: { bg: 'rgba(22,163,74,0.08)',  text: '#16A34A', border: 'rgba(22,163,74,0.2)',  title: 'Lage prioriteit' },
}

export interface BriefingData {
  contactId:   string
  contactName: string
  contact: {
    companyName: string | null
    firstName:   string | null
    lastName:    string | null
    phone:       string | null
    city:        string | null
  }
  classification: {
    label:      string | null
    revenue:    number | null
    assignedTo: string | null
    color:      string | null
  } | null
  rawNotes:        { createdAt: string | number | null | undefined; body: string }[]
  rawTasks:        { dueDate: string | number | null | undefined; title: string; body?: string }[]
  rawAppointments: { startTime: string | number | null | undefined; title: string }[]
  stats: { notes: number; openTasks: number; appointments: number }
}

function parseDate(val: string | number | null | undefined): Date | null {
  if (val == null || val === '') return null
  const num = typeof val === 'number' ? val : /^\d+$/.test(String(val)) ? Number(val) : NaN
  if (!isNaN(num)) {
    const d = new Date(num > 1e10 ? num : num * 1000)
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(val as string)
  return isNaN(d.getTime()) ? null : d
}
function nlDate(val: string | number | null | undefined): string {
  const d = parseDate(val)
  if (!d) return '—'
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' })
}
function nlTime(val: string | number | null | undefined): string {
  const d = parseDate(val)
  if (!d) return ''
  return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-border last:border-b-0 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="text-muted flex">{icon}</span>
        <span className="text-[11px] font-extrabold text-primary uppercase tracking-[0.06em]">{title}</span>
      </div>
      {children}
    </div>
  )
}

export default function BriefingCard({ data }: { data: BriefingData }) {
  const { contact, classification, rawNotes, rawTasks, rawAppointments, stats } = data
  const lm = classification?.label ? LABEL_META[classification.label] : null

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden w-full max-w-[420px] text-[13px]">

      {/* Header */}
      <div className="px-4 py-3 bg-bg border-b border-border">
        <div className="text-sm font-bold text-primary tracking-tight">
          {contact.companyName ?? data.contactName}
        </div>
        <div className="flex items-center gap-2.5 mt-1 flex-wrap">
          {contact.firstName && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <User size={11} /> {[contact.firstName, contact.lastName].filter(Boolean).join(' ')}
            </span>
          )}
          {contact.city && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <MapPin size={11} /> {contact.city}
            </span>
          )}
          {contact.phone && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <Phone size={11} /> {contact.phone}
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 border-b border-border">
        {[
          { label: 'Notities',  value: stats.notes,        icon: <FileText    size={12} /> },
          { label: 'Taken',     value: stats.openTasks,    icon: <CheckSquare size={12} /> },
          { label: 'Afspraken', value: stats.appointments, icon: <Calendar    size={12} /> },
        ].map(({ label, value, icon }) => (
          <div key={label} className="px-3.5 py-2.5 flex flex-col gap-0.5 border-r border-border last:border-r-0">
            <div className="flex items-center gap-1 text-muted">{icon}</div>
            <span className="text-[18px] font-bold text-primary leading-none">{value}</span>
            <span className="text-[10px] text-muted uppercase tracking-[0.05em]">{label}</span>
          </div>
        ))}
      </div>

      {/* Classification */}
      {classification && (lm || classification.revenue || classification.assignedTo) && (
        <Section icon={<TrendingUp size={12} />} title="Classificatie">
          <div className="flex items-center gap-2.5 flex-wrap">
            {lm && classification.label && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold text-muted">Label</span>
                <span
                  title={lm.title}
                  className="inline-flex items-center text-xs font-bold px-2.5 py-1 rounded cursor-help"
                  style={{ background: lm.bg, color: lm.text, border: `1px solid ${lm.border}`, fontFamily: MONO, letterSpacing: '0.08em' }}
                >
                  {classification.label}
                </span>
              </div>
            )}
            {classification.revenue != null && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold text-muted">Volume</span>
                <span className="text-[13px] font-bold text-primary" style={{ fontFamily: MONO }}>
                  {Number(classification.revenue).toLocaleString('nl-NL')}
                </span>
              </div>
            )}
            {classification.assignedTo && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold text-muted">Toegewezen aan</span>
                <span
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full tracking-[0.04em] uppercase"
                  style={{
                    background: classification.color ? `${classification.color}18` : 'var(--active)',
                    color:      classification.color ?? 'var(--text)',
                    border:     `1px solid ${classification.color ? `${classification.color}40` : 'var(--border)'}`,
                  }}
                >
                  {classification.color && (
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: classification.color }} />
                  )}
                  {classification.assignedTo}
                </span>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Recent notes */}
      <Section icon={<FileText size={12} />} title="Recente notities">
        {rawNotes.length === 0
          ? <span className="text-xs text-muted italic">Geen notities gevonden.</span>
          : (
            <div className="flex flex-col gap-1.5">
              {rawNotes.map((n, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-[11px] text-muted whitespace-nowrap flex-shrink-0 pt-px">{nlDate(n.createdAt)}</span>
                  <span className="text-xs text-primary leading-relaxed overflow-hidden line-clamp-2">{n.body}</span>
                </div>
              ))}
            </div>
          )
        }
      </Section>

      {rawTasks.length > 0 && (
        <Section icon={<CheckSquare size={12} />} title="Open taken">
          <div className="flex flex-col gap-1">
            {rawTasks.map((t, i) => (
              <div key={i} className="flex gap-2 items-start">
                <span className="text-[11px] text-muted whitespace-nowrap flex-shrink-0 pt-0.5">{nlDate(t.dueDate)}</span>
                <span className="text-xs text-primary leading-relaxed">
                  <strong>{t.title}</strong>{t.body ? ` — ${t.body}` : ''}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {rawAppointments.length > 0 && (
        <Section icon={<Calendar size={12} />} title="Aankomende afspraken">
          <div className="flex flex-col gap-1">
            {rawAppointments.map((a, i) => (
              <div key={i} className="flex gap-2 items-center">
                <span className="text-[11px] text-muted whitespace-nowrap flex-shrink-0">
                  {nlDate(a.startTime)} {nlTime(a.startTime)}
                </span>
                <span className="text-xs text-primary">{a.title}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
