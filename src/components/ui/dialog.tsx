"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { trackKeyboardInset } from "@/lib/keyboard-inset"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-scrim/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * SH-19b: on phones (below `sm`) a `phoneSheet` dialog is a bottom sheet: full
 * width, anchored to the bottom, sliding up, and lifted above the on-screen
 * keyboard by `--keyboard-inset` (kept by `trackKeyboardInset` while it is open).
 * From `sm` up it is the usual centred dialog.
 */
const PHONE_SHEET_CLASSES =
  "[@media(max-width:639.98px)]:left-0 [@media(max-width:639.98px)]:right-0 [@media(max-width:639.98px)]:top-auto [@media(max-width:639.98px)]:bottom-[var(--keyboard-inset,0px)] [@media(max-width:639.98px)]:max-h-[calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px))] [@media(max-width:639.98px)]:max-w-none [@media(max-width:639.98px)]:translate-x-0 [@media(max-width:639.98px)]:translate-y-0 [@media(max-width:639.98px)]:rounded-t-2xl [@media(max-width:639.98px)]:border-x-0 [@media(max-width:639.98px)]:border-b-0 [@media(max-width:639.98px)]:pb-[calc(1.5rem+env(safe-area-inset-bottom))] [@media(max-width:639.98px)]:data-[state=open]:zoom-in-100 [@media(max-width:639.98px)]:data-[state=closed]:zoom-out-100 [@media(max-width:639.98px)]:data-[state=open]:slide-in-from-left-0 [@media(max-width:639.98px)]:data-[state=closed]:slide-out-to-left-0 [@media(max-width:639.98px)]:data-[state=open]:slide-in-from-bottom-full [@media(max-width:639.98px)]:data-[state=closed]:slide-out-to-bottom-full"

/** Mounted inside an open sheet's content only, so the listener lives exactly while it is open. */
function KeyboardInsetTracker() {
  React.useEffect(() => trackKeyboardInset(), [])
  return null
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** For dialogs that must be completed: no close button that would do nothing. */
    hideClose?: boolean
    /** A bottom sheet on phones that stays above the on-screen keyboard (SH-19b). */
    phoneSheet?: boolean
  }
>(({ className, children, hideClose = false, phoneSheet = false, ...props }, ref) => (
  // SH-19: never taller than the dynamic viewport minus the safe areas; the content
  // scrolls inside, so the footer stays reachable above an on-screen keyboard.
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid max-h-[var(--dialog-max-h)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] overflow-y-auto overscroll-contain ease-spring-enter gap-4 border bg-popover p-6 text-popover-foreground shadow-overlay duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-xl",
        phoneSheet && PHONE_SHEET_CLASSES,
        className
      )}
      {...props}
    >
      {phoneSheet && <KeyboardInsetTracker />}
      {children}
      {!hideClose && (
        <DialogPrimitive.Close data-dialog-close className="hit-slop absolute right-4 top-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none">
          <X aria-hidden className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:flex-wrap sm:justify-end sm:gap-y-2 sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
