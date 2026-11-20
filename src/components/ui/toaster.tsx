"use client"

import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { tabletToastDuration, tabletToasts } from "@/lib/devices/tablet-toasts"

/**
 * The app's toasts. `tablet` (the registered wall tablet's shell, emulator evidence D2): at
 * most two, newest first, at the bottom right where the shell keeps a scroll clearance;
 * informational toasts leave after 4 s; only a toast card takes a tap.
 */
export function Toaster({ tablet = false }: { tablet?: boolean } = {}) {
  const { toasts } = useToast()
  const shown = tablet ? tabletToasts(toasts) : toasts

  return (
    <ToastProvider>
      {shown.map(function ({ id, title, description, action, holdsAction: _holdsAction, group: _group, ...props }) {
        void _holdsAction
        void _group
        return (
          <Toast
            key={id}
            {...props}
            {...(tablet ? { duration: tabletToastDuration({ action, duration: props.duration }), className: "data-[state=open]:slide-in-from-bottom-full" } : {})}
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
