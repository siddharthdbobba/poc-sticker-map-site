// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // Update to the final deploy URL (used for canonical/OG tags).
  site: 'https://stickers.siddharthbobba.com',

  integrations: [react()],
  adapter: cloudflare(),
});