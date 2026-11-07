
import type {Metadata, Viewport} from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Header } from '@/components/header';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import { Toaster } from "@/components/ui/toaster"
import { AuthProvider } from '@/contexts/auth-context';
import { PasswordChangeHandler } from '@/components/password-change-handler';
import { HouseholdManager } from '@/components/household-manager';
import { AppearanceProvider } from '@/components/appearance-provider';
import { AmbientBackground } from '@/components/motion/ambient-background';
import { NavigationProgress } from '@/components/motion/navigation-progress';
import { GlowPointerTracker } from '@/components/motion/glow-card';
import { MorphRouteListener } from '@/hooks/use-morph-navigation';
import { themeCss, DEFAULT_DARK_PRESET } from '@/lib/theme/tokens';
import { THEME_COLORS, themeBootstrapScript } from '@/lib/theme/appearance';
import { FirebaseErrorListener } from '@/components/FirebaseErrorListener';
import { DeferredPushNotificationManager } from '@/components/deferred-push-notification-manager';
import { CommandCenter } from '@/components/command/command-center';
import { TimeOfDayTint } from '@/components/dashboard/time-of-day';

// Fonts are bundled from npm (Fontsource variable fonts, Latin subset), not fetched
// from Google Fonts at build time: that download failed intermittently and broke
// builds (CI and an App Hosting rollout) with a next/font loader error.
const inter = localFont({
  src: '../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  weight: '100 900',
  variable: '--font-inter',
  display: 'swap',
});

const spaceGrotesk = localFont({
  src: '../../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2',
  weight: '300 700',
  variable: '--font-space-grotesk',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HomeHub',
  description: 'Your all-in-one home management dashboard.',
  // The manifest link and icon tags come from src/app/manifest.ts, icon.svg,
  // favicon.ico and apple-icon.png (Next file conventions).
  applicationName: 'HomeHub',
  appleWebApp: {
    capable: true,
    title: 'HomeHub',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
};

// viewport-fit=cover lets the phone tab bar sit above the home indicator via safe-area insets.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Updated before paint (and on theme change) to the active preset's background.
  themeColor: THEME_COLORS[DEFAULT_DARK_PRESET],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The theme script rewrites data-theme / class / data-motion before hydration.
    <html
      lang="en"
      data-theme={DEFAULT_DARK_PRESET}
      className={`dark ${inter.variable} ${spaceGrotesk.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Color tokens for every preset (src/lib/theme/tokens.ts). */}
        <style id="homehub-theme-tokens" dangerouslySetInnerHTML={{ __html: themeCss() }} />
        {/* Applies the stored theme and motion preference before first paint: no flash. */}
        <script id="homehub-theme-bootstrap" dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
      </head>
      <body className="font-body antialiased min-h-screen flex flex-col">
        <AmbientBackground />
        <AuthProvider>
          <AppearanceProvider>
            <NavigationProgress />
            <TimeOfDayTint />
            <GlowPointerTracker />
            <MorphRouteListener />
            <DeferredPushNotificationManager />
            <FirebaseErrorListener />
            <PasswordChangeHandler />
            <HouseholdManager>
              <Header />
              <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
              <MobileTabBar />
              <CommandCenter />
            </HouseholdManager>
            <Toaster />
          </AppearanceProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
