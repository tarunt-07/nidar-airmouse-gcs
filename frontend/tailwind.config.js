/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#05080F',
        panel: '#0C1524',
        panel2: '#101C2E',
        border: '#1E3350',
        accent: '#35E0F0',
        accent2: '#8B7BFF',
        mint: '#46F0C0',
        amber: '#FFC46B',
        ok: '#3EE6A0',
        warn: '#FFC24B',
        crit: '#FF5D73',
        survivor: '#FF7A9C',
        ink: '#DCE7F7',
        dim: '#8497B4',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 18px rgba(53,224,240,0.28)',
        glowlg: '0 0 34px rgba(53,224,240,0.35)',
        violet: '0 0 22px rgba(139,123,255,0.30)',
        panel:
          'inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.5), 0 18px 44px -18px rgba(0,0,0,0.92)',
        tile: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 6px 16px -10px rgba(0,0,0,0.8)',
      },
      borderRadius: {
        xl2: '14px',
      },
      transitionDuration: {
        250: '250ms',
      },
      keyframes: {
        breathe: {
          '0%,100%': { opacity: '0.55', transform: 'scale(0.98)' },
          '50%': { opacity: '1', transform: 'scale(1.02)' },
        },
        sheen: {
          '0%': { transform: 'translateX(-130%)' },
          '100%': { transform: 'translateX(130%)' },
        },
        rise: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        glowsweep: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        breathe: 'breathe 3.2s ease-in-out infinite',
        rise: 'rise 0.35s ease-out both',
        sheen: 'sheen 0.9s ease',
        glowsweep: 'glowsweep 6s linear infinite',
      },
    },
  },
  plugins: [],
}
