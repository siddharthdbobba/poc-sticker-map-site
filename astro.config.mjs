// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  // Update to the final deploy URL (used for canonical/OG tags).
  site: 'https://stickers.siddharthbobba.com',
  integrations: [react()],
});