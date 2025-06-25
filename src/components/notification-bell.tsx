
"use client"

import { useState, useEffect, useRef } from "react";
import { Bell, CheckCheck, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import type { Notification } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { db, auth } from "@/lib/firebase";
import { collection, query, orderBy, onSnapshot, doc, writeBatch, deleteDoc } from "firebase/firestore";
import { errorEmitter } from '@/lib/error-emitter';
import { FirestorePermissionError } from '@/lib/errors';
import { useToast } from "@/hooks/use-toast";


function NotificationItem({ notification, onDelete }: { notification: Notification, onDelete: (id: string) => void }) {
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const wasDraggedRef = useRef(false);
  const SWIPE_THRESHOLD = -60; // Swiping 60px to the left triggers delete

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;

    // Reset drag state for new interaction
    wasDraggedRef.current = false;
    setIsDragging(true);
    startXRef.current = e.clientX;
    itemRef.current?.setPointerCapture(e.pointerId);
    if(itemRef.current) {
        itemRef.current.style.transition = 'none'; // Disable transition while dragging for instant feedback
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !e.isPrimary) return;
    
    const currentX = e.clientX;
    const deltaX = currentX - startXRef.current;

    // If movement is significant, consider it a drag and prevent default behavior.
    if (Math.abs(deltaX) > 5) {
        wasDraggedRef.current = true;
    }
    
    if (wasDraggedRef.current) {
      // Prevent text selection and other side effects on PC
      e.preventDefault();
    }
    
    // Only allow swiping left, and provide some resistance if swiping right
    if (deltaX < 50) {
      setDragX(deltaX < 0 ? deltaX : deltaX / 5);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !e.isPrimary) return;
    
    setIsDragging(false);
    itemRef.current?.releasePointerCapture(e.pointerId);
    if(itemRef.current) {
        itemRef.current.style.transition = 'transform 0.2s ease-out'; // Re-enable transition for snapping
    }

    if (wasDraggedRef.current && dragX < SWIPE_THRESHOLD) {
      // Animate out and delete
      setDragX(-itemRef.current!.offsetWidth);
      setTimeout(() => {
        onDelete(notification.id);
      }, 200); // Wait for animation to finish
    } else {
      // Snap back to original position
      setDragX(0);
    }
  };
  
  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      setIsDragging(false);
      wasDraggedRef.current = false;
      itemRef.current?.releasePointerCapture(e.pointerId);
      if(itemRef.current) itemRef.current.style.transition = 'transform 0.2s ease-out';
      setDragX(0);
    }
  }

  const backgroundOpacity = Math.min(Math.abs(dragX / SWIPE_THRESHOLD), 1);

  return (
    <div className="relative bg-popover overflow-hidden rounded-sm w-full">
       <div 
        className="absolute inset-y-0 right-0 flex items-center justify-end pr-4 bg-destructive text-destructive-foreground"
        style={{ opacity: backgroundOpacity, width: '100%' }}
      >
        <Trash2 className="h-5 w-5" />
      </div>
      <div
        ref={itemRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className="w-full touch-pan-y bg-popover"
        style={{ transform: `translateX(${dragX}px)`, cursor: isDragging ? 'grabbing' : 'grab' }}
      >
         <DropdownMenuItem 
            asChild 
            className={cn("flex flex-col items-start gap-1 whitespace-normal p-0", !notification.isRead && "bg-accent/50")} 
            onSelect={(e) => {
               // If the item was dragged, prevent navigation and the dropdown from closing.
               if (wasDraggedRef.current) e.preventDefault();
            }}
         >
            <Link href={notification.href || '#'} className="w-full h-full p-2 block" draggable={false}>
                <p className="text-sm pointer-events-none">{notification.message}</p>
                <p className="text-xs text-muted-foreground pointer-events-none">
                    {formatDistanceToNow(notification.createdAt, { addSuffix: true })}
                </p>
            </Link>
        </DropdownMenuItem>
      </div>
    </div>
  );
}


