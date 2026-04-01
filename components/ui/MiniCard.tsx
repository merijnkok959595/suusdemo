'use client'

/**
 * Unified MiniCard — used in the SUUS AI feed for all CRM feedback cards.
 * Works for voice (via _bridge) and text chat (via __CARD__: stream marker).
 */

import Link from 'next/link'
import { Building2, CheckSquare, CalendarDays, FileText, MapPin, ExternalLink, AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type MiniCardType = 'contact_found' | 'contact_created' | 'task' | 'appointment' | 'note' | 'bezoek' | 'success' | 'error'

export type MiniCardDetail = { label: string; value: string }

export type MiniCardData = {
  type:         MiniCardType
  id:           string        // contact/task/appointment/note id
  title:        string        // bedrijfsnaam / taak titel / afspraak titel / notitie snippet
  subtitle?:    string        // contactnaam / extra info
  meta?:        string        // adres+stad / datum / tijd
  contactId?:   string        // for deep linking on task/appointment/note
  btnLabel?:    string        // override default button label
  btnHref?:     string        // override default button href
  details?:     MiniCardDetail[]  // bezoek card — key/value rows
}

const TYPE_META: Record<MiniCardType, {
  icon:     React.ReactNode
  badge:    string
  badgeCls: string
  btnLabel: string
  href:     (card: MiniCardData) => string
}> = {
  contact_found: {
    icon:     <Building2 size={17} className="text-copy" />,
    badge:    '✓ Gevonden in CRM',
    badgeCls: 'bg-green-100 text-green-700',
    btnLabel: 'Bekijk contact',
    href:     (c) => `/dashboard/contacts/${c.id}`,
  },
  contact_created: {
    icon:     <Building2 size={17} className="text-copy" />,
    badge:    '+ Aangemaakt in CRM',
    badgeCls: 'bg-blue-100 text-blue-700',
    btnLabel: 'Bekijk contact',
    href:     (c) => `/dashboard/contacts/${c.id}`,
  },
  task: {
    icon:     <CheckSquare size={17} className="text-copy" />,
    badge:    '✓ Taak aangemaakt',
    badgeCls: 'bg-green-100 text-green-700',
    btnLabel: 'Bekijk taken',
    href:     () => `/dashboard/tasks`,
  },
  appointment: {
    icon:     <CalendarDays size={17} className="text-copy" />,
    badge:    '✓ Afspraak gepland',
    badgeCls: 'bg-green-100 text-green-700',
    btnLabel: 'Bekijk agenda',
    href:     () => `/dashboard/calendar`,
  },
  note: {
    icon:     <FileText size={17} className="text-copy" />,
    badge:    '✓ Notitie opgeslagen',
    badgeCls: 'bg-green-100 text-green-700',
    btnLabel: 'Bekijk notities',
    href:     () => `/dashboard/notes`,
  },
  bezoek: {
    icon:     <CheckCircle2 size={17} className="text-green-600" />,
    badge:    '✓ Bezoek gelogd',
    badgeCls: 'bg-green-100 text-green-700',
    btnLabel: 'Bekijk contact',
    href:     (c) => `/dashboard/contacts/${c.contactId ?? c.id}`,
  },
  success: {
    icon:     <CheckCircle2 size={17} className="text-copy" />,
    badge:    '✓ Gelukt',
    badgeCls: 'bg-green-100 text-green-700',
    btnLabel: 'Bekijk',
    href:     (c) => c.btnHref ?? '#',
  },
  error: {
    icon:     <AlertCircle size={17} className="text-red-500" />,
    badge:    '✕ Fout opgetreden',
    badgeCls: 'bg-red-100 text-red-600',
    btnLabel: 'Probeer opnieuw',
    href:     (c) => c.btnHref ?? '#',
  },
}

export function MiniCard({ card }: { card: MiniCardData }) {
  const meta    = TYPE_META[card.type]
  const isError = card.type === 'error'
  const href    = card.btnHref ?? meta.href(card)
  const label   = card.btnLabel ?? meta.btnLabel

  return (
    <div className={cn('mini-card', isError && 'border-red-200 bg-red-50/40')}>
      {/* Icon */}
      <div className={cn('mini-card-icon', isError && 'bg-red-100')}>
        {meta.icon}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13.5px] font-semibold text-copy leading-tight">{card.title}</span>
          <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', meta.badgeCls)}>
            {meta.badge}
          </span>
        </div>

        {/* address / date meta */}
        {card.meta && (
          <div className="flex items-center gap-1 mt-0.5">
            <MapPin size={10} className="text-copy flex-shrink-0" />
            <span className="text-[11.5px] text-copy-muted truncate">{card.meta}</span>
          </div>
        )}

        {/* action detail — note snippet / task title / appointment title */}
        {card.subtitle && (
          <p className="text-[12px] text-copy-muted font-medium mt-0.5 leading-snug">{card.subtitle}</p>
        )}

        {/* Detail rows — for bezoek card */}
        {card.details && card.details.length > 0 && (
          <div className="mt-1.5 mb-1 flex flex-col gap-0.5">
            {card.details.map((d, i) => (
              <div key={i} className="flex gap-1.5 text-[11.5px] leading-[1.5]">
                <span className="text-copy-muted font-medium shrink-0 w-[90px] truncate">{d.label}</span>
                <span className="text-copy">{d.value}</span>
              </div>
            ))}
          </div>
        )}

        {/* Button — links to page (no inline editing) */}
        <Link href={href} className="mini-card-btn">
          {label}
          <ExternalLink size={11} strokeWidth={2.5} />
        </Link>
      </div>
    </div>
  )
}

export function MiniCardList({ cards }: { cards: MiniCardData[] }) {
  return (
    <div className="flex flex-col gap-2 mt-1">
      {cards.map((c, i) => <MiniCard key={`${c.type}-${c.id}-${i}`} card={c} />)}
    </div>
  )
}
