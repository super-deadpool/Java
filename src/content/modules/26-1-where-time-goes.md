---
title: "Where Java time actually goes: memory, allocation, boxing, branches, and contention"
phase: 26
order: 1
minutes: 45
summary: "The cost hierarchy from a register to a network hop, why an unsorted array is 6× slower than a sorted one, what allocation really costs, and the order in which to look for a bottleneck."
tags: ["performance", "cache", "allocation", "boxing", "branch-prediction", "contention", "latency"]
---

## 1. The cost hierarchy

Every performance discussion should start from these numbers, because they span **nine orders of magnitude** and almost every optimisation is really about moving work up this table.

| Operation | Latency | Relative |
| --- | --- | --- |
| Register / L1 cache hit | ~1 ns (≈4 cycles) | 1× |
| L2 cache hit | ~4 ns | 4× |
| L3 cache hit | ~15 ns | 15× |
| **Main memory (cache miss)** | **~80–100 ns** | **~100×** |
| Branch misprediction | ~5–20 ns (15–20 cycles) | ~10× |
| Uncontended lock (CAS) | ~20 ns | 20× |
| Contended lock (park/unpark) | ~1–10 µs | ~5 000× |
| Thread context switch | ~1–10 µs | ~5 000× |
| NVMe SSD read | ~100 µs | ~100 000× |
| Network round trip, same datacentre | ~0.5 ms | ~500 000× |
| Network round trip, cross-region | ~50–150 ms | ~10⁸× |

The implication that governs everything below: **a cache miss costs about as much as 100 arithmetic operations.** Layout beats instruction count. And **a single database round trip costs more than a million cache hits** — which is why the first place to look is never the code you were staring at.

## 2. The order to look

Optimising in the wrong order is the most common waste of effort. Work down this list:

```text
1. ALGORITHM         O(n²) -> O(n log n) beats every micro-optimisation ever written
2. I/O AND QUERIES   N+1 queries, unbatched calls, missing indexes, chatty RPC
3. ALLOCATION / GC   allocation rate drives GC frequency; survivors drive GC cost
4. CONCURRENCY       lock contention, false sharing, thread starvation
5. MEMORY LAYOUT     cache misses, pointer chasing, boxing
6. MICRO             branch prediction, inlining, instruction selection
```

**Amdahl's law** is the reason: if a component is 10% of your runtime, making it infinitely fast gives you 11% overall. Before optimising anything, find out what fraction of time it accounts for — which is Module 26.2's subject.

**Measure the right statistic.** An average latency is nearly meaningless for a service:

```text
Requests: 99 × 1 ms + 1 × 500 ms
average = 6 ms      <- looks fine
p99     = 500 ms    <- what 1% of your users experience
```

Users experience **percentiles**, and a page that makes 20 backend calls hits the p99 of *something* on most page loads. Always report p50 / p95 / p99 / p99.9 / max.

## 3. Allocation and GC

Allocation itself is a pointer bump — about ten instructions (Module 22.2 §5). The cost is elsewhere:

- **Allocation rate drives GC *frequency*.** 1 GB/s into a 500 MB Eden means two young collections per second.
- **Survivor count drives GC *cost*.** A young collection copies live objects; dead ones are free (Module 23.1 §3).
- **Allocation also evicts cache.** Writing 1 GB/s of fresh objects flushes L1/L2 continuously, slowing everything else.

So the goal is not "zero allocation" — it is **allocating objects that die young**, and not allocating in the hottest loops.

```java
// Allocating in a hot loop, invisibly:
for (Order o : orders) {
    String key = o.region() + ":" + o.type();     // a StringBuilder + a String + a byte[], per iteration
    Integer count = counts.get(key);              // boxing on the way in and out
    counts.put(key, count == null ? 1 : count + 1);
}

// Same logic, a fraction of the garbage:
for (Order o : orders) {
    counts.merge(key(o), 1, Integer::sum);        // one merge; the Integer cache covers small counts
}
```