export function NotificationBell() {
    const { currentUser } = useAuth();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const { toast } = useToast();

    useEffect(() => {
        if (!currentUser?.email) return;

        // --- START: Auth Debugging Log ---
        const logAuthInfo = async () => {
            if (auth.currentUser) {
                console.log("--- AUTH DEBUG INFO ---");
                console.log("currentUser.uid from useAuth hook:", currentUser.uid);
                console.log("currentUser.email from useAuth hook:", currentUser.email);
                
                try {
                    const idTokenResult = await auth.currentUser.getIdTokenResult();
                    console.log("Firebase Auth Token Claims:", idTokenResult.claims);
                    console.log("Sign-in provider:", idTokenResult.signInProvider);
                    console.log("Token email from claims:", idTokenResult.claims.email);
                } catch (error) {
                    console.error("Error getting ID token result:", error);
                }
                console.log("-------------------------");
            } else {
                console.log("--- AUTH DEBUG INFO ---");
                console.log("auth.currentUser is null. No user is authenticated in the core Firebase Auth SDK context.");
                console.log("-------------------------");
            }
        };
        logAuthInfo();
        // --- END: Auth Debugging Log ---

        const q = query(
            collection(db, 'users', currentUser.email, 'notifications'),
            orderBy('createdAt', 'desc')
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const notifs = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt.toDate() // Convert Firestore Timestamp to Date
            } as Notification));
            setNotifications(notifs);
        },
        async (error) => {
            console.error(error); // Keep original console error
            const permissionError = new FirestorePermissionError({
                path: `users/${currentUser.email}/notifications`,
                operation: 'list',
            });
            errorEmitter.emit('permission-error', permissionError);
        });

        return () => unsubscribe();
    }, [currentUser?.email, currentUser?.uid]);


    const unreadCount = notifications.filter(n => !n.isRead).length;

    const markAllAsRead = async () => {
        if (!currentUser?.email || unreadCount === 0) return;

        const batch = writeBatch(db);
        const unreadNotifications = notifications.filter(n => !n.isRead);
        
        unreadNotifications.forEach(notification => {
            const notifRef = doc(db, 'users', currentUser!.email, 'notifications', notification.id);
            batch.update(notifRef, { isRead: true });
        });
        
        try {
            await batch.commit();
        } catch(error) {
            console.error("Error marking all notifications as read:", error);
            // Emit a contextual error for the batch write operation
            const permissionError = new FirestorePermissionError({
                path: `users/${currentUser.email}/notifications`,
                operation: 'update',
                requestResourceData: { isRead: true } // Representing the batch update
            });
            errorEmitter.emit('permission-error', permissionError);
        }
    };
    
    const handleDeleteNotification = async (notificationId: string) => {
        if (!currentUser?.email) return;
        const notifRef = doc(db, 'users', currentUser.email, 'notifications', notificationId);
        try {
            await deleteDoc(notifRef);
            // No toast on success, the UI feedback is enough.
        } catch (error) {
            console.error("Error deleting notification:", error);
            toast({ variant: 'destructive', title: 'Error', description: 'Could not delete notification.' });
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="relative">
                    <Bell className="h-5 w-5" />
                    {unreadCount > 0 && (
                        <span className="absolute top-0 right-0 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center">
                            {unreadCount}
                        </span>
                    )}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 p-0">
                 <div className="p-2">
                    <DropdownMenuLabel className="flex justify-between items-center">
                        <span className="font-headline">Notifications</span>
                        {unreadCount > 0 && (
                            <Button variant="ghost" size="sm" onClick={markAllAsRead} className="text-xs h-auto py-1 px-2">
                                <CheckCheck className="mr-1 h-3 w-3" />
                                Mark all as read
                            </Button>
                        )}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                </div>
                <ScrollArea className="h-64">
                    {notifications.length > 0 ? (
                        <div className="space-y-1 p-1">
                            {notifications.map(notification => (
                                <NotificationItem key={notification.id} notification={notification} onDelete={handleDeleteNotification} />
                            ))}
                        </div>
                    ) : (
                        <p className="text-center text-sm text-muted-foreground py-8">No new notifications</p>
                    )}
                </ScrollArea>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
