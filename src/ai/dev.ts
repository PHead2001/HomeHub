import { config } from 'dotenv';
config();

import '@/ai/flows/summarize-maintenance-log.ts';
import '@/ai/flows/categorize-grocery-item-flow.ts';
import '@/ai/flows/lookup-barcode-flow.ts';
import '@/ai/flows/generate-recipe-flow.ts';
