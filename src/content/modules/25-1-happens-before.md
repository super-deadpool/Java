---
title: "The Java Memory Model: data races, happens-before, and why reading the code is not enough"
phase: 25
order: 1
minutes: 50
summary: "What the compiler and CPU are allowed to reorder, the complete list of happens-before edges, the SC-DRF guarantee, and why Java's data races produce garbage values rather than undefined behaviour."
tags: ["jmm", "happens-before", "data-race", "reordering", "volatile", "final-fields"]
---

## 1. The problem

Source order is not execution order. Three separate agents reorder your program:

```text
1. javac / the JIT   may reorder, eliminate, hoist, or duplicate memory accesses
2. the CPU           executes out of order, speculatively
3. the memory system store buffers and caches make writes visible at different times to different cores
```

All three are constrained by one rule: **within a single thread, the result must look as if the program ran in order** (*intra-thread as-if-serial semantics*). Nothing constrains what *other* threads observe — unless you create the constraint yourself.

The canonical demonstration:

```java
int a = 0, b = 0;
volatile boolean nothingIsVolatileHere;      // pretend this line isn't here

// Thread 1              // Thread 2
a = 1;                   b = 1;
int r1 = b;              int r2 = a;
```

Can `r1 == 0 && r2 == 0`? Reading the code, no: one of the writes must happen first. In reality **yes**, routinely — each CPU buffers its own store and reads the other's stale value. This is exactly what the C++ community calls store-buffer reordering, and Java permits it too.

The **Java Memory Model** ([JLS 17.4]) exists to define precisely which executions are legal, so you can reason about concurrent code at all.

## 2. Data race — the precise definition

**[JLS 17.4.5]** Two accesses **conflict** if they touch the same variable and at least one is a write. A program has a **data race** if it contains two conflicting accesses **not ordered by happens-before**.

```java
// DATA RACE: two threads, one writes, one reads, no synchronization
private boolean ready;
// T1: ready = true;         T2: while (!ready) { }

// NOT a data race: the accesses are ordered by the volatile edge
private volatile boolean ready;

// NOT a data race: only reads
private final int size = 10;
```

**A data race is different from a race condition.** A race condition is a *correctness* problem — the outcome depends on timing. A data race is a *memory model* problem — the program has no defined behaviour under the JMM's ordering rules. You can have either without the other:

```java
// Race condition, NO data race: every access is atomic and ordered, but check-then-act is not
if (!map.containsKey(k)) map.put(k, v);        // on a ConcurrentHashMap

// Data race, arguably no race condition: a status flag whose exact timing doesn't matter —
// except that without volatile the reader may NEVER see the write
private boolean shutdown;
```

## 3. The happens-before edges

**[JLS 17.4.5]** If `x` happens-before `y`, everything `x`'s thread did up to `x` is visible to `y`'s thread at `y`. Memorise this list.

| # | Edge |
| --- | --- |
| 1 | **Program order.** Within one thread, each action happens-before every later action in program order |
| 2 | **Monitor.** An unlock of monitor *m* happens-before every subsequent lock of *m* |
| 3 | **Volatile.** A write to a volatile field happens-before every subsequent read of that field |
| 4 | **Thread start.** `t.start()` happens-before every action in thread *t* |
| 5 | **Thread termination.** Every action in *t* happens-before `t.join()` returning, or `t.isAlive()` returning false |
| 6 | **Interruption.** `t.interrupt()` happens-before *t* detecting the interrupt |
| 7 | **Finalizer.** The end of an object's constructor happens-before the start of its finalizer |
| 8 | **Transitivity.** If *x* hb *y* and *y* hb *z*, then *x* hb *z* |

Rule 8 does the real work: it is what lets a write to a plain field, followed by a volatile write, be seen by a thread that reads the volatile and then reads the plain field.

```java
int data;                      // plain
volatile boolean ready;        // the "gate"

// Writer                      // Reader
data = 42;                     if (ready) {          // 3: sees the volatile write
ready = true;                      use(data);        // 1 + 3 + 8: therefore sees data = 42
                               }
```

