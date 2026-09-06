---
title: "Parallel streams: the common pool, splitting, and when parallelism loses"
phase: 12
order: 3
minutes: 45
summary: "One keyword hands your work to a shared fork-join pool. What splits well, what ordering costs, why blocking I/O in a parallel stream is a system-wide outage, and the N×Q rule."
tags: ["parallel-streams", "forkjoin", "spliterator", "nq-model", "ordering"]
---

## 1. Concept

```java
long count = orders.parallelStream().filter(Order::isLate).count();
long same  = orders.stream().parallel().filter(Order::isLate).count();
```

`parallel()` sets a flag on the pipeline. At the terminal operation, instead of `copyInto`, the framework:

1. asks the source `Spliterator` to **`trySplit()`** recursively into a tree of leaf tasks,
2. runs each leaf on the **common `ForkJoinPool`**,
3. **combines** partial results pairwise back up the tree.

Everything else — laziness, the sink chain, short-circuiting — is unchanged.

## 2. Why this is not free

The three costs are always paid; the benefit is only sometimes there.

| Cost | Where it comes from |
| --- | --- |
| **Splitting** | Walking the source to divide it; cheap for arrays, expensive or impossible for linked structures |
| **Combining** | Merging *k* partial results; merging `HashMap`s or `List`s is real work |
| **Coordination** | Task submission, work-stealing deques, thread wake-ups, memory barriers |

Against that you get at most `parallelism` times the throughput of the filter/map work. If the per-element work is trivial, the overhead dominates and parallel is **slower** — routinely by 5–50× on small collections.

## 3. Mental model — N × Q

> Parallelism pays when **N × Q** is large: **N** = number of elements, **Q** = cost per element.

**[JDK]** The Streams API authors' rule of thumb is that the pipeline should be doing on the order of **10 000+ "basic operations"** total before parallelism can win. Concretely:

| N | Q | Verdict |
| --- | --- | --- |
| 100 | trivial (`x * 2`) | Never. Overhead is 100× the work |
| 1 000 000 | trivial | Maybe — depends on splitting quality |
| 10 000 | expensive (parse, hash, compress) | Yes |
| 20 | very expensive (an HTTP call) | **No** — see §6; use an executor |

The last row is the important one: parallel streams are for **CPU-bound** work on **in-memory** data. Blocking work belongs in an `ExecutorService` or on virtual threads (Phase 24).

## 4. How well does your source split?

This is the difference between a 6× speedup and a 1.1× one.

| Source | Splits | Why |
| --- | --- | --- |
| `int[]` / `Object[]`, `Arrays.stream` | **Excellent** | `SIZED \| SUBSIZED`; split by index arithmetic, perfectly balanced |
| `ArrayList` | **Excellent** | Backed by an array; same |
| `IntStream.range(a, b)` | **Excellent** | Split arithmetically, no data touched |
| `HashMap` / `HashSet` | Good | Splits the bin table; balance depends on the hash |
| `TreeMap` / `ConcurrentSkipListMap` | Fair | Splits by subtree; not size-balanced |
| `LinkedList`, `ArrayDeque` iteration | **Poor** | Must walk to find a midpoint; each split is O(n) |
| `Stream.iterate` / `generate` | **Poor** | Unsized, sequential by construction |
| `BufferedReader.lines`, `Files.lines` | **Poor** | Reads in batches of a fixed size; no size estimate |
| `Files.lines` on a small file | Poor | Splitting cost exceeds the work |

The mechanics: `AbstractSpliterator` and iterator-based sources fall back to `trySplit` handing off a fixed-size *batch* (starting at 1024 and growing), which produces a lopsided tree. `SIZED | SUBSIZED` sources split exactly in half every time, giving a balanced tree of depth log₂(N) with `parallelism`-many leaves.

```java
// good: 3 M elements over a contiguous array, real per-element work
double energy = IntStream.range(0, n).parallel()
        .mapToDouble(i -> expensiveTransform(data[i]))
        .sum();

// bad: linked source, trivial work, tiny N
list.parallelStream().map(String::trim).toList();   // a LinkedList of 200 strings
```

