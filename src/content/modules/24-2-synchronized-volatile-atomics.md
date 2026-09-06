---
title: "synchronized, volatile, and atomics: mutual exclusion, visibility, and CAS"
phase: 24
order: 2
minutes: 50
summary: "The three separate problems concurrency creates, what each tool actually guarantees, why volatile does not make ++ atomic, and how compare-and-swap builds lock-free counters."
tags: ["synchronized", "volatile", "atomic", "cas", "monitor", "wait-notify", "false-sharing"]
---

## 1. Three problems, not one

Concurrency breaks programs in three distinct ways. Every tool in this module addresses a specific subset, and conflating them is the root of most confusion.

| Problem | Symptom | Fixed by |
| --- | --- | --- |
| **Atomicity** | `count++` loses updates — it is read, add, write, and two threads interleave | `synchronized`, `Lock`, atomics |
| **Visibility** | Thread B never sees a value thread A wrote — it reads a cached or register-held copy forever | `volatile`, `synchronized`, atomics, `final` |
| **Ordering** | Operations appear to happen in a different order to another thread (compiler and CPU reorder freely) | `volatile`, `synchronized`, atomics |

```java
// Atomicity failure: two threads, 10 000 increments each, result is not 20 000
count++;                       // getfield, iconst_1, iadd, putfield — four bytecodes, not one

// Visibility failure: this loop may NEVER terminate, even after another thread sets running = false
private boolean running = true;
while (running) { }            // the JIT may hoist the read out of the loop entirely
```

That second one is not theoretical. **[HotSpot]** C2 legitimately transforms `while (running) {}` into `if (running) while (true) {}` because, absent a happens-before edge, nothing in the program says the value can change. Adding `volatile` forbids the hoist.

## 2. `synchronized`

Every Java object has an associated **monitor**. `synchronized` acquires it.

```java
synchronized void m() { }                    // locks THIS
static synchronized void s() { }             // locks Foo.class — a DIFFERENT lock
void m2() { synchronized (lock) { } }        // locks whatever `lock` refers to
```

**[JVMS]** A synchronized block compiles to `monitorenter` / `monitorexit`, with a synthetic exception handler guaranteeing the exit even when the body throws. A synchronized *method* has no such instructions — it carries the `ACC_SYNCHRONIZED` flag and the JVM does the locking at invocation.

What it guarantees:

- **Mutual exclusion.** One thread at a time, per monitor.
- **Visibility and ordering.** Releasing a monitor flushes everything the thread did; acquiring it makes those writes visible. Formally, an unlock **happens-before** every subsequent lock of the same monitor (Phase 25).
- **Reentrancy.** The owning thread can re-acquire the same monitor; a hold count tracks the depth. This is why a synchronized method calling another synchronized method on the same object does not deadlock.

The three rules that follow:

```java
// 1. The lock is the OBJECT, not the code. These do not exclude each other:
synchronized void a() { }          // locks this
static synchronized void b() { }   // locks the Class

// 2. Never lock on something a caller can also lock, or on something that changes
synchronized (this) { }            // callers can lock you too — surprising interference
synchronized ("key") { }           // interned string: shared JVM-wide. Catastrophic
synchronized (Integer.valueOf(1)) { }   // cached box: shared JVM-wide
private final Object lock = new Object();   // correct: a private, final, dedicated lock

// 3. Hold locks for as little as possible, and NEVER across I/O
synchronized (lock) { httpCall(); }        // serialises every thread behind a network round trip
```

## 3. `wait` / `notify`

The intrinsic condition mechanism. Three hard rules:

```java
synchronized (lock) {                       // 1. you MUST hold the monitor
    while (!condition) {                    // 2. ALWAYS a while, never an if
        lock.wait();                        //    releases the monitor, parks, reacquires on wake
    }
    consume();
}

synchronized (lock) {
    condition = true;
    lock.notifyAll();                       // 3. prefer notifyAll
}
```

**Why `while` and not `if`:** **[JLS 17.2]** a thread may return from `wait()` **without any notification** — a *spurious wakeup*, permitted by the specification and real on some platforms. More commonly, another thread wins the race to the monitor after the notify and consumes the condition first. Re-checking is mandatory.

