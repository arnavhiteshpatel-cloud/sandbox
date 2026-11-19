import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(here, 'index.html'), path.join(here, 'src/**/*.{ts,tsx}')],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#07070a', 900: '#0c0c11', 850: '#111118', 800: '#16161f', 700: '#1f1f2b', 600: '#2a2a38' },
        haze: { 100: '#f4f1ea', 200: '#d9d5cc', 300: '#a9a59c', 400: '#7c7972', 500: '#5a5853' },
        ember: { 300: '#ffd19a', 400: '#f5b971', 500: '#e89a45', 600: '#c97a2a' },
        ok: '#7ee0b8', warn: '#ffd36e', bad: '#ff8a8a', sky: '#8ec5ff',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        lift: '0 18px 50px -12px rgba(0,0,0,.7)',
        glow: '0 0 0 1px rgba(245,185,113,.35), 0 10px 40px -10px rgba(245,185,113,.35)',
      },
      keyframes: {
        fadeUp: { '0%': { opacity: 0, transform: 'translateY(10px)' }, '100%': { opacity: 1, transform: 'none' } },
        fadeIn: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        shimmer: { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
        kenburns: { '0%': { transform: 'scale(1.04)' }, '100%': { transform: 'scale(1.12) translate(-1%, -1%)' } },
      },
      animation: {
        fadeUp: 'fadeUp .5s cubic-bezier(.2,.7,.2,1) both',
        fadeIn: 'fadeIn .4s ease both',
        shimmer: 'shimmer 1.4s linear infinite',
        kenburns: 'kenburns 24s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [],
};
