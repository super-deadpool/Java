// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://super-deadpool.github.io',
  base: '/Java',
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      wrap: false,
    },
  },
});