**Escape analysis may remove an allocation entirely** (Module 22.3 §5) — but only if the allocating method is inlined and the object never escapes. One `log.trace(obj)` on a cold path can force every allocation on the hot path to become real.

## 4. Boxing

The most common invisible cost in Java, because the syntax hides it.

```java
Map<Integer, Integer> counts = new HashMap<>();   // EVERY key and value is a heap object
long sum = 0;
for (int i = 0; i < 10_000_000; i++) sum += list.get(i);    // List<Integer>: 10 M unboxes
```

**[JDK]** `Integer.valueOf` caches −128..127 (Module 1.2), which is exactly why microbenchmarks over small integers show no allocation and production over real IDs allocates gigabytes.

The costs, in order:

1. **Allocation** — 16 bytes per boxed `Integer`, plus GC pressure.
2. **Indirection** — `Integer[]` is an array of pointers; summing it is a cache miss per element, while `int[]` streams at memory bandwidth.
3. **`Long` boxing has no useful cache** beyond the same small range, so ID-keyed maps allocate constantly.

```java
Map<Integer, Long> m;                  // ~48 bytes of overhead per entry, plus pointer chasing
long[] byIndex;                        // 8 bytes per entry, contiguous
// Or a primitive collection library: Eclipse Collections, fastutil, HPPC
IntLongHashMap m2;                     // no boxing, open addressing, 5-10x less memory
```

The stream equivalent is `mapToInt` (Module 12.1 §6): `stream().map(Order::total).reduce(0, Integer::sum)` boxes every element; `stream().mapToInt(Order::total).sum()` does not.

## 5. Memory layout and cache

Recall Module 22.2 §6: an array of objects is an array of **references**. Iterating it is pointer chasing — one potential cache miss per element.

```java
class Particle { double x, y, vx, vy; }
Particle[] ps = new Particle[1_000_000];
for (Particle p : ps) p.x += p.vx;              // ~1 cache miss per particle

double[] x = new double[1_000_000], vx = new double[1_000_000];
for (int i = 0; i < x.length; i++) x[i] += vx[i];   // 8 doubles per cache line; vectorisable
```

Two more layout effects worth knowing:

**Stride matters.** A cache line is 64 bytes; sequential access gets 8 doubles per miss and triggers hardware prefetching. Random or large-stride access gets one useful value per miss and defeats the prefetcher. Row-major versus column-major traversal of a 2-D array can differ by 5–10×.

**False sharing** (Module 24.2 §7): two threads writing two independent fields on the same 64-byte line cause the line to bounce between cores. The fix is padding (`@Contended`, or what `LongAdder.Cell` does).

## 6. Branch prediction

The famous demonstration, and it is real:

```java
int[] data = new int[32768];
// fill with random values 0..255
// Arrays.sort(data);       <-- uncomment this line

long sum = 0;
for (int i = 0; i < 100_000; i++)
    for (int v : data)
        if (v >= 128) sum += v;         // the branch
```

Sorting the array first makes this loop roughly **6× faster**, even though the sort itself takes longer than one pass. Sorted data makes the branch perfectly predictable (a long run of false, then a long run of true); random data mispredicts ~50% of the time, and each misprediction flushes a ~15–20 stage pipeline.

The fix when you cannot sort is **branchless code**:

```java
sum += v & -((128 - v) >> 31);          // no branch; arithmetic instead
sum += (v >= 128) ? v : 0;              // the JIT MAY emit a conditional move (cmov) here
```

The JIT will sometimes do this for you (`cmov`), and sometimes not. This is the level at which reading the emitted assembly is the only way to know.

## 7. Strings

```java
// A loop: quadratic. Each += allocates a new String and copies everything so far.
String s = ""; for (String p : parts) s += p;                       // O(n²)

// Linear
var sb = new StringBuilder(expectedLength);                          // size it if you can
for (String p : parts) sb.append(p);
String result = String.join(",", parts);                             // best when it applies
```