That pattern — **write the data, then write a volatile flag; read the flag, then read the data** — is the foundation of every safe-publication idiom (Module 25.2).

**The library also gives you edges**, and these matter more in practice than the primitives:

| Library action | Edge |
| --- | --- |
| `executor.submit(task)` | Happens-before the task executing |
| A task's completion | Happens-before `Future.get()` returning |
| `latch.countDown()` | Happens-before `latch.await()` returning |
| `semaphore.release()` | Happens-before a subsequent `acquire()` |
| `queue.put(x)` | Happens-before `queue.take()` returning x |
| Placing an object in **any** `java.util.concurrent` collection | Happens-before its retrieval by another thread |
| `barrier.await()` returning | Ordered with every other party's actions before the barrier |
| Completing a `CompletableFuture` | Happens-before its dependent stages running |

This is why handing an object to an `ExecutorService` needs no extra synchronization — the submission itself carries the edge.

## 4. SC-DRF: the guarantee you actually rely on

**[JLS 17.4.3]** The Java Memory Model's central promise:

> **A correctly synchronized program — one with no data races — behaves as if it were sequentially consistent.**

*Sequentially consistent* means: there exists a single global interleaving of all threads' operations, consistent with each thread's program order, and every read sees the most recent write in that interleaving. In other words, **exactly what you would naively expect**.

The practical reading: **if you eliminate every data race, you may reason about your program the way you always wanted to.** All the reordering, store buffers, and cache coherence become invisible. This is the "SC for data-race-free programs" (SC-DRF) contract, and it is the same one C++11 adopted.

The corollary is the harder half: **if your program has even one data race, the guarantee is void for the whole program** — not just for the racy variable.

## 5. What Java guarantees even for racy programs

Here Java diverges sharply from C++, for a reason rooted in the JVM's purpose.

**[JLS 17.4]** A Java program with a data race still has **defined safety properties**:

- Every read returns **some value that was actually written** to that variable by some thread (or the default value). It may be stale, it may be a value from far in the past, but it is not fabricated.
- The JVM cannot be corrupted. No wild pointers, no memory-safety violation, no type confusion.
- **Out-of-thin-air values are forbidden** — a read cannot produce a value that no write ever produced, even through a speculative causal loop. (Formalising this is the hardest part of the JMM, and the current definition is known to be imperfect.)

The exception, and the one place tearing is allowed: **[JLS 17.7]** a non-`volatile` `long` or `double` write may be performed as two 32-bit writes, so a racing reader can observe a **word-torn** value that was never written as a whole. Declaring the field `volatile` makes it atomic.

**Why the safety guarantee exists:** the JVM must run untrusted code without letting a data race become a security vulnerability. C++ has no such requirement, so it declares data races **undefined behaviour**, which lets its compilers optimise more aggressively.

## 6. `volatile` in memory-model terms

Beyond the visibility of Module 24.2, `volatile` gives ordering:

```text
volatile READ   is an ACQUIRE:  no subsequent read or write may be reordered BEFORE it
volatile WRITE  is a RELEASE:   no prior read or write may be reordered AFTER it
```

Together those make every volatile access participate in a **single total order** seen identically by all threads — Java's `volatile` is the equivalent of C++'s `memory_order_seq_cst`, not merely acquire/release.

**The "roach motel" mnemonic** describes what synchronization does and does not prevent:

```text
Code can move INTO a synchronized block or across an acquire.
Code cannot move OUT of a synchronized block or across a release.
```

```java
x = 1;                        // may be reordered INTO the block below
synchronized (lock) {
    y = 2;                    // may NOT move out
}
z = 3;                        // may be reordered INTO the block above
```

That asymmetry is why lock coarsening (Module 22.3 §5) is legal: merging two adjacent blocks only moves code *inward*.

## 7. Final field semantics

**[JLS 17.5]** `final` fields get a guarantee no other field has, and it is the reason immutable objects are safe to share.

