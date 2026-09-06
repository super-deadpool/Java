---
title: "Garbage collection I: roots, reachability, generations, and safepoints"
phase: 23
order: 1
minutes: 45
summary: "What a GC root actually is, why reachability beats reference counting, the generational hypothesis and the machinery it requires, and why every collector needs to stop your threads at a safepoint."
tags: ["gc", "reachability", "generational", "safepoint", "write-barrier", "tlab"]
---

## 1. Concept

A garbage collector answers one question: **which objects can the program still reach?** Everything else is an implementation strategy.

```text
GC ROOTS  ──►  objects  ──►  objects  ──►  ...        REACHABLE — keep
                                                       everything else — collect
```

**GC roots** are the starting points, and you should be able to list them:

| Root | Why |
| --- | --- |
| Local variables and operand stack of every **live frame** on every thread | Currently executing code can name them |
| **`static` fields** of loaded classes | Reachable by name from anywhere |
| **Live threads** themselves | A running `Thread` object is always reachable |
| Objects held as **monitors** (inside a `synchronized` block) | The lock must survive |
| **JNI** local and global references | Native code holds pointers the JVM cannot see |
| **Class loaders and classes** they loaded, while the loader is reachable | Module 22.1 §7 |
| The run-time constant pool's object references | Interned strings, class literals |

**Reachability, not reference counting.** A cycle of objects referring only to each other is unreachable from any root, so Java collects it — no `weak_ptr` needed. That single property is the biggest day-to-day difference from `shared_ptr`-based C++ memory management.

## 2. The five reachability levels

**[JDK]** From strongest to weakest, an object is:

| Level | Definition | Collected |
| --- | --- | --- |
| **Strongly reachable** | Reachable from a root without traversing a `Reference` | Never |
| **Softly reachable** | Not strong; reachable through a `SoftReference` | When the JVM decides memory is tight — before `OutOfMemoryError` |
| **Weakly reachable** | Not strong or soft; reachable through a `WeakReference` | At the **next** GC that notices |
| **Phantom reachable** | Finalized (if applicable), reachable only via a `PhantomReference` | After the reference is enqueued and cleared |
| **Unreachable** | Nothing | Immediately eligible |

Module 23.2 covers what to do with each. The level exists to answer "can I hold a reference that does not prevent collection?" — the basis of every cache and every native-resource cleaner.

## 3. The generational hypothesis

**The weak generational hypothesis: most objects die young.** In typical Java workloads, well over 90% of allocations are unreachable by the next collection — request-scoped objects, boxed values, iterators, `StringBuilder`s, lambdas.

That observation buys an enormous optimisation: **collect only the young objects, and do it by copying the survivors.**

```text
YOUNG GENERATION                                        OLD GENERATION
+---------------+-------+-------+                       +------------------------+
|     Eden      |  S0   |  S1   |                       |       Tenured          |
+---------------+-------+-------+                       +------------------------+
  allocation      one is always empty                     objects that survived
                                                          enough young collections
```

A **minor (young) GC**:

1. Trace from the roots **into the young generation only**.
2. Copy every live object out of Eden and the occupied survivor space into the *other* survivor space, incrementing its **age**.
3. Objects whose age exceeds `-XX:MaxTenuringThreshold` (default 15, capped by the 4 age bits in the mark word) are **promoted** to Old.
4. Declare Eden and the vacated survivor space empty — in one operation.

Why this is fast, and the point that matters: **the cost is proportional to the number of *surviving* objects, not to the amount of garbage.** Freeing 500 MB of dead objects costs nothing; the collector never looks at them. "Allocation is cheap, survival is expensive" is the whole model.

Copying also **compacts** for free — survivors are packed contiguously in the destination — which is what keeps allocation a pointer bump (Module 22.2 §5) with no fragmentation and no free lists.

## 4. Remembered sets and the write barrier

A young-only collection has a problem: an old object can reference a young one. Tracing the whole old generation to find those references would destroy the benefit.

**The solution: track old→young references as they are created.** HotSpot divides the heap into **cards** (512 bytes) and keeps a **card table** — one byte per card. Every reference store executes a **write barrier**:

```java
obj.field = other;
// the JIT emits, roughly:
//   store the reference
//   cardTable[(address(obj)) >> 9] = DIRTY;
```

At the next minor GC, dirty cards are scanned as additional roots. G1 generalises this to per-region **remembered sets**.

Two consequences you can be asked about:

- **Every reference field write costs a few extra instructions.** This is a permanent, unavoidable tax on Java programs — one reason primitive arrays (no barriers) beat object arrays for bulk numeric work.
- **A concurrent collector needs a stronger barrier.** Marking while the application mutates the graph can miss objects; the two standard fixes are **SATB** (snapshot-at-the-beginning — record the *old* value on overwrite, used by G1 and Shenandoah) and **incremental update** (record the new value). SATB is conservative: an object that dies during marking is still retained until the next cycle ("floating garbage").

**Tri-colour marking** is the vocabulary: white = not yet reached, grey = reached but its references not yet scanned, black = fully scanned. The invariant a concurrent collector must preserve is that **no black object ever points to a white object** without the collector knowing — which is exactly what the barriers enforce.

## 5. Safepoints and stop-the-world

Even "concurrent" collectors need brief pauses, and every pause happens at a **safepoint**.

A safepoint is a point in execution where the JVM knows precisely where every reference lives — in which register, which stack slot, which field. Compiled code carries an **oop map** for each safepoint. Between safepoints the JVM cannot move objects, because it cannot find all the pointers to update.

**[HotSpot]** Reaching a safepoint:

- Compiled code contains **safepoint polls** — at method returns and at loop back-edges. The poll is a read from a page the JVM protects when it wants to stop the world; the resulting fault traps the thread.
- Interpreted threads check a flag.
- Threads **already blocked** or in native code are already at a safepoint and need no action.

**Time-to-safepoint (TTSP)** is the delay between "please stop" and "all threads have stopped", and it is counted as part of the pause. The classic pathology:

```java
// A COUNTED loop with an int index: HotSpot omits the back-edge safepoint poll,
// because it can prove the loop terminates. A very long one delays every thread in the JVM.
for (int i = 0; i < 2_000_000_000; i++) { sum += data[i & mask]; }
```

**[HotSpot]** Int-counted loops are safepoint-poll-free by default; changing the index to `long` reintroduces the poll. A multi-second TTSP with a 5 ms GC pause looks, in GC logs, like a fast collector and a mysteriously frozen application. `-Xlog:safepoint` and `-XX:+SafepointTimeout` expose it.

Safepoints are also used for far more than GC: thread dumps, biased-lock revocation (historically), class redefinition, deoptimization, and `Thread.getStackTrace` all require one.

## 6. The numbers that actually matter

Tuning starts with two rates, both readable from GC logs:

| Metric | What it tells you | Typical fix when bad |
| --- | --- | --- |
| **Allocation rate** (MB/s into Eden) | How fast you create garbage | Reduce allocation: boxing, defensive copies, string building, streams over primitives |
| **Promotion rate** (MB/s into Old) | How much survives young collection | Bigger young gen, or fix objects living too long |
| Young pause time & frequency | Cost of survivors | Size the young gen |
| Old/mixed pause time | Cost of the old generation | Change collector or heap size |
| GC overhead (% of wall clock) | Whether GC is your problem at all | Above ~10% is a problem; below ~2% look elsewhere |

**Premature promotion** is the most common tunable pathology: the young generation is too small, so objects that would have died are copied into Old, where collecting them is expensive. The symptom is a high promotion rate with a low old-generation *live* set, and rising full-GC frequency. The fix is usually a larger heap or young generation, not a different collector.

```bash
-Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=5,filesize=20M
-Xlog:gc+heap=debug -Xlog:safepoint -Xlog:gc+age=trace     # tenuring distribution
```

## 7. What happens internally

**Allocation** goes to a TLAB (Module 22.2 §5). When a TLAB cannot be refilled and Eden is full, a minor GC is triggered.