**[JDK]** Note what does *not* need fixing: a **single-expression** concatenation like `"a" + x + "b"` compiles, since Java 9, to an `invokedynamic` bound to `StringConcatFactory.makeConcatWithConstants`, which computes the exact length and fills one array — faster than a hand-written `StringBuilder`. The quadratic problem is specifically concatenation **across loop iterations**.

Other string costs:

- **`String.format` is ~10–100× slower than concatenation** — it parses the format string every call. Fine for errors, wrong for a hot path.
- **`Pattern.compile` in a loop** is a large cost; hoist it to a `static final Pattern`. `String.matches`/`replaceAll`/`split` compile a pattern **every call** (except `split` on a single non-regex character, which has a fast path).
- **Compact strings** (Java 9+) store Latin-1 text at one byte per character, so ASCII strings are half the size they were on Java 8.
- **`intern()`** is rarely a win and can make the string table a bottleneck.

**Logging is the string trap most services actually hit:**

```java
log.debug("processing " + order + " with " + context);      // builds the string EVEN IF debug is off
log.debug("processing {} with {}", order, context);         // SLF4J: formats only if enabled
log.debug(() -> "processing " + expensive());               // Supplier overload: nothing runs if off
```

## 8. Contention and I/O

**Lock contention is Amdahl's law made concrete.** A critical section that is 5% of the work caps you at 20× speedup no matter how many cores you add — and contention makes it worse than that, because losers park and context-switch (~5 000× the cost of the CAS they failed).

The fixes, in order: **hold the lock for less time** (never across I/O), **partition the data** (lock striping, `ConcurrentHashMap`, `LongAdder`), **use an immutable snapshot** (Module 25.2 §3), or **remove the sharing** (confinement).

**I/O is usually the actual answer.** The classic shapes:

- **N+1 queries** — one query for the list, then one per element. 200 round trips instead of 2.
- **Unbatched writes** — one insert per row instead of a batch.
- **Unbuffered streams** — one syscall per byte (Module 19.1 §3).
- **Chatty RPC** — five sequential calls that could have been parallel or one.
- **A missing index** — a full table scan that no amount of Java tuning will fix.

If your service spends 80% of its time waiting on a database, every optimisation in this module is worth at most 20%.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>The hardware costs are identical.</strong> Cache misses, branch mispredictions, and false sharing behave exactly the same in both languages — this whole module's §1, §5 and §6 are language-independent, and your C++ intuition transfers unchanged.</p>
<p><strong>What differs is which costs you can control.</strong> C++ lets you choose layout (values in a <code>vector</code>, <code>alignas</code>, arenas, custom allocators) and pay no per-object overhead. Java forces indirection for every non-primitive and adds a 12-byte header, so the equivalent optimisation is <em>always</em> "flatten into primitive arrays by hand". Conversely, Java's allocator is faster than <code>malloc</code>, its compacting GC eliminates fragmentation, and the JIT devirtualizes calls that a C++ compiler cannot prove.</p>
</div>

| Cost | C++ | Java |
| --- | --- | --- |
| Cache miss | Same | Same — but you hit more of them |
| Object overhead | 0 (or 8 for a vptr) | 12–16 bytes, always |
| Contiguous collection of objects | `std::vector<T>` | Only for primitives; else parallel arrays |
| Allocation | `malloc` — shared, locking | TLAB bump — faster |
| Deallocation | Deterministic, proportional to freed | GC — deferred, proportional to survivors |
| Fragmentation | Real | Eliminated by compaction |
| Boxing | Nonexistent | Everywhere, invisible |
| Devirtualization | Only when provable, or `final` | Speculative, from a profile |
| Bounds checks | None (UB instead) | Inserted, usually eliminated |
| String concatenation | `+` on `std::string` reallocates; `reserve` | `+` in a loop is O(n²); `StringBuilder` |
| Determinism | High | GC and JIT introduce variance |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Assuming <code>List&lt;Integer&gt;</code> is <code>vector&lt;int&gt;</code>. It is <code>vector&lt;shared_ptr&lt;int&gt;&gt;</code> with a 16-byte allocation per element. For numeric work, <code>int[]</code> or a primitive-collection library is the only equivalent.</p>
<p>Micro-optimising Java from the source. The JIT may have removed your allocation, eliminated your bounds check, and inlined your virtual call — or done none of it because one call site went megamorphic. Measure first, every time.</p>
</div>

