import type {Config} from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/hooks/**/*.{js,ts,jsx,tsx}',
    './src/lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      // `coarse:` applies on touch screens (D-2: 48 px targets there, 44 px elsewhere).
      // Raw media screens come after the width breakpoints, so `coarse:` wins over `md:`.
      screens: {
        coarse: { raw: '(pointer: coarse)' },
      },
      fontFamily: {
        body: ['var(--font-inter)', 'sans-serif'],
        headline: ['var(--font-space-grotesk)', 'sans-serif'],
        code: ['monospace'],
      },
      // Every color is a token from src/lib/theme/tokens.ts (no raw literals).
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        // Elevation aliases: base (page), raised (cards), overlay (dialogs, popovers, sheets).
        surface: {
          base: 'hsl(var(--background))',
          raised: 'hsl(var(--card))',
          overlay: 'hsl(var(--popover))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        border: {
          DEFAULT: 'hsl(var(--border))',
          subtle: 'hsl(var(--border-subtle))',
        },
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        scrim: 'hsl(var(--scrim))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))',
        },
        // Per-member colors; pick one with memberColor() from src/lib/member-colors.ts.
        member: {
          '1': 'hsl(var(--member-1))',
          '2': 'hsl(var(--member-2))',
          '3': 'hsl(var(--member-3))',
          '4': 'hsl(var(--member-4))',
          '5': 'hsl(var(--member-5))',
          '6': 'hsl(var(--member-6))',
          '7': 'hsl(var(--member-7))',
          '8': 'hsl(var(--member-8))',
          foreground: 'hsl(var(--member-foreground))',
        },
      },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
      },
      transitionDuration: {
        micro: 'var(--duration-micro)',
        ui: 'var(--duration-ui)',
        data: 'var(--duration-data)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        exit: 'var(--ease-exit)',
        spring: 'var(--ease-spring)',
      },
      borderRadius: {
        // One radius scale derived from --radius (globals.css).
        '2xl': 'calc(var(--radius) + 8px)',
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
  // `hover:` styles apply only on devices with a real hovering pointer, so a tapped
  // button on a phone never keeps a stuck hover fill (audit section 4, "Refresh").
  future: { hoverOnlyWhenSupported: true },
} satisfies Config;
