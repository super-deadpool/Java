---
title: "Threads and executors: lifecycle, interruption, and pool sizing"
phase: 24
order: 1
minutes: 50
summary: "Thread states and the cooperative interruption protocol, why the Executors factory methods are dangerous, the seven ThreadPoolExecutor parameters, and the two ways submit() silently swallows your exceptions."
tags: ["thread", "interrupt", "executorservice", "threadpoolexecutor", "future", "pool-sizing"]
---

## 1. Creating a thread

```java
// 1. Implement Runnable — preferred: the task is not the thread
Thread t = new Thread(() -> doWork(), "worker-1");    // ALWAYS name your threads
t.start();                                             // start() creates an OS thread and calls run()
t.run();                                               // BUG: runs on the CURRENT thread, no concurrency

// 2. Extend Thread — couples the task to the mechanism, wastes your one superclass
class Worker extends Thread { @Override public void run() { doWork(); } }

// 3. Java 21+: virtual threads (Module 24.4)
Thread v = Thread.ofVirtual().name("req-1").start(() -> doWork());
```

Naming threads is not cosmetic: a thread dump full of `pool-1-thread-7` tells you nothing, and a production incident is exactly when you need to know which pool is stuck.

| Property | Effect |
| --- | --- |
| `setDaemon(true)` | The JVM exits when only daemon threads remain. Must be set **before** `start()` |
| `setPriority(1..10)` | A **hint**; most OSes largely ignore it. Do not build anything on it |
| `setUncaughtExceptionHandler` | Where an escaping exception goes; otherwise the thread dies printing to stderr |
| `join()` / `join(ms)` | Block until the thread terminates |

## 2. Thread states

**[JDK]** `Thread.State` has six values, and distinguishing `BLOCKED` from `WAITING` is the core skill of reading a thread dump.

```text
            start()                  scheduler
   NEW ─────────────► RUNNABLE ◄──────────────► (running on a CPU)
                       │  ▲  ▲
   synchronized (busy) │  │  │ notify/notifyAll, unpark, join returns, timeout
                       ▼  │  │
                    BLOCKED│  │
                           │  │
   wait()/join()/park() ───┴──┤
                    WAITING    │
   wait(t)/sleep(t)/join(t) ───┘
                 TIMED_WAITING
                       │
                       ▼
                  TERMINATED
```

| State | Means | In a thread dump |
| --- | --- | --- |
| `RUNNABLE` | Executing, **or blocked in a syscall** (the JVM cannot tell) | A thread stuck in `socketRead0` shows as RUNNABLE |
| `BLOCKED` | Waiting to acquire a **monitor** (`synchronized`) | `waiting to lock <0x...>` — deadlock candidate |
| `WAITING` | `Object.wait()`, `Thread.join()`, `LockSupport.park()` | `parking to wait for <0x...>` |
| `TIMED_WAITING` | The same with a timeout, or `Thread.sleep` | |
| `TERMINATED` | `run()` returned or threw | |

`RUNNABLE` covering "blocked on I/O" is the detail that catches people: a thread dump showing 200 RUNNABLE threads may be 200 threads waiting on a database.

## 3. Interruption — the only correct cancellation mechanism

Java has **no way to forcibly stop a thread**. `Thread.stop()` was deprecated in 1.2 and **removed** (it released monitors mid-update, leaving objects in inconsistent states); `suspend`/`resume` are deprecated for deadlock. What remains is **cooperative**.

```java
t.interrupt();                              // sets the thread's interrupt FLAG
Thread.currentThread().isInterrupted();     // reads it, does NOT clear
Thread.interrupted();                       // reads AND CLEARS — a static, easy to misuse
```

The protocol has two halves. A **blocking method** (`sleep`, `wait`, `join`, `BlockingQueue.take`, `Future.get`, `Lock.lockInterruptibly`) throws `InterruptedException` **and clears the flag**. A **computational loop** must poll the flag itself.

```java
// Blocking work
while (running) {
    try { queue.take(); }
    catch (InterruptedException e) {
        Thread.currentThread().interrupt();     // RESTORE the flag — it was cleared by the throw
        break;                                  // then actually stop
    }
}

// CPU-bound work: nothing throws, so you must check
while (!Thread.currentThread().isInterrupted()) { computeOneChunk(); }
```

**The single most common concurrency defect in Java code:**

```java
try { Thread.sleep(100); }
catch (InterruptedException e) { }            // swallowed: the thread is now uninterruptible
catch (InterruptedException e) { e.printStackTrace(); }   // equally wrong
```

