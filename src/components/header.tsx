
"use client";

import { Boxes, User, LogOut, ScanBarcode } from 'lucide-react';
import Link from 'next/link';
import { Button } from './ui/button';
import { useAuth } from '@/hooks/use-auth';
import { LoginDialog } from './login-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { NotificationBell } from './notification-bell';


export function Header() {
  const { currentUser, logout } = useAuth();
  
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center px-4">
        <Link href="/" className="flex items-center gap-2 mr-6">
          <Boxes className="h-6 w-6 text-primary" />
          <span className="font-headline text-xl font-bold">HomeHub</span>
        </Link>
        <nav className="hidden md:flex items-center gap-4 text-sm">
           <Link href="/shopping" className="text-muted-foreground transition-colors hover:text-foreground">Shopping</Link>
           <Link href="/pets" className="text-muted-foreground transition-colors hover:text-foreground">Pets</Link>
           <Link href="/maintenance" className="text-muted-foreground transition-colors hover:text-foreground">Maintenance</Link>
           <Link href="/chores" className="text-muted-foreground transition-colors hover:text-foreground">Chores</Link>
           <Link href="/automation" className="text-muted-foreground transition-colors hover:text-foreground">Automation</Link>
        </nav>
        <div className="flex flex-1 items-center justify-end gap-2">
            {currentUser ? (
              <>
                 <NotificationBell />
                 <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                      <Avatar className="h-9 w-9">
                         <AvatarImage src={currentUser.avatarUrl} alt={currentUser.displayName} />
                        <AvatarFallback>{currentUser.displayName ? currentUser.displayName[0].toUpperCase() : 'U'}</AvatarFallback>
                      </Avatar>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-56" align="end" forceMount>
                    <DropdownMenuLabel className="font-normal">
                      <div className="flex flex-col space-y-1">
                        <p className="text-sm font-medium leading-none">{currentUser.displayName}</p>
                        <p className="text-xs leading-none text-muted-foreground truncate">
                          {currentUser.email}
                        </p>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                     <DropdownMenuItem asChild>
                       <Link href="/profile">
                          <User className="mr-2" />
                          <span>Profile</span>
                       </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                       <Link href="/library">
                          <ScanBarcode className="mr-2" />
                          <span>Barcode Library</span>
                       </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={logout}>
                      <LogOut className="mr-2" />
                      <span>Log out</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
                <LoginDialog>
                    <Button>Login</Button>
                </LoginDialog>
            )}
        </div>
      </div>
    </header>
  );
}