**Why `notifyAll` and not `notify`:** `notify` wakes **one arbitrary waiter**. If waiters are waiting for *different* conditions on the same monitor (producers and consumers on one lock), it can wake the wrong one, which re-checks, sees nothing, and waits again — while the thread that could have made progress sleeps forever. That is a **missed signal** deadlock. `notify` is only safe when every waiter is interchangeable and every notification enables exactly one.

Calling `wait`/`notify` without holding the monitor throws `IllegalMonitorStateException`.

## 4. `volatile`

**`volatile` gives you visibility and ordering. It does not give you atomicity.**

```java
private volatile boolean running = true;     // CORRECT use: a flag, written by one, read by many
private volatile int count;
count++;                                     // STILL BROKEN — read-modify-write is three steps
```

What it does guarantee:

| Guarantee | Detail |
| --- | --- |
| Visibility | A write is immediately visible to any subsequent read by any thread |
| Ordering | Reads/writes are not reordered across the volatile access (Phase 25) |
| Atomicity of the access itself | **Including `long` and `double`** — see below |
| No caching in registers | Every read goes to memory |

**[JLS 17.7]** Non-`volatile` `long` and `double` reads and writes are **not guaranteed atomic** — a 64-bit value may be written as two 32-bit halves, and another thread can observe a "word-torn" value that was never written. Marking it `volatile` makes it atomic. In practice 64-bit HotSpot is atomic anyway, but the spec permits otherwise and you should not depend on the implementation.

The correct uses of `volatile` are narrow:

```java
// 1. A status/cancellation flag
private volatile boolean shutdown;

// 2. Safe publication of an immutable object (Phase 25)
private volatile Config config;               // whole-object replacement, never mutation
public void reload() { config = new Config(load()); }

// 3. Double-checked locking (Phase 25 — and it is broken without volatile)
private volatile Singleton instance;

// 4. The write happens on one thread only, or writes never depend on the current value
```

That last condition is the test: **if the new value depends on the old value, `volatile` is not enough.**

## 5. Atomics and compare-and-swap

**[JDK]** `java.util.concurrent.atomic` gives lock-free read-modify-write, built on the CPU's compare-and-swap instruction (`lock cmpxchg` on x86, `ldrex/strex` or `casal` on ARM).

```java
var counter = new AtomicInteger();
counter.incrementAndGet();                       // atomic ++
counter.addAndGet(5);
counter.compareAndSet(expected, newValue);       // the primitive everything is built on
counter.updateAndGet(x -> x * 2);                // a CAS retry loop, given a pure function
counter.accumulateAndGet(5, Integer::max);

var ref = new AtomicReference<Config>();
ref.compareAndSet(old, updated);
ref.getAndUpdate(c -> c.withTimeout(30));
```

`incrementAndGet` is a retry loop:

```java
int v;
do { v = get(); } while (!compareAndSet(v, v + 1));   // retry until nobody raced us
```

**This is optimistic, not free.** Under low contention it is faster than a lock (no context switch, no monitor inflation). Under **high** contention it degrades: many threads spin, most CAS attempts fail, and the cache line holding the counter ping-pongs between cores. At that point a lock — which parks losers instead of spinning them — can win.

**`LongAdder` is the answer for hot counters.** **[JDK]** It stripes the value across an array of `Cell`s (one per contending thread, padded to a cache line) and sums them on `sum()`. Writes scale nearly linearly with cores; reads are O(cells) and are not an atomic snapshot.

```java
var hits = new LongAdder();
hits.increment();                 // contended writes: 5-10x faster than AtomicLong
hits.sum();                       // approximate under concurrent updates
```

Use `AtomicLong` when you need `compareAndSet` or an exact instantaneous value; use `LongAdder` for pure counting under contention. `ConcurrentHashMap.size()` uses exactly this technique (Module 8.4).

**The ABA problem.** CAS checks the *value*, not whether it changed and changed back. A thread reads `A`, is descheduled; another thread does `A → B → A`; the first thread's CAS succeeds even though the world moved underneath it. It is harmless for counters and dangerous for pointer-based structures (a popped-and-recycled stack node).

```java
var stamped = new AtomicStampedReference<>(node, 0);
stamped.compareAndSet(expectedRef, newRef, expectedStamp, expectedStamp + 1);   // version counter
```

## 6. Choosing between them

