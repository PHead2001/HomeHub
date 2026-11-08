/**
 * Browser harness for the shared motion components (bundled with esbuild by
 * tests/e2e/shell-wave4.spec.ts, rendered with page.setContent).
 * - NumberTicker where real callers put it: a button label, an accordion trigger
 *   and running text. `window.__setCount(n)` changes every value.
 * - Stagger around clickable rows and Tabs with a button in each panel, to check
 *   that entrances never move a click target.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Stagger } from '@/components/motion/stagger';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

declare global {
  interface Window {
    __setCount?: (value: number) => void;
  }
}

function Harness() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    window.__setCount = setCount;
  }, []);
  return (
    <main>
      <button type="button" id="todo">To Do (<NumberTicker value={count} />)</button>
      <Accordion type="single" collapsible>
        <AccordionItem value="future">
          <AccordionTrigger id="future">Future (<NumberTicker value={count} animateOnMount={false} />)</AccordionTrigger>
          <AccordionContent>Later chores</AccordionContent>
        </AccordionItem>
      </Accordion>
      <p id="pets"><NumberTicker value={count} /> of 2 today</p>
      <p id="big"><NumberTicker value={count * 1000} format={{ maximumFractionDigits: 0 }} locale="en-US" /> points</p>
      <Stagger as="ul" data-testid="stagger-list">
        {Array.from({ length: 14 }, (_, index) => (
          <li key={index}><button type="button" data-testid={`row-${index}`}>Row {index}</button></li>
        ))}
      </Stagger>
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one"><button type="button" data-testid="panel-one-button">In one</button></TabsContent>
        <TabsContent value="two"><button type="button" data-testid="panel-two-button">In two</button></TabsContent>
      </Tabs>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
