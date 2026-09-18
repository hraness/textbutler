import type { MetadataRoute } from 'next';

import { SITE_DESCRIPTION, SITE_NAME } from './_lib/site';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: '/',
    display: 'browser',
    background_color: '#f8f7f4',
    theme_color: '#f8f7f4',
    icons: [{
      src: '/icon.png',
      sizes: '512x512',
      type: 'image/png',
    }],
  };
}
