---
title: "CompletableFuture, ForkJoin, and virtual threads"
phase: 24
order: 4
minutes: 55
summary: "Composing asynchronous work without blocking, how work-stealing divides recursive tasks, and how virtual threads make one-thread-per-request correct again."
tags: ["completablefuture", "forkjoin", "work-stealing", "virtual-threads", "structured-concurrency"]
---

## 1. `CompletableFuture`

`Future` can only be polled or blocked on (Module 24.1 §4). `CompletableFuture` adds **composition**: you describe what happens *after*, and never block.

```java
CompletableFuture<User>  u = CompletableFuture.supplyAsync(() -> loadUser(id), pool);
CompletableFuture<Void>  r = CompletableFuture.runAsync(() -> audit(id), pool);
CompletableFuture<String> done = CompletableFuture.completedFuture("cached");

var manual = new CompletableFuture<String>();     // complete it yourself from a callback
callbackApi.onResult(manual::complete, manual::completeExceptionally);
```

**The four transformation shapes**, and choosing between them is the whole API:

```java
f.thenApply(user -> user.name())              // T -> U          (like Stream.map)
f.thenAccept(user -> log(user))               // T -> void
f.thenRun(() -> log("done"))                  // ignores the value
f.thenCompose(user -> loadOrders(user))       // T -> CompletableFuture<U>   (like flatMap)
f.thenCombine(other, (a, b) -> merge(a, b))   // two INDEPENDENT futures -> one value
```

**`thenApply` versus `thenCompose` is the standard question.** If your function returns a future, `thenApply` gives you `CompletableFuture<CompletableFuture<U>>`; `thenCompose` flattens it. Identical to `map` versus `flatMap` (Modules 12.1, 13.1).

**Combining many:**

```java
CompletableFuture.allOf(f1, f2, f3);       // CompletableFuture<Void> — completes when ALL do
CompletableFuture.anyOf(f1, f2, f3);       // CompletableFuture<Object> — the FIRST to complete

// allOf gives you no values, so the idiom is:
var futures = ids.stream().map(id -> supplyAsync(() -> load(id), pool)).toList();
CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new))
        .thenApply(v -> futures.stream().map(CompletableFuture::join).toList());
        //             ^ safe: every future is already complete here
```

## 2. Which thread runs the callback?

The most commonly misunderstood part of the API. Every method has three forms:

```java
f.thenApply(fn)                 // runs on the thread that COMPLETED f — or the caller, if already done
f.thenApplyAsync(fn)            // runs on ForkJoinPool.commonPool()
f.thenApplyAsync(fn, executor)  // runs on YOUR executor
```

The non-`Async` form is a trap in two directions:

- If `f` is already complete when you attach the stage, **your calling thread runs it** — synchronously, inline.
- If it is not, **the completing thread runs it** — so a slow callback delays whatever thread completed the future, which may be an I/O callback thread or a single-threaded event loop.

And the `Async` form with no executor lands on the **common `ForkJoinPool`**, which is the same shared, unbounded-lifetime resource parallel streams use (Module 12.3 §6). **Blocking there starves the whole JVM.**

> **The rule: for anything that blocks, always pass an explicit executor.**

**Exception handling** has three shapes:

```java
f.exceptionally(ex -> fallbackValue)                  // recover: only runs on failure
f.handle((value, ex) -> ex != null ? fallback : value)// always runs, sees both, can transform
f.whenComplete((value, ex) -> log(value, ex))         // always runs, CANNOT change the result
f.exceptionallyCompose(ex -> retryAsync())            // Java 12: recover with another future
```

Exceptions propagate down the chain wrapped in `CompletionException`, so `handle`'s `ex` is usually a wrapper — `ex.getCause()` is your exception. `join()` throws the unchecked `CompletionException`; `get()` throws the checked `ExecutionException`. That is the only real difference between them.

**Timeouts** arrived in Java 9:

```java
f.orTimeout(2, TimeUnit.SECONDS);              // completes exceptionally with TimeoutException
f.completeOnTimeout(fallback, 2, SECONDS);     // completes normally with a fallback
```

Neither **cancels** the underlying work — the task keeps running and keeps its thread. `cancel(true)` on a `CompletableFuture` does not interrupt the running task either; it only completes the future exceptionally. This surprises people coming from `Future`.

```java
// A realistic composed call graph: two parallel fetches, then a dependent one, with a fallback
CompletableFuture<Profile> profile =
    supplyAsync(() -> users.find(id), ioPool)
        .thenCombineAsync(supplyAsync(() -> prefs.find(id), ioPool),
                          Profile::new, cpuPool)
        .thenComposeAsync(p -> supplyAsync(() -> enrich(p), ioPool), ioPool)
        .orTimeout(2, SECONDS)
        .exceptionally(ex -> Profile.degraded(id));
```

## 3. `ForkJoinPool` and work-stealing

**[JDK]** `ForkJoinPool` targets **recursive divide-and-conquer**: split until the pieces are small, solve, merge.

```java
class SumTask extends RecursiveTask<Long> {
    private static final int THRESHOLD = 10_000;          // tune this; too small = overhead
    private final long[] data; private final int lo, hi;

    @Override protected Long compute() {
        if (hi - lo <= THRESHOLD) {                        // base case: solve directly
            long s = 0; for (int i = lo; i < hi; i++) s += data[i]; return s;
        }
        int mid = (lo + hi) >>> 1;
        var left  = new SumTask(data, lo, mid);
        left.fork();                                       // queue the left half for stealing
        var right = new SumTask(data, mid, hi);
        long r = right.compute();                          // compute the right half HERE
        return r + left.join();                            // then join the left
    }
}
```

The `fork()` one half, `compute()` the other, `join()` shape is the canonical form — forking **both** halves and joining both wastes a task and performs measurably worse.

**Work-stealing** is why it scales. Each worker has its own **double-ended queue**:

```text
Worker's own tasks:  pushed and popped at the HEAD (LIFO)
                     -> the most recently forked task is still cache-hot, and LIFO keeps the
                        recursion depth-first, bounding memory

Stealing:            an idle worker takes from the TAIL of another's deque (FIFO)
                     -> the oldest task is the LARGEST piece of work, so one steal buys a lot,
                        and head/tail contention is minimised
```

That LIFO-own / FIFO-steal asymmetry is the whole trick, and it is exactly what an interviewer is looking for.

`join()` does not block the worker idly: if the joined task is not done, the worker **helps** — running that task itself if it is still queued, or stealing other work. This is why a fork/join pool with 8 threads does not deadlock when 10 000 tasks join each other.

**When not to use it:** anything that blocks. A worker blocked on I/O cannot help, cannot steal, and cannot be stolen from. `ForkJoinPool.managedBlock` lets the pool compensate by starting a replacement thread, but it does not bound the resulting thread count, and almost nobody uses it correctly.

## 4. Virtual threads

**[JDK]** Java 21, JEP 444. The problem: the I/O-bound pool-sizing formula (Module 24.1 §6) demands hundreds or thousands of threads, and a platform thread costs ~1 MB of stack reservation and ~1 ms to create. That ceiling is why the industry moved to callbacks and reactive frameworks — trading readable, debuggable sequential code for throughput.

A **virtual thread** is a `Thread` scheduled by the JVM onto a small pool of **carrier** platform threads.

```java
Thread v = Thread.ofVirtual().name("req-", 1).start(() -> handle(request));

try (var exec = Executors.newVirtualThreadPerTaskExecutor()) {
    for (var task : tasks) exec.submit(task);     // a million tasks is fine
}
```

The mechanism:

