import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const modules = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/modules' }),
  schema: z.object({
    title: z.string(),
    /** Curriculum phase number, 1..28 */
    phase: z.number().int(),
    /** Order within the phase */
    order: z.number().int(),
    summary: z.string(),
    /** Rough reading/working time */
    minutes: z.number().int().optional(),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { modules };
