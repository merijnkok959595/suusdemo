'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

export function Nav() {
  const path = usePathname()
  return (
    <nav className="flex items-center gap-1 px-4 py-2 border-b border-border bg-bg flex-shrink-0">
      <span className="text-[14px] font-bold text-primary tracking-tight mr-3">Süüs</span>
      {[
        { href: '/suus', label: 'Demo' },
        { href: '/flow', label: 'Flow' },
      ].map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            'px-3 py-1 rounded-full text-[12px] font-medium transition-colors',
            path === href
              ? 'bg-primary text-white'
              : 'text-muted hover:text-primary hover:bg-active',
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}
