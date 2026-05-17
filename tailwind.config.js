/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Match the design's --font-sans / --font-mono. The body font is also
        // forced to Geist by keshucord.css, so utility classes and inherited
        // styles agree.
        sans: [
          'Geist',
          'Söhne',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'Geist Mono',
          'JetBrains Mono',
          'SF Mono',
          'ui-monospace',
          'monospace',
        ],
      },
      colors: {
        brand: {
          50: '#fff1f1',
          100: '#ffdfdf',
          400: '#ff5e5e',
          500: '#ff2e2e',
          600: '#e60000',
          700: '#b80000',
        },
        ink: {
          950: '#08080c',
          900: '#0c0c14',
          800: '#13131d',
          700: '#1d1d2b',
          600: '#2a2a3d',
          500: '#3a3a52',
        },
      },
      boxShadow: {
        glow: '0 0 60px -10px rgba(255, 46, 46, 0.45)',
        card: '0 20px 60px -20px rgba(0, 0, 0, 0.6)',
      },
      animation: {
        'fade-in': 'fadeIn 220ms ease-out',
        'slide-up': 'slideUp 360ms cubic-bezier(0.22, 1, 0.36, 1)',
        'pulse-glow': 'pulseGlow 2.4s ease-in-out infinite',
        'gradient-shift': 'gradientShift 16s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 30px -6px rgba(255,46,46,0.35)' },
          '50%': { boxShadow: '0 0 55px -2px rgba(255,46,46,0.7)' },
        },
        gradientShift: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