## 10. Edge cases

- **`ArrayList` beats `LinkedList` for almost everything**, including mid-list insertion at realistic sizes, because finding the position is a pointer chase and `System.arraycopy` is vectorised. `LinkedList`'s only real niche is a deque, and `ArrayDeque` is better at that too.
- **`HashMap` without an initial capacity** rehashes log₂(n/16) times while filling (Module 8.4 §3).
- **`Collections.unmodifiableList` wraps**, adding one indirection per access on a hot path.
- **Streams add virtual calls** that only disappear when the JIT inlines through them (Module 22.3 §4).
- **`Optional` allocates** unless escape analysis removes it (Module 13.1 §7).
- **Exceptions cost in `fillInStackTrace`**, proportional to stack depth. Preallocating an exception without a stack trace (`super(msg, null, false, false)`) is a legitimate technique for control-flow exceptions — and a smell if you need it.
- **`System.currentTimeMillis()` and `nanoTime()` are not free** — tens of nanoseconds each, and `nanoTime` can be a `vDSO` call or worse on some virtualised platforms. Timing a 5 ns operation with them measures the timer.
- **`ThreadLocal.get()` is a hash lookup**, not a field read.
- **Megamorphic `equals`/`hashCode`** on a heterogeneous map's keys prevents inlining in the map's hot path.
- **JIT warm-up means the first thousand requests are slow** — relevant for autoscaling and for canary comparisons.

## 11. Common mistakes

- Optimising before profiling.
- Optimising something that is 3% of runtime.
- Reporting averages instead of percentiles.
- `String +=` in a loop.
- `String.format` or `Pattern.compile` on a hot path.
- String concatenation inside a disabled log statement.
- `Map<Integer, X>` for a dense integer key space.
- `List<Integer>` for numeric work.
- An array of small objects where parallel primitive arrays belong.
- Holding a lock across I/O.
- Tuning GC flags before reducing allocation.
- Ignoring the database because the problem "must be in the Java".

## 12. Interview questions

**Beginner** — 1. Why is a cache miss expensive? 2. What does autoboxing cost? 3. Why is `String +=` in a loop bad?

**Intermediate** — 4. Give the order in which you look for a bottleneck. 5. Why report p99 rather than the mean? 6. What drives GC frequency, and what drives GC cost? 7. Why is `ArrayList` usually faster than `LinkedList`?

**Advanced** — 8. Explain the sorted-versus-unsorted array result and the two ways to fix it. 9. Why is `Integer[]` slower to sum than `int[]` — give both reasons. 10. What is false sharing and how do you fix it? 11. Why is a single-expression `"a" + x` fine but a loop concatenation quadratic?

**Senior** — 12. A service's p99 is 800 ms and its p50 is 4 ms. Give five hypotheses ranked by likelihood and how you would test each. 13. State Amdahl's law and apply it to a 5% critical section on a 64-core machine. 14. Design the data layout for 100 M records scanned repeatedly with a numeric filter. Justify every choice against the cost hierarchy.

## 13. Follow-ups

- *After Q2:* "When does it not allocate?" → the −128..127 cache.
- *After Q6:* "So does reducing allocation reduce pause time?" → frequency yes, per-pause cost only if survivors drop.
- *After Q8:* "What does the JIT do on its own?" → sometimes `cmov`; check the assembly.
- *After Q11:* "What changed in Java 9?" → `invokedynamic` string concat.
- *After Q12:* → GC pauses, lock contention, a slow dependency's tail, TTSP, connection-pool exhaustion.