```text
Read a flag / publish an immutable object          -> volatile
Single variable, read-modify-write                 -> Atomic*
Pure counter under heavy contention                -> LongAdder
Multiple variables that must change together       -> synchronized or Lock
Need to WAIT for a condition                       -> synchronized + wait/notifyAll, or Lock + Condition
Need timeout / interruptible / fairness / try-lock -> ReentrantLock (Module 24.3)
```

**The invariant test**: if two or more fields must be consistent with each other, no amount of `volatile` or atomics will do it. Atomicity of each field individually does not give atomicity of the pair.

```java
// BROKEN: each field is atomic; the PAIR is not
private final AtomicInteger lower = new AtomicInteger(0), upper = new AtomicInteger(10);
void setLower(int v) { if (v > upper.get()) throw new IllegalArgumentException(); lower.set(v); }
// Two threads calling setLower(5) and setUpper(3) can both pass their checks and leave lower > upper.
```

## 7. What happens internally

**[HotSpot]** Monitor states, encoded in the object's mark word (Module 22.2 §3):

| State | Representation | Cost |
| --- | --- | --- |
| **Unlocked** | Hash/age in the mark word | — |
| **Thin (stack-locked)** | Mark word points to a lock record on the owner's stack; acquired by CAS | ~20 ns, no kernel involvement |
| **Inflated (fat)** | Mark word points to an `ObjectMonitor`; contenders park | A syscall on contention: ~1–10 µs |

Uncontended `synchronized` is a CAS and is genuinely cheap. **Contention is what costs**, because a parked thread means a context switch. *Biased locking*, which made repeated uncontended locking by one thread nearly free, was disabled by default in Java 15 and **removed in Java 18** — it had become a maintenance burden and modern CAS is cheap enough.

**The JIT also removes locks** (Module 22.3 §5): **lock elision** deletes locking on a provably thread-local object, and **lock coarsening** merges adjacent blocks on the same monitor.

```java
// Escape analysis proves sb never escapes -> every append's lock is elided
String f() { StringBuffer sb = new StringBuffer(); sb.append("a").append("b"); return sb.toString(); }
```

**`volatile` compiles to memory barriers**, not to locks. On x86 a volatile *read* is an ordinary load (the hardware is already TSO), and a volatile *write* is a store followed by a full fence (`lock addl $0,(%rsp)` or `mfence`) — so **volatile reads are nearly free and volatile writes cost roughly a CAS**. On weakly-ordered architectures (ARM, POWER) both sides need explicit barriers.

**`VarHandle`** (Java 9, Module 18.1 §7) exposes the whole ordering spectrum, which is what the atomics are built on and what replaced `sun.misc.Unsafe`:

```java
V.get(o)              // plain: no ordering
V.getOpaque(o)        // atomic, no ordering with other variables
V.getAcquire(o)       // acquire: later reads cannot move before it
V.getVolatile(o)      // full volatile semantics
V.compareAndSet(o, expected, value);
V.getAndAdd(o, 1);
```

**False sharing** is the last performance trap. Two independent variables on the **same 64-byte cache line** cause the line to bounce between cores even though the threads never touch the same data.

