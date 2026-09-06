---
title: "Profiling and JMH: measuring without lying to yourself"
phase: 26
order: 2
minutes: 45
summary: "Why most Java profilers are safepoint-biased, how to read a flame graph, what JFR and async-profiler each give you, and the JMH anatomy that stops the JIT from optimising your benchmark away."
tags: ["profiling", "jmh", "jfr", "async-profiler", "flame-graph", "safepoint-bias", "benchmarking"]
---

## 1. The method

```text
1. MEASURE      establish a baseline with a real workload and real data
2. HYPOTHESISE  "the p99 is dominated by X" — a specific, falsifiable claim
3. PROFILE      confirm or refute it with a tool that measures the right thing
4. CHANGE ONE THING
5. RE-MEASURE   same workload, same machine, same JVM flags
6. KEEP OR REVERT — and write down the number either way
```

Steps 4 and 6 are the ones people skip. Two changes at once means you learn nothing; a change you keep without a number is superstition.

## 2. Safepoint bias — why most profilers lie

This is the single most valuable thing in this module.

A traditional Java sampling profiler asks the JVM for stack traces via `ThreadMXBean.getThreadInfo` or JVMTI's `GetStackTrace`. **Both require a safepoint** (Module 23.1 §5). So the profiler cannot sample *wherever the code is* — it samples only **where the code can stop**, which is at method returns and non-counted loop back-edges.

The consequence: **exactly the code the JIT optimised hardest — tight counted loops with the safepoint polls elided — is invisible to the profiler.** A method burning 60% of your CPU inside an `int`-counted loop shows near-zero samples, and the time is attributed to whichever method happened to be at the next safepoint.

```text
Safepoint-biased (avoid for CPU profiling):
    VisualVM's sampler, JConsole, hprof, most JMX-based and "pure Java" profilers

Not biased (use these):
    async-profiler   — AsyncGetCallTrace, or perf events
    JDK Flight Recorder — its ExecutionSample event also uses AsyncGetCallTrace
    perf + perf-map-agent — the kernel's sampler, sees JIT frames via a symbol map
    IntelliJ's profiler  — bundles async-profiler
```

If a profiler tells you the hot method is something implausible — a getter, a `hashCode`, an empty loop — suspect safepoint bias before believing it.

## 3. Flame graphs

The standard visualisation, and it is routinely misread.

```text
        ┌──────────────────────────────────────────┐
        │              main (100%)                  │   y-axis = STACK DEPTH
        ├───────────────────────┬──────────────────┤
        │  handleRequest (70%)  │   background(30%) │   x-axis = SHARE OF SAMPLES
        ├──────────┬────────────┤                  │   NOT time order
        │ parse    │  query(50%)│                  │
        │ (20%)    ├───────┬────┤                  │
        │          │ jdbc  │ ser│                  │
        └──────────┴───────┴────┴──────────────────┘
```

Rules for reading one:

- **Width is everything.** A wide frame consumed CPU (or wall time, depending on the profile). A tall stack is just deep, not slow.
- **The x-axis is not chronological.** Frames are sorted alphabetically so identical stacks merge; left-to-right position means nothing.
- **Look for wide *plateaus*** — a wide frame with nothing wide above it is where time is actually spent, not merely passed through.
- **The `[j]`/`[i]`/`[k]` suffixes** in async-profiler mark JIT-compiled, interpreted, and kernel frames. A lot of `[i]` in a hot path means something is not being compiled (Module 22.3 §9).
- **Differential flame graphs** (red/blue) compare two profiles and are the fastest way to see what a change did.

## 4. The tools

**JDK Flight Recorder** — the production default. **[JDK]** Built into the JVM, ~1% overhead at the default settings, event-based rather than purely sampling.

```bash
# Start at launch
-XX:StartFlightRecording=duration=120s,filename=app.jfr,settings=profile

# Or attach to a running process
jcmd <pid> JFR.start name=diag settings=profile
jcmd <pid> JFR.dump  name=diag filename=/tmp/app.jfr
jcmd <pid> JFR.stop  name=diag
```

