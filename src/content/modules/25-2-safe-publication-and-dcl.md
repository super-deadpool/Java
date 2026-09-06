---
title: "Safe publication, immutability, and double-checked locking"
phase: 25
order: 2
minutes: 45
summary: "The four ways to publish an object so other threads see it fully built, why the classic double-checked locking idiom was broken for a decade, and the design order: immutability, then confinement, then synchronization."
tags: ["safe-publication", "immutability", "double-checked-locking", "singleton", "thread-confinement"]
---

## 1. Publication and escape

**Publishing** an object makes it visible outside its current scope. **Escaping** is publishing something that was not meant to be published — or publishing it *too early*.

```java
public class Holder {
    private int n;
    public Holder(int n) { this.n = n; }
    public void assertSane() { if (n != n) throw new AssertionError("impossible");  }
}

// UNSAFE PUBLICATION: a plain field write
public Holder holder;
public void initialize() { holder = new Holder(42); }
```

**[JLS]** Another thread reading `holder` may observe:

- `null` — it has not seen the write yet;
- a **fully constructed** `Holder`;
- a **partially constructed** `Holder` — a non-null reference whose `n` is still `0`.

That third outcome is the one people refuse to believe, and it is exactly what `assertSane()` above is designed to catch: `n != n` can be **true**, because the two reads of a racily-published field can return different values. Object construction is not atomic, and without a happens-before edge (Module 25.1) nothing orders the constructor's writes against the reference write.

## 2. The four safe publication idioms

**[Goetz, *Java Concurrency in Practice*]** To publish an object safely, both the reference **and** the object's state must be made visible at the same time. There are exactly four language-level ways:

```java
// 1. Static initializer — the class initialization lock provides the edge (Module 22.1 §4)
public static final Holder HOLDER = new Holder(42);
static { OTHER = new Holder(1); }

// 2. Volatile field, or AtomicReference
private volatile Holder holder;
private final AtomicReference<Holder> ref = new AtomicReference<>();

// 3. Final field of a properly constructed object (Module 25.1 §7)
private final Holder holder = new Holder(42);

// 4. A field guarded by a lock, read under the same lock
private Holder holder;
public synchronized Holder get() { return holder; }
public synchronized void set(Holder h) { holder = h; }
```

Plus the library shortcuts, which are the ones you actually use:

```java
concurrentMap.put(key, obj);          // safe: the put/get pair carries an edge
blockingQueue.put(obj);
executor.submit(() -> use(obj));
future.complete(obj);
latch.countDown();                    // after writing obj
```

**The rule that covers most code:** *putting an object into any `java.util.concurrent` collection safely publishes it.* That is why passing objects between threads through a `BlockingQueue` needs no extra synchronization.

## 3. Immutable objects publish themselves

**[JLS 17.5]** An object is **immutable** when:

- all its fields are `final`;
- its state cannot be modified after construction (including the state of anything it references);
- `this` did not escape during construction.

Such an object can be published **by any means, safely, with no synchronization at all** — a plain field write, a data race, anything. The final-field freeze guarantees any thread that sees the reference sees the fully-built state.

```java
public final class Rates {                                 // immutable
    private final Map<String, BigDecimal> byCurrency;
    private final Instant asOf;

    public Rates(Map<String, BigDecimal> m, Instant asOf) {
        this.byCurrency = Map.copyOf(m);                   // defensive, immutable copy
        this.asOf = asOf;
    }
    public BigDecimal get(String c) { return byCurrency.get(c); }
}

// Publishing it needs nothing special. Even this plain field is safe:
private Rates current = new Rates(...);
```

Records (Module 5.2) give you this shape by construction, which is a large part of their value in concurrent code.

**Effectively immutable** objects — technically mutable, but never actually mutated after publication — are safe **only if safely published**. A `Date` handed off through a `BlockingQueue` and never touched again is fine; the same `Date` in a plain field is not.

**Volatile plus immutable is the workhorse pattern** for state that must change:

```java
private volatile Rates current;                            // whole-object replacement
public void refresh() { current = new Rates(load(), Instant.now()); }
public BigDecimal rate(String c) { return current.get(c); }   // no lock, no race
```

Readers are lock-free, writers are atomic at the object level, and there is no window where a partially updated state is visible. When you can express state as "replace the whole immutable snapshot", do.

## 4. Do not let `this` escape

The precondition for both final-field safety and constructor invariants. Three ways to break it:

```java
public class Broken {
    private final int value;

    public Broken(EventBus bus) {
        bus.register(this);              // 1. registered before construction finishes
        this.value = compute();
    }
}

public class Broken2 {
    private final int value;
    public Broken2() {
        new Thread(this::run).start();   // 2. a thread sees `this` before the constructor returns
        this.value = 42;
    }
}

public class Broken3 {
    protected Broken3() { init(); }      // 3. an overridable call — the subclass's override runs
    protected void init() { }            //    before the SUBCLASS's fields are assigned (Module 2.1)
}
```