```java
class Counters { long a; long b; }              // a and b share a cache line: ~10x slowdown
                                                // when two threads increment them concurrently
@jdk.internal.vm.annotation.Contended long a;   // JDK-internal; needs -XX:-RestrictContended
long p1, p2, p3, p4, p5, p6, p7;                // manual padding: what LongAdder.Cell does
```

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>The single most dangerous false friend in this entire curriculum: <code>volatile</code> means completely different things.</strong> In C and C++, <code>volatile</code> is about memory-mapped I/O and signal handlers — it prevents the <em>compiler</em> from eliding accesses and does <strong>nothing</strong> about CPU reordering, cache coherence, or atomicity. Using it for threading in C++ is a well-known bug. Java's <code>volatile</code> is a full <strong>sequentially consistent</strong> atomic: the correct C++ analogue is <code>std::atomic&lt;T&gt;</code> with the default <code>memory_order_seq_cst</code>.</p>
<p><strong><code>synchronized</code> is <code>std::recursive_mutex</code> + <code>lock_guard</code></strong> — Java's monitors are always reentrant, where C++ makes you choose (<code>std::mutex</code> is <em>not</em> reentrant, and re-locking it is undefined behaviour). Java gives every object a monitor for free; C++ makes the mutex an explicit member, which is arguably better design because you can see the lock in the type.</p>
<p><strong>Memory ordering:</strong> C++ exposes six orderings (<code>relaxed</code>, <code>consume</code>, <code>acquire</code>, <code>release</code>, <code>acq_rel</code>, <code>seq_cst</code>) as a first-class parameter. Java's language level offers only <code>volatile</code> (≈ <code>seq_cst</code>) and plain; the finer control arrived with <code>VarHandle</code> in Java 9.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| `volatile` | Compiler-only; **useless for threading** | Full seq-cst atomic access |
| Atomic variable | `std::atomic<T>` | `volatile` field, or `Atomic*`, or `VarHandle` |
| Mutex | `std::mutex` — **not** reentrant | Every object's monitor — always reentrant |
| Recursive mutex | `std::recursive_mutex` | The default |
| RAII locking | `lock_guard`, `scoped_lock`, `unique_lock` | `synchronized` block (scoped), or `try/finally` with `Lock` |
| Condition variable | `std::condition_variable` + predicate loop | `wait`/`notifyAll` + `while` loop |
| Spurious wakeups | Documented; use the predicate overload | Documented; use `while` |
| CAS | `compare_exchange_weak` / `_strong` | `compareAndSet` |
| Memory orderings | Six, explicit per operation | `volatile` (seq-cst) or `VarHandle` modes |
| Striped counter | Hand-rolled or a library | `LongAdder` |
| False sharing | `alignas(64)`, `hardware_destructive_interference_size` | `@Contended`, manual padding |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Dismissing <code>volatile</code> as "the useless keyword". In Java it is the primary visibility tool and the thing that makes double-checked locking correct.</p>
<p>Expecting a mutex to deadlock on re-entry. Java monitors are reentrant, so recursive locking is fine — which also means a bug where you assumed exclusion between two synchronized methods on the same object will never announce itself.</p>
</div>

## 9. Edge cases

- **`synchronized` on a boxed value or a `String` literal** locks a JVM-wide shared object. Catastrophic and hard to find.
- **A `synchronized` method's lock is on `this`**, which callers can also lock, and which is part of your public API surface. Prefer a private lock object.
- **`volatile` arrays**: the *reference* is volatile, the **elements are not**. Use `AtomicIntegerArray` or `VarHandle` for elements.
- **`volatile` on a mutable object reference** publishes the reference safely but says nothing about the object's fields being safe to mutate afterwards.
- **`wait(long)` cannot distinguish timeout from notification** — check the condition and the clock.
- **Interrupting a thread inside `wait()`** throws `InterruptedException` after reacquiring the monitor, not immediately.
- **`Thread.sleep` inside a `synchronized` block does not release the lock** — `wait` does. This is the classic exam distinction.
- **`AtomicInteger.compareAndSet` may fail spuriously?** No — `compareAndSet` is strong in Java. `weakCompareAndSetPlain` is the weak variant.
- **`AtomicLong` on a 32-bit JVM** may use a lock internally (`VM.supportsCS8`).
- **`LongAdder.sum()` is not atomic** with respect to concurrent increments — it is an estimate, like `ConcurrentHashMap.size()`.
- **`getAndUpdate` / `updateAndGet` may call the function more than once** on contention, so the function must be pure and side-effect free.

## 10. Common mistakes

- `volatile int count; count++;`
- `if` instead of `while` around `wait()`.
- `notify()` where `notifyAll()` is required.
- Locking on `this`, a `String`, or a boxed value.
- Holding a lock across I/O or a callback.
- Assuming atomicity of two independently atomic fields.
- Using `synchronized` for a pure counter under heavy contention instead of `LongAdder`.
- Using an atomic where a lock is needed because an invariant spans fields.
- Believing a non-volatile `long` write is atomic.
- Ignoring false sharing in per-thread counter arrays.

## 11. Interview questions

**Beginner** — 1. What does `synchronized` do? 2. What does `volatile` do? 3. Is `count++` atomic?

**Intermediate** — 4. Name the three problems concurrency creates and which tool addresses each. 5. Why must `wait` be in a `while` loop? 6. `notify` versus `notifyAll`. 7. What lock does a `static synchronized` method take?

