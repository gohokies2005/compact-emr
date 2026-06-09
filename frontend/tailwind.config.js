/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif']
      },
      // Aegis maritime palette — single source of truth (mirrors CSS vars in styles/globals.css).
      // Pacific-Northwest / Puget Sound: misty water, soft maritime blues, muted brass, ivory surfaces.
      colors: {
        navy: '#315F83',
        navyDeep: '#244A68',
        harbor: '#6F8EA5',
        mist: '#DCE8EF',
        mistSoft: '#EEF4F7',
        foam: '#F8F7F3',
        ivory: '#FCFAF6',
        steel: '#748393',
        // 'slate' / 'brass' below extend (do not replace) Tailwind's slate scale.
        slateInk: '#334155',
        brass: '#C4A86F',
        brassSoft: '#E4D2A3'
      },
      borderColor: {
        aegis: 'rgba(49,95,131,0.12)'
      },
      borderRadius: {
        aegis: '24px',
        'aegis-lg': '28px'
      },
      boxShadow: {
        // Soft maritime elevation conventions.
        'aegis-panel': '0 12px 40px rgba(49,95,131,0.08)',
        'aegis-card': '0 8px 24px rgba(49,95,131,0.06)',
        'aegis-soft': '0 4px 16px rgba(49,95,131,0.05)'
      }
    }
  },
  plugins: []
};