`settings=default` is safe to leave on permanently; `settings=profile` costs more (~2%) and captures more. Open the recording in **JDK Mission Control**. What JFR gives you that a sampler does not: allocation profiles by call site, GC pauses with causes, **time-to-safepoint**, lock contention with the blocking stack, I/O events, exception counts, thread states over time, and JIT compilation events — all correlated on one timeline.

**async-profiler** — the sharpest CPU and allocation profiler.

```bash
./profiler.sh -d 30 -e cpu   -f cpu.html   <pid>     # CPU, no safepoint bias
./profiler.sh -d 30 -e alloc -f alloc.html <pid>     # allocation by call site (TLAB events)
./profiler.sh -d 30 -e lock  -f lock.html  <pid>     # monitor contention
./profiler.sh -d 30 -e wall  -f wall.html  <pid>     # WALL clock: includes blocked/waiting time
./profiler.sh -d 30 -e cache-misses -f cm.html <pid> # any perf event
```

**`-e cpu` versus `-e wall` is the choice that matters.** CPU profiling answers "what is burning the processor"; wall-clock profiling answers "what is my request waiting on". For a service whose p99 is dominated by I/O, a CPU profile shows you nothing useful and a wall profile shows you everything.

**The rest of the toolbox:**

```bash
jcmd <pid> Thread.print                    # thread dump — the first thing for a hang
jcmd <pid> GC.heap_info / GC.class_histogram / GC.heap_dump /tmp/h.hprof
jcmd <pid> VM.native_memory summary        # needs -XX:NativeMemoryTracking=summary
jcmd <pid> VM.flags -all                   # what the JVM actually chose
jcmd <pid> Thread.dump_to_file -format=json  # includes virtual threads
-Xlog:gc*:file=gc.log:time,uptime,level,tags
```

Take **three thread dumps ten seconds apart**: threads in the same stack in all three are stuck; threads in different stacks are working.

## 5. Why hand-written benchmarks lie

Everything in Module 22.3 applies. Concretely, this measures nothing:

```java
long t0 = System.nanoTime();
for (int i = 0; i < 1_000_000; i++) result = compute(i);
System.out.println((System.nanoTime() - t0) / 1_000_000);
```

The failure modes, all simultaneous:

| Failure | What happens |
| --- | --- |
| **No warm-up** | You measure the interpreter and the C1 compile, not steady state |
| **Dead-code elimination** | `result` is never used, so C2 deletes the whole loop |
| **Constant folding** | A loop-invariant input lets C2 compute the answer once |
| **Loop unrolling / hoisting** | The loop you wrote is not the loop that runs |
| **OSR** | The benchmark loop is compiled differently from a real call site |
| **Profile pollution** | Earlier benchmarks in the same JVM poisoned the call-site profiles (Module 22.3 §4) |
| **GC timing** | A collection landing inside the timed region, or not |

**JMH exists to defeat every one of these**, and there is no substitute.

## 6. JMH anatomy

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@Fork(3)                                   // 3 SEPARATE JVMs — defeats profile pollution
@State(Scope.Benchmark)
public class MapBenchmark {

    @Param({"10", "1000", "100000"})       // the benchmark runs once per value
    private int size;

    private Map<Integer, String> map;
    private int[] keys;

    @Setup(Level.Trial)                    // Trial | Iteration | Invocation
    public void setup() {
        map = new HashMap<>();
        for (int i = 0; i < size; i++) map.put(i, "v" + i);
        keys = ThreadLocalRandom.current().ints(1000, 0, size).toArray();
    }

    @Benchmark
    public String getReturned() {          // RETURNING the result prevents dead-code elimination
        return map.get(keys[0]);
    }

