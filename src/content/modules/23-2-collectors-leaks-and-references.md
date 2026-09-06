---
title: "Garbage collection II: choosing a collector, finding leaks, and the reference types"
phase: 23
order: 2
minutes: 50
summary: "G1 versus ZGC versus Parallel and how to choose, the eight shapes a memory leak takes in a garbage-collected language, and what Soft/Weak/Phantom references and Cleaner are actually for."
tags: ["g1", "zgc", "shenandoah", "memory-leak", "weakreference", "cleaner", "heap-dump"]
---

## 1. The collectors

**[HotSpot]** Five shipping collectors, plus one that does nothing.

| Collector | Flag | Optimises for | Pauses | Heap range | Use when |
| --- | --- | --- | --- | --- | --- |
| **Serial** | `-XX:+UseSerialGC` | Footprint, simplicity | Proportional to heap | < 100 MB | Containers with 1 CPU, CLI tools, tiny services |
| **Parallel** | `-XX:+UseParallelGC` | **Throughput** | Longest, but fewest | < 8 GB | Batch jobs where total time matters and pauses do not |
| **G1** | `-XX:+UseG1GC` (**default since 9**) | Balance | Target-driven, tens of ms | 4 GB – 100s of GB | Almost everything |
| **ZGC** | `-XX:+UseZGC` | **Latency** | **< 1 ms**, independent of heap size | 8 GB – 16 TB | Latency-sensitive services, huge heaps |
| **Shenandoah** | `-XX:+UseShenandoahGC` | Latency | Low, independent of heap | Wide | Same niche as ZGC; OpenJDK/Red Hat lineage |
| **Epsilon** | `-XX:+UseEpsilonGC` | Nothing — never collects | N/A | N/A | Benchmarking allocation, or a job that exits before filling the heap |

**The three-way tradeoff you cannot escape: throughput, latency, footprint — pick two.** ZGC's sub-millisecond pauses cost extra memory (it needs headroom to relocate concurrently) and roughly 5–15% throughput compared with Parallel. Parallel's throughput costs you a full-heap stop-the-world pause.

## 2. G1 — the default, in enough detail

**[HotSpot]** G1 divides the heap into **equal-sized regions** (1–32 MB, chosen so there are ~2048 of them). Regions are *labelled* Eden, Survivor, Old, or Humongous — they are not contiguous areas, and a region's role changes over time.

The cycle:

```text
Young collection      STW. Evacuate live objects out of Eden/Survivor regions into new ones.
                      Cost ∝ survivors. Frequency adapts to the pause target.

Concurrent marking    Mostly concurrent (SATB), with two short STW pauses:
                      initial-mark (piggybacked on a young GC) and remark.
                      Result: a liveness estimate per old region.

Mixed collection      STW. Evacuate young regions PLUS the old regions with the least live data —
                      "garbage first", hence the name. Spread over several collections
                      to respect the pause target.

Full GC               A failure mode. Single-threaded until Java 10, parallel since.
                      Means G1 could not keep up: evacuation failure, or humongous pressure.
```

**`-XX:MaxGCPauseMillis=200`** (the default) is a *target*, not a guarantee — G1 adapts young-generation size and the number of old regions per mixed collection to try to meet it. Setting it very low does not make G1 faster; it makes the young generation tiny, which raises collection frequency and promotion rate, and usually makes things worse.

**Humongous objects** — allocations larger than half a region — are allocated directly into contiguous Old regions and, historically, were only reclaimed by a concurrent cycle. A workload allocating many 2 MB byte arrays into 4 MB regions can drive G1 into repeated full GCs while the young generation is nearly empty. `-Xlog:gc+heap=info` shows humongous region counts; the fix is usually a larger `-XX:G1HeapRegionSize` or smaller buffers.

**Practical G1 tuning is short:** set `-Xmx`, leave `MaxGCPauseMillis` alone, and fix allocation rate in the application. Everything else is a symptom.

## 3. ZGC and Shenandoah — how sub-millisecond pauses work

The insight: pauses scale with heap size only because **relocation** (moving objects and fixing every pointer to them) is done while the world is stopped. Both collectors do relocation **concurrently**, which requires intercepting the application's reads.

**ZGC — coloured pointers plus load barriers.** **[HotSpot]** ZGC stores metadata *in unused bits of the 64-bit pointer itself* (marked, remapped, finalizable). Every reference **load** executes a barrier:

```text
Object o = obj.field;
// load barrier: check the colour bits.
//   good colour  -> proceed (the common case, a few instructions)
//   bad colour   -> the object moved or needs marking: fix THIS reference, self-heal, proceed
```

Because the barrier repairs each reference as it is used, ZGC never needs to stop the world to fix pointers. Its pauses are only for root scanning and are **O(number of roots)**, not O(heap) — hence sub-millisecond on a 16 TB heap. Coloured pointers are also why ZGC does not support compressed oops: it needs all 64 bits.

**Shenandoah** solves the same problem with **load reference barriers** (formerly Brooks forwarding pointers), and works with compressed oops.

**[HotSpot]** **Generational ZGC** (Java 21, `-XX:+ZGenerational`) added a young generation to ZGC — the original was non-generational, so it did full-heap concurrent cycles and needed high allocation headroom. Generational became the default in Java 23 and the non-generational mode was removed in Java 24. If you evaluated ZGC before 21 and rejected it on CPU or footprint, re-evaluate.

## 4. Choosing, and the tuning method

The decision, in order:

1. **Do you have a GC problem?** Measure GC overhead (% of wall clock) and the pause distribution. Under ~2% overhead and acceptable p99, stop — the problem is elsewhere.
2. **Fix allocation before touching flags.** Halving the allocation rate halves young-collection frequency for free, and no collector choice matches that.
3. **Size the heap.** Too small causes constant collection; too large delays and lengthens old-generation work. Aim for a live set around 30–50% of `-Xmx` after a full collection.
4. **Then, and only then, choose a collector** from the table in §1.

```bash
-Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=10,filesize=20M
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/dumps
-XX:MaxRAMPercentage=75                      # containers: never hardcode -Xmx in a container
```

Read GC logs with a tool (GCeasy, GCViewer) or JFR; the raw log is fine but the distributions are what matter. **[JDK]** **JDK Flight Recorder** is the production-grade answer — `-XX:StartFlightRecording=duration=60s,filename=r.jfr`, roughly 1% overhead, and it records allocation profiles, pauses, TTSP, and object-sample stacks.

## 5. Leaks in a garbage-collected language

A leak in Java is not a lost pointer — it is **an unintended strong reference from a root**. Eight shapes cover almost everything:

| Shape | Mechanism | Fix |
| --- | --- | --- |
| **Unbounded cache** | A `static Map` that only ever grows | Bound it: Caffeine, an LRU (`LinkedHashMap`, Module 8.4), or a TTL |
| **Listener / callback registry** | `addListener` with no matching `remove` | Explicit deregistration, or weak listeners |
| **`ThreadLocal` in a pooled thread** | The thread outlives the request; the entry is never removed | `remove()` in a `finally`, always |
| **Class-loader leak** | Anything pinning a redeployed app's loader (Module 22.1 §7) | Clean up statics, threads, JDBC drivers on shutdown |
| **Inner-class `this$0`** | A long-lived inner instance pins its outer (Module 16.1 §6) | `static` nested class |
| **Mutated map key** | The key's hash changed; the entry is unreachable but counted (Module 3.2) | Immutable keys |
| **Unclosed resource** | Streams, connections, `FileChannel`s holding native memory | try-with-resources |
| **Growing collection field** | A `List` appended to per request and never trimmed | Bound or clear it |

**`ThreadLocal` deserves its own paragraph** because it is the most common one in web applications. `ThreadLocal.ThreadLocalMap` uses **weak references to the `ThreadLocal` key** but **strong references to the value**. If the `ThreadLocal` object itself is a `static final` field (as it almost always is), the key is never collected, and the value is retained for the entire life of the pooled thread.

```java
private static final ThreadLocal<RequestContext> CTX = new ThreadLocal<>();

try { CTX.set(ctx); handle(request); }
finally { CTX.remove(); }        // NOT set(null) — remove() clears the map entry
```

**Diagnosis method:**

```bash
jcmd <pid> GC.class_histogram          # what is there, by count and bytes
jcmd <pid> GC.heap_dump /tmp/heap.hprof
jcmd <pid> GC.heap_info
jcmd <pid> Thread.print
```

