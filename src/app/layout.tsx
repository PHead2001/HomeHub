
import type {Metadata} from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import './globals.css';
import { Header } from '@/components/header';
import { Toaster } from "@/components/ui/toaster"
import { AuthProvider } from '@/contexts/auth-context';
import { PasswordChangeHandler } from '@/components/password-change-handler';
import { HouseholdManager } from '@/components/household-manager';
import { ThemeInjector } from '@/components/theme-injector';
import { FirebaseErrorListener } from '@/components/FirebaseErrorListener';
import { PushNotificationManager } from '@/components/PushNotificationManager';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-inter',
  display: 'swap',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HomeHub',
  description: 'Your all-in-one home management dashboard.',
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
            <main className="flex-1">{children}</main>
          </HouseholdManager>
          <Toaster />
        </AuthProvider>
      </body>
    </html>
  );
}
