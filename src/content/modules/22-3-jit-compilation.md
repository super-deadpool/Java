---
title: "The JIT: tiered compilation, inlining, escape analysis, and deoptimization"
phase: 22
order: 3
minutes: 50
summary: "How HotSpot goes from interpreting to C2-optimised code, why inlining is the optimisation that enables all the others, what a megamorphic call site costs you, and why the JIT can undo its own work."
tags: ["jit", "hotspot", "c1", "c2", "inlining", "escape-analysis", "deoptimization"]
---

## 1. Concept

**[HotSpot]** Java code runs in one of three ways, and the JVM moves it between them at runtime based on measured behaviour:

```text
INTERPRETER          reads bytecode, executes it, COUNTS invocations and back-edges
       |  hot enough
       v
C1  (client)         fast to compile, moderate optimisation, can be instrumented for profiling
       |  still hot, and profile collected
       v
C2  (server)         slow to compile, aggressive speculative optimisation
       |  assumption violated
       v
DEOPTIMIZATION       discard the compiled code, fall back to the interpreter, recompile later
```

The whole design rests on one bet: **a JIT knows things an AOT compiler cannot** — which branches are actually taken, which types actually arrive at a call site, which methods are actually hot. It pays for that with warm-up time and the possibility of being wrong, which is what deoptimization exists to handle.

## 2. Tiered compilation

**[HotSpot]** Since Java 8, `-XX:+TieredCompilation` is on by default and there are five levels:

| Level | What runs | Profiling | Used when |
| --- | --- | --- | --- |
| 0 | Interpreter | Full (counters) | Cold code |
| 1 | C1, fully optimised | **None** | Trivial methods that C2 would not improve |
| 2 | C1 + invocation/back-edge counters | Limited | C2 queue is full |
| 3 | C1 + full profiling | Full (types, branches) | The normal warm-up path |
| 4 | C2 | None (consumes the level-3 profile) | Hot code |

The normal trajectory is **0 → 3 → 4**. Level 3 code is roughly 30% slower than level 1 because it is carrying instrumentation, but that instrumentation is what makes level 4 good.

```bash
-XX:+PrintCompilation                 # one line per compilation: level, method, reason
-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining
-XX:TieredStopAtLevel=1               # C1 only: fast startup, no peak performance (good for CLI tools)
-XX:-TieredCompilation                # C2 only: the old "server" behaviour
-Xlog:jit+compilation=debug
```

**On-Stack Replacement (OSR)** handles the case where a method is entered once but loops a million times. The back-edge counter trips, the JVM compiles a special OSR version entered *in the middle of the loop*, and the running frame is migrated into it. A `%` in `PrintCompilation` output marks an OSR compilation. Without OSR, `public static void main` with one hot loop would never speed up.

## 3. Inlining — the optimisation that enables the others

Inlining removes a call, but that is not why it matters. It matters because **it creates the context for every other optimisation**: constant propagation across the boundary, dead branch elimination, escape analysis, lock elision. An un-inlined call is an opaque wall.

**[HotSpot]** The heuristics:

| Flag | Default | Meaning |
| --- | --- | --- |
| `-XX:MaxInlineSize` | 35 bytes | Inline any method this small |
| `-XX:FreqInlineSize` | 325 bytes | Inline a *hot* method up to this size |
| `-XX:MaxInlineLevel` | 15 | Maximum inlining depth |
| `-XX:MinInliningThreshold` | 250 | Invocations before "hot" applies |

Two things must be true to inline: the method must be small enough, **and the target must be known**. That second condition is where Java's everything-is-virtual design collides with optimisation.

## 4. Call sites: monomorphic, bimorphic, megamorphic

This is the most practically important concept in the module.

**[HotSpot]** The JIT records, per call site, which receiver types it has actually seen:

| Call site | Types seen | What C2 does | Cost |
| --- | --- | --- | --- |
| **Monomorphic** | 1 | Guard (`if klass != X goto deopt`) then **inline** the body | ≈ a direct call, often free |
| **Bimorphic** | 2 | Two guards, both bodies inlined | Still cheap |
| **Polymorphic** | 3–~8 | Inline cache; sometimes a jump table | Moderate |
| **Megamorphic** | many | **Virtual dispatch through the vtable/itable — no inlining** | A call plus an indirect branch the predictor often misses |

```java
// Monomorphic in practice: only ArrayList ever arrives here
for (String s : list) { ... }          // list.iterator() inlines, hasNext/next inline, loop fuses

// Megamorphic: 12 Shape implementations flow through this site
for (Shape s : shapes) total += s.area();   // no inlining; a real virtual call each iteration
```