Then open the dump in **Eclipse MAT** and use the **dominator tree** — it answers "if this object were collected, how much memory would be freed?", which is the question you actually have. The workflow: take two dumps an hour apart, compare histograms to find the growing class, then find its **path to GC root** in the dominator tree. That path is the leak.

## 6. The reference types

**[JDK]** `java.lang.ref` gives you references that do not prevent collection.

```java
ReferenceQueue<Big> q = new ReferenceQueue<>();

SoftReference<Big>    soft  = new SoftReference<>(obj, q);     // cleared when memory is tight
WeakReference<Big>    weak  = new WeakReference<>(obj, q);     // cleared at the next GC
PhantomReference<Big> phant = new PhantomReference<>(obj, q);  // get() ALWAYS returns null

soft.get();     // the referent, or null if cleared
```

| Type | Cleared when | `get()` | Use for |
| --- | --- | --- | --- |
| `SoftReference` | The JVM decides memory is tight, before OOM | Referent or null | Memory-sensitive caches — **but see below** |
| `WeakReference` | The next GC that finds it only weakly reachable | Referent or null | Canonicalising maps, listener registries, metadata keyed by object |
| `PhantomReference` | After the referent is unreachable | **Always null** | Knowing an object is gone, so you can release its native resources |

**`SoftReference` is worse than it sounds.** Its clearing policy is a JVM-wide heuristic (`-XX:SoftRefLRUPolicyMSPerMB`, default 1000 ms of survival per free MB of heap), not an LRU with a size bound. A soft-reference cache holds everything until memory pressure, then drops *everything*, giving a hit rate that swings wildly and a full GC to find out. **Use a real cache (Caffeine, or a bounded `LinkedHashMap`) with a size or time bound.**

**`WeakHashMap`** holds its **keys** weakly. The classic trap: if a value references its own key, the entry is strongly reachable through the value and never collected.

```java
Map<Session, SessionData> m = new WeakHashMap<>();
m.put(session, new SessionData(session));    // LEAK: the value holds the key
```

Also note that `WeakHashMap` keyed on a `String` literal never evicts — the literal is interned and strongly held by the constant pool.

**`Cleaner` is the finalizer replacement** (Java 9), built on phantom references:

```java
public class NativeBuffer implements AutoCloseable {
    private static final Cleaner CLEANER = Cleaner.create();

    private static final class State implements Runnable {     // MUST NOT reference the outer object
        private final long address;
        State(long address) { this.address = address; }
        @Override public void run() { free(address); }         // idempotent
    }

    private final State state;
    private final Cleaner.Cleanable cleanable;

    public NativeBuffer(long size) {
        this.state = new State(allocate(size));
        this.cleanable = CLEANER.register(this, state);        // registers a phantom ref
    }
    @Override public void close() { cleanable.clean(); }       // the DETERMINISTIC path
}
```

Two rules, and the first is the one people get wrong: **the cleaning action must not reference the object being cleaned** — that would make it strongly reachable and it would never be cleaned. And a `Cleaner` is a **safety net, not a strategy**: `close()` in try-with-resources is the real mechanism; the cleaner only catches the case where someone forgot.

## 7. The `OutOfMemoryError` family

Each message means something specific:

| Message | Meaning | Where to look |
| --- | --- | --- |
| `Java heap space` | The live set exceeds `-Xmx` | Heap dump, dominator tree |
| `GC overhead limit exceeded` | >98% of time in GC, <2% recovered | Same — a leak or an undersized heap |
| `Metaspace` | Class metadata exhausted | Class-loader leak (Module 22.1) |
| `Direct buffer memory` | `allocateDirect` exceeded `-XX:MaxDirectMemorySize` | Unreleased NIO buffers, Netty pools |
| `unable to create native thread` | OS thread limit or address space exhausted | Thread leak; check `-Xss` × thread count |
| `Requested array size exceeds VM limit` | An array over ~`Integer.MAX_VALUE - 8` | A bug, not a tuning issue |
| Killed by the OOM killer (no Java error) | The **process** exceeded the container limit | Memory outside `-Xmx` (Module 22.2 §1) |