## 5. Ordering — what parallelism changes

An **ordered** stream keeps *encounter order*, and preserving it across parallel tasks costs buffering.

```java
list.parallelStream().forEach(System.out::println);         // arbitrary order, fast
list.parallelStream().forEachOrdered(System.out::println);  // encounter order, buffers and serialises

list.parallelStream().findFirst();   // must find the FIRST — cannot short-circuit freely
list.parallelStream().findAny();     // any match, all tasks can stop immediately
```

Operations whose cost changes with ordering: `findFirst`, `limit`, `skip`, `forEachOrdered`, `sorted`, `distinct`, `toList`. `limit(n)` on an ordered parallel stream is particularly bad — it must know which *n* elements are first, so it cannot simply take the first *n* produced.

`unordered()` explicitly gives up encounter order and unlocks the cheaper paths:

```java
set.parallelStream().unordered().limit(100).toList();       // any 100
map.entrySet().parallelStream().unordered()
   .collect(groupingByConcurrent(...));                     // enables the CONCURRENT path (Module 12.2)
```

`HashSet` and `HashMap`-backed streams are already unordered; `List`-backed ones are ordered.

## 6. What happens internally — and the common-pool trap

**[JDK]** All parallel streams run on `ForkJoinPool.commonPool()`, whose parallelism is `Runtime.getRuntime().availableProcessors() - 1` by default. The **calling thread also participates** (it joins in on the work rather than blocking idle), so effective concurrency is `availableProcessors()`.

```bash
-Djava.util.concurrent.ForkJoinPool.common.parallelism=8    # the only supported way to size it
```

**The common pool is a single, process-wide, unbounded-lifetime resource shared by every parallel stream in your application and in every library you depend on.** That produces the single most damaging misuse in this module:

```java
// DO NOT DO THIS. Each element blocks a common-pool thread on network I/O.
List<Response> rs = urls.parallelStream().map(httpClient::getBlocking).toList();
```

On an 8-core box that is 7 pool threads parked in `read()`. Every other parallel stream in the JVM — including ones inside libraries you did not write — now queues behind your HTTP calls. The symptom is a latency cliff in an unrelated subsystem, which is exceptionally hard to attribute.

The correct tools:

```java
// Bounded, dedicated, and sized for I/O
try (var exec = Executors.newFixedThreadPool(64)) {                 // Java 19+: ExecutorService is AutoCloseable
    List<Future<Response>> fs = exec.invokeAll(urls.stream().map(u -> (Callable<Response>) () -> get(u)).toList());
}

// Or, Java 21+: one virtual thread per request — the right answer for blocking I/O
try (var exec = Executors.newVirtualThreadPerTaskExecutor()) { ... }
```

**Running a parallel stream in your own pool** is a known trick: submitting the terminal operation to a `ForkJoinPool` makes the stream use *that* pool, because the framework uses the current thread's pool when it is a `ForkJoinWorkerThread`.

```java
var pool = new ForkJoinPool(4);
try { pool.submit(() -> data.parallelStream().map(...).toList()).get(); }
finally { pool.shutdown(); }
```

This works and is widely used, but it is **not specified** — it is an implementation behaviour, not an API. Treat it as a mitigation for CPU-bound work you must isolate, never as a way to make blocking work acceptable.

**Virtual threads do not help parallel streams.** Virtual threads solve *blocking*; parallel streams are for *CPU-bound* work, where you want exactly as many carriers as cores. **[JDK]** `ForkJoinPool` does not use virtual threads, and mounting more virtual threads on the same cores gains nothing on a CPU-bound loop.

**Accumulation must be thread-safe.** The framework guarantees no shared state of its own, but your lambdas can create some:

```java
List<String> out = new ArrayList<>();
data.parallelStream().forEach(out::add);         // BROKEN: races, lost updates, or AIOOBE
data.parallelStream().collect(toList());         // correct: per-leaf containers, merged by the combiner
```

