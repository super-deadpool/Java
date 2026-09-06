# Java for C++ Engineers

A static Astro site holding a 28-phase Java curriculum written for someone who already knows C++:
concept → why it exists → mental model → what the JVM actually does → C++ comparison → traps →
interview questions → exercises → mastery check (answers deliberately omitted).

## Commands

```bash
npm run dev       # http://localhost:4321
npm run build     # → dist/  (fully prerendered HTML)
npm run preview   # serve the build
```

## Layout

```
src/
  content/modules/*.md    # the curriculum, one module per file
  content.config.ts       # frontmatter schema (title, phase, order, summary, minutes, tags)
  data/curriculum.ts      # the 28 phases + their topic lists (drives the roadmap and sidebar)
  layouts/Base.astro      # shell, theme toggle
  components/Sidebar.astro
  pages/index.astro       # hero + roadmap
  pages/modules/[...slug].astro
  styles/global.css       # all styling, light + dark tokens
```

## Adding a module

Drop a Markdown file in `src/content/modules/` with frontmatter:

```yaml
---
title: "Method dispatch: overriding, overloading, hiding"
phase: 2
order: 1
minutes: 40
summary: "One sentence on what the module settles."
tags: ["inheritance", "dispatch"]
---
```

Sidebar, roadmap card and prev/next pager update automatically; ordering is `phase` then `order`.

Three callout styles are available as raw HTML inside the Markdown (use HTML tags inside them,
not Markdown):

```html
<div class="cpp"><span class="label">C++ mental model → Java</span><p>…</p></div>
<div class="trap"><span class="label">Common mistake</span><p>…</p></div>
<div class="note"><span class="label">Note</span><p>…</p></div>
```

## Written so far

Phase 1 — the platform and compilation pipeline, primitives vs references and boxing,
variables and initialization order, strings. Phases 2–28 are scaffolded in `src/data/curriculum.ts`
and appear on the roadmap as "not written yet".