The standard fix is a **static factory that constructs first and publishes second**:

```java
public class Safe {
    private final int value;
    private Safe(int v) { this.value = v; }

    public static Safe create(EventBus bus) {
        Safe s = new Safe(compute());     // fully constructed
        bus.register(s);                  // THEN published
        return s;
    }
}
```

## 5. Double-checked locking

The idiom that made the JMM famous, because for years it was **broken and looked correct**.

```java
// BROKEN — do not use. This was published in books.
private static Singleton instance;
public static Singleton getInstance() {
    if (instance == null) {                       // 1. cheap check, no lock
        synchronized (Singleton.class) {
            if (instance == null) {               // 2. re-check under the lock
                instance = new Singleton();       // 3. THE PROBLEM
            }
        }
    }
    return instance;
}
```

Line 3 is not one operation. It is roughly:

```text
1. allocate memory for the Singleton
2. run the constructor, writing its fields
3. assign the reference to `instance`
```

**Steps 2 and 3 may be reordered** — both by the JIT and by the hardware — because within the writing thread the result is indistinguishable. A second thread executing the *unsynchronized* first check can therefore see a **non-null `instance` whose constructor has not run**, and return a half-built object. The bug is rare, load-dependent, and unreproducible in a debugger.

**The fix, valid since Java 5 (JSR-133):**

```java
private static volatile Singleton instance;       // volatile is REQUIRED
public static Singleton getInstance() {
    Singleton result = instance;                  // read the volatile ONCE into a local
    if (result == null) {
        synchronized (Singleton.class) {
            result = instance;
            if (result == null) instance = result = new Singleton();
        }
    }
    return result;
}
```

