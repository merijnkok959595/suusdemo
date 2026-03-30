'use client'

import React from 'react'
import { cn } from '@/lib/utils'

export type VoiceOrbState = 'idle' | 'connecting' | 'listening' | 'speaking'

export type VoiceOrbProps = {
  state?: VoiceOrbState
  size?: number
  onClick?: () => void
  className?: string
}

export function VoiceOrb({
  state = 'idle',
  size = 200,
  onClick,
  className,
}: VoiceOrbProps) {
  const isSpeaking   = state === 'speaking'
  const isListening  = state === 'listening'
  const isConnecting = state === 'connecting'
  const isActive     = state !== 'idle'

  return (
    <div
      onClick={onClick}
      className={cn(
        'relative rounded-full overflow-hidden select-none flex-shrink-0',
        onClick && 'cursor-pointer',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* ── Base: white-blue gradient ───────────────────────────────── */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: 'radial-gradient(circle at 40% 35%, #FFFFFF 0%, #E0F2FF 45%, #B3DDFF 100%)' }}
      />

      {/* ── Conic spin layer 1 – main shimmer ───────────────────────── */}
      <div
        className={cn(
          'absolute inset-0 rounded-full',
          isActive ? 'animate-[spinSlow_5s_linear_infinite]' : 'animate-[spinSlow_12s_linear_infinite]',
        )}
        style={{
          background:
            'conic-gradient(from 180deg at 50% 50%, #FFFFFF 0deg, #5AC8FA 80deg, #007AFF 160deg, #FFFFFF 230deg, #B3DDFF 300deg, #FFFFFF 360deg)',
          opacity: isActive ? 0.85 : 0.65,
          transition: 'opacity 0.8s ease',
        }}
      />

      {/* ── Conic counter-spin layer 2 – blurred depth ──────────────── */}
      <div
        className={cn(
          'absolute inset-[7%] rounded-full',
          isActive ? 'animate-[spinSlowRev_4s_linear_infinite]' : 'animate-[spinSlowRev_9s_linear_infinite]',
        )}
        style={{
          background:
            'conic-gradient(from 0deg at 50% 50%, #FFFFFF 0deg, #007AFF 90deg, #5AC8FA 180deg, #FFFFFF 270deg, #007AFF 360deg)',
          opacity: 0.45,
          filter: `blur(${isActive ? 5 : 8}px)`,
          transition: 'filter 0.8s ease, opacity 0.8s ease',
        }}
      />

      {/* ── Radial depth mask ───────────────────────────────────────── */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, transparent 20%, rgba(0,122,255,0.12) 60%, rgba(0,122,255,0.22) 100%)',
        }}
      />

      {/* ── Breathing pulse (active states) ─────────────────────────── */}
      <div
        className={cn(
          'absolute inset-0 rounded-full transition-opacity duration-700',
          isActive ? 'opacity-100 animate-[orbBreath_2s_ease-in-out_infinite]' : 'opacity-0',
        )}
        style={{
          background:
            'radial-gradient(circle at 38% 36%, rgba(255,255,255,0.95) 0%, transparent 50%)',
        }}
      />

      {/* ── Connecting: fast ping ring ───────────────────────────────── */}
      {isConnecting && (
        <div
          className="absolute inset-[-6px] rounded-full animate-ping"
          style={{
            border: '2px solid rgba(0,122,255,0.45)',
            animationDuration: '1.2s',
          }}
        />
      )}

      {/* ── Listening: gentle pulse ring ────────────────────────────── */}
      {isListening && (
        <div
          className="absolute inset-[-4px] rounded-full"
          style={{
            border: '2px solid rgba(90,200,250,0.6)',
            animation: 'ringPulse 1.8s ease-out infinite',
          }}
        />
      )}


      {/* ── Satin sheen (top-left highlight) ────────────────────────── */}
      <div
        className="absolute rounded-full animate-[orbSheen_6s_ease-in-out_infinite]"
        style={{
          width: '52%', height: '52%',
          top: '5%', left: '8%',
          background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.92) 0%, transparent 70%)',
          filter: 'blur(10px)',
          opacity: 0.75,
        }}
      />

      {/* ── Glass border ────────────────────────────────────────────── */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          boxShadow: 'inset 0 1.5px 2px rgba(255,255,255,0.95), inset 0 -1px 1px rgba(0,122,255,0.15)',
          border: '1px solid rgba(255,255,255,0.55)',
        }}
      />

      {/* ── Outer glow ──────────────────────────────────────────────── */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none transition-all duration-700"
        style={{
          boxShadow: isActive
            ? '0 0 32px rgba(0,122,255,0.45), 0 0 12px rgba(90,200,250,0.35), 0 4px 16px rgba(0,0,0,0.1)'
            : '0 8px 28px rgba(0,122,255,0.18), 0 2px 8px rgba(0,0,0,0.06)',
        }}
      />
    </div>
  )
}

export function OrbBadge({ icon, label }: { icon?: React.ReactNode; label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/60 text-[11px] font-semibold text-gray-700 tracking-wide"
      style={{
        background: 'rgba(255,255,255,0.75)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
      }}
    >
      {icon && (
        <span className="w-4 h-4 rounded-full bg-gray-900 text-white flex items-center justify-center text-[9px]">
          {icon}
        </span>
      )}
      {label}
    </div>
  )
}
