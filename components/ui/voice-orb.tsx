'use client'

import React from 'react'
import { cn } from '@/lib/utils'

export type VoiceOrbState = 'idle' | 'connecting' | 'listening' | 'speaking'

export type VoiceOrbProps = {
  state?:     VoiceOrbState
  size?:      number
  imageSrc?:  string | null
  onClick?:   () => void
  className?: string
}

export function VoiceOrb({
  state = 'idle',
  size = 200,
  imageSrc,
  onClick,
  className,
}: VoiceOrbProps) {
  const isSpeaking   = state === 'speaking'
  const isListening  = state === 'listening'
  const isConnecting = state === 'connecting'
  const isActive     = state !== 'idle'

  /* ── Photo mode ─────────────────────────────────────────────── */
  if (imageSrc) {
    const animClass = isConnecting
      ? 'animate-[orbBreath_1s_ease-in-out_infinite]'
      : isSpeaking
        ? 'animate-[orbBreath_0.65s_ease-in-out_infinite]'
        : isListening
          ? 'animate-[orbBreath_1.2s_ease-in-out_infinite]'
          : isActive
            ? 'animate-[orbBreath_2.5s_ease-in-out_infinite]'
            : ''

    const shadow = isSpeaking
      ? '0 0 0 2.5px rgba(99,102,241,0.55), 0 8px 28px rgba(0,0,0,0.2)'
      : isListening
        ? '0 0 0 2.5px rgba(34,197,94,0.6), 0 8px 28px rgba(0,0,0,0.15)'
        : isActive
          ? '0 6px 24px rgba(0,0,0,0.15)'
          : '0 4px 16px rgba(0,0,0,0.10)'

    return (
      <div
        onClick={onClick}
        className={cn('relative flex-shrink-0 select-none', onClick && 'cursor-pointer', className)}
        style={{ width: size, height: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageSrc}
          alt="AI assistant"
          className={cn('absolute inset-0 w-full h-full rounded-full object-cover object-top transition-all duration-300', animClass)}
          style={{ boxShadow: shadow }}
          draggable={false}
        />

        {/* Speaking: wave bars + blue tint */}
        {isSpeaking && (
          <div
            className="absolute inset-0 rounded-full flex items-end justify-center pb-[10%] overflow-hidden gap-[3px]"
            style={{ background: 'rgba(79,70,229,0.25)' }}
          >
            {[0, 0.12, 0.24, 0.36, 0.24, 0.12, 0].map((delay, i) => (
              <div
                key={i}
                className="w-[2.5px] rounded-full bg-white/90"
                style={{ animation: `waveAnim 0.75s ease-in-out ${delay}s infinite` }}
              />
            ))}
          </div>
        )}

        {/* Listening: subtle green tint overlay */}
        {isListening && (
          <div
            className="absolute inset-0 rounded-full transition-opacity duration-300"
            style={{ background: 'rgba(34,197,94,0.12)' }}
          />
        )}
      </div>
    )
  }

  /* ── Animated orb mode (default) ─────────────────────────────── */
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
      {/* Base: white-blue gradient */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: 'radial-gradient(circle at 40% 35%, #FFFFFF 0%, #E0F2FF 45%, #B3DDFF 100%)' }}
      />

      {/* Conic spin layer 1 */}
      <div
        className={cn(
          'absolute inset-0 rounded-full',
          isActive
            ? 'animate-[spinSlow_5s_linear_infinite]'
            : 'animate-[spinSlow_12s_linear_infinite]',
        )}
        style={{
          background: 'conic-gradient(from 180deg at 50% 50%, #FFFFFF 0deg, #5AC8FA 80deg, #007AFF 160deg, #FFFFFF 230deg, #B3DDFF 300deg, #FFFFFF 360deg)',
          opacity: isActive ? 0.85 : 0.65,
          transition: 'opacity 0.8s ease',
        }}
      />

      {/* Conic counter-spin layer 2 */}
      <div
        className={cn(
          'absolute inset-[7%] rounded-full',
          isActive
            ? 'animate-[spinSlowRev_4s_linear_infinite]'
            : 'animate-[spinSlowRev_9s_linear_infinite]',
        )}
        style={{
          background: 'conic-gradient(from 0deg at 50% 50%, #FFFFFF 0deg, #007AFF 90deg, #5AC8FA 180deg, #FFFFFF 270deg, #007AFF 360deg)',
          opacity: 0.45,
          filter: `blur(${isActive ? 5 : 8}px)`,
          transition: 'filter 0.8s ease, opacity 0.8s ease',
        }}
      />

      {/* Radial depth mask */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'radial-gradient(circle at 50% 50%, transparent 20%, rgba(0,122,255,0.12) 60%, rgba(0,122,255,0.22) 100%)',
        }}
      />

      {/* Breathing pulse (active states) */}
      <div
        className={cn(
          'absolute inset-0 rounded-full transition-opacity duration-700',
          isActive ? 'opacity-100 animate-[orbBreath_2s_ease-in-out_infinite]' : 'opacity-0',
        )}
        style={{
          background: 'radial-gradient(circle at 38% 36%, rgba(255,255,255,0.95) 0%, transparent 50%)',
        }}
      />

      {/* Connecting: fast ping ring */}
      {isConnecting && (
        <div
          className="absolute inset-[-6px] rounded-full animate-ping"
          style={{ border: '2px solid rgba(0,122,255,0.45)', animationDuration: '1.2s' }}
        />
      )}

      {/* Listening: gentle pulse ring */}
      {isListening && (
        <div
          className="absolute inset-[-4px] rounded-full"
          style={{ border: '2px solid rgba(90,200,250,0.6)', animation: 'ringPulse 1.8s ease-out infinite' }}
        />
      )}

      {/* Speaking: wave bars */}
      {isSpeaking && (
        <div className="absolute inset-0 flex items-center justify-center gap-[3px]">
          {[0, 0.15, 0.3, 0.45, 0.3, 0.15, 0].map((delay, i) => (
            <div
              key={i}
              className="w-[3px] rounded-full bg-white/80"
              style={{ animation: `waveAnim 0.8s ease-in-out ${delay}s infinite` }}
            />
          ))}
        </div>
      )}

      {/* Satin sheen */}
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

      {/* Glass border */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          boxShadow: 'inset 0 1.5px 2px rgba(255,255,255,0.95), inset 0 -1px 1px rgba(0,122,255,0.15)',
          border: '1px solid rgba(255,255,255,0.55)',
        }}
      />

      {/* Outer glow */}
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
