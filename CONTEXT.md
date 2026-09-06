# Session handoff — Java for C++ Engineers

Paste-able context for continuing this project in a fresh Claude Code session.

## What this is

A static **Astro 7** site at `/Users/komalsai/Documents/new-lang` publishing a 28-phase Java
curriculum written for an engineer who **already knows C++ well** and is preparing for Java
software-engineering interviews. Not a beginner tutorial. The goal is to think like an experienced
Java engineer: what the JVM does, why the language is shaped this way, and where C++ instincts
mislead.

## Commands

```bash
npm run dev       # http://localhost:4321
npm run build     # → dist/ (verify after every content change)
```

## Repo layout

```
src/
  content/modules/*.md          # the curriculum, one module per file — this is the product
  content.config.ts             # frontmatter schema
  data/curriculum.ts            # the 28 phases + topic lists (drives roadmap + sidebar)
  layouts/Base.astro            # shell + theme toggle
  components/Sidebar.astro
  pages/index.astro             # hero + how-to-use + 28-phase roadmap
  pages/modules/[...slug].astro # module page: eyebrow, TOC from h2s, prev/next pager
  styles/global.css             # all styling; light/dark tokens
```

## Authoring conventions (follow these exactly)

**Frontmatter** — filename is `<phase>-<order>-<slug>.md`; sidebar/roadmap/pager derive from it:

```yaml
---
title: "Method Dispatch: overriding, overloading, hiding"
phase: 2
order: 2
minutes: 45
summary: "One sentence on what this module settles."
tags: ["inheritance", "dispatch"]
---
```

**Module structure** — every module uses the same 15 numbered `##` sections (the TOC is built from
them). Sections may be merged or renamed where a topic genuinely doesn't need one, but the spine is:
concept → why Java has it → mental model → syntax → minimal example → realistic example → what
happens internally → C++ comparison → edge cases → common mistakes → interview questions (Beginner /
Intermediate / Advanced / Senior) → likely follow-up questions → coding exercise → output prediction
→ mastery check.

**Answers are never printed.** Output-prediction snippets and mastery-check questions are left
unanswered on purpose — the user attempts them, then asks for a walkthrough.

**Label every runtime claim** as `**[JLS]**`, `**[JVMS]**`, `**[JDK]**` (library implementation) or
`**[HotSpot]**` (implementation detail that could differ). Never invent implementation details.

**Callouts** are raw HTML in the Markdown (use HTML tags inside, not Markdown):

```html
<div class="cpp"><span class="label">C++ mental model → Java</span><p>…</p></div>
<div class="trap"><span class="label">C++ programmer mistakes</span><p>…</p></div>
<div class="note"><span class="label">Note</span><p>…</p></div>
```

**Voice**: dense, concrete, no filler. Prefer a table or a code block over a paragraph. Every module
should carry at least one "this surprises C++ programmers" point and at least one production
consequence. Use modern Java (records, sealed, pattern matching, `var`, virtual threads) and mark
legacy practice as legacy. Java 25 is the current LTS.

## Written so far — 42 modules, phases 1–20

| Phase | Modules |
| --- | --- |
| 1 Fundamentals | 1.1 platform/javac/bytecode/class loading/JIT · 1.2 primitives vs references, boxing · 1.3 variables, init order, `final` · 1.4 strings, pool, concat |
| 2 OOP | 2.1 objects & construction · 2.2 method dispatch (overriding/overloading/hiding, fields not polymorphic) · 2.3 access control & `final` · 2.4 casting, `instanceof`, diamond, composition |
| 3 Object contracts | 3.1 the `Object` class · 3.2 equals/hashCode contract |
| 4 Abstract & interfaces | 4.1 choosing between them · 4.2 default methods, conflicts, functional interfaces |
| 5 Design | 5.1 immutability & defensive copying · 5.2 records · 5.3 composition over inheritance |
| 6 Generics | 6.1 type parameters & bounds · 6.2 wildcards & PECS · 6.3 erasure, bridges, heap pollution |
| 7 Exceptions | 7.1 hierarchy & checked design · 7.2 try-with-resources & suppression |
| 8 Collections | 8.1 framework & views · 8.2 lists · 8.3 sets & sorted collections · 8.4 **HashMap deep dive** · 8.5 queues, deques, enum collections |
| 9 Comparison | 9.1 Comparable/Comparator, combinators, TimSort, contract violations |
| 10 Iterators | 10.1 for-each desugaring, modCount/fail-fast, weakly consistent, Spliterator |
| 11 Functional Java | 11.1 lambdas, capture, invokedynamic/LambdaMetafactory · 11.2 the function zoo & method references |
| 12 Streams | 12.1 pipelines, laziness, the sink chain · 12.2 collectors & grouping · 12.3 parallel streams & the common pool |
| 13 Optional | 13.1 return-type tool, orElse/orElseGet, value-based class, the four misuses |
| 14 Modern Java | 14.1 var, text blocks, switch expressions, List.of, sequenced collections · 14.2 sealed types & pattern matching |
| 15 Enums | 15.1 generated class, constant bodies, EnumSet/EnumMap, enum singleton, ordinal hazards |
| 16 Nested classes | 16.1 four kinds, this$0, nestmates, the enclosing-instance leak |
| 17 Annotations | 17.1 retention/targets, annotation proxies, processing vs runtime reflection |
| 18 Reflection | 18.1 Class API, setAccessible & strong encapsulation, cost, MethodHandle/VarHandle, Proxy |
| 19 I/O & NIO | 19.1 byte/char streams, buffering, charsets & JEP 400 · 19.2 Path/Files, ByteBuffer, channels, mmap |
| 20 Serialization | 20.1 serialVersionUID, constructor bypass, proxy pattern, gadget chains, JEP 290, records |

## Remaining — phases 21–28

| Phase | Planned modules |
| --- | --- |
| 21 Date & time | 1 |
| 22 JVM internals | 3: class loading · memory areas & object layout · JIT |
| 23 GC | 2: reachability & generations · collectors, leaks, reference types |
| 24 Concurrency | 4: threads & executors · synchronized/volatile/atomics · locks & synchronizers · CompletableFuture, ForkJoin, virtual threads |
| 25 Java Memory Model | 2: happens-before · safe publication & DCL |
| 26 Performance | 2: where time goes · profiling & JMH |
| 27 Design patterns | 2 |
| 28 Interview prep | 2 + a separate exam page (8 parts, answers withheld) |

Roughly 18 modules remaining (phases 21–28). Work phase by phase, `npm run build` after each phase, and keep the
progress note in `~/.claude/projects/-Users-komalsai-Documents-new-lang/memory/` current.

## Open threads

- The user has not yet attempted any output-prediction or mastery-check questions. When they paste
  answers, mark them by naming the **wrong mental model**, not just the right answer.
- Phase 28's exam should be its own page type (Parts 1–8: 50 rapid-fire, 30 code/output, 20
  conceptual, 10 JVM, 10 concurrency, 10 debugging scenarios, 5 design tasks, 1 mock 60-min
  interview), with answers revealed only after an attempt.