The consequence for modern Java is direct: **a stream pipeline's `Sink.accept` chain (Module 12.1) is only fast when the JIT can inline through it.** In a method used with one lambda, the call site is monomorphic and the whole pipeline collapses into a loop. In a shared utility used with fifty different lambdas, the same code is megamorphic and measurably slower than the hand-written loop — which is exactly why a stream that benchmarks well in isolation can be slow in production. **Profile pollution** is the name for this: a shared generic method's profile is contaminated by all its callers.

**Class Hierarchy Analysis (CHA)** is HotSpot's other lever: if only one class currently implements an interface method, C2 devirtualizes and inlines it unconditionally, recording the assumption. Load a second implementation and every compiled method depending on that assumption is **invalidated and deoptimized** (§6). This is why `final` and sealed hierarchies help — they make the assumption permanent.

## 5. What C2 actually does

Beyond inlining, the optimisations worth naming:

**Escape analysis → scalar replacement.** If C2 proves an object never escapes the compiled region, it does not allocate it — it **replaces its fields with registers or stack slots**. The object simply does not exist in the compiled code.

```java
// Written:                                    // What C2 may actually emit:
double dist(double x, double y) {              // no allocation at all —
    Point p = new Point(x, y);                 // p.x and p.y become registers
    return Math.sqrt(p.x * p.x + p.y * p.y);
}
```

Escape states are **NoEscape** (scalar-replaced), **ArgEscape** (passed to a non-escaping callee; locks can still be elided), and **GlobalEscape** (stored to a field or returned — must be allocated). Escape analysis **requires inlining** to see the whole lifetime, which is why a `new` inside an un-inlined call always allocates. `-XX:+PrintEscapeAnalysis`, and `-XX:-DoEscapeAnalysis` to prove a benchmark's dependence on it.

**Lock elision and coarsening.** A lock on a NoEscape object is removed entirely (`StringBuffer` in a local variable). Adjacent `synchronized` blocks on the same object may be merged into one.

**Loop optimisations.** Unrolling, **range-check elimination** (proving `i` stays in bounds so the per-element bounds check disappears), loop peeling, loop-invariant code motion, and **auto-vectorization** (SuperWord) turning a scalar loop into SIMD instructions.

**Null-check elimination via implicit exceptions.** Rather than testing for null, C2 emits the load and installs a signal handler: the hardware page fault at address 0 becomes the `NullPointerException`. A null check that never fires costs literally nothing — but a `NullPointerException` thrown in a *hot* loop causes repeated deoptimization and is dramatically more expensive than the check would have been.

**Branch elimination.** A branch never taken in the profile is compiled as an **uncommon trap** — a jump straight to deoptimization. That is how `if (debugEnabled)` costs nothing when it is always false, and why the first `true` is expensive.

## 6. Deoptimization

Every speculative optimisation records an assumption. When one is violated the JVM must **undo** the compiled code while frames of it are on the stack.

Common triggers:

- A new class is loaded that breaks a CHA assumption (a second implementation appears).
- An uncommon trap fires — the never-taken branch is taken, a type guard fails, an unexpected null arrives.
- A class is redefined by an agent or a debugger.

The mechanism: the JVM reconstructs an interpreter frame from the compiled frame's debug information (which is why compiled code carries a full map of where every local lives), resumes in the interpreter, and marks the compiled code **not entrant**. If the trap keeps firing, the method is recompiled *without* that speculation; repeated failures escalate to `-XX:PerMethodTrapLimit` and the method is compiled conservatively.

```bash
-XX:+UnlockDiagnosticVMOptions -XX:+TraceDeoptimization
-XX:+LogCompilation                    # a full XML log for JITWatch
```

The practical signature of a deoptimization storm is throughput that **degrades after being fast**, or that oscillates — the opposite of the normal warm-up curve. Common causes: an exception path becoming common, a lazily-loaded second implementation of a hot interface, or a benchmark whose input distribution changes.

## 7. Warm-up, and why benchmarks lie

Everything above means **the first N executions of any Java code are not representative**. A naive benchmark measures the interpreter, the C1 compile, the profiling overhead, and possibly a deoptimization — and reports it as "the performance".

```java
// This measures nothing useful
long t0 = System.nanoTime();
for (int i = 0; i < 1000; i++) work();
System.out.println(System.nanoTime() - t0);
```

The failure modes a hand-rolled benchmark hits, all of which **JMH** exists to prevent (Phase 26): no warm-up, dead-code elimination of an unused result, constant folding of a loop-invariant input, loop unrolling changing what you measure, and on-stack replacement compiling the benchmark loop differently from the real call path.

**Startup versus peak throughput** is the tradeoff the JIT imposes, and there is now a spectrum of answers:

| Approach | Startup | Peak | Cost |
| --- | --- | --- | --- |
| `-XX:TieredStopAtLevel=1` | Fast | Low | C1 only |
| Default tiered | Moderate | High | Warm-up |
| AppCDS / **JEP 483** AOT class loading (Java 24) | Faster | High | A training run |
| **Graal JIT** | Similar | Often higher for lambda/stream-heavy code | Compile time, memory |
| **GraalVM native image** | Milliseconds | Lower peak, no JIT | Closed-world; reflection must be declared |

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ optimises once, ahead of time, with no runtime information.</strong> The compiler inlines what it can see (limited by translation units unless you enable LTO), devirtualizes only when it can prove the type, and unrolls based on static heuristics. What you get is deterministic, immediately fast, and never changes.</p>
<p><strong>HotSpot optimises repeatedly, with a real profile, and may be wrong.</strong> It can devirtualize a call that <em>is</em> virtual because it observed only one type; it can delete a branch because your production traffic never takes it; it can eliminate an allocation entirely. When reality changes it deoptimizes and tries again. C++'s equivalent of the profile is <strong>PGO</strong> — and PGO is exactly the admission that static heuristics are worse than measurements.</p>
</div>

| Concern | C++ | HotSpot |
| --- | --- | --- |
| When optimisation happens | Compile/link time | Continuously, at runtime |
| Cross-module inlining | Needs LTO | Automatic — one heap of bytecode |
| Devirtualization | Only when statically provable, or `final` | Speculative, from a profile, guarded |
| Profile guidance | Opt-in PGO with a training run | Always on, from real traffic |
| Speculation | None (must be correct) | Extensive, with deoptimization as the safety net |
| Escape analysis | Sometimes; you also just use the stack | Scalar replacement, needs inlining |
| Bounds checks | None (you write UB instead) | Inserted, then usually eliminated |
| Startup | Instant | Warm-up required |
| Peak on ideal code | Predictable and high | Comparable, sometimes higher via devirtualization |
| Reproducibility | Deterministic | Varies run to run |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Reasoning about Java performance from the source. The code C2 emits may have no allocation, no bounds check, no virtual call, and no branch where you wrote all four — or it may have all of them because one call site went megamorphic. Reading disassembly (<code>-XX:+PrintAssembly</code> with hsdis, or JITWatch) is the only way to know, and measuring with JMH is the only way to compare.</p>
<p>Assuming <code>final</code> on a method makes it faster. It does not, directly — CHA already devirtualizes a method with one implementation. <code>final</code> helps by making the assumption permanent so no deoptimization can occur, and by documenting intent.</p>
</div>

## 9. Edge cases