**Large objects bypass the young generation.** An allocation larger than a TLAB may go directly to Eden; above `-XX:PretenureSizeThreshold` (Parallel GC) or half a region (G1's *humongous* objects) it goes straight to Old. A steady stream of large arrays therefore pressures the old generation directly and can cause full GCs with a mostly-empty young generation.

**Survivor space sizing.** `-XX:SurvivorRatio` sets Eden:Survivor. If survivors do not fit, objects are promoted early regardless of age — *premature promotion by overflow*. `-Xlog:gc+age=trace` prints the tenuring distribution and tells you directly whether this is happening.

**Finalization is gone.** `Object.finalize()` was deprecated in Java 9, **deprecated for removal in Java 18 (JEP 421)** with `--finalization=disabled` to turn it off, and is slated for removal. It was always a mistake: it delayed collection by an extra cycle, ran on an unbounded-latency finalizer thread, could resurrect objects, and had no ordering or timing guarantee. The replacement is `Cleaner` plus try-with-resources (Module 23.2).

**`System.gc()`** is a *hint*, ignorable, and disabled entirely by `-XX:+DisableExplicitGC`. When it is honoured it usually triggers a **full, stop-the-world** collection — which is why calling it in application code is a defect, not a tuning technique. Its one legitimate use is in a benchmark harness between iterations.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ deallocation is deterministic and immediate.</strong> A destructor runs at a known point; <code>delete</code> costs work proportional to what you are freeing; RAII ties resource lifetime to scope. Reference counting via <code>shared_ptr</code> makes the cost incremental and predictable — and <strong>leaks cycles</strong>, which is why <code>weak_ptr</code> exists.</p>
<p><strong>Java deallocation is deferred and batched.</strong> Nothing happens at the moment an object becomes garbage; cost is paid later, proportional to <em>survivors</em>, at a time you do not choose. Cycles are free. The trade is throughput and simplicity for latency predictability — and it is why Java needs try-with-resources: the GC manages memory, but it manages <strong>nothing else</strong>, so file descriptors, sockets and locks still need explicit, scoped release.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| When memory is freed | Deterministically, at destruction | Whenever the collector runs |
| Cost model | Proportional to what you free | Proportional to what **survives** |
| Cycles | Leak with `shared_ptr`; need `weak_ptr` | Collected |
| Fragmentation | Real; needs pool/arena allocators | Eliminated by compaction |
| Allocation cost | `malloc`: shared free list, locking | TLAB pointer bump |
| Pauses | None from memory management | Stop-the-world at safepoints |
| Non-memory resources | RAII destructors | try-with-resources; GC does not help |
| Write cost | A plain store | A store **plus a write barrier** |
| Locality | You control it | The collector controls it (and compaction often helps) |
| Tuning surface | Allocators, arenas | Collector choice, heap sizing, allocation reduction |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Expecting an object to be "freed" when the last reference is dropped, and writing <code>obj = null</code> to trigger it. Nulling a field only matters when the field is <em>long-lived</em> (a static, a cache, an array slot in a collection you wrote); a local going out of scope is already unreachable and the assignment is dead code the JIT removes.</p>
<p>Assuming garbage collection handles resources. It handles memory. A leaked file descriptor is not memory, and no collector will close it in time.</p>
</div>

## 9. Edge cases

- **An object can be collected while one of its methods is still running**, if `this` is no longer used later in the method. This surprises people writing `Cleaner`-based resource classes — hence `Reference.reachabilityFence`.
- **Nulling a local variable is almost always pointless**; nulling an element of a long-lived array is not (`ArrayList.remove` explicitly nulls the vacated slot, and so does `ArrayDeque`).
- **A `static` field is a root for as long as its class is loaded**, which is as long as its class loader lives.
- **Interned strings** live in the heap (since Java 7) but are referenced by the string table; over-interning user input is a real leak.
- **`SoftReference` behaviour is JVM-wide and heuristic** (`-XX:SoftRefLRUPolicyMSPerMB`, default 1000 ms per free MB) — it is not an LRU cache, and using it as one gives unpredictable hit rates.
- **Floating garbage:** SATB marking retains objects that died during the concurrent mark. Heap usage after a concurrent cycle is not the true live set.
- **A minor GC can trigger a full GC** if promotion fails and Old cannot accommodate the survivors ("promotion failure" / "to-space exhausted" in G1 logs).
- **`OutOfMemoryError: GC overhead limit exceeded`** means over 98% of time in GC recovering under 2% of heap — the JVM refusing to thrash. It is a symptom of a leak or an undersized heap, not of GC configuration.
- **Threads in native code do not need to be stopped** for a safepoint — but they must not return into Java until the safepoint ends, which is why a long JNI call can look like a stuck thread.
- **`-Xmx` equal to `-Xms`** avoids heap resizing, which itself causes full GCs on some collectors.

## 10. Common mistakes

- Calling `System.gc()`.
- Nulling locals "to help the GC".
- Believing the GC closes resources.
- Reading heap usage right after a concurrent cycle as the live set.
- Tuning collector flags before measuring allocation and promotion rates.
- Treating `OutOfMemoryError: GC overhead limit exceeded` as a flag problem.
- Ignoring time-to-safepoint and blaming the collector for a multi-second freeze.
- Using `SoftReference` as a cache eviction policy.
- Relying on `finalize()`.
- Allocating large arrays in a loop and wondering why the old generation fills with an empty young generation.

## 11. Interview questions

**Beginner** — 1. What is garbage collection? 2. Name four GC roots. 3. Does Java collect cyclic garbage?

**Intermediate** — 4. What is the generational hypothesis? 5. Describe a minor GC step by step. 6. What are the survivor spaces for? 7. Why is `System.gc()` a bad idea?

**Advanced** — 8. Why is a young collection's cost proportional to survivors rather than garbage? 9. What problem do the card table and write barrier solve? 10. What is a safepoint and why does the JVM need one to move objects? 11. Explain premature promotion: symptom, cause, fix.

**Senior** — 12. An application freezes for 4 seconds but GC logs show 8 ms pauses. Diagnose. 13. Explain SATB versus incremental-update barriers and what floating garbage is. 14. You have allocation rate 2 GB/s, promotion rate 300 MB/s, 12% GC overhead. What do you change first, and why not the collector?

## 12. Follow-ups

- *After Q3:* "How, without reference counting?"
- *After Q5:* "Where do objects go when survivor space overflows?"
- *After Q9:* "What does that cost every reference store?"
- *After Q10:* "Which loops omit the poll and why?"
- *After Q14:* → allocation reduction first; sizing second; collector last.

## 13. Exercise

1. Write an allocation loop and capture `-Xlog:gc*`. Compute allocation rate and promotion rate by hand from the log. Then shrink the young generation and recompute both.
2. Use `-Xlog:gc+age=trace` to print the tenuring distribution for a workload where objects live for exactly 3 collections. Tune `MaxTenuringThreshold` and show the promotion rate change.
3. Reproduce a long time-to-safepoint: an int-counted loop over two billion iterations in one thread while another thread requests thread dumps. Measure the stall with `-Xlog:safepoint`. Change the index to `long` and re-measure.
4. Create a cyclic object graph, drop all external references, and prove with a heap histogram before and after `jcmd GC.run` that it was collected.
5. Build a benchmark that allocates 100 MB/s of short-lived objects, and a second that allocates 10 MB/s of objects that survive 20 collections. Compare GC overhead and explain which is worse and why.

## 14. Output prediction

```java
import java.lang.ref.*;
import java.util.*;

public class Main {
    static Object strongRoot;

    static class Big { final byte[] payload = new byte[1024 * 1024]; final String id;
                       Big(String id) { this.id = id; } }

    public static void main(String[] args) throws Exception {
        var q = new ReferenceQueue<Big>();

        Big a = new Big("a");
        WeakReference<Big> weak = new WeakReference<>(a, q);
        System.out.println(weak.get() != null);
        a = null;
        System.gc(); Thread.sleep(200);
        System.out.println(weak.get() != null);
        System.out.println(q.poll() == weak);

        Big b = new Big("b");
        strongRoot = b;
        WeakReference<Big> weak2 = new WeakReference<>(b);
        b = null;
        System.gc(); Thread.sleep(200);
        System.out.println(weak2.get() != null);

        // a cycle with no external references
        var x = new ArrayList<Object>();
        var y = new ArrayList<Object>();
        x.add(y); y.add(x);
        WeakReference<Object> cyc = new WeakReference<>(x);
        x = null; y = null;
        System.gc(); Thread.sleep(200);
        System.out.println(cyc.get() != null);

        SoftReference<Big> soft = new SoftReference<>(new Big("s"));
        System.gc(); Thread.sleep(200);
        System.out.println(soft.get() != null);

        var map = new WeakHashMap<String, String>();
        String k = new String("key");
        map.put(k, "v");
        System.out.println(map.size());
        k = null;
        System.gc(); Thread.sleep(200);
        System.out.println(map.size());

        var interned = new WeakHashMap<String, String>();
        interned.put("literal", "v");
        System.gc(); Thread.sleep(200);
        System.out.println(interned.size());
    }
}
```

## 15. Mastery check

1. List seven categories of GC root.
2. Explain why reachability collects cycles and reference counting does not.
3. Name the five reachability levels and when each is cleared.
4. State the generational hypothesis and describe a minor GC in four steps.
5. Explain why young-collection cost scales with survivors, and what that means for allocation-heavy code.
6. What is the card table, what is the write barrier, and what do they cost?
7. Explain tri-colour marking and the invariant a concurrent collector must maintain.
8. Define a safepoint, explain the poll mechanism, and give the counted-loop pathology.
9. Explain premature promotion: two causes, one symptom, two fixes.
10. Which two rates do you measure first, and what does each tell you to change?
