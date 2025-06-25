
'use client';

import { useAuth } from '@/hooks/use-auth';

export function ThemeInjector() {
  const { currentUser } = useAuth();
  const theme = currentUser?.theme;

  // Default dark theme values from globals.css
  const background = theme?.background || '222.2 84% 4.9%';
  const accent = theme?.accent || '174 44% 51%';
  const primary = accent;
  const ring = accent;
  
  // Custom properties for foreground colors can be derived or set here if needed
  // For now, we assume high contrast is desired.
  // A helper function could determine whether to use light/dark text based on L of HSL.
  const primaryForeground = '0 0% 100%'; // White text on primary color
  const accentForeground = '0 0% 100%'; // White text on accent color


  const css = `
    .dark {
      --background: ${background};
      --foreground: 210 40% 98%;
      --card: ${background};
      --card-foreground: 210 40% 98%;
      --popover: ${background};
      --popover-foreground: 210 40% 98%;
      --primary: ${primary};
      --primary-foreground: ${primaryForeground};
      --secondary: 217.2 32.6% 17.5%;
      --secondary-foreground: 210 40% 98%;
      --muted: 217.2 32.6% 17.5%;
      --muted-foreground: 215 20.2% 65.1%;
      --accent: ${accent};
      --accent-foreground: ${accentForeground};
      --border: 217.2 32.6% 17.5%;
      --input: 217.2 32.6% 17.5%;
      --ring: ${ring};
    }
  `;

  return <style>{css}</style>;
}
