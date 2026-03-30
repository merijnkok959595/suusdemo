import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import { Nav } from '@/components/nav'
import './globals.css'

const inter = Inter({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'SUUS Demo',
  description: 'AI sales-assistent demo',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl" className={inter.className}>
      <body style={{ margin: 0, height: '100dvh' }} className="flex flex-col bg-bg">
        <Nav />
        <div className="flex-1 overflow-hidden flex flex-col">
          {children}
        </div>
      </body>
    </html>
  )
}