The rule: **either propagate `InterruptedException`, or restore the flag.** Never just log it. Code that swallows it makes the whole shutdown path unreliable, because the signal is gone and no caller up the stack can see it.

## 4. `ExecutorService`

Threads are not the abstraction you want; **tasks** are.

```java
ExecutorService pool = Executors.newFixedThreadPool(8);

pool.execute(runnable);                          // fire and forget — an exception reaches the
                                                 // UncaughtExceptionHandler
Future<String> f = pool.submit(callable);        // an exception is CAPTURED in the Future
String s = f.get();                              // blocks; throws ExecutionException wrapping the cause

List<Future<T>> all = pool.invokeAll(tasks);     // blocks until all complete
T first = pool.invokeAny(tasks);                 // first successful result; cancels the rest
```

**`submit` versus `execute` is a real trap.** A `Runnable` passed to `submit` returns a `Future`; if the task throws and nobody calls `get()`, **the exception vanishes** — no log, no handler, no stack trace. A task that silently stops running is usually this.

```java
pool.execute(() -> { throw new RuntimeException("seen"); });   // printed by the default handler
pool.submit (() -> { throw new RuntimeException("lost"); });   // silent, unless you call get()
```

The fix is to make every task catch its own throwables, or to override `ThreadPoolExecutor.afterExecute`.

**`Future`'s limitations** are why `CompletableFuture` exists (Module 24.4): `get()` blocks, there is no callback, no composition, and no way to combine two futures without blocking on one of them.

```java
f.cancel(true);       // interrupt the running thread if started
f.cancel(false);      // only prevent it from starting
f.isDone(); f.isCancelled();
f.get(5, TimeUnit.SECONDS);     // TimeoutException — does NOT cancel the task
```

## 5. `ThreadPoolExecutor` — the seven parameters

**[JDK]** The `Executors` factory methods are convenient and **two of them are actively dangerous**:

```java
Executors.newFixedThreadPool(n);      // queue is an UNBOUNDED LinkedBlockingQueue
                                      //   -> a slow consumer grows the queue until OutOfMemoryError
Executors.newCachedThreadPool();      // maximumPoolSize = Integer.MAX_VALUE, SynchronousQueue
                                      //   -> a burst creates unbounded threads until the OS refuses
Executors.newSingleThreadExecutor();  // same unbounded queue problem
```

Build the pool explicitly and choose every bound:

```java
var pool = new ThreadPoolExecutor(
    8,                                     // 1. corePoolSize   — kept alive even when idle
    16,                                    // 2. maximumPoolSize — only reached when the QUEUE IS FULL
    60L, TimeUnit.SECONDS,                 // 3-4. keepAliveTime for threads above core
    new ArrayBlockingQueue<>(1000),        // 5. workQueue — BOUNDED, always
    new ThreadFactoryBuilder()             // 6. threadFactory — naming, daemon, UEH
            .setNameFormat("ingest-%d").build(),
    new ThreadPoolExecutor.CallerRunsPolicy());  // 7. rejection handler — backpressure
```

**The sizing algorithm is not what most people assume:**

```text
1. A task arrives. If threads < corePoolSize     -> create a new thread. (Even if others are idle.)
2. Otherwise                                     -> try to ENQUEUE it.
3. If the queue is FULL and threads < maximum    -> create a new thread.
4. If the queue is full and threads == maximum   -> REJECT (the rejection handler runs).
```

Step 2 before step 3 is the crucial ordering: **with an unbounded queue, `maximumPoolSize` is never reached** — the pool never grows past core, and the queue grows forever instead. That is exactly the `newFixedThreadPool` failure.

**Rejection policies:**

| Policy | Behaviour |
| --- | --- |
| `AbortPolicy` (default) | Throws `RejectedExecutionException` |
| **`CallerRunsPolicy`** | The submitting thread runs the task — **natural backpressure**, because the producer stops producing |
| `DiscardPolicy` | Silently drops it |
| `DiscardOldestPolicy` | Drops the oldest queued task and retries |

`CallerRunsPolicy` is usually the right default for an ingest pipeline: it throttles the producer instead of failing or losing work.

## 6. Pool sizing

Two formulas, both from Little's law:

```text
CPU-bound:   threads ≈ N_cpu + 1          (the +1 covers an occasional page fault)

I/O-bound:   threads ≈ N_cpu × U × (1 + W/C)
                 U = target CPU utilisation (0..1)
                 W = wait time per task, C = compute time per task
```

