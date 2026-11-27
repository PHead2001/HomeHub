import { adminDb } from '@/lib/server/firebase-admin';
import { calendarFeedText, householdForFeedToken } from '@/lib/server/calendar-feed';

// The household's phone calendar feed (audit CA-25; docs/modules/chores/README.md,
// "Phone calendar feed"): GET /api/calendar-feed/<token> (a trailing ".ics" is accepted,
// some calendar apps want it). The token is the only credential; an unknown, rotated or
// malformed one gets the same plain 404 as a household that is gone. Read with the Admin
// SDK on every request; phones poll it (about hourly), so nothing is cached for long.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The public origin for links in the feed: the forwarding proxy's host when present (hosting), else the request's. */
const publicOrigin = (request: Request): string => {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  return host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) && /^https?$/.test(proto) ? `${proto}://${host}` : url.origin;
};

const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = typeof raw === 'string' ? raw.replace(/\.ics$/i, '') : '';
  try {
    const householdId = await householdForFeedToken(adminDb, token);
    if (!householdId) return notFound();
    const body = await calendarFeedText(adminDb, householdId, new Date(), publicOrigin(request));
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="homehub.ics"',
        'Cache-Control': 'private, max-age=300',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (error) {
    console.error('Calendar feed failed', error instanceof Error ? error.message : String(error));
    return new Response('Calendar unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' } });
  }
}