That last row is the one people miss: no exception, no heap dump, just exit code 137. `-XX:NativeMemoryTracking=summary` plus `jcmd VM.native_memory` is the tool.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ leaks are missing frees or cycles of <code>shared_ptr</code></strong>, and the tools are Valgrind, ASan/LSan, and heap profilers that record allocation stacks. The leaked memory is unreachable — nothing points to it.</p>
<p><strong>Java leaks are the opposite: the memory is perfectly reachable</strong>, from a static field, a cache, or a thread-local, through a chain nobody intended. No tool can flag it automatically, because "reachable but unwanted" is a judgement about intent. That is why the Java tooling is a <em>dominator tree</em> and a <em>path to GC root</em> rather than a leak detector: it shows you what is holding what, and you decide whether it should be.</p>
<p><code>weak_ptr</code> is the direct analogue of <code>WeakReference</code>, and for the same reason: breaking an unwanted retention. There is no C++ counterpart to <code>SoftReference</code> (there is no allocator-wide memory-pressure signal to hook), and <code>PhantomReference</code> + <code>Cleaner</code> is the awkward substitute for a destructor.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| A "leak" is | Unreachable, unfreed memory | **Reachable**, unwanted memory |
| Detection | Valgrind, LSan, heap profilers | Heap dump + dominator tree + path to root |
| Cycles | Leak with `shared_ptr` | Collected |
| Break a cycle | `weak_ptr` | `WeakReference` / `WeakHashMap` |
| Memory-pressure cache | Manual, with your own eviction | `SoftReference` (avoid) or a real cache library |
| Deterministic cleanup | Destructor | try-with-resources; `Cleaner` as a net |
| Native resource lifetime | RAII | `AutoCloseable` + `Cleaner` |
| Choosing an allocator | jemalloc, tcmalloc, arenas | Choosing a collector |
| Pause tuning | N/A | The core tuning activity |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Reaching for <code>SoftReference</code> because it sounds like the GC-aware version of a cache. It behaves nothing like an LRU and gives you a JVM-wide cliff instead of a bound. Use a bounded cache with an explicit policy.</p>
<p>Writing <code>Cleaner</code> or <code>finalize</code>-style cleanup as the primary release mechanism. Java's answer to RAII is try-with-resources; the reference-based path exists only as a backstop.</p>
</div>

## 9. Edge cases

- **G1's `MaxGCPauseMillis` set too low** shrinks the young generation until throughput collapses. It is a target, not a lever.
- **A concurrent collector's heap usage overstates the live set** because of floating garbage (Module 23.1 §4).
- **ZGC does not use compressed oops**, so references are 8 bytes — budget ~10–20% more heap than G1 for the same live set.
- **`WeakHashMap` entries are removed lazily**, on the next map operation that processes the reference queue — `size()` can be stale.
- **`ReferenceQueue.remove()` blocks**; `poll()` does not. A cleaner thread that busy-polls burns a core.
- **A `Cleaner` action holding the outer object** is the most common cleaner bug and produces silence, not an error.
- **`Reference.reachabilityFence(this)`** is needed when a method uses a native resource owned by `this` but never touches `this` afterwards — the object can be collected mid-method (Module 23.1 §9).
- **`-XX:+UseEpsilonGC`** turns `OutOfMemoryError` into a hard stop; it is a measurement tool, not a production option.
- **Heap dumps trigger a full GC** and stop the world for their duration — a 20 GB dump is a multi-second outage. Take them from a canary, not from every instance.
- **`jcmd GC.class_histogram` also stops the world** briefly; the `-all` variant skips the preceding GC and shows unreachable objects too.

## 10. Common mistakes

- Choosing a collector before measuring GC overhead.
- Lowering `MaxGCPauseMillis` to "make it faster".
- Using `SoftReference` as a cache.
- A `WeakHashMap` whose values reference their keys.
- `ThreadLocal.set(null)` instead of `remove()`.
- Adding listeners with no removal path.
- Unbounded static maps.
- Blaming the GC when the process was OOM-killed for non-heap memory.
- Taking a heap dump on every production instance during an incident.
- Using a `Cleaner` instead of `close()`.

## 11. Interview questions

**Beginner** — 1. Name three collectors and what each optimises for. 2. What is the default collector? 3. Can Java leak memory?

**Intermediate** — 4. What does "garbage first" mean in G1? 5. What are `SoftReference`, `WeakReference` and `PhantomReference` for? 6. How does `WeakHashMap` work? 7. Why is `ThreadLocal` a leak risk in a thread pool?

