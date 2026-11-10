"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"
import { tabEnterChange } from "@/lib/motion"
import styles from "./tabs.module.css"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-auto min-h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "hit-slop relative inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-ui disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-raised",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

/**
 * A tab panel (D09/H12). Radix keeps every panel's element rendered (inactive ones
 * are `hidden`) and mounts only the active panel's children, so the entrance is
 * keyed to activation, not to mounting: when this panel goes from inactive to
 * active after the first render, it gets `data-tab-enter` before paint (a
 * MutationObserver on its own `data-state`) and fades
 * in (opacity only, `tabs.module.css`; its content is clickable at once and never
 * moves). The panel active on first render, and
 * any panel under reduced motion, shows at once. The attribute is set on the DOM
 * (React never manages it), so a parent re-render cannot cut the animation short.
 */
const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, forwardedRef) => {
  const local = React.useRef<React.ElementRef<typeof TabsPrimitive.Content> | null>(null)
  const ref = React.useCallback((node: React.ElementRef<typeof TabsPrimitive.Content> | null) => {
    local.current = node
    if (typeof forwardedRef === "function") forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }, [forwardedRef])

  // Watches the panel's own data-state: the selected tab can change without this
  // wrapper re-rendering (uncontrolled tab sets). Mutation records are handled as
  // a microtask, before the browser paints the newly shown panel.
  React.useEffect(() => {
    const node = local.current
    if (!node || typeof MutationObserver === "undefined") return
    let previous = node.getAttribute("data-state")
    const observer = new MutationObserver(() => {
      const state = node.getAttribute("data-state")
      const change = tabEnterChange(previous, state)
      if (change === "add") node.setAttribute("data-tab-enter", "")
      else if (change === "remove") node.removeAttribute("data-tab-enter")
      previous = state
    })
    observer.observe(node, { attributes: true, attributeFilter: ["data-state"] })
    return () => observer.disconnect()
  }, [])

  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        "mt-2",
        styles.panel,
        className
      )}
      {...props}
    />
  )
})
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