`collect` is safe *because* the collector contract (Module 12.2) gives every leaf its own container.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++17</strong> attaches parallelism to the <em>algorithm</em>: <code>std::sort(std::execution::par, b, e)</code>. There are four policies — <code>seq</code>, <code>par</code>, <code>par_unseq</code>, <code>unseq</code> — and <code>par_unseq</code> additionally permits vectorisation, so your callable must not lock or allocate. The thread pool is unspecified and implementation-supplied (libstdc++ routes through Intel TBB), and there is no standard way to size or query it.</p>
<p><strong>Java</strong> attaches parallelism to the <em>pipeline</em>, uses one documented, process-wide pool, and has no vectorisation policy — but it does give you a defined splitting protocol (<code>Spliterator</code>) you can implement for your own data structures.</p>
</div>

| Concern | C++17/20 | Java |
| --- | --- | --- |
| Granularity | Per algorithm call | Per pipeline |
| Policies | `seq`, `par`, `unseq`, `par_unseq` | `.parallel()` / `.sequential()` / `.unordered()` |
| Pool | Unspecified, often TBB | `ForkJoinPool.commonPool()`, one per JVM |
| Sizing | Non-standard | `-Djava.util.concurrent.ForkJoinPool.common.parallelism` |
| Data-race rules | Your responsibility; UB if violated | Your responsibility; usually wrong results, not UB |
| Splitting | Iterator ranges, random-access preferred | `Spliterator.trySplit` + characteristics |
| Exception from an element | `std::terminate` for `par` | Propagated from the terminal op |
| Vectorisation | `unseq` policies | None (Vector API is separate and incubating) |

## 8. Edge cases

- **A parallel stream on a 4-element list still submits tasks.** The framework does not fall back below a threshold you control.
- **Exceptions:** one element throwing aborts the pipeline; the exception surfaces from the terminal operation, and other tasks may already have run. Do not assume all-or-nothing.
- **`peek` in parallel** is called from arbitrary threads in arbitrary order — useless for debugging.
- **`Collectors.toMap` in parallel** merges maps in the combiner; a merge function that is not associative gives wrong answers non-deterministically.
- **Stateful lambdas** (a lambda reading or writing something that changes during the run) are documented as producing undefined results, even sequentially.
- **`forEach` order is unspecified even sequentially**, so code that "works" sequentially can break the moment `.parallel()` appears.
- **`sorted()` in parallel** uses a parallel merge sort and allocates a full second array — bounded memory becomes 2× the data.
- **Nested parallel streams** submit into the same pool from a pool thread. It does not deadlock (work-stealing lets threads help), but it does not add parallelism either.
- **`ForkJoinPool.managedBlock`** is the sanctioned way to block inside a pool thread and lets the pool compensate by starting another; almost nobody uses it, and it does not bound the resulting thread count.
- **Determinism:** a correctly written parallel pipeline produces the same *result*, not the same *execution*. If your comparator is not a total order, sequential and parallel can disagree (Phase 9).

## 9. Common mistakes

- `.parallel()` on a small collection, or on trivial per-element work.
- Blocking I/O in a parallel stream, starving the common pool.
- `forEach(sharedList::add)` instead of `collect`.
- Using `findFirst` where `findAny` was meant.
- Expecting `forEach` to print in order.
- Benchmarking a parallel stream in the same JVM run as the sequential one, without JMH, and believing the number.
- Parallelising a `LinkedList` or a `BufferedReader.lines()` pipeline.
- Assuming virtual threads make parallel streams better.
- Leaving `.parallel()` in code because it was faster once on a laptop with 16 idle cores, then deploying to a 2-core container.
- Sizing the common pool for one workload and breaking every other user of it.

## 10. Interview questions

**Beginner** — 1. How do you make a stream parallel? 2. Which pool does it use? 3. Is a parallel stream always faster?

**Intermediate** — 4. What is the default parallelism, and does the calling thread help? 5. Which sources split well and why? 6. Why is `forEach(list::add)` wrong in parallel and `collect` right? 7. `findFirst` versus `findAny` in parallel.

