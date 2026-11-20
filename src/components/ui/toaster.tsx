"use client"

import * as React from "react"

import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { tabletToasts, toastExpiries, type ToastExpiry } from "@/lib/devices/tablet-toasts"

/**
 * The app's toasts. `tablet` (the registered wall tablet's shell, emulator evidence D2): at
 * most two, newest first, at the bottom right where the shell keeps a scroll clearance;
 * informational toasts leave after 4 s; only a toast card takes a tap. On the tablet the
 * shell times every open toast itself, from an absolute expiry (`toastExpiries`), shown or
 * hidden by the display limit: Radix pauses its own timer while a pointer rests over or focus
 * sits in the toast region (after a tap on Undo the pointer rests exactly where "Undone."
 * appears), and a toast hidden behind two newer ones must not come back with a full duration.
 */
export function Toaster({ tablet = false }: { tablet?: boolean } = {}) {
  const { toasts, dismiss } = useToast()
  const shown = tablet ? tabletToasts(toasts) : toasts
  const expiries = React.useRef<Map<string, ToastExpiry>>(new Map())
  React.useEffect(() => {
    if (!tablet) return
    const now = Date.now()
    expiries.current = toastExpiries(expiries.current, toasts, now)
    const timers = [...expiries.current].map(([id, { expiresAt }]) => window.setTimeout(() => dismiss(id), Math.max(0, expiresAt - now)))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [tablet, toasts, dismiss])

  return (
    <ToastProvider>
      {shown.map(function ({ id, title, description, action, holdsAction: _holdsAction, group: _group, ...props }) {
        void _holdsAction
        void _group
        return (
          <Toast
            key={id}
            {...props}
            {...(tablet ? { duration: Infinity, className: "data-[state=open]:slide-in-from-bottom-full" } : {})}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport
        {...(tablet
          ? {
              "data-tablet-toasts": "",
              className:
                "top-auto bottom-0 left-auto right-0 mx-0 max-h-none max-w-[380px] pt-0 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:top-auto md:pt-0 [[data-kiosk]_&]:top-auto",
            }
          : {})}
      />
    </ToastProvider>
  )
}

