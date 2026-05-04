// ─────────────────────────────────────────────────────────────────────────────
// P3: tailwind.config.ts — Space Grotesk font swap
// Replace src/../tailwind.config.ts with this file.
//
// Changes:
//   1. font-sans: "Space Grotesk" replaces "DM Sans"
//      (DM Sans will fall back to system-ui if not preloaded — safe migration)
//   2. Added --signal and --shadow-primary tokens to match new index.css
//   3. Added --gradient-brand token
//   4. Everything else unchanged
//
// REQUIRED: Add to index.html <head> (before existing Google Fonts link):
//   <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
// ─────────────────────────────────────────────────────────────────────────────

import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        // P3: Space Grotesk replaces DM Sans — one-line change, big visual impact
        sans: ["Space Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        hairline: "hsl(var(--hairline))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          glow: "hsl(var(--primary-glow))",
        },
        // New: signal token for amber (AI signals, Taylor output, caution)
        signal: {
          DEFAULT: "hsl(var(--signal))",
          foreground: "hsl(var(--signal-foreground))",
          glow: "hsl(var(--signal-glow))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        surface: {
          1: "hsl(var(--surface-1))",
          2: "hsl(var(--surface-2))",
          3: "hsl(var(--surface-3))",
        },
        status: {
          safe: "hsl(var(--status-safe))",
          "safe-foreground": "hsl(var(--status-safe-foreground))",
          caution: "hsl(var(--status-caution))",
          "caution-foreground": "hsl(var(--status-caution-foreground))",
          blocked: "hsl(var(--status-blocked))",
          "blocked-foreground": "hsl(var(--status-blocked-foreground))",
          candidate: "hsl(var(--status-candidate))",
          "candidate-foreground": "hsl(var(--status-candidate-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      backgroundImage: {
        "gradient-brand":   "var(--gradient-brand)",
        "gradient-signal":  "var(--gradient-signal)",
        "gradient-amber":   "var(--gradient-amber)",   // backward compat
        "gradient-surface": "var(--gradient-surface)",
      },
      boxShadow: {
        panel:   "var(--shadow-panel)",
        primary: "var(--shadow-primary)",
        amber:   "var(--shadow-amber)",   // backward compat
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // New: metric value flash on update (green/red direction signal)
        "flash-green": {
          "0%": { color: "hsl(var(--status-safe))" },
          "100%": { color: "inherit" },
        },
        "flash-red": {
          "0%": { color: "hsl(var(--status-blocked))" },
          "100%": { color: "inherit" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "fade-in": "fade-in 0.3s ease-out",
        "flash-green": "flash-green 0.4s ease-out",
        "flash-red": "flash-red 0.4s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