```text
MOUNT     the virtual thread's continuation runs on a carrier platform thread
BLOCK     it calls something that blocks (socket read, sleep, BlockingQueue.take, lock)
UNMOUNT   the JVM copies its stack to the heap and FREES the carrier
          -> the carrier immediately runs another virtual thread
READY     the I/O completes; the scheduler remounts the continuation on some carrier
```

The carrier pool is a dedicated `ForkJoinPool` sized to `availableProcessors()` by default (`jdk.virtualThreadScheduler.parallelism`).

| | Platform thread | Virtual thread |
| --- | --- | --- |
| Cost to create | ~1 ms, ~1 MB stack reserved | ~1 µs, a few hundred bytes, grows on the heap |
| Practical count | thousands | **millions** |
| Scheduled by | The OS | The JVM |
| Blocking cost | An OS thread is idle | The carrier is released |
| Pooling | Essential | **Never pool them** — creation is the cheap part |
| `ThreadLocal` | Fine | Works, but per-thread state × 1 M is a footprint problem |
| Best for | CPU-bound work | Blocking I/O |
| `synchronized` | Fine | See pinning, below |

**Pinning** is the one thing you must know. A virtual thread that cannot unmount **blocks its carrier**:

- **Inside a `synchronized` block or method** — the monitor is tied to the carrier. **[JDK]** **JEP 491 (Java 24) fixed this**, so on 24+ `synchronized` no longer pins. On 21–23 it does, and a pool of carriers can be exhausted by a handful of virtual threads blocking inside `synchronized`.
- **Inside a native frame** (JNI). Still pins, on every version.

On 21–23 the mitigation is to replace `synchronized` with `ReentrantLock` on any path that blocks, and to detect the problem with `-Djdk.tracePinnedThreads=full`.

**Virtual threads are not faster; they are more numerous.** They do nothing for CPU-bound work — you still have the same cores, and a parallel stream over a virtual-thread executor gains nothing (Module 12.3 §6). Their entire value is letting you write **blocking, sequential, debuggable code** at a concurrency level that previously required callbacks.

```java
// This is now a reasonable way to serve a million connections.
try (var exec = Executors.newVirtualThreadPerTaskExecutor()) {
    while (true) {
        var socket = server.accept();
        exec.submit(() -> {                 // ordinary blocking code
            try (socket) { handle(socket); }
            return null;
        });
    }
}
```

## 5. Structured concurrency

**[JDK]** A preview API (JEP 453 and successors) that makes concurrent subtasks obey the same lexical scoping as a block: **if a task splits into subtasks, they all complete before the block exits.**

```java
// Preview API — the exact shape has changed between releases; the concept has not.
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Supplier<User>  user  = scope.fork(() -> findUser(id));
    Supplier<Order> order = scope.fork(() -> findOrder(id));

    scope.join();                 // wait for both
    scope.throwIfFailed();        // propagate the first failure

    return new Response(user.get(), order.get());
}   // on exit: every subtask is done or CANCELLED — no leaks, no orphans
```

What it fixes about the `CompletableFuture` model:

- **No leaked tasks.** If the block exits — normally, by exception, or by cancellation — every subtask is cancelled. With an executor, a forgotten future keeps running.
- **Cancellation propagates.** `ShutdownOnFailure` cancels the siblings the moment one fails; `ShutdownOnSuccess` cancels them when one succeeds.
- **Stack traces make sense.** The subtask's trace shows the forking frame, because the relationship is real, not a queue handoff.

**Scoped values** (the companion preview) replace `ThreadLocal` for this model: immutable, explicitly bounded to a dynamic scope, and automatically inherited by forked subtasks — which matters when you have a million threads and per-thread mutable maps are unaffordable.

## 6. Choosing between them

```text
One-off async call, no composition           -> executor.submit + Future
A pipeline of dependent async steps          -> CompletableFuture
Recursive CPU-bound divide-and-conquer       -> ForkJoinPool / parallel streams
Many concurrent BLOCKING operations          -> virtual threads
A block that fans out and must not leak      -> StructuredTaskScope (preview)
```