For a task that waits 90 ms on a database and computes for 10 ms, `W/C = 9`, so on 8 cores at full utilisation that is `8 × 1 × 10 = 80` threads. That number is why I/O-heavy services historically ran hundreds of threads — and why **virtual threads** (Module 24.4) change the whole calculation.

The other rules:

- **Separate pools for separate work.** One pool shared between fast CPU work and slow HTTP calls means the slow work starves the fast work. This is the same failure as blocking the common `ForkJoinPool` (Module 12.3 §6).
- **Never size a pool from `availableProcessors()` alone in a container** without confirming the JVM sees the cgroup limit (it does since Java 10, but check).
- **Measure queue depth**, not just thread count. A pool whose queue is never empty is undersized; one whose queue is always empty may be oversized.

## 7. Scheduled execution

```java
var sched = Executors.newScheduledThreadPool(2);

sched.schedule(task, 5, TimeUnit.SECONDS);                        // once
sched.scheduleAtFixedRate(task, 0, 1, TimeUnit.MINUTES);          // start-to-start
sched.scheduleWithFixedDelay(task, 0, 1, TimeUnit.MINUTES);       // end-to-start
```

`scheduleAtFixedRate` measures from the *start* of each run: if a run takes longer than the period, the next starts immediately and runs can bunch up (they never overlap — a single task is not run concurrently with itself). `scheduleWithFixedDelay` measures from the *end*, so there is always a real gap.

**The trap that costs people days:** if a scheduled task throws, **the schedule is cancelled silently.** No log, no exception, the job simply stops running forever.

```java
sched.scheduleAtFixedRate(() -> {
    try { doWork(); }
    catch (Throwable t) { log.error("scheduled task failed", t); }   // MANDATORY
}, 0, 1, TimeUnit.MINUTES);
```

## 8. Shutdown

```java
pool.shutdown();                                     // no new tasks; queued tasks still run
if (!pool.awaitTermination(30, TimeUnit.SECONDS)) {
    List<Runnable> never = pool.shutdownNow();       // interrupt running tasks, drain the queue
    pool.awaitTermination(10, TimeUnit.SECONDS);
}
```

`shutdownNow` **interrupts** running tasks — which does nothing to a task that swallows `InterruptedException` (§3). The two halves of this module connect exactly here: correct shutdown requires correct interruption handling all the way down.

**[JDK]** Since Java 19 `ExecutorService` is `AutoCloseable`, and `close()` is `shutdown()` plus an uninterruptible `awaitTermination`:

```java
try (var pool = Executors.newFixedThreadPool(8)) {
    pool.submit(task);
}   // blocks here until every task completes
```

## 9. What happens internally

**[HotSpot]** A platform `Thread` is a 1:1 wrapper over an OS thread — `pthread_create` on Linux. That means:

- **Creation costs ~1 ms** and a stack reservation (`-Xss`, default ~1 MB of address space).
- **Context switching costs ~1–10 µs** and flushes cache lines.
- **Scheduling is the OS's**, not the JVM's. Priorities are advisory.

Those three facts are the entire justification for thread pools: amortise creation, bound the count, and keep the OS scheduler's runnable set small.

**`ThreadPoolExecutor` internals:** worker threads run a loop of `getTask()` (a blocking `poll`/`take` on the queue) then `task.run()`. Pool state and worker count are packed into a **single `AtomicInteger`** (3 bits of state, 29 bits of count) so both can be updated in one CAS. `beforeExecute`/`afterExecute`/`terminated` are protected hooks — `afterExecute` is where you add uniform exception logging, and it receives the `Throwable` only for `execute`d tasks, so you must also unwrap `FutureTask` results for `submit`ted ones.

**`FutureTask`** is the bridge: it holds the `Callable`, an `AtomicReference`-like state machine, and the result or exception. `get()` parks the caller with `LockSupport.park` until the state becomes terminal.

