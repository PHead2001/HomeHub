/**
 * Browser harness for NumberTicker's text contract (bundled by
 * tests/e2e/number-ticker.ts with esbuild, rendered with page.setContent). It
 * puts tickers where real callers do: inside a button label, an accordion
 * trigger and running text. `window.__setCount(n)` changes every value.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

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
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