**Virtual threads have made a lot of `CompletableFuture` code unnecessary.** Three sequential HTTP calls written as a `thenCompose` chain, purely to avoid blocking a pooled thread, can now be three blocking calls on a virtual thread — shorter, debuggable, with a real stack trace. Keep `CompletableFuture` where you genuinely need **fan-out with composition** or where you are integrating a callback-based API.

## 7. What happens internally

**[JDK]** `CompletableFuture` holds a `volatile Object result` and a **Treiber stack** of dependent `Completion` nodes, all manipulated with CAS — it is lock-free. Completing the future pops the stack and fires each dependent, either on the completing thread (non-`Async`) or by submitting to an executor (`Async`). Deep chains are unrolled iteratively to avoid stack overflow.

**[HotSpot]** A virtual thread's stack is a **`Continuation`** — a heap-allocated object holding the frames. Unmounting copies the stack frames from the carrier's native stack into the continuation; mounting copies them back. HotSpot uses lazy copying so only the frames actually needed are moved, which is why the cost is on the order of a microsecond rather than a full stack copy. This is the same continuation machinery Loom built for structured concurrency.

Virtual thread stack traces show only Java frames and are typically **shorter and more readable** than reactive stack traces, because there is no scheduler machinery interleaved.

**JFR** has dedicated events: `jdk.VirtualThreadStart`, `jdk.VirtualThreadPinned`, `jdk.VirtualThreadSubmitFailed`. Pinning shows up there, which is the production way to find it.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong><code>std::async</code> + <code>std::future</code></strong> is the rough analogue of <code>Future</code>, and it is notoriously limited: no continuations, no combinators, and a destructor that <em>blocks</em> for <code>launch::async</code> futures. <code>std::future::then</code> has been proposed for a decade and is not in the standard; in practice C++ codebases use folly, Seastar, or a hand-rolled executor library. Java's <code>CompletableFuture</code> is a considerably richer standard offering.</p>
<p><strong>C++20 coroutines</strong> are the analogue of virtual threads, and the difference is <strong>stackless versus stackful</strong>. A C++ coroutine's frame is heap-allocated by the compiler and holds only what survives a suspension point; suspension is explicit (<code>co_await</code>) and <em>viral</em> — a function that awaits must itself be a coroutine, so async-ness colours your whole call graph. A Java virtual thread is <strong>stackful</strong>: the entire stack moves to the heap, suspension is implicit at any blocking call, and <strong>ordinary blocking code needs no changes at all</strong>. That is the point of the design: no <code>async</code>/<code>await</code> keywords, no function colouring, and existing libraries work unmodified.</p>
<p><strong>Work-stealing</strong> has no standard C++ equivalent; Intel TBB and HPX provide it, with the same LIFO-own/FIFO-steal deques.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Future | `std::future` — no continuations | `CompletableFuture` — full composition |
| Chaining | Library (folly, Seastar) | `thenApply`/`thenCompose`/`thenCombine` |
| Combine many | `when_all` (folly) | `allOf` / `anyOf` |
| Lightweight concurrency | Coroutines (C++20), **stackless** | Virtual threads, **stackful** |
| Suspension | Explicit `co_await` | Implicit, at any blocking call |
| Function colouring | Yes — async is viral | **No** |
| Existing blocking libraries | Must be rewritten | Work as-is |
| Scheduler | You supply one | The JVM's, on a carrier `ForkJoinPool` |
| Work-stealing | TBB, HPX | `ForkJoinPool` |
| Structured concurrency | Proposals; `jthread` + `stop_token` partially | `StructuredTaskScope` (preview) |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Pooling virtual threads. They are the <em>task</em>, not the resource — creating one is cheaper than borrowing one, and a pool reintroduces exactly the limit they remove. Use <code>newVirtualThreadPerTaskExecutor</code>, or a <code>Semaphore</code> if you need to bound concurrency against a downstream system.</p>
<p>Expecting virtual threads to speed up computation. They add no cores. A CPU-bound workload on a million virtual threads is slower than on <code>N_cpu</code> platform threads, because of scheduling overhead.</p>
</div>

