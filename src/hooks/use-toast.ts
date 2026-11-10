"use client"

// Inspired by react-hot-toast library
import * as React from "react"

import type {
  ToastActionElement,
  ToastProps,
} from "@/components/ui/toast"
import { FRIENDLY_ERROR_TITLES, friendlyError, friendlyErrorKind } from "@/lib/friendly-error"
import { markBusy } from "@/lib/shell/busy"
import { capToasts, toastsHoldShell } from "@/lib/shell/toast-queue"

export { TOAST_LIMIT } from "@/lib/shell/toast-queue"
export { UNDO_WINDOW_MS } from "@/lib/undo-window"

// A dismissed toast leaves the store once its exit animation has finished.
const TOAST_REMOVE_DELAY = 1000

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
  /**
   * Whether this toast's action must not be lost to a reload or displaced by a
   * newer toast (an Undo). Defaults to true when the toast has an action; pass
   * false for an action that is not a pending decision (e.g. "Reload").
   */
  holdsAction?: boolean
}

let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

type ActionType = {
  ADD_TOAST: "ADD_TOAST"
  UPDATE_TOAST: "UPDATE_TOAST"
  DISMISS_TOAST: "DISMISS_TOAST"
  REMOVE_TOAST: "REMOVE_TOAST"
}

type Action =
  | {
      type: ActionType["ADD_TOAST"]
      toast: ToasterToast
    }
  | {
      type: ActionType["UPDATE_TOAST"]
      toast: Partial<ToasterToast>
    }
  | {
      type: ActionType["DISMISS_TOAST"]
      toastId?: ToasterToast["id"]
    }
  | {
      type: ActionType["REMOVE_TOAST"]
      toastId?: ToasterToast["id"]
    }

interface State {
  toasts: ToasterToast[]
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId)
    dispatch({
      type: "REMOVE_TOAST",
      toastId: toastId,
    })
  }, TOAST_REMOVE_DELAY)

  toastTimeouts.set(toastId, timeout)
}

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST":
      return {
        ...state,
        toasts: capToasts([action.toast, ...state.toasts]),
      }

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      }

    case "DISMISS_TOAST": {
      const { toastId } = action

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId)
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id)
        })
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      }
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        }
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      }
  }
}

const listeners: Array<(state: State) => void> = []

let memoryState: State = { toasts: [] }

// An open toast with an Undo-style action keeps the shell busy (src/lib/shell/busy.ts),
// so nothing reloads on its own while the member could still tap it.
let releaseUndoBusy: (() => void) | null = null

function syncShellBusy() {
  const holding = toastsHoldShell(memoryState.toasts)
  if (holding && !releaseUndoBusy) releaseUndoBusy = markBusy("undo")
  if (!holding && releaseUndoBusy) {
    releaseUndoBusy()
    releaseUndoBusy = null
  }
}

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  syncShellBusy()
  listeners.forEach((listener) => {
    listener(memoryState)
  })
}

type Toast = Omit<ToasterToast, "id">

function toast({ holdsAction, ...props }: Toast) {
  const id = genId()

  const update = (props: ToasterToast) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    })
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id })

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      holdsAction: holdsAction ?? Boolean(props.action),
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss()
      },
    },
  })

  return {
    id: id,
    dismiss,
    update,
  }
}

/**
 * Failure toast for a caught error. The description always comes from
 * `friendlyError()`, so raw Firebase/network text never reaches users. Use it
 * for outcomes only (could not save, could not reach the server); field
 * problems belong inline next to the field (see `FieldError`).
 *
 *   } catch (error) {
 *     toastError(error, "Couldn't save the chore")
 *   }
 */
function toastError(
  error: unknown,
  title?: string,
  options: Omit<Toast, "title" | "description" | "variant"> = {}
) {
  const kind = friendlyErrorKind(error)
  return toast({
    ...options,
    variant: "destructive",
    title: title ?? FRIENDLY_ERROR_TITLES[kind],
    description: friendlyError(error),
  })
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState)

  React.useEffect(() => {
    listeners.push(setState)
    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }, [state])

  return {
    ...state,
    toast,
    toastError,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  }
}

export { useToast, toast, toastError }