    @Benchmark
    public void manyResults(Blackhole bh) {// Blackhole for multiple results
        for (int k : keys) bh.consume(map.get(k));
    }
}
```

The pieces and what each defeats:

| Element | Purpose |
| --- | --- |
| **`@Fork(n)`** | Runs in *n* fresh JVMs. **Non-negotiable** — without it, benchmark A's profile pollutes benchmark B |
| `@Warmup` | Reaches steady-state JIT before measuring |
| **Returning a value / `Blackhole`** | Makes the result observable so C2 cannot delete the work |
| **`@State`** | Holds inputs the JIT cannot constant-fold. `Scope.Benchmark` shared, `Scope.Thread` per thread |
| `@Setup(Level)` | Trial (once), Iteration, or Invocation (per call — high overhead, use sparingly) |
| `@Param` | Sweeps a dimension; always benchmark across sizes |
| `@BenchmarkMode` | `Throughput`, `AverageTime`, `SampleTime` (gives percentiles), `SingleShotTime` (cold/first-call) |
| `@Threads` | Concurrency level; `@Group`/`@GroupThreads` for asymmetric producer/consumer benchmarks |
| `@CompilerControl(DONT_INLINE)` | Forces a real call boundary when that is what you are measuring |

**The built-in profilers are where JMH becomes a diagnostic tool, not just a stopwatch:**

```bash
java -jar benchmarks.jar MapBenchmark -prof gc          # allocation rate per operation — always run this
                                      -prof perfasm     # the actual emitted assembly for the hot region
                                      -prof async:output=flamegraph
                                      -prof perfnorm    # cycles, instructions, cache misses per op