**Advanced** — 8. State the N×Q rule and give the order of magnitude where parallelism starts to pay. 9. What does `SIZED | SUBSIZED` buy the splitter? 10. What does `unordered()` unlock, and for which operations? 11. Why is blocking I/O in a parallel stream a system-wide problem rather than a local one?

**Senior** — 12. A batch job's p99 doubled after an unrelated team added `.parallelStream()` to a library. Explain the mechanism and how you would confirm it. 13. You must parallelise 500 HTTP calls. Argue for the right tool and against parallel streams specifically. 14. Design and justify a `Spliterator` for a custom rope/tree structure so that parallel streams over it split well.

## 11. Follow-ups

- *After Q3:* "Give me a case where it is 50× slower."
- *After Q4:* "Why minus one?"
- *After Q6:* "What exactly goes wrong — exception, or silent corruption?" → both are possible.
- *After Q11:* "Name a supported way to isolate it." → your own executor; the custom-pool trick is unspecified.
- *After Q13:* → bounded executor or virtual threads; the pool is for CPU work, blocking wastes carriers.

## 12. Exercise

1. JMH: sum of `x * x` over `int[]` at N = 100, 10 000, 1 000 000, 100 000 000, sequential versus parallel. Find the crossover on your machine and explain it with N×Q.
2. Same benchmark with `ArrayList<Integer>`, `LinkedList<Integer>`, and `IntStream.range`. Explain the three curves in terms of splitting.
3. Write a parallel pipeline that calls `Thread.sleep(50)` per element on 100 elements. Simultaneously run a second, unrelated parallel stream in another thread and measure *its* latency. Then repeat with a dedicated executor.
4. Show a `forEach(list::add)` failure: run it 100 times on 100 000 elements and report the distribution of resulting sizes and any exceptions.
5. Implement `Spliterator` for a binary tree with a real `trySplit` (hand off one subtree) and compare parallel throughput against the default `Spliterators.spliteratorUnknownSize` wrapper.

## 13. Output prediction

```java
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.*;

public class Main {
    public static void main(String[] args) throws Exception {
        System.out.println(ForkJoinPool.getCommonPoolParallelism() + " " +
                           Runtime.getRuntime().availableProcessors());

        List<Integer> src = IntStream.rangeClosed(1, 6).boxed().toList();

        System.out.println(src.parallelStream().reduce(0, Integer::sum));
        System.out.println(src.parallelStream().reduce(0, (a, b) -> a - b));   // think first
        System.out.println(src.stream().reduce(0, (a, b) -> a - b));

        System.out.println(src.parallelStream().map(String::valueOf)
                              .collect(Collectors.joining()));

        List<Integer> bad = new ArrayList<>();
        try { src.parallelStream().forEach(bad::add); }
        catch (Exception e) { System.out.println("threw " + e.getClass().getSimpleName()); }
        System.out.println("size " + bad.size());

        System.out.println(src.parallelStream().filter(x -> x > 2).findAny().isPresent());
        System.out.println(src.parallelStream().filter(x -> x > 2).findFirst().get());

        System.out.println(Stream.iterate(1, i -> i + 1).parallel().limit(5).toList());

        var stats = IntStream.range(0, 1000).parallel().summaryStatistics();
        System.out.println(stats.getSum() + " " + stats.getCount());
    }
}
```

## 14. Mastery check

1. Describe the three phases of parallel stream execution and the three costs each imposes.
2. State the N×Q rule and give the threshold order of magnitude.
3. Rank six sources by splitting quality and justify the top and the bottom.
4. What does `SIZED | SUBSIZED` guarantee, and what does its absence do to the task tree?
5. Which operations get more expensive when the stream is ordered? Name five.
6. Explain what `unordered()` enables, including its interaction with `CONCURRENT` collectors.
7. Why is `collect` safe in parallel when `forEach(list::add)` is not?
8. Explain, in terms of the common pool, why blocking I/O in a parallel stream degrades unrelated code.
9. What is the custom-pool trick, why does it work, and why should you not rely on it?
10. Why do virtual threads not improve parallel streams?