## 10. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong><code>std::thread</code></strong> must be <code>join()</code>ed or <code>detach()</code>ed before destruction or the program calls <code>std::terminate</code> — an aggressive default that catches the "forgot to join" bug at runtime. <strong><code>std::jthread</code></strong> (C++20) fixes it: it joins in its destructor and carries a <code>std::stop_token</code>, which is the direct analogue of Java's interrupt flag but explicit, type-safe, and passed to the task rather than hidden in the thread.</p>
<p><strong>C++ has no standard thread pool</strong> and no standard executor — <code>std::async</code> with <code>launch::async</code> is the only portable "run this somewhere else", and its <code>future</code> destructor blocks, which surprises everyone. Java's <code>ExecutorService</code>, with its queue, sizing, rejection policy and lifecycle, is a genuinely richer standard library.</p>
<p><strong>Interruption</strong> is the deepest difference. C++ has no way to interrupt a blocked thread at all (POSIX cancellation is not usable portably), so cancellation must be designed in from the start via <code>stop_token</code> plus a condition variable. Java's blocking library methods all respond to <code>interrupt()</code> — which is why swallowing <code>InterruptedException</code> breaks something that would otherwise have worked.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Thread object | `std::thread` / `std::jthread` (C++20) | `Thread` |
| Forgot to join | `std::terminate` | Nothing — it just runs |
| Auto-join | `jthread` destructor | try-with-resources on an `ExecutorService` (19+) |
| Cancellation | `stop_token` (C++20); nothing before | `interrupt()` + `InterruptedException` |
| Interrupt a blocked thread | Not possible portably | Every blocking JDK method responds |
| Thread pool | None standard (TBB, folly, hand-rolled) | `ThreadPoolExecutor` |
| Task result | `std::future` / `promise` / `packaged_task` | `Future` / `CompletableFuture` |
| Exception transport | Stored in the `future`, rethrown by `get()` | `ExecutionException` from `get()` |
| Daemon threads | No concept | `setDaemon(true)` |
| Naming | Platform-specific (`pthread_setname_np`) | `Thread(name)` |
| Lightweight threads | Coroutines (C++20), stackless | Virtual threads (21), stackful |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Catching <code>InterruptedException</code> and moving on, because C++ has no equivalent and it looks like noise. It is a <em>cancellation signal</em>; discarding it makes graceful shutdown impossible and turns <code>shutdownNow()</code> into a no-op.</p>
<p>Using <code>Executors.newFixedThreadPool</code> as the obvious default. Its unbounded queue is a latent <code>OutOfMemoryError</code>; C++ has no such convenience factory precisely because there is no one right answer.</p>
</div>

## 11. Edge cases

- **`t.run()` instead of `t.start()`** silently runs on the caller's thread. It compiles and does the wrong thing.
- **`start()` twice** throws `IllegalThreadStateException`; a `Thread` object is single-use.
- **`setDaemon` after `start()`** throws.
- **`Thread.sleep(0)`** is not a no-op — it is a yield hint on some platforms.
- **`Thread.yield()`** is a hint the OS may ignore entirely.
- **`Future.get(timeout)` throwing `TimeoutException` does not cancel the task** — it keeps running and keeps its thread.
- **`invokeAll` blocks until *all* tasks finish**, including ones you no longer need; it has a timeout overload that cancels the rest.
- **A task submitted to a pool holds a reference to everything it captures** until it completes — a queued task with a large captured payload is retained memory.
- **`ThreadLocal`s survive in pooled threads** (Module 23.2 §5); always `remove()` in a `finally`.
- **An uncaught exception kills only that thread**, and the pool quietly replaces the worker — so a task failing 100% of the time looks like nothing happening.
- **`shutdownNow` returns queued tasks that never ran** — log them, or you have silently lost work.
- **`availableProcessors()` respects cgroup CPU limits** since Java 10, but `-XX:ActiveProcessorCount` overrides it when the container limit is a fractional CPU.

## 12. Common mistakes

- Swallowing `InterruptedException`.
- `Executors.newFixedThreadPool` / `newCachedThreadPool` in production.
- Unnamed threads.
- `submit` for fire-and-forget work, losing every exception.
- No try/catch inside a scheduled task.
- `scheduleAtFixedRate` where `scheduleWithFixedDelay` was meant.
- One shared pool for fast and slow work.
- Never calling `shutdown`, leaving non-daemon threads and a JVM that will not exit.
- Sizing a pool by guesswork instead of `N × (1 + W/C)`.
- Reading a thread dump and assuming `RUNNABLE` means "using CPU".

## 13. Interview questions

**Beginner** — 1. `Runnable` versus `Thread` — which and why? 2. `start()` versus `run()`? 3. What is a daemon thread?

**Intermediate** — 4. Name the six thread states and what distinguishes `BLOCKED` from `WAITING`. 5. How do you stop a thread? 6. `submit` versus `execute`. 7. Why is `newFixedThreadPool` risky?

**Advanced** — 8. Give the seven `ThreadPoolExecutor` parameters and the exact order in which the pool decides to queue versus grow. 9. Why is `maximumPoolSize` ignored with an unbounded queue? 10. What does `interrupt()` actually do, and what must a `catch (InterruptedException)` block do? 11. What happens when a `scheduleAtFixedRate` task throws?