## 14. Exercise

1. Reproduce the branch-prediction benchmark with JMH. Report sorted versus unsorted, then add a branchless variant, then check with `-prof perfasm` whether the JIT emitted a `cmov`.
2. Sum 10 M elements four ways: `int[]`, `Integer[]`, `List<Integer>`, `IntStream`. Report time and allocation rate (`-prof gc`) for each and explain all four.
3. Build the particle simulation both ways (array-of-objects and structure-of-arrays), measure, then confirm the cause with `perf stat -e cache-misses`.
4. Demonstrate false sharing with two adjacent `long` fields versus padded ones, at 2, 4 and 8 threads.
5. Take a real endpoint. Measure p50/p99/p99.9 under load with a coordinated-omission-free generator (wrk2), then find where the p99 time goes and fix one thing. Re-measure and report the delta honestly.

## 15. Output prediction

```java
import java.util.*;
import java.util.stream.*;
import java.util.regex.*;

public class Main {
    public static void main(String[] args) {
        System.out.println(Integer.valueOf(127) == Integer.valueOf(127));
        System.out.println(Integer.valueOf(128) == Integer.valueOf(128));
        System.out.println(Long.valueOf(127) == Long.valueOf(127));

        Map<Integer, Integer> m = new HashMap<>();
        for (int i = 0; i < 5; i++) m.put(i, i * i);
        Integer a = m.get(2), b = m.get(2);
        System.out.println(a == b);

        long t0 = System.nanoTime();
        String s = "";
        for (int i = 0; i < 20_000; i++) s += "x";
        long quadratic = System.nanoTime() - t0;

        t0 = System.nanoTime();
        var sb = new StringBuilder();
        for (int i = 0; i < 20_000; i++) sb.append("x");
        String s2 = sb.toString();
        long linear = System.nanoTime() - t0;

        System.out.println(s.length() == s2.length());
        System.out.println("ratio > 10: " + (quadratic / Math.max(1, linear) > 10));

        int[] data = new int[32768];
        var rnd = new Random(42);
        for (int i = 0; i < data.length; i++) data[i] = rnd.nextInt(256);

        long sum1 = 0;
        t0 = System.nanoTime();
        for (int r = 0; r < 2000; r++) for (int v : data) if (v >= 128) sum1 += v;
        long unsorted = System.nanoTime() - t0;

        Arrays.sort(data);
        long sum2 = 0;
        t0 = System.nanoTime();
        for (int r = 0; r < 2000; r++) for (int v : data) if (v >= 128) sum2 += v;
        long sorted = System.nanoTime() - t0;

        System.out.println(sum1 == sum2);
        System.out.println("sorted faster: " + (sorted < unsorted));
        System.out.printf("ratio %.1f%n", (double) unsorted / sorted);

        System.out.println("a,b,,".split(",").length);
        System.out.println(Pattern.compile("\\d+").matcher("abc123").find());

        System.out.println(IntStream.rangeClosed(1, 5).sum());
        System.out.println(Stream.of(1, 2, 3, 4, 5).reduce(0, Integer::sum));
    }
}
```

## 16. Mastery check

1. Give the cost hierarchy from L1 to a cross-region network hop, with approximate numbers.
2. State the six-step order for finding a bottleneck and justify the ordering with Amdahl's law.
3. Why is p99 the number that matters, and what does an average hide?
4. What drives GC frequency and what drives GC cost? Which does reducing allocation help?
5. Give both reasons `Integer[]` is slower to sum than `int[]`.
6. Explain the sorted-array result mechanically, and give two fixes.
7. Explain false sharing and its fix.
8. When is `String +` fine and when is it quadratic? What changed in Java 9?
9. Give three logging patterns and say which allocate when the level is disabled.
10. Give four I/O bottleneck shapes and how you would detect each.
