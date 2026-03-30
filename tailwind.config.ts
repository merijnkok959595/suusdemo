import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#7C3AED',
          subtle:  '#F5F0FF',
          rgb:     '124, 58, 237',
        },
        bg:      '#F7F6F3',
        surface: '#FFFFFF',
        border:  '#E8E6E0',
        active:  '#F3F2EF',
        // Text scale
        primary:   '#1a1a1a',
        secondary: '#333333',
        muted:     '#6B7280',
        subtle:    '#9CA3AF',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ["'SF Mono'", "'Fira Code'", 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
        sm:  '6px',
        md:  '8px',
        lg:  '12px',
        xl:  '16px',
        '2xl': '20px',
      },
      boxShadow: {
        card:   '0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)',
        panel:  '0 4px 24px rgba(0,0,0,.08), 0 1px 4px rgba(0,0,0,.04)',
        input:  '0 0 0 3px rgba(124,58,237,.15)',
        brand:  '0 4px 14px rgba(124,58,237,.35)',
      },
      keyframes: {
        thinkPulse: { '0%,100%': { opacity: '0.15' }, '50%': { opacity: '1' } },
        fadeUp:    { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        msgIn:     { from: { opacity: '0', transform: 'translateY(3px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        dotBounce: { '0%,80%,100%': { transform: 'translateY(0)' }, '40%': { transform: 'translateY(-5px)' } },
        recPulse:  { '0%,100%': { opacity: '1' }, '50%': { opacity: '.3' } },
        orbSpin:   { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
        orbMorph: {
          '0%,100%': { borderRadius: '50%' },
          '25%':     { borderRadius: '44% 56% 55% 45%/48% 52% 48% 52%' },
          '50%':     { borderRadius: '56% 44% 48% 52%/52% 48% 54% 46%' },
          '75%':     { borderRadius: '48% 52% 44% 56%/44% 56% 52% 48%' },
        },
        orbInner:  { '0%,100%': { opacity: '1', transform: 'scale(1)' }, '50%': { opacity: '.7', transform: 'scale(1.08)' } },
        ringPulse: { '0%': { transform: 'scale(1)', opacity: '.5' }, '70%,100%': { transform: 'scale(1.8)', opacity: '0' } },
        waveAnim:     { '0%,100%': { height: '4px' }, '50%': { height: '22px' } },
        waveUser:     { '0%,100%': { height: '4px' }, '50%': { height: '14px' } },
        dictWave:     { '0%,100%': { transform: 'scaleY(0.4)' }, '50%': { transform: 'scaleY(1)' } },
        spinSlow:     { from: { transform: 'rotate(0deg)' },   to: { transform: 'rotate(360deg)' } },
        spinSlowRev:  { from: { transform: 'rotate(0deg)' },   to: { transform: 'rotate(-360deg)' } },
        orbBreath:    { '0%,100%': { transform: 'scale(1)', opacity: '0.7' }, '50%': { transform: 'scale(1.06)', opacity: '1' } },
        orbSheen:     { '0%': { transform: 'rotate(0deg) translateX(20%) rotate(0deg)' }, '100%': { transform: 'rotate(360deg) translateX(20%) rotate(-360deg)' } },
      },
      transitionTimingFunction: {
        'drawer': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      animation: {
        'fade-up':    'fadeUp .4s ease',
        'msg-in':     'msgIn .2s ease',
        'dot-bounce': 'dotBounce .9s ease-in-out infinite',
        'rec-pulse':  'recPulse 1s ease-in-out infinite',
        'orb-spin':   'orbSpin 8s linear infinite',
        'orb-spin-fast': 'orbSpin 2s linear infinite',
        'orb-morph':  'orbMorph 9s cubic-bezier(.45,.05,.55,.95) infinite',
        'orb-morph-fast': 'orbMorph 3s cubic-bezier(.45,.05,.55,.95) infinite',
        'orb-inner':  'orbInner 12s ease-in-out infinite',
        'orb-inner-fast': 'orbInner 3s ease-in-out infinite',
        'ring-pulse': 'ringPulse 1.6s ease-out infinite',
        'wave-agent':    'waveAnim .6s ease-in-out infinite',
        'wave-user':     'waveUser .8s ease-in-out infinite',
        'dict-wave':     'dictWave .7s ease-in-out infinite',
        'spin-slow':     'spinSlow 12s linear infinite',
        'spin-slow-rev': 'spinSlowRev 18s linear infinite',
        'orb-breath':    'orbBreath 4s ease-in-out infinite',
        'orb-sheen':     'orbSheen 8s linear infinite',
      },
    },
  },
  plugins: [],
}

export default config