- **Methods over `-XX:-DontCompileHugeMethods`' 8000-byte limit are never compiled.** A giant generated `switch` or a hand-unrolled method silently stays interpreted forever.
- **`-XX:+PrintCompilation` markers:** `%` = OSR, `s` = synchronized, `!` = has exception handlers, `n` = native wrapper, `made not entrant` = deoptimized.
- **Exceptions are cheap to throw and expensive to *profile*** — a hot exception path forces the previously-eliminated branch back into existence. `fillInStackTrace` dominates the cost; the JIT may eventually elide stack traces for repeatedly-thrown preallocated exceptions (`-XX:-OmitStackTraceInFastThrow` controls the JDK's own version of this, which is why production NPEs sometimes have no stack trace).
- **`System.gc()`, `Thread.sleep`, and I/O** are compilation barriers in practice — nothing inlines through them.
- **Code cache exhaustion disables the JIT permanently** for the rest of the run (Module 22.2 §8).
- **Escape analysis is all-or-nothing per allocation site**, and a single escaping path (a debug `log.trace(obj)`) forces allocation on every path.
- **`-XX:+UseCompressedOops` interacts with inlining** only indirectly, but smaller objects mean more fits in cache, which changes what is worth inlining.
- **Graal (`-XX:+UseJVMCICompiler`)** is generally better at inlining through lambdas, streams, and megamorphic sites, and worse at compile time.
- **Deoptimization is not an error.** Seeing `made not entrant` in a log is normal; seeing it repeatedly for the same method is not.
- **`-Xint`** forces pure interpretation — useful to prove a bug is a JIT bug, and roughly 20–50× slower.

## 10. Common mistakes

- Benchmarking without warm-up, or without JMH.
- Concluding "streams are slow" from a megamorphic call site, or "streams are fast" from a monomorphic microbenchmark.
- Adding `final` everywhere expecting a speedup.
- Writing giant methods that exceed the compile threshold.
- Using exceptions for control flow in a hot loop.
- Assuming an object you can see in the source is allocated.
- Assuming an object you *cannot* see is not — boxing is everywhere.
- Ignoring "CodeCache is full" in the log.
- Tuning JIT flags before measuring which method is actually hot.
- Comparing a JVM's first second against a native binary's first second and calling it a language comparison.

## 11. Interview questions

**Beginner** — 1. What is the JIT and why does Java have one? 2. What is warm-up? 3. What does the interpreter do that a compiler does not?

**Intermediate** — 4. What are C1 and C2 and why have both? 5. What is OSR and what problem does it solve? 6. Why is inlining important beyond removing the call? 7. What is escape analysis?

**Advanced** — 8. Define monomorphic, bimorphic and megamorphic, and give the cost of each. 9. What is CHA and what happens when a second implementation loads? 10. Explain deoptimization: triggers, mechanism, and what makes it possible. 11. How does C2 make a never-taken branch free, and what is the cost when it is taken?

**Senior** — 12. A stream pipeline benchmarks 2× faster than a loop in JMH and 3× slower in production. Explain, and say how you would confirm. 13. Throughput is good for ten minutes then degrades by 40% with no GC change. Give three JIT hypotheses and the flags to test each. 14. Compare JIT with C++ AOT + LTO + PGO: name two things the JIT can do that AOT cannot, and two the other way.

## 12. Follow-ups

- *After Q4:* "What are the five tiers and the usual path through them?"
- *After Q6:* "Which optimisation depends on inlining most?" → escape analysis.
- *After Q8:* "How does a shared utility method become megamorphic?" → profile pollution.
- *After Q9:* "Does `final` help?" → it makes the assumption permanent.
- *After Q12:* → check `PrintInlining` for "too many receiver types" at the pipeline's call sites.

## 13. Exercise

1. Write a hot method and run with `-XX:+PrintCompilation`. Identify the level-3 and level-4 compilations and the OSR entry. Then run with `-XX:TieredStopAtLevel=1` and compare peak throughput.
2. Build a monomorphic and a megamorphic version of the same interface call (one implementation versus twelve) and benchmark with JMH. Then run `-XX:+PrintInlining` on both and find the "too many receiver types" line.
3. Demonstrate scalar replacement: a method allocating a small object in a loop, benchmarked with and without `-XX:-DoEscapeAnalysis`, with allocation rate measured. Then make the object escape by one line and re-measure.
4. Force a deoptimization storm: a hot loop where an exception starts being thrown after 1 M iterations. Capture it with `-XX:+TraceDeoptimization` and plot throughput over time.
5. Take a method just under 8000 bytes of bytecode, grow it past the limit, and show it is never compiled. Explain the throughput cliff.

## 14. Output prediction

```java
// Run this with:  -XX:+PrintCompilation  and then with  -Xint
// Predict the SHAPE of the timings, not exact numbers.
public class Main {
    interface Shape { double area(); }
    record Circle(double r)   implements Shape { public double area() { return 3.14159 * r * r; } }
    record Square(double s)   implements Shape { public double area() { return s * s; } }
    record Tri(double b, double h) implements Shape { public double area() { return b * h / 2; } }

    static double sum(Shape[] shapes) {
        double t = 0;
        for (Shape s : shapes) t += s.area();
        return t;
    }

    public static void main(String[] args) {
        Shape[] mono = new Shape[10_000];
        Shape[] mega = new Shape[10_000];
        for (int i = 0; i < mono.length; i++) {
            mono[i] = new Circle(i);
            mega[i] = switch (i % 3) { case 0 -> new Circle(i); case 1 -> new Square(i); default -> new Tri(i, i); };
        }

        for (int round = 0; round < 5; round++) {
            long t0 = System.nanoTime();
            double a = 0; for (int i = 0; i < 1000; i++) a += sum(mono);
            long t1 = System.nanoTime();
            double b = 0; for (int i = 0; i < 1000; i++) b += sum(mega);
            long t2 = System.nanoTime();
            System.out.printf("round %d  mono %6d us   mega %6d us   ratio %.2f%n",
                    round, (t1 - t0) / 1000, (t2 - t1) / 1000, (double) (t2 - t1) / (t1 - t0));
        }
        // Questions to answer BEFORE running:
        // 1. How do round 0 and round 4 differ, and why?
        // 2. Why is `sum` shared between both arrays a problem for the mono case?
        // 3. What changes if you give each array its own copy of `sum`?
        // 4. What does -Xint do to the ratio, and why?
    }
}
```

## 15. Mastery check

1. Name the five tiers, what each does, and the usual path through them.
2. What is OSR, when does it trigger, and what would happen without it?
3. Explain why inlining is the enabling optimisation, and name three things that depend on it.
4. Define the four call-site categories and the cost of each.
5. Explain profile pollution and give a realistic example from stream code.
6. What is CHA, what assumption does it record, and what invalidates it?
7. Describe escape analysis, its three states, and what scalar replacement produces.
8. Explain how a never-taken branch becomes free and what happens the first time it is taken.
9. Describe deoptimization: three triggers, the mechanism, and what compiled code must carry for it to work.
10. Name five ways a hand-written microbenchmark misleads you, and what JMH does about each.