```

`-prof gc` is the one to use every time: `gc.alloc.rate.norm` gives **bytes allocated per operation**, which is deterministic, machine-independent, and often more informative than the timing.

**Reading the output:**

```text
Benchmark              (size)  Mode  Cnt    Score    Error  Units
MapBenchmark.get           10  avgt   30    4.312 ±  0.087  ns/op
MapBenchmark.get         1000  avgt   30    5.901 ±  0.213  ns/op
MapBenchmark.get       100000  avgt   30   28.447 ±  2.914  ns/op
```

**The `Error` column is the 99.9% confidence interval, and it is not optional.** A 3% difference with ±5% error is noise. If two variants' intervals overlap, you have not shown anything. Rising cost with size here is the cache hierarchy (Module 26.1 §1), not algorithmic complexity — `HashMap.get` is still O(1).

## 7. Measuring a service, not a method

Microbenchmarks answer microquestions. For a service:

**Load generation must avoid coordinated omission.** A generator that waits for a response before sending the next request **stops measuring during a stall** — exactly when latency is worst — and reports a p99 that can be off by orders of magnitude. Use a generator with a fixed request *rate*: `wrk2`, `hdrhistogram`-based harnesses, Gatling with an open workload model.

**Record histograms, not averages.** `HdrHistogram` stores the full distribution at bounded memory and lets you merge across instances. Averaging percentiles across servers is meaningless; merging histograms is not.

**Profile in production, continuously.** JFR at `settings=default` is cheap enough to leave on permanently, and async-profiler can be attached on demand. The alternative — reproducing a production performance problem in staging — usually fails, because the data, the concurrency, and the cache behaviour are all different.

**Benchmark hygiene:** pin the CPU governor to performance, disable turbo if you need repeatability, isolate cores (`taskset`), close everything else, and never compare numbers across machines or JVM versions.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>Google Benchmark is JMH's direct counterpart</strong>, down to the details: <code>benchmark::DoNotOptimize</code> is <code>Blackhole.consume</code>, <code>State</code> is <code>@State</code>, and both auto-tune iteration counts. The difference is that C++ needs <strong>no warm-up</strong> — the binary is already optimised — so a C++ benchmark stabilises in milliseconds where a JMH one needs seconds of warm-up per fork.</p>
<p><strong>Profiling is easier in C++</strong> in one specific way: <code>perf</code> works out of the box because the symbols are in the binary. Java needs <code>perf-map-agent</code> or a JVM-aware profiler to resolve JIT frames, and the safepoint-bias problem has no C++ equivalent at all. Conversely, JFR has no C++ counterpart — a single always-on, low-overhead recorder correlating GC, locks, I/O, allocation and CPU on one timeline is a genuine JVM advantage.</p>
<p><strong><code>gprof</code> lies</strong> for reasons analogous to safepoint bias (instrumentation overhead and sampling at call boundaries) — the C++ community abandoned it for <code>perf</code> and VTune, exactly as the Java community abandoned hprof for async-profiler.</p>
</div>

| Task | C++ | Java |
| --- | --- | --- |
| Microbenchmark | Google Benchmark | **JMH** |
| Prevent dead-code elimination | `DoNotOptimize` | `Blackhole` / return the value |
| Warm-up needed | No | Yes — and multiple forks |
| CPU profiler | `perf`, VTune | async-profiler, JFR |
| Symbol resolution | In the binary | `perf-map-agent` or a JVM-aware tool |
| Sampling bias | Skid only | **Safepoint bias** if you pick the wrong tool |
| Allocation profiling | heaptrack, massif | JFR / async-profiler `-e alloc` |
| Always-on production recorder | None standard | **JFR** |
| Lock profiling | VTune, `perf lock` | JFR, async-profiler `-e lock` |
| Assembly inspection | `objdump`, compiler explorer | `-prof perfasm`, `-XX:+PrintAssembly` |
| Run-to-run variance | Low | Higher — GC and JIT |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Writing a timing loop in <code>main</code> and trusting it, because that habit works acceptably in C++. In Java it measures the interpreter, or nothing at all after C2 deletes the loop. Use JMH — there is no shortcut.</p>
<p>Running one JVM for a whole benchmark suite. Java benchmarks contaminate each other through JIT profiles; <code>@Fork</code> exists for this and has no C++ analogue.</p>
</div>

## 9. Edge cases

- **`Blackhole.consume` is not free** (~1 ns); returning the value from `@Benchmark` is cheaper when you have one result.
- **`@Setup(Level.Invocation)`** has overhead comparable to the thing you are measuring for sub-microsecond benchmarks — prefer `Iteration` and design the state to be reusable.
- **`@State(Scope.Benchmark)` with mutable state and `@Threads(n)`** measures contention, not the operation. Use `Scope.Thread` unless contention is the point.
- **`Mode.SampleTime`** gives you percentiles; `Throughput` and `AverageTime` give you a mean and hide the tail.
- **`SingleShotTime` with `@Fork(50)`** is how you measure cold-start / first-call cost.
- **JFR's `settings=profile` raises the sampling rate**; on a very hot, very shallow stack it can still miss frames.
- **Flame graphs from a wall-clock profile include idle threads** — filter to the threads you care about, or every graph is dominated by parked pool workers.
- **`-XX:+DebugNonSafepoints`** improves the accuracy of JIT frame attribution for async-profiler and JFR; without it, inlined frames can be misattributed.
- **Container CPU limits distort everything** — a benchmark in a throttled container measures the throttler.
- **`System.nanoTime()` resolution and cost** vary by platform; on some virtualised hosts it is a syscall, which JMH accounts for but a hand-rolled loop does not.

## 10. Common mistakes

- A hand-written timing loop.
- `@Fork(0)` or a single JVM for a whole suite.
- Not returning or consuming the result.
- Ignoring the `Error` column.
- Benchmarking with unrealistic data (all keys under 128, all strings ASCII and short, an empty map).
- Comparing numbers from different machines or JVM versions.
- CPU-profiling a service whose problem is I/O wait.
- Using a safepoint-biased profiler and trusting the answer.
- A closed-loop load generator, then reporting p99.
- Profiling in staging and assuming it matches production.
- Changing two things between measurements.

## 11. Interview questions

**Beginner** — 1. Why can't you time Java code with `System.nanoTime()` around a loop? 2. What is warm-up? 3. What does a flame graph show?

**Intermediate** — 4. What is JMH and name four things it defeats. 5. What does `Blackhole` do? 6. Why does JMH fork a new JVM? 7. CPU profile versus wall-clock profile — when do you want each?

**Advanced** — 8. What is safepoint bias, why does it happen, and which tools avoid it? 9. How do you read a flame graph — what does width mean, and what does left-to-right mean? 10. What does `-prof gc` give you that timing does not? 11. What is coordinated omission and how does it corrupt a p99?

**Senior** — 12. Design a performance investigation for a service whose p99 regressed 3× after a deploy, with no code change you can identify. 13. Compare JFR and async-profiler on overhead, coverage, and production suitability. 14. A JMH result shows variant A 4% faster than B with ±6% error. What do you conclude and what do you do next?

## 12. Follow-ups

- *After Q2:* "How many warm-up iterations, and why does JMH also need multiple forks?"
- *After Q7:* "Which one would you use on a service that is 90% I/O wait?"
- *After Q8:* "Name two biased and two unbiased tools."
- *After Q10:* "Why is `alloc.rate.norm` more useful than the timing?"
- *After Q14:* → nothing yet; more iterations, more forks, or a bigger effect.

## 13. Exercise

1. Write the naive timing loop from §5 and show it reports a time near zero. Then convert it to JMH and explain every difference in the number.
2. Benchmark `HashMap.get` across `@Param` sizes 10 / 10³ / 10⁶ / 10⁸. Plot ns/op and explain the curve using the cost hierarchy, not complexity.
3. Profile the same application with VisualVM's sampler and with async-profiler `-e cpu`. Find a method where they disagree and explain the disagreement in terms of safepoints.
4. Take a JFR recording with `settings=profile` during a load test. From it alone, produce: the top allocation sites, the GC pause distribution, the worst time-to-safepoint, and the most contended lock.
5. Load-test a service with a closed-loop generator and with `wrk2` at a fixed rate. Compare the reported p99s and explain the gap with coordinated omission.

## 14. Output prediction

```java
// Predict what each of these REPORTS, and why each is wrong or right.
import java.util.*;
import java.util.concurrent.TimeUnit;

