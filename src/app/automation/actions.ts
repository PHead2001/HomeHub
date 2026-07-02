
'use server';

import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { HomeAssistantEntity, HomeAssistantCredentials } from '@/lib/types';

type ActionResult = {
  error?: string;
  data?: HomeAssistantEntity[];
};

export async function getHomeAssistantEntities(userEmail: string | undefined, householdId: string | undefined): Promise<ActionResult> {
  if (!userEmail) {
    return { error: 'Not authenticated.' };
  }
  if (!householdId) {
    return { error: 'No household found for user.' };
  }

  // Fetch HA credentials from the dedicated subcollection
  const haConfigDocRef = doc(db, 'households', householdId, 'home-automation', 'credentials');
  let haConfig: HomeAssistantCredentials;

  try {
    const haConfigDoc = await getDoc(haConfigDocRef);
    if (!haConfigDoc.exists()) {
      return { error: 'Home Assistant is not configured. Please provide URL and Access Token in the household settings.' };
    }
    haConfig = haConfigDoc.data() as HomeAssistantCredentials;
  } catch (dbError) {
    console.error('Failed to retrieve Home Assistant configuration:', dbError);
    return { error: 'Failed to retrieve Home Assistant configuration from database.' };
  }
  
  if (!haConfig?.url || !haConfig?.accessToken) {
    return { error: 'Home Assistant configuration is incomplete. Please provide URL and Access Token.' };
  }

  const { url, accessToken } = haConfig;

  try {
    const response = await fetch(`${url}/api/states`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
       cache: 'no-store', // Don't cache HA entity states
    });

    if (!response.ok) {
      console.error('Home Assistant API error:', response.status);
      return { error: `Home Assistant API returned an error: ${response.status}. Check your URL and token.` };
    }

    const data: HomeAssistantEntity[] = await response.json();
    return { data };
  } catch (networkError) {
    console.error('Network error connecting to Home Assistant:', networkError);
    return { error: 'Could not connect to Home Assistant. Check the URL and ensure your server can reach it.' };
  }
}
