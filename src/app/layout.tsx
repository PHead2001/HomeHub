
import type {Metadata, Viewport} from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Header } from '@/components/header';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import { Toaster } from "@/components/ui/toaster"
import { AuthProvider } from '@/contexts/auth-context';
import { PasswordChangeHandler } from '@/components/password-change-handler';
import { HouseholdManager } from '@/components/household-manager';
import { ThemeInjector } from '@/components/theme-injector';
import { FirebaseErrorListener } from '@/components/FirebaseErrorListener';
import { PushNotificationManager } from '@/components/PushNotificationManager';

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
  themeColor: '#020817',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="font-body antialiased min-h-screen flex flex-col">
        <AuthProvider>
          <PushNotificationManager />
          <FirebaseErrorListener />
          <ThemeInjector />
          <PasswordChangeHandler />
          <HouseholdManager>
            <Header />
            <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
            <MobileTabBar />
          </HouseholdManager>
          <Toaster />
        </AuthProvider>
      </body>
    </html>
  );
}