> If an object is **correctly constructed** — meaning `this` does not escape during construction — then any thread that sees a reference to the object is **guaranteed to see the correctly initialized values of its `final` fields**, with **no synchronization at all**.

The mechanism is a **freeze action** at the end of the constructor: the JVM emits a `StoreStore` barrier so the final-field writes cannot be reordered after the publication of the reference.

```java
public final class Config {
    private final Map<String, String> values;      // final
    public Config(Map<String, String> v) { this.values = Map.copyOf(v); }   // defensive copy
    public String get(String k) { return values.get(k); }
}

// Any thread that obtains a Config reference — however unsafely — sees a fully built `values`.
```

Two conditions, both easy to break:

**1. The field must be `final`.** Change `values` to non-final and another thread can see `null`.

**2. `this` must not escape the constructor.** If a reference to the object becomes visible to another thread before the constructor finishes, the freeze has not happened yet and all bets are off:

```java
public class Broken {
    private final int x;
    public Broken(EventBus bus) {
        bus.register(this);      // ESCAPE — another thread can see `this` with x still 0
        this.x = 42;
    }
}
```

The same rule kills starting a thread in a constructor, and calling an overridable method from one (Module 2.1).

`final` also protects the *contents* transitively when they are themselves reachable only through final fields — which is why an immutable object built from immutable parts is safe to publish by any means whatsoever.

## 8. What happens internally

**[HotSpot]** The JMM is enforced by inserting **memory barriers**, and what they cost depends entirely on the hardware:

| Architecture | Volatile read | Volatile write |
| --- | --- | --- |
| **x86/x64** (TSO — strongly ordered) | An ordinary load; barriers are free | A store plus `lock addl $0,(%rsp)` (a full fence) — ~20–100 cycles |
| **ARM / POWER** (weakly ordered) | `ldar` / an explicit acquire barrier | `stlr` / an explicit release barrier — both cost |

So **volatile reads are essentially free on x86 and not free on ARM** — a real portability consideration now that ARM servers and Apple silicon are common. Code tuned on x86 can regress on ARM specifically because the barriers become visible.

The four barrier types the JVM reasons about — `LoadLoad`, `StoreStore`, `LoadStore`, `StoreLoad` — map onto hardware fences; `StoreLoad` is the expensive one and is what a volatile write requires.

**The JIT's freedom is bounded by the model, not by intuition.** C2 will happily:

- hoist a non-volatile field read out of a loop (the `while (!done) {}` infinite loop of Module 24.2 §1);
- eliminate a redundant read entirely;
- reorder independent stores;
- speculatively execute both sides of a branch.

Each of these is legal *only* because there is no happens-before edge forbidding it. Add the edge and the optimisation disappears — which is the whole point.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>Java and C++11 adopted the same core design</strong> — SC-DRF — within a year of each other, and Java's JSR-133 (2004) directly influenced C++11's model. Both say: no data races ⟹ sequential consistency.</p>
<p><strong>They differ completely on what a data race means.</strong> In C++ a data race is <strong>undefined behaviour</strong>: the compiler may assume it cannot happen, and a racy program can do literally anything — including corrupting unrelated memory or optimising away a loop's exit condition entirely. In Java a data race yields <em>some previously-written value</em>, and the JVM remains memory-safe. Java pays for that guarantee with weaker permitted optimisations; it buys the ability to run untrusted code.</p>
<p><strong>C++ exposes the ordering spectrum; Java (at language level) exposes one point on it.</strong> <code>memory_order_relaxed</code>, <code>acquire</code>, <code>release</code>, <code>acq_rel</code>, <code>seq_cst</code> are per-operation in C++; Java gives you <code>volatile</code> (seq-cst) or plain, with the finer modes available only through <code>VarHandle</code> since Java 9.</p>
</div>