`volatile` forbids the reordering (the release write cannot move before the constructor's writes) and gives the unsynchronized read the acquire edge it needs. The local variable is a real optimisation — it turns two volatile reads into one on the common path.

**But you should almost never write this.** Two better answers exist:

```java
// The HOLDER IDIOM — lazy, thread-safe, no synchronization, no volatile.
// The JVM's class initialization lock does the work (Module 22.1 §4).
public class Singleton {
    private Singleton() { }
    private static class Holder { static final Singleton INSTANCE = new Singleton(); }
    public static Singleton getInstance() { return Holder.INSTANCE; }
}

// The ENUM SINGLETON — additionally serialization- and reflection-safe (Module 15.1 §6)
public enum Singleton { INSTANCE; }
```

The full comparison:

| Approach | Lazy | Thread-safe | Cost per call | Notes |
| --- | --- | --- | --- | --- |
| Eager `static final` | ❌ | ✅ | None | Simplest; fine unless construction is expensive |
| `synchronized` getter | ✅ | ✅ | A lock **every call** | Correct but needlessly slow |
| DCL without `volatile` | ✅ | ❌ | — | **Broken** |
| DCL with `volatile` | ✅ | ✅ | One volatile read | Correct; verbose |
| **Holder idiom** | ✅ | ✅ | None after init | **The default answer** |
| **Enum** | ✅ | ✅ | None | Best when you want a true singleton |

## 6. Thread confinement — the alternative to synchronizing

The cheapest way to make shared state safe is **not to share it**.

| Technique | Mechanism | Example |
| --- | --- | --- |
| **Stack confinement** | A local variable is unreachable by other threads by construction | Build a `List` locally, return an unmodifiable copy |
| **`ThreadLocal`** | One instance per thread | `SimpleDateFormat` before `java.time`; request context |
| **Ad-hoc confinement** | By convention only — a single-threaded executor, an event loop | Swing's EDT, Netty's event loop |
| **Ownership transfer** | Hand the object off and never touch it again | A `BlockingQueue` between pipeline stages |

Ownership transfer through a blocking queue is the most valuable of these: it gives you safe publication *and* confinement, so each stage's object is single-threaded in practice with no locking anywhere.

`ThreadLocal` deserves the reminder from Module 23.2 §5: in a **pooled** thread it must be `remove()`d in a `finally`, or it leaks for the life of the pool. On virtual threads (Module 24.4), a million per-thread values is a footprint problem, which is why **scoped values** were introduced.

## 7. The design order

Concurrency correctness is a design decision, not a keyword. In order of preference:

```text
1. IMMUTABILITY      No mutable shared state -> nothing to synchronize. Records, final fields,
                     defensive copies, volatile whole-object replacement.

2. CONFINEMENT       Mutable state owned by exactly one thread -> no sharing. Stack locals,
                     ownership transfer through a queue, a single-threaded executor.

3. SAFE PUBLICATION  Shared but effectively immutable -> publish it correctly, then never mutate.

4. SYNCHRONIZATION   Genuinely shared mutable state -> a lock, an atomic, or a concurrent
                     collection. Document which lock guards which fields.

5. LOCK-FREE         CAS loops and custom algorithms. Rarely correct on the first attempt;
                     use java.util.concurrent's implementations instead of writing your own.
```

If you reach step 4, **document the policy**:

```java
/** Guarded by {@code this}. */
private final Map<String, Session> sessions = new HashMap<>();
```

An undocumented lock policy is the reason concurrent code decays: the next person cannot tell which fields the lock covers, adds a field without the lock, and the bug appears six months later under load.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ has the same publication problem and a cleaner standard answer.</strong> <code>std::call_once</code> with a <code>std::once_flag</code> is the canonical thread-safe lazy initialization, and since C++11 <strong>function-local statics ("magic statics") are guaranteed thread-safe</strong> — the compiler emits the guard for you. That construct is the exact analogue of Java's holder idiom, and it works for the same reason: the language guarantees the initialization happens exactly once with a barrier.</p>
<p>Double-checked locking is <strong>equally broken in C++</strong> without atomics, and equally fixable with <code>std::atomic&lt;T*&gt;</code> and release/acquire ordering. The Java and C++ stories here are genuinely parallel — DCL was the motivating example for both JSR-133 and the C++11 memory model.</p>
<p>What Java has and C++ lacks is the <strong>final-field freeze</strong>: an immutable Java object is safe to publish through a data race. In C++ a <code>const</code> object published through a non-atomic pointer has undefined behaviour like any other race; <code>const</code> carries no ordering.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Thread-safe lazy init | Magic statics, `std::call_once` | Holder idiom, enum, DCL + `volatile` |
| DCL correctness | Needs `std::atomic` + acquire/release | Needs `volatile` |
| Publish an immutable object | Still needs an atomic or a mutex | **Free** — final-field freeze |
| Immutability | `const`, or a type with no mutators | `final` fields + no mutators + records |
| Confinement | `thread_local`; ownership via `unique_ptr` move | `ThreadLocal`; hand-off via a queue |
| Ownership transfer | `std::move` — enforced by the type system | Convention only |
| Documenting a lock policy | Convention; `-Wthread-safety` in Clang | Convention; `@GuardedBy` (JSR-305/errorprone) |
| Escaped `this` | Same hazard, plus vtable is the base's during construction | Same hazard, plus the override *does* run |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><code>std::move</code> makes ownership transfer checkable by the compiler; Java's is pure convention. After <code>queue.put(obj)</code> nothing stops you from touching <code>obj</code>, and nothing warns you. Null out your reference, or build the object inside the producing scope so no reference survives.</p>
<p>Calling a virtual function from a constructor is "safe" in C++ in the sense that it dispatches to the base — surprising but defined. In Java it dispatches to the <strong>subclass override</strong>, which then runs before the subclass's fields exist. Same code, worse outcome.</p>
</div>

## 9. Edge cases

- **`volatile` on the reference does not make the object thread-safe.** `volatile List<String> list` publishes the list safely; concurrent `add` calls are still a race.
- **`final` protects the reference, not the referent.** A `final Map` field can still be mutated.
- **`Map.copyOf` returns the same object if the input is already an immutable map** — so it is not always a defensive copy of a *mutable* input's identity (Module 14.1 §7).
- **A partially constructed object can be observed twice with different values** — `n != n` really can be true.
- **Serialization and `readObject` bypass constructors** (Module 20.1 §3), so the final-field freeze does not apply the way you expect; the JVM handles it, but a custom `readObject` publishing `this` breaks it.
- **`ThreadLocal.withInitial` is lazy per thread**, and the supplier can run more than once across threads (once each) — it is not a singleton.
- **Class initialization can deadlock** across two threads with circular static dependencies (Module 22.1 §4) — the holder idiom is not immune if the held class initializes something circular.
- **`AtomicReference.compareAndSet` publishes safely**, so a CAS-based lock-free structure gets publication for free.
- **An object published safely and then mutated** is only as safe as the mutation protocol — safe publication is a one-time guarantee, not ongoing.
- **`@GuardedBy` is not enforced by javac** — only by Error Prone, SpotBugs, or IntelliJ inspections.

## 10. Common mistakes

- Assigning to a plain field and assuming other threads see a complete object.
- DCL without `volatile`.
- `synchronized` on the getter of a singleton, called millions of times.
- Registering `this` with a listener, executor, or thread inside a constructor.
- Calling an overridable method from a constructor.
- Making fields non-final "in case we need setters later", losing initialization safety.
- Publishing a mutable object and continuing to mutate it.
- `ThreadLocal` in a pool with no `remove()`.
- Not documenting which lock guards which state.
- Writing a lock-free algorithm instead of using `java.util.concurrent`.

## 11. Interview questions

**Beginner** — 1. What is publication? 2. What makes a class immutable? 3. Why is a singleton with a `synchronized` getter slow?

**Intermediate** — 4. Name the four safe publication idioms. 5. Why can another thread see a partially constructed object? 6. What is thread confinement and name three forms? 7. Why is an immutable object safe to share without synchronization?

**Advanced** — 8. Explain exactly why double-checked locking without `volatile` is broken — at the level of the three steps of `new`. 9. Why does the holder idiom work with no synchronization? 10. What are the two preconditions for final-field initialization safety? 11. Can `if (n != n)` ever be true? Explain.

**Senior** — 12. Give the design order for concurrent state and justify each step. 13. Review a class with a `volatile Map` field and concurrent `put`s: what is safe, what is not, and what would you change? 14. Design a hot-reloadable configuration used by 10 000 threads, read on every request, replaced once a minute. Justify every choice.

## 12. Follow-ups

- *After Q4:* "Which one do you use most often in real code?" → the concurrent collection shortcut.
- *After Q5:* "Give me the three outcomes a reader can observe."
- *After Q8:* "Why does `volatile` fix it? Name the barrier."
- *After Q9:* "What provides the happens-before edge?" → the class initialization lock.
- *After Q14:* → immutable snapshot in a volatile field.

## 13. Exercise

1. Write the `Holder`/`assertSane` unsafe-publication test with a publisher thread and a reader loop. Run it for a few million iterations on a multi-core machine (ideally ARM) until you observe `n == 0` or the assertion firing.
2. Implement all six singleton variants from §5. For each, measure per-call cost with JMH and write down when you would choose it.
3. Build the broken DCL and try to make it fail. If you cannot on x86, explain why, and say what would happen on a weakly-ordered machine.
4. Write a class that escapes `this` three different ways. For each, construct a scenario where another thread observes a default field value.
5. Implement a hot-reloadable `Config` two ways: a `volatile` immutable snapshot, and a `ConcurrentHashMap` mutated in place. Benchmark reads, then write down which semantics each gives a request that reads three keys.

## 14. Output prediction

```java
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class Main {
    static class Eager   { static final Eager I = new Eager();   private Eager()   { System.out.println("Eager ctor"); } }
    static class Holder  { private Holder() { System.out.println("Holder ctor"); }
                           private static class H { static final Holder I = new Holder(); }
                           static Holder get() { return H.I; } }
    enum EnumSingleton { INSTANCE; EnumSingleton() { System.out.println("Enum ctor"); } }

    static final class Immutable {
        private final List<String> items;
        private final int size;
        Immutable(List<String> in) { this.items = List.copyOf(in); this.size = items.size(); }
        List<String> items() { return items; }
    }

    public static void main(String[] args) throws Exception {
        System.out.println("--- before any access");
        System.out.println(Eager.I != null);
        System.out.println("--- holder not yet touched");
        System.out.println(Holder.get() != null);
        System.out.println(Holder.get() == Holder.get());
        System.out.println("--- enum");
        System.out.println(EnumSingleton.INSTANCE);

        var src = new ArrayList<>(List.of("a", "b"));
        var imm = new Immutable(src);
        src.add("c");
        System.out.println(imm.items() + " " + src);
        try { imm.items().add("d"); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var m1 = Map.of("k", 1);
        System.out.println(Map.copyOf(m1) == m1);
        var m2 = new HashMap<>(Map.of("k", 1));
        System.out.println(Map.copyOf(m2) == m2);

        // safe publication through a concurrent structure
        var q = new ArrayBlockingQueue<Immutable>(1);
        var pub = new Immutable(List.of("x", "y", "z"));
        new Thread(() -> { try { q.put(pub); } catch (Exception e) {} }).start();
        System.out.println(q.take().items());

        var ref = new AtomicReference<Immutable>();
        System.out.println(ref.compareAndSet(null, imm) + " " + ref.get().items());

        var pool = Executors.newSingleThreadExecutor();
        var tl = ThreadLocal.withInitial(() -> { System.out.println("supplier ran"); return new Object(); });
        pool.submit(tl::get).get();
        pool.submit(tl::get).get();
        pool.shutdown();
    }
}
```

## 15. Mastery check

1. Define publication and escape, and give the three outcomes of an unsafely published object.
2. List the four safe publication idioms and the library shortcut that covers most code.
3. State the three conditions for immutability and the guarantee they buy.
4. Explain why an effectively immutable object still needs safe publication.
5. Give three ways `this` escapes a constructor and the standard fix.
6. Explain why DCL without `volatile` is broken, in terms of the three steps of `new`.
7. Write the correct DCL, including the local-variable optimisation, and say what each part does.
8. Explain why the holder idiom needs no synchronization.
9. Compare the six singleton implementations on laziness, safety, and per-call cost.
10. Give the five-step design order for concurrent state and one technique from each step.
