/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],

  darkMode: ['selector', ':root:not([data-theme="light"])'],

  theme: {
    extend: {
      colors: {
        brand: {
          primary:    '#219EBC',
          dark:       '#023047',
          light:      '#8ECAE6',
          accent:     '#FFB703',
          'accent-2': '#FB8500',
        },
        'theme-bg':           'var(--theme-bg-gradient)',
        'theme-card':         'var(--theme-card-bg)',
        'theme-border':       'var(--theme-card-border)',
        'theme-text':         'var(--color-text-primary)',
        'theme-muted':        'var(--color-text-muted)',
        'theme-surface':      'var(--color-bg-input)',
        'theme-hover':        'var(--color-bg-hover)',
        'theme-input':        'var(--theme-input-bg)',
        'theme-input-border': 'var(--theme-input-border)',
        'theme-input-color':  'var(--theme-input-color)',
      },
      fontFamily: {
        sans:    ['Geist', 'DM Sans', 'sans-serif'],
        serif:   ['Newsreader', 'Georgia', 'serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
        mono:    ['"JetBrains Mono"', '"Space Mono"', 'monospace'],
      },
      borderRadius: {
        sm:   'var(--radius-sm)',
        md:   'var(--radius-md)',
        lg:   'var(--radius-lg)',
        xl:   'var(--radius-xl)',
        full: 'var(--radius-full)',
      },
      boxShadow: {
        'brand-sm':     'var(--shadow-sm)',
        'brand-md':     'var(--shadow-md)',
        'brand-lg':     'var(--shadow-lg)',
        'glow-primary': '0 0 20px rgba(33,158,188,0.25)',
        'glow-accent':  '0 0 20px rgba(255,183,3,0.20)',
        'glow-dark':    '0 0 30px rgba(2,48,71,0.45)',
      },
      backgroundImage: {
        'brand-gradient':  'linear-gradient(135deg, #219EBC, #8ECAE6)',
        'dark-gradient':   'linear-gradient(135deg, #219EBC, #023047)',
        'accent-gradient': 'linear-gradient(135deg, #FFB703, #FB8500)',
        'warm-gradient':   'linear-gradient(135deg, #FFB703, #FB8500, #d06000)',
      },
      animation: {
        'fade-up':   'fadeUp 0.5s ease-out',
        'fade-in':   'fadeIn 0.3s ease',
        'spin-slow': 'spin 0.8s linear infinite',
      },
      keyframes: {
        fadeUp: {
          '0%':   { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },

  plugins: [],
}