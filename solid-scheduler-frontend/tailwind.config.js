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
          primary:    '#6366F1',
          dark:       '#312E81',
          light:      '#A5B4FC',
          accent:     '#6366F1',
          'accent-2': '#4F46E5',
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
        sans:    ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        serif:   ['Georgia', 'Times New Roman', 'serif'],
        display: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono:    ['Menlo', 'Consolas', 'monospace'],
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
        'glow-primary': '0 0 20px rgba(99,102,241,0.20)',
        'glow-accent':  '0 0 20px rgba(99,102,241,0.15)',
        'glow-dark':    '0 0 30px rgba(15,23,42,0.40)',
      },
      backgroundImage: {
        'brand-gradient':  'linear-gradient(135deg, #6366F1, #A5B4FC)',
        'dark-gradient':   'linear-gradient(135deg, #6366F1, #312E81)',
        'accent-gradient': 'linear-gradient(135deg, #6366F1, #4F46E5)',
        'warm-gradient':   'linear-gradient(135deg, #6366F1, #4F46E5, #312E81)',
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
