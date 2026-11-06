import type { Metadata } from 'next';
import { ShareTargetClient } from '@/components/share-target-client';
import { parseSharedContent } from '@/lib/share-target';

export const metadata: Metadata = {
  title: 'Add to HomeHub',
  robots: { index: false },
};

type SharePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const firstValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Web Share Target (GET) declared in src/app/manifest.ts. The shared title,
// text and URL arrive as query parameters; nothing is written until the member
// confirms in ShareTargetClient.
export default async function SharePage({ searchParams }: SharePageProps) {
  const params = await searchParams;
  const shared = parseSharedContent({
    title: firstValue(params.title),
    text: firstValue(params.text),
    url: firstValue(params.url),
  });

  return (
    <div className="container mx-auto max-w-xl px-4 py-8">
      <h1 className="font-headline text-3xl font-bold tracking-tight">Add to a shopping list</h1>
      <p className="mt-1 text-muted-foreground">Save what you shared as an item on one of your lists.</p>
      <div className="mt-6">
        <ShareTargetClient shared={shared} />
      </div>
    </div>
  );
}