## 9. Edge cases

- **`join()` throws `CompletionException`; `get()` throws `ExecutionException`.** Both wrap the cause.
- **A non-`Async` stage attached to an already-complete future runs on the calling thread**, synchronously — so `thenApply` can block the caller.
- **`allOf(...)` completes exceptionally if any input does**, but the other futures keep running.
- **`cancel(true)` on a `CompletableFuture` does not interrupt anything** — unlike `FutureTask`.
- **`orTimeout` does not cancel the work.**
- **An exception in a `whenComplete` action replaces the result**, quietly, if the original completed normally.
- **`fork()` from a non-ForkJoin thread** submits to the common pool rather than a worker deque.
- **A too-small fork/join threshold** makes task overhead dominate; there is no automatic tuning.
- **`ForkJoinPool.commonPool()` has parallelism `availableProcessors() - 1`** and returns a pool with parallelism 0 on a single-core machine, where everything runs on the caller.
- **Virtual threads are always daemon threads** and their priority cannot be changed.
- **`Thread.currentThread()` inside a virtual thread returns the virtual thread**, not the carrier — but `synchronized` on 21–23 still pins the carrier.
- **Thread dumps for virtual threads** need `jcmd <pid> Thread.dump_to_file -format=json`; a classic `jstack` does not list them.

## 10. Common mistakes

- Blocking on the common `ForkJoinPool` via `supplyAsync` with no executor.
- `thenApply` where `thenCompose` is needed, producing a nested future.
- Ignoring the exception path entirely — a failed stage that nothing handles is silent.
- Calling `join()` in the middle of a chain, turning async code back into blocking code.
- Assuming `orTimeout` or `cancel` stops the underlying work.
- Forking both halves in a `RecursiveTask` instead of forking one and computing the other.
- Blocking inside a fork/join task.
- Pooling virtual threads.
- Leaving `synchronized` around blocking calls on Java 21–23 and pinning carriers.
- Using virtual threads for CPU-bound work.
- Keeping large `ThreadLocal` state with a million virtual threads.

## 11. Interview questions

**Beginner** — 1. What does `CompletableFuture` add over `Future`? 2. What is a virtual thread? 3. What is work-stealing?

**Intermediate** — 4. `thenApply` versus `thenCompose`. 5. Which thread runs a `thenApply` callback? 6. How do you handle an exception in a chain — name three methods and their differences. 7. Why should you never pool virtual threads?

**Advanced** — 8. Explain the LIFO-own / FIFO-steal deque design and why each half is chosen. 9. What happens when a virtual thread blocks — mount, unmount, and what moves where? 10. What is pinning, what causes it, and what changed in Java 24? 11. Why is `allOf` typed `CompletableFuture<Void>` and what is the idiom to get the values?

**Senior** — 12. Compare virtual threads with reactive programming: what each buys, what each costs, and when you would still choose reactive. 13. Design a service making 5 downstream calls with per-call timeouts, a partial-failure policy, and no thread leaks — on Java 17, and again on Java 21. 14. Explain stackful versus stackless coroutines and why Java chose stackful.

## 12. Follow-ups

- *After Q2:* "What does it cost, and how many can you have?"
- *After Q5:* "What if the future is already complete?"
- *After Q7:* "Then how do you bound concurrency against a database?" → a `Semaphore`.
- *After Q9:* "Where does the stack live while unmounted?"
- *After Q12:* → reactive still wins for backpressure-heavy streaming pipelines.

## 13. Exercise

