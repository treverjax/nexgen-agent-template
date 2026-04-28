/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/**/*.{html,js}",
    "./src/**/*.{html,js}"
  ],
  theme: {
    extend: {
      fontFamily: { 
        sans: ['Inter', 'system-ui', 'sans-serif'] 
      },
      colors: { 
        cf: { 
          orange: '#F38020', 
          gray: '#f4f4f5' 
        } 
      },
      animation: { 
        'fade-in-up': 'fadeInUp 0.5s ease-out forwards',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards'
      },
      keyframes: {
        fadeInUp: { 
          '0%': { opacity: '0', transform: 'translateY(10px)' }, 
          '100%': { opacity: '1', transform: 'translateY(0)' } 
        },
        scaleIn: { 
          '0%': { opacity: '0', transform: 'scale(0.9)' }, 
          '100%': { opacity: '1', transform: 'scale(1)' } 
        }
      }
    }
  },
  plugins: [],
}