**Advanced** — 8. How does ZGC achieve pauses independent of heap size? 9. What are humongous objects and how do they break G1? 10. Why is a Java leak harder to find than a C++ leak, and what tool answers the real question? 11. Why is `SoftReference` a poor cache?

**Senior** — 12. p99 latency is 400 ms with 15 ms GC pauses. Walk through your diagnosis. 13. Give the eight leak shapes and one detection strategy each. 14. A container is OOM-killed with heap at 40% and no Java error. Investigate. 15. Design a native-resource-owning class with deterministic release and a safety net, and explain every reference you hold.

## 12. Follow-ups

- *After Q2:* "Since which version, and what was it before?"
- *After Q6:* "What if the value references the key?"
- *After Q8:* "What does ZGC give up to do that?" → compressed oops, some throughput, headroom.
- *After Q10:* "What does the dominator tree tell you that a histogram does not?"
- *After Q12:* → not GC; check TTSP, allocation stalls, lock contention, or downstream I/O.

## 13. Exercise

1. Run the same workload under Serial, Parallel, G1 and ZGC. Report throughput, p50/p99/max pause, and peak RSS for each. Explain the four-way tradeoff with your own numbers.
2. Build each of the eight leak shapes as a minimal program. For each: take two heap dumps, find the growing class in the histogram diff, and screenshot the path to GC root.
3. Write a `ThreadLocal` leak in a fixed thread pool, prove the retention in MAT, then fix it and prove the fix.
4. Implement the `NativeBuffer` cleaner from §6. Then deliberately make the cleaning action reference the outer object and show it never runs.
5. Build a cache three ways — `HashMap`, `SoftReference` values, and Caffeine with a size bound — and measure hit rate and pause behaviour under memory pressure. Write up why the soft version is unusable.

## 14. Output prediction

```java
import java.lang.ref.*;
import java.util.*;
import java.util.concurrent.*;

public class Main {
    static final ThreadLocal<byte[]> TL = new ThreadLocal<>();

    public static void main(String[] args) throws Exception {
        System.out.println(java.lang.management.ManagementFactory
                .getGarbageCollectorMXBeans().stream()
                .map(java.lang.management.GarbageCollectorMXBean::getName).toList());

        var wm = new WeakHashMap<Object, String>();
        Object k1 = new Object();
        wm.put(k1, "v1");
        wm.put("literal", "v2");
        System.out.println(wm.size());
        k1 = null;
        System.gc(); Thread.sleep(200);
        System.out.println(wm.size());

        // value references key
        var wm2 = new WeakHashMap<Object, Object[]>();
        Object k2 = new Object();
        wm2.put(k2, new Object[]{ k2 });
        k2 = null;
        System.gc(); Thread.sleep(200);
        System.out.println(wm2.size());

        var q = new ReferenceQueue<Object>();
        Object o = new Object();
        var ph = new PhantomReference<>(o, q);
        System.out.println(ph.get());
        o = null;
        System.gc(); Thread.sleep(200);
        System.out.println(q.poll() == ph);

        var cleaner = Cleaner.create();
        var latch = new CountDownLatch(1);
        Object target = new Object();
        cleaner.register(target, latch::countDown);
        target = null;
        System.gc();
        System.out.println(latch.await(2, TimeUnit.SECONDS));

        var pool = Executors.newFixedThreadPool(1);
        pool.submit(() -> TL.set(new byte[1024])).get();
        pool.submit(() -> System.out.println(TL.get() != null)).get();
        pool.submit(() -> { TL.remove(); }).get();
        pool.submit(() -> System.out.println(TL.get() != null)).get();
        pool.shutdown();

        System.out.println(Runtime.getRuntime().totalMemory() <= Runtime.getRuntime().maxMemory());
    }
}
```

## 15. Mastery check

1. Name six collectors, what each optimises for, and when you would choose it.
2. Describe G1's four phases and what "garbage first" refers to.
3. Explain how ZGC keeps pauses independent of heap size, and what it gives up.
4. What are humongous objects and what pathology do they cause?
5. Give the tuning order: what do you measure and change, in what sequence?
6. Define a Java memory leak, and give all eight shapes.
7. Explain the `ThreadLocal` leak precisely: which reference is weak, which is strong, and why it matters.
8. Compare the three reference types on clearing time, `get()` behaviour, and intended use.
9. Why is `SoftReference` a poor cache implementation?
10. Write the `Cleaner` contract: the two rules and why each exists.