**Senior** — 12. A pool's tasks stopped running overnight with no errors in the log. Give four hypotheses and how to test each. 13. Design the ingest pipeline for 50 k messages/second with bounded memory: pool, queue, rejection policy, shutdown, and metrics. 14. Derive the I/O-bound pool sizing formula and say what virtual threads change about it.

## 14. Follow-ups

- *After Q2:* "What actually happens if you call `run()`?"
- *After Q5:* "Why was `Thread.stop` removed?"
- *After Q6:* "Where does an exception go in each case?"
- *After Q10:* "Which methods clear the flag?"
- *After Q12:* → a throwing scheduled task, a swallowed interrupt, a full queue with `DiscardPolicy`, a deadlocked worker.

## 15. Exercise

1. Write a thread that does CPU work in a loop and one that blocks on a queue. Interrupt both. Make each shut down within 100 ms, and prove it with a test.
2. Build a pool with `newFixedThreadPool(2)` and a producer submitting 10 M tasks faster than they complete. Watch heap grow to `OutOfMemoryError`. Replace it with a bounded queue plus `CallerRunsPolicy` and show the producer throttling instead.
3. Submit a throwing task with `execute` and with `submit`. Show the difference in what reaches the log, then add an `afterExecute` override that logs both uniformly.
4. Schedule a task at a fixed rate that throws on its fifth run. Prove the schedule dies. Fix it and prove it survives.
5. Measure the I/O-bound formula: a task with 90 ms of sleep and 10 ms of computation, at 1, 8, 40, 80 and 400 threads. Plot throughput and find the knee. Then do it with virtual threads.

## 16. Output prediction

```java
import java.util.*;
import java.util.concurrent.*;

public class Main {
    public static void main(String[] args) throws Exception {
        Thread t = new Thread(() -> System.out.println("in " + Thread.currentThread().getName()), "w1");
        t.run();
        t.start();
        t.join();
        System.out.println(t.getState());
        try { t.start(); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        Thread s = new Thread(() -> {
            try { Thread.sleep(5000); System.out.println("slept"); }
            catch (InterruptedException e) { System.out.println("interrupted, flag=" +
                    Thread.currentThread().isInterrupted()); }
        });
        s.start(); Thread.sleep(50); s.interrupt(); s.join();

        Thread c = new Thread(() -> {
            long n = 0;
            while (!Thread.currentThread().isInterrupted()) n++;
            System.out.println("loop exited");
        });
        c.start(); Thread.sleep(50); c.interrupt(); c.join();

        var pool = Executors.newFixedThreadPool(2);
        pool.execute(() -> { throw new RuntimeException("via execute"); });
        Future<?> f = pool.submit(() -> { throw new RuntimeException("via submit"); });
        Thread.sleep(200);
        System.out.println("still alive, isDone=" + f.isDone());
        try { f.get(); } catch (ExecutionException e) { System.out.println(e.getCause().getMessage()); }

        var tpe = new ThreadPoolExecutor(1, 4, 1, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(), r -> new Thread(r, "x"));
        for (int i = 0; i < 20; i++) tpe.execute(() -> { try { Thread.sleep(100); } catch (Exception e) {} });
        Thread.sleep(50);
        System.out.println(tpe.getPoolSize() + " " + tpe.getQueue().size());
        tpe.shutdown();

        var bounded = new ThreadPoolExecutor(1, 2, 1, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(1), new ThreadPoolExecutor.AbortPolicy());
        try { for (int i = 0; i < 10; i++) bounded.execute(() -> { try { Thread.sleep(200); } catch (Exception e) {} }); }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        System.out.println(bounded.shutdownNow().size());

        pool.shutdown();
        System.out.println(pool.awaitTermination(1, TimeUnit.SECONDS));
    }
}
```

## 17. Mastery check

1. Name the six thread states and give a concrete cause for each.
2. Why does a thread blocked on a socket read show as `RUNNABLE`?
3. Explain the interruption protocol: what `interrupt()` does, what blocking methods do, and the two legal responses in a catch block.
4. Why was `Thread.stop` removed?
5. Give the seven `ThreadPoolExecutor` parameters and the four-step decision algorithm.
6. Explain why an unbounded queue makes `maximumPoolSize` dead configuration.
7. Compare the four rejection policies and say which gives backpressure.
8. Derive both pool-sizing formulas and work a numeric example.
9. Explain what happens to an exception thrown by an `execute`d task versus a `submit`ted one.
10. What happens when a `scheduleAtFixedRate` task throws, and what is the fix?
