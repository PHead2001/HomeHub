'use client';

import { useEffect } from 'react';
import { captureInstallPrompt } from '@/lib/shell/install-prompt';

/** SL-19: keeps the browser's install offer for Profile's "Install HomeHub" card. */
export function InstallPromptCapture() {
  useEffect(() => captureInstallPrompt(), []);
  return null;
}