| Concern | C++11 | Java |
| --- | --- | --- |
| Model | SC-DRF | SC-DRF |
| Data race | **Undefined behaviour** | Defined: some written value; JVM stays safe |
| Out-of-thin-air | UB permits anything | Forbidden by fiat |
| Default atomic ordering | `seq_cst` | `volatile` = `seq_cst` |
| Relaxed / acquire / release | First-class per operation | `VarHandle` modes (Java 9+) |
| `volatile` keyword | **Not for threading** — MMIO only | The primary visibility tool |
| Immutable-object publication | `const` gives no ordering; needs an atomic or a mutex | **Final field freeze** — no synchronization needed |
| Torn 64-bit values | Non-atomic types can tear; `atomic<T>` cannot | Non-volatile `long`/`double` may tear |
| Thread-safe static init | "Magic statics" (C++11) | `<clinit>` lock (Module 22.1) |
| Fences | `std::atomic_thread_fence` | Implicit; `VarHandle.fullFence()` |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Assuming <code>final</code> is just <code>const</code>. <code>const</code> is a compile-time access restriction with <strong>no memory-ordering meaning</strong>; Java's <code>final</code> carries a runtime freeze guarantee that is the entire basis of safe immutable publication. This is one of the few places Java's model is genuinely stronger.</p>
<p>Relying on x86's strong ordering because "it works on my machine". It works because the hardware is TSO; the same code on ARM will fail. The JMM, not the hardware, is the contract.</p>
</div>

## 10. Edge cases

- **`volatile` on an array field** orders the *reference*, not the elements. Use `VarHandle` or `AtomicIntegerArray`.
- **A `final` field holding a mutable object** protects the *reference*, not later mutations of the object.
- **A `final` field read through a racy path before the constructor completes** (via an escaped `this`) can be observed as the default value.
- **`static final` fields are safe by class initialization**, which carries its own happens-before edge (Module 22.1 §4).
- **`Thread.join()` gives you an edge; `Thread.isAlive()` returning false does too** — but polling `isAlive()` in a loop is still terrible practice.
- **Interruption gives an edge**, so state written before `interrupt()` is visible to the interrupted thread when it notices.
- **64-bit tearing has never been observed on 64-bit HotSpot**, but the spec permits it and 32-bit JVMs did it.
- **A `synchronized` block with an empty body is not a no-op** — it is a full barrier pair, and the JIT will not remove it if the monitor is shared.
- **`Thread.yield()`, `Thread.sleep()`, and `System.out.println`** create no happens-before edge, even though they often accidentally "fix" racy code by changing timing.
- **Reordering can move code *into* a synchronized block**, so a "just outside the lock" read may in fact execute inside it — you cannot use position to reason about atomicity.

## 11. Common mistakes

- "It works when I add a `println`" — you changed timing, not correctness.
- Assuming a write becomes visible "eventually" without an edge. There is no eventually.
- Believing `volatile` on a collection reference makes the collection thread-safe.
- Reasoning about a racy program by reading it in order.
- Fixing a visibility bug with `Thread.sleep`.
- Publishing `this` from a constructor.
- Making a field non-final "for flexibility" and losing the initialization-safety guarantee.
- Testing concurrency on x86 and shipping to ARM.
- Assuming one data race only affects one variable.
- Using `volatile` where the update depends on the previous value.

## 12. Interview questions

**Beginner** — 1. Why might a thread never see another thread's write? 2. What does `volatile` guarantee? 3. What is a data race?

**Intermediate** — 4. Name five happens-before edges. 5. Data race versus race condition — give an example of each without the other. 6. What does `synchronized` guarantee besides mutual exclusion? 7. Why must a check-then-act sequence be atomic even on a concurrent collection?

**Advanced** — 8. State the SC-DRF guarantee precisely and what it costs you if you break it. 9. What does Java guarantee for a program that *does* have a data race? 10. Explain the final-field freeze and its two preconditions. 11. What is the "roach motel" rule and which optimisation does it enable?

**Senior** — 12. Explain why a volatile read is free on x86 and not on ARM, and what that means for a service being ported. 13. Why does Java define data-race behaviour where C++ leaves it undefined? What does each choice buy? 14. Given a class with one non-volatile field written by one thread and read by many, list every mechanism that could make the read stale and every fix.

