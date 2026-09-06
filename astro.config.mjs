// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

const env = loadEnv('production', process.cwd(), '');


export default defineConfig({
  site: 'https://super-deadpool.github.io',
  base: env.PUBLIC_BASE_URL || '/',
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      wrap: false,
    },
  },
});