**Advanced** — 8. Why does `volatile` not make `++` atomic, and what does? 9. Explain CAS and write `incrementAndGet` from it. 10. What is the ABA problem and how do you fix it? 11. Why is `LongAdder` faster than `AtomicLong` under contention, and what does it cost?

**Senior** — 12. Explain HotSpot's three monitor states and where the cost is. 13. Explain false sharing with a concrete two-counter example and three fixes. 14. Two fields each guarded by an atomic still violate their invariant. Explain and fix. 15. When is a lock faster than a CAS loop?

## 12. Follow-ups

- *After Q2:* "Does it make anything atomic?" → only the single access, including 64-bit.
- *After Q5:* "Name both reasons." → spurious wakeup, and losing the race after notify.
- *After Q9:* "What happens under 64-thread contention?" → most CAS attempts fail; cache line ping-pong.
- *After Q11:* "Is `sum()` exact?" → no.
- *After Q13:* "How would you prove it?" → `perf` cache-line events, or padding and re-measuring.

## 13. Exercise

1. Write the visibility failure: a non-volatile `boolean running` flag and a spinning reader. Run with `-XX:+PrintCompilation` and show the loop never exits after C2 compiles it. Add `volatile` and show it does.
2. Increment a counter 10 M times from 8 threads four ways: plain `int`, `volatile int`, `synchronized`, `AtomicInteger`, `LongAdder`. Report correctness and throughput for each and explain all five.
3. Implement a bounded buffer with `synchronized` + `wait`/`notifyAll`. Then break it by using `notify` and by using `if` instead of `while`, and construct the interleaving that fails in each case.
4. Demonstrate false sharing: two threads incrementing two adjacent `long` fields versus two fields padded 64 bytes apart. Report the ratio and confirm with cache-miss counters.
5. Build a lock-free stack with `AtomicReference` and reproduce ABA using a node pool. Fix it with `AtomicStampedReference`.

## 14. Output prediction

```java
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class Main {
    static int plain = 0;
    static volatile int vol = 0;
    static AtomicInteger atom = new AtomicInteger();
    static LongAdder adder = new LongAdder();
    static final Object LOCK = new Object();
    static int guarded = 0;

    public static void main(String[] args) throws Exception {
        int threads = 8, per = 100_000;
        var latch = new CountDownLatch(threads);
        for (int i = 0; i < threads; i++) {
            new Thread(() -> {
                for (int j = 0; j < per; j++) {
                    plain++; vol++; atom.incrementAndGet(); adder.increment();
                    synchronized (LOCK) { guarded++; }
                }
                latch.countDown();
            }).start();
        }
        latch.await();
        int expected = threads * per;
        System.out.println(expected);
        System.out.println(plain == expected);
        System.out.println(vol == expected);
        System.out.println(atom.get() == expected);
        System.out.println(adder.sum() == expected);
        System.out.println(guarded == expected);

        var a = new AtomicInteger(5);
        System.out.println(a.compareAndSet(5, 10) + " " + a.get());
        System.out.println(a.compareAndSet(5, 20) + " " + a.get());
        System.out.println(a.getAndIncrement() + " " + a.incrementAndGet());
        System.out.println(a.updateAndGet(x -> x * 2));

        Object o = new Object();
        try { o.wait(); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var t = new Thread(() -> {
            synchronized (LOCK) {
                try { Thread.sleep(300); } catch (Exception e) {}
            }
        });
        t.start(); Thread.sleep(50);
        long t0 = System.currentTimeMillis();
        synchronized (LOCK) { }
        System.out.println(System.currentTimeMillis() - t0 > 100);
        System.out.println(t.getState());
    }
}
```

## 15. Mastery check

1. Name the three concurrency problems and which tools address each.
2. What exactly does `synchronized` guarantee — all three properties, stated precisely?
3. Give three objects you must never synchronize on and why.
4. Why must `wait()` be inside a `while` loop? Give both reasons.
5. Explain when `notify` is safe and when it causes a missed signal.
6. State everything `volatile` guarantees and everything it does not.
7. Explain the 64-bit non-atomicity rule and how `volatile` changes it.
8. Write `incrementAndGet` in terms of `compareAndSet`, and describe its behaviour under 64-thread contention.
9. Explain the ABA problem, a case where it matters, and the fix.
10. Describe HotSpot's three monitor states and what each costs.