## 13. Follow-ups

- *After Q2:* "Does it make `count++` atomic?" → no.
- *After Q4:* "Which one makes the others useful?" → transitivity.
- *After Q9:* "Can a read return a value nobody wrote?" → no, except 64-bit tearing.
- *After Q10:* "Show me code that breaks it." → `this` escaping the constructor.
- *After Q13:* → memory safety for untrusted code, versus optimisation freedom.

## 14. Exercise

1. Reproduce the store-buffer reordering from §1 with two threads and a loop of a million trials, counting how often `r1 == 0 && r2 == 0`. Then add `volatile` to both fields and confirm it becomes zero. Run on x86 and, if you can, on ARM.
2. Write the non-terminating `while (!done) {}` loop. Show it hangs, confirm with `-XX:+PrintCompilation` that C2 compiled it, then fix it three ways: `volatile`, `synchronized`, `AtomicBoolean`.
3. Build the escaped-`this` example: a constructor that registers itself with another thread before assigning its final fields. Run it under load until you observe the default value.
4. Take a class with five plain fields and one volatile flag written last. Prove with a stress test that a reader seeing the flag always sees all five, and that removing the volatile breaks it.
5. Use `jcstress` (the JDK's concurrency stress harness) to test one of the above. It exists precisely because hand-written concurrency tests do not find these bugs.

## 15. Output prediction

```java
import java.util.concurrent.*;

public class Main {
    static int plainData; static boolean plainFlag;
    static int volData;   static volatile boolean volFlag;

    static class Escape {
        final int x;
        static Escape leaked;
        Escape() { leaked = this; try { Thread.sleep(1); } catch (Exception e) {} x = 42; }
    }

    public static void main(String[] args) throws Exception {
        // 1. The safe pattern: plain write, then volatile write
        var t1 = new Thread(() -> { volData = 7; volFlag = true; });
        var t2 = new Thread(() -> { while (!volFlag) { } System.out.println("saw " + volData); });
        t2.start(); t1.start(); t1.join(); t2.join();

        // 2. Thread.start and join edges
        plainData = 99;
        var t3 = new Thread(() -> System.out.println("start edge: " + plainData));
        t3.start(); t3.join();
        plainData = 100;
        var t4 = new Thread(() -> plainData = 101);
        t4.start(); t4.join();
        System.out.println("join edge: " + plainData);

        // 3. Executor submit edge
        var pool = Executors.newSingleThreadExecutor();
        int[] shared = { 0 };
        shared[0] = 5;
        System.out.println(pool.submit(() -> shared[0]).get());
        pool.shutdown();

        // 4. Escaped this — what can the other thread see?
        var t5 = new Thread(() -> new Escape());
        t5.start();
        Thread.sleep(0, 500_000);
        Escape e = Escape.leaked;
        System.out.println(e == null ? "not yet" : "x=" + e.x);
        t5.join();
        System.out.println("after join x=" + Escape.leaked.x);

        // 5. What does a latch give you?
        var latch = new CountDownLatch(1);
        int[] box = { 0 };
        new Thread(() -> { box[0] = 77; latch.countDown(); }).start();
        latch.await();
        System.out.println(box[0]);
    }
}
```

## 16. Mastery check

1. Name the three agents that reorder your program and the one rule that constrains all of them.
2. Give the precise definition of a data race, and one example each of a race condition without a data race and vice versa.
3. List all eight happens-before edges.
4. Give five library-level happens-before edges.
5. State the SC-DRF guarantee and its corollary for a program with one race.
6. What does Java guarantee for a racy program, and what is the single exception?
7. Explain `volatile` as acquire/release, and say which C++ ordering it corresponds to.
8. State the roach-motel rule and name an optimisation it permits.
9. State the final-field guarantee and both conditions required for it.
10. Explain why a volatile read costs nothing on x86 and something on ARM.
