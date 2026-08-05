import { NextResponse } from 'next/server';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { generateHomeOverview } from '@/ai/flows/generate-home-overview';
import { generateRecipe } from '@/ai/flows/generate-recipe-flow';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { summarizeMaintenanceLog } from '@/ai/flows/summarize-maintenance-log';

const isEnabled = () => process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true'
  && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === 'demo-homehub-e2e'
  && process.env.NODE_ENV !== 'production';

export async function POST(request: Request) {
  if (!isEnabled()) return new NextResponse('Not found', { status: 404 });

  const authorization = request.headers.get('authorization') || '';
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const body = await request.json() as { operation?: string; householdId?: string; barcode?: string };
  const context = { idToken, householdId: body.householdId || '' };

  if (body.operation === 'overview') return NextResponse.json(await generateHomeOverview(context));
  if (body.operation === 'barcode') return NextResponse.json(await lookupBarcode({ barcode: body.barcode || '' }, context));
  if (body.operation === 'categorize') {
    return NextResponse.json(await categorizeGroceryItem({ itemName: 'Cross-household check', categories: ['Other'] }, context));
  }
  if (body.operation === 'recipe') {
    return NextResponse.json(await generateRecipe({
      items: [
        { name: 'Household check rice', quantity: 1, unit: 'cup' },
        { name: 'Household check beans', quantity: 1, unit: 'can' },
      ],
    }, context));
  }
  if (body.operation === 'maintenance') {
    return NextResponse.json(await summarizeMaintenanceLog({ log: 'Cross-household maintenance check.' }, context));
  }

  return NextResponse.json({ error: 'Unsupported E2E probe.' }, { status: 400 });
}
