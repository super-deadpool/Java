// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://super-deadpool.github.io',
  base: import.meta.env.PUBLIC_BASE_URL,
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      wrap: false,
    },
  },
});
