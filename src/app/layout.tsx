
import type {Metadata} from 'next';
import './globals.css';
import { Header } from '@/components/header';
import { Toaster } from "@/components/ui/toaster"
import { AuthProvider } from '@/contexts/auth-context';
import { PasswordChangeHandler } from '@/components/password-change-handler';
import { HouseholdManager } from '@/components/household-manager';
import { ThemeInjector } from '@/components/theme-injector';
import { FirebaseErrorListener } from '@/components/FirebaseErrorListener';
import { PushNotificationManager } from '@/components/PushNotificationManager';

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
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet" />
      </head>
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

    
