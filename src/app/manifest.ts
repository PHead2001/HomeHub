import type { MetadataRoute } from 'next';
import { BRAND_BACKGROUND_HEX } from '@/components/brand/logo-artwork';

// Served at /manifest.webmanifest; Next adds the <link rel="manifest"> tag.
// Colors match the dark default theme so the install splash and status bar
// blend with the first painted frame.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'HomeHub',
    short_name: 'HomeHub',
    description: 'Your all-in-one home management dashboard.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BRAND_BACKGROUND_HEX,
    theme_color: BRAND_BACKGROUND_HEX,
    categories: ['lifestyle', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    shortcuts: [
      {
        name: 'Add to shopping',
        short_name: 'Add item',
        description: 'Add an item to a shopping list',
        url: '/shopping?quickAdd=1',
        icons: [{ src: '/icons/shortcut-96.png', sizes: '96x96', type: 'image/png' }],
      },
      {
        name: 'Log feeding',
        short_name: 'Feeding',
        description: 'Log a pet feeding',
        url: '/pets',
        icons: [{ src: '/icons/shortcut-96.png', sizes: '96x96', type: 'image/png' }],
      },
      {
        name: 'My chores',
        short_name: 'Chores',
        description: 'See your chores',
        url: '/chores',
        icons: [{ src: '/icons/shortcut-96.png', sizes: '96x96', type: 'image/png' }],
      },
    ],
    share_target: {
      action: '/share',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    },
  };
}