public class Main {
    static int sink;

    static long timeIt(String label, Runnable r) {
        long t0 = System.nanoTime();
        r.run();
        long ns = System.nanoTime() - t0;
        System.out.printf("%-24s %,12d ns%n", label, ns);
        return ns;
    }

    public static void main(String[] args) {
        // A: result never used
        timeIt("A: unused result", () -> {
            for (int i = 0; i < 100_000_000; i++) { int x = i * i; }
        });

        // B: result escapes to a static
        timeIt("B: stored to static", () -> {
            int s = 0;
            for (int i = 0; i < 100_000_000; i++) s += i * i;
            sink = s;
        });

        // C: same as B, but run a second time
        timeIt("C: second run", () -> {
            int s = 0;
            for (int i = 0; i < 100_000_000; i++) s += i * i;
            sink = s;
        });

        // D: loop-invariant input
        int constant = 7;
        timeIt("D: constant input", () -> {
            int s = 0;
            for (int i = 0; i < 100_000_000; i++) s += constant * constant;
            sink = s;
        });

        // E: timing something smaller than the timer
        long t0 = System.nanoTime();
        long t1 = System.nanoTime();
        System.out.println("timer granularity ns: " + (t1 - t0));

        // Questions:
        // 1. Why is A so much faster than B?
        // 2. Why is C different from B?
        // 3. What does D actually measure?
        // 4. What would JMH do differently for each of A-D?
        // 5. What does E tell you about the smallest thing you can time this way?
    }
}
```

## 15. Mastery check

1. Give the six-step measurement method and name the two steps people skip.
2. Explain safepoint bias: the mechanism, the consequence, and two tools on each side.
3. How do you read a flame graph? State what width, height, and left-to-right position mean.
4. When do you want a CPU profile and when a wall-clock profile?
5. Name five things JMH defeats that a hand-written loop does not.
6. Explain why `@Fork` is mandatory.
7. What does `Blackhole` do, and when is returning the value better?
8. What does `-prof gc` report, and why is it more portable than a timing?
9. Explain the `Error` column and the decision rule for two overlapping results.
10. Define coordinated omission and say how to avoid it.