1. Build a five-call fan-out with `CompletableFuture`: two parallel, one dependent, one with a timeout and fallback, one fire-and-forget. Then rewrite it with virtual threads and blocking calls. Compare line count, stack traces on failure, and p99 latency.
2. Prove the common-pool trap: a `supplyAsync` chain doing blocking I/O with no executor, while a parallel stream runs elsewhere. Measure the stream's latency, then pass an executor and re-measure.
3. Implement `SumTask` with fork/join. Sweep the threshold from 100 to 10 000 000 and plot throughput. Then implement it forking both halves and explain the regression.
4. On Java 21, write a virtual-thread task that blocks inside `synchronized`. Run with `-Djdk.tracePinnedThreads=full`, capture the pinning, and fix it with `ReentrantLock`. If you are on 24+, verify the behaviour changed.
5. Create 1 000 000 virtual threads each sleeping 1 second, and measure wall time and peak RSS. Then attempt the same with platform threads and record where it fails.

## 14. Output prediction

```java
import java.util.*;
import java.util.concurrent.*;
import static java.util.concurrent.CompletableFuture.*;

public class Main {
    public static void main(String[] args) throws Exception {
        var f = supplyAsync(() -> 21).thenApply(x -> x * 2);
        System.out.println(f.get() + " " + f.isDone());

        var done = completedFuture("ready");
        done.thenApply(s -> { System.out.println("on " + Thread.currentThread().getName()); return s; }).join();

        CompletableFuture<CompletableFuture<Integer>> nested =
                completedFuture(1).thenApply(x -> completedFuture(x + 1));
        System.out.println(nested.join().join());
        System.out.println(completedFuture(1).thenCompose(x -> completedFuture(x + 1)).join());

        var boom = CompletableFuture.<Integer>supplyAsync(() -> { throw new IllegalStateException("x"); });
        System.out.println(boom.exceptionally(ex -> -1).join());
        System.out.println(boom.handle((v, ex) -> ex == null ? v : -2).join());
        try { boom.join(); } catch (Exception e) {
            System.out.println(e.getClass().getSimpleName() + " / " + e.getCause().getClass().getSimpleName());
        }
        try { boom.get(); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var a = supplyAsync(() -> "a");
        var b = supplyAsync(() -> "b");
        System.out.println(a.thenCombine(b, (x, y) -> x + y).join());
        System.out.println(allOf(a, b).join());
        System.out.println(anyOf(a, b).join() != null);

        var slow = supplyAsync(() -> { try { Thread.sleep(500); } catch (Exception e) {} return "slow"; });
        System.out.println(slow.completeOnTimeout("fallback", 100, TimeUnit.MILLISECONDS).join());
        Thread.sleep(600);

        Thread v = Thread.ofVirtual().unstarted(() -> {});
        System.out.println(v.isVirtual() + " " + v.isDaemon());

        var counter = new java.util.concurrent.atomic.AtomicInteger();
        try (var exec = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 10_000; i++)
                exec.submit(() -> { try { Thread.sleep(10); } catch (Exception e) {} counter.incrementAndGet(); });
        }
        System.out.println(counter.get());

        System.out.println(ForkJoinPool.commonPool().getParallelism());
    }
}
```

## 15. Mastery check

1. Name the five `CompletableFuture` transformation methods and the shape of each.
2. Explain `thenApply` versus `thenCompose` with the type that goes wrong.
3. Give the three execution-thread rules for `thenX`, `thenXAsync`, and `thenXAsync(exec)`.
4. Compare `exceptionally`, `handle`, and `whenComplete` on when they run and what they can change.
5. What do `orTimeout` and `cancel` actually do, and what do they not do?
6. Write the canonical `RecursiveTask.compute()` and say why forking both halves is worse.
7. Explain the LIFO-own / FIFO-steal deque design and the reason for each half.
8. Describe mount, block, unmount and remount for a virtual thread, and where the stack lives.
9. Define pinning, name both causes, and say what Java 24 changed.
10. Explain stackful versus stackless coroutines and what Java's choice bought.
