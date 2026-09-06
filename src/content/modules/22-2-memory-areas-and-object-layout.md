---
title: "Runtime data areas and object layout: headers, compressed oops, TLABs, and where the bytes go"
phase: 22
order: 2
minutes: 50
summary: "The JVM's memory regions, what a frame contains, the exact byte layout of an object on HotSpot, why 32 GB is a cliff, and why an array of objects is not an array of objects."
tags: ["jvm", "heap", "stack", "object-header", "compressed-oops", "tlab", "metaspace"]
---

## 1. The runtime data areas

**[JVMS 2.5]** The specification defines six regions, split by whether they are per-thread or shared.

```text
PER THREAD                              SHARED
  PC register      current instruction    Heap             all objects and arrays
  JVM stack        frames                 Method area      class metadata, code, constant pools
  Native stack     JNI frames             ...of which the run-time constant pool is a part
```

**[HotSpot]** maps that onto:

| Spec region | HotSpot reality | Sized by | Exhaustion |
| --- | --- | --- | --- |
| Heap | Young (Eden + 2 Survivors) + Old | `-Xms` / `-Xmx` | `OutOfMemoryError: Java heap space` |
| JVM stack | One native stack per thread | `-Xss` (default ~1 MB) | `StackOverflowError` |
| Method area | **Metaspace** — native memory | `-XX:MaxMetaspaceSize` | `OutOfMemoryError: Metaspace` |
| — | **Code cache** — JIT output | `-XX:ReservedCodeCacheSize` | `CodeCache is full`, JIT disables itself |
| — | **Direct memory** — `ByteBuffer.allocateDirect`, mmap | `-XX:MaxDirectMemorySize` | `OutOfMemoryError: Direct buffer memory` |
| — | Thread stacks, GC structures, JNI, malloc | — | Native OOM / the OOM killer |

The practical consequence: **`-Xmx` does not bound the process.** A JVM with `-Xmx4g` routinely uses 5–6 GB of RSS once you add Metaspace, code cache, thread stacks (1 MB × threads), GC overhead, and direct buffers. Container memory limits must account for all of it, and `-XX:MaxRAMPercentage` exists because of exactly this.

## 2. A stack frame

**[JVMS 2.6]** Each method invocation pushes a frame containing three things:

```text
+-------------------------------------------------+
| local variable array   slot 0 = this (instance)  |   fixed size, computed by javac
|                        slot 1..n = params, locals|   long/double occupy TWO slots
+-------------------------------------------------+
| operand stack          the working stack         |   max depth computed by javac
+-------------------------------------------------+
| reference to the run-time constant pool          |
+-------------------------------------------------+
```

Both sizes are constants baked into the `Code` attribute (`max_locals`, `max_stack`) — which is why the JVM can allocate the whole frame in one step and why the verifier can prove the operand stack never underflows.

```text
int add(int a, int b) { return a + b; }        // instance method
  locals: [0]=this [1]=a [2]=b        max_stack=2
  iload_1; iload_2; iadd; ireturn
```

**`StackOverflowError`** means frames exhausted `-Xss` — deep or infinite recursion. Note the interaction: **more threads means less memory for everything else**, because each thread reserves a full stack. 10 000 platform threads at 1 MB is 10 GB of reserved address space, which is precisely the constraint virtual threads remove (Phase 24).

## 3. Object layout on HotSpot

**[HotSpot]** — this is implementation detail, not specification, and it has changed recently.

```text
64-bit JVM, compressed oops ON (the default under 32 GB heap):

+--------------------------------+
| mark word            8 bytes   |  hash, GC age, lock state, forwarding pointer during GC
+--------------------------------+
| klass pointer        4 bytes   |  compressed; 8 bytes with -XX:-UseCompressedClassPointers
+--------------------------------+
| [array length]       4 bytes   |  arrays only
+--------------------------------+
| instance fields      ...       |  reordered by the JVM, aligned
+--------------------------------+
| padding                        |  to a multiple of 8 bytes (-XX:ObjectAlignmentInBytes)
+--------------------------------+
```

So the sizes people quote in interviews:

```java
new Object()                 // 16 bytes  (12 header + 4 padding)
new Integer(1)               // 16 bytes  (12 header + 4 int)
new Long(1L)                 // 16 bytes  (12 header + 8 long, aligned to 24? no — 12+8=20 -> 24)
new int[0]                   // 16 bytes  (16 header)
new byte[10]                 // 24 bytes  (16 header + 10 + 6 padding)
"abc"                        // 24 bytes for the String  + 24 for its byte[]  = 48 total
```

Verify these rather than memorising them — **JOL (Java Object Layout)** prints the real thing:

```java
System.out.println(org.openjdk.jol.info.ClassLayout.parseInstance(obj).toPrintable());
```

**Field reordering.** The JVM does *not* lay fields out in declaration order. It groups by size — longs/doubles, then ints/floats, then shorts/chars, then bytes/booleans, then references — to minimise padding, and it packs superclass fields before subclass fields. A class declaring `byte, long, byte, long` costs the same as `long, long, byte, byte`.

**The mark word** carries, depending on the lock state: the identity hash code (computed lazily on first `hashCode()` call — before that there is no hash stored), the GC age (how many collections survived), and the lock bits. **[HotSpot]** *Biased locking*, which used to live here, was disabled by default in Java 15 and **removed in Java 18**; the modern states are unlocked, thin-locked (a pointer to a lock record on the owner's stack), and inflated (a pointer to a monitor).

**[HotSpot]** **JEP 450 (Java 24) — compact object headers** shrinks the header to **8 bytes** by merging the klass pointer into the mark word, cutting heap use by roughly 10–20% on typical workloads. Enabled with `-XX:+UseCompactObjectHeaders`. Expect the numbers above to change.

## 4. Compressed oops and the 32 GB cliff

An "oop" is an *ordinary object pointer*. On a 64-bit JVM a raw reference is 8 bytes; **compressed oops** store a 32-bit value instead and reconstruct the address by shifting.

```text
address = base + (compressed_oop << 3)          // 3 = log2(8-byte alignment)
```

Because objects are 8-byte aligned, the low three bits of every address are zero and carry no information — so 32 bits of storage addresses 2³² × 8 = **32 GB** of heap. **[HotSpot]** Compressed oops are on by default whenever `-Xmx` is under that threshold (roughly 32 GB, a little less in practice).

The consequence is a genuine performance cliff:

```text
-Xmx31g   -> compressed oops ON:  4-byte references, more objects per cache line
-Xmx33g   -> compressed oops OFF: 8-byte references, every object grows,
                                  ~20% more heap needed for the SAME live set
```

A 33 GB heap can hold **less** live data than a 31 GB one. The standard advice: stay under ~31 GB, or jump well past it (64 GB+) so the extra capacity outweighs the loss.

There are two flavours: **zero-based** (the heap is mapped so `base` is 0, making decoding a single shift) and **based** (an extra add). Below ~26 GB the JVM usually gets a zero-based mapping. `-XX:+PrintFlagsFinal` and `-Xlog:gc+heap+coops` show which you got.

Class pointers are compressed separately (`UseCompressedClassPointers`, backed by a compressed class space in Metaspace, `-XX:CompressedClassSpaceSize`).

## 5. Allocation: why `new` is nearly free

**[HotSpot]** Allocation is **bump-the-pointer** in a **TLAB** (Thread-Local Allocation Buffer): each thread owns a private chunk of Eden and allocates by incrementing a pointer.

```text
if (tlab.top + size <= tlab.end) {      // the fast path: a compare and an add
    obj = tlab.top;
    tlab.top += size;
} else {
    slow path: get a new TLAB, or allocate directly in Eden, or trigger a GC
}
```

That is roughly **ten instructions with no locking**, because the TLAB is thread-private. It is the reason "Java allocation is faster than C `malloc`" is a defensible claim — `malloc` must consult a shared, lock-protected free list, while a bump allocator does not.

The cost is deferred to the collector, and the accounting is different: **allocation is cheap; surviving is expensive** (Phase 23). Objects larger than a TLAB go straight to Eden or, above `-XX:PretenureSizeThreshold`, straight to Old.

`-XX:+PrintTLAB`, `-Xlog:gc+tlab` show TLAB sizing, which HotSpot adapts per thread based on observed allocation rate.

## 6. The layout consequence that matters for performance

Java has **no value types** (until Valhalla). Every non-primitive field is a **reference**, and every array of objects is an **array of references**.

```java
class Point { double x, y; }
Point[] points = new Point[1_000_000];
```

```text
Java                                        C++ (std::vector<Point>)
points ---> [ref][ref][ref]...              [x][y][x][y][x][y]...   contiguous, 16 B/element
              |    |    |
              v    v    v
           {hdr,x,y} {hdr,x,y} ...          one cache line holds 4 Points
           32 bytes each, ANYWHERE in the heap
```

Iterating `points` to sum `x` in Java is **pointer chasing**: one cache miss per element unless the GC happened to lay them out contiguously (a compacting collector often does, for objects allocated together — which is why allocation order matters). The C++ version streams through memory at full bandwidth.

The two standard mitigations:

```java
// 1. Structure of arrays: primitive arrays ARE contiguous
double[] xs = new double[1_000_000], ys = new double[1_000_000];

// 2. Flatten into a primitive array with manual indexing
double[] xy = new double[2_000_000];        // xy[2i], xy[2i+1]
```

This is the single largest systematic performance difference between Java and C++ for data-heavy code, and it is entirely a layout consequence. **Project Valhalla**'s value classes are designed to close it by allowing flattened, header-free objects.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>A C++ object has no header.</strong> <code>struct Point { double x, y; }</code> is exactly 16 bytes and <code>sizeof</code> says so. A polymorphic class adds one 8-byte vptr; that is all. Objects live wherever you put them — stack, static storage, inside another object, inside a <code>vector</code>'s contiguous buffer, or on the heap.</p>
<p><strong>Every Java object has a 12-byte header, lives on the heap, and is reached through a reference.</strong> A "<code>Point</code>" costs 32 bytes instead of 16 and cannot be embedded in anything. In exchange you get a compacting allocator that makes <code>new</code> a pointer bump, uniform GC, and a mark word that carries the lock and the hash so every object can be synchronized on and hashed.</p>
</div>

| Concern | C++ | Java (HotSpot) |
| --- | --- | --- |
| Per-object overhead | 0, or 8 (vptr) | 12 bytes (8 with JEP 450) |
| `sizeof` | Exact, compile time | No equivalent; use JOL or an agent |
| Storage location | Stack / static / member / heap | Heap only (modulo scalar replacement) |
| Field order | Declaration order (ABI-fixed) | **Reordered** by the JVM |
| Array of objects | Contiguous values | Contiguous **references** |
| Allocation | `malloc` — shared free list, locking | TLAB bump pointer |
| Deallocation | `free`/destructor — deterministic | GC — deferred, amortised |
| Pointer size | 8 bytes | 4 with compressed oops |
| Alignment control | `alignas`, `#pragma pack` | `-XX:ObjectAlignmentInBytes` only |
| Cache-friendly layout | Default | Requires SoA by hand |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Reaching for a <code>Point[]</code> the way you would a <code>vector&lt;Point&gt;</code> and expecting the same memory behaviour. Measure it: for a million-element traversal the Java version can be 5–10× slower purely from cache misses. Use parallel primitive arrays when the data is hot.</p>
<p>Sizing a container by <code>-Xmx</code>. Metaspace, code cache, thread stacks and direct buffers are all outside it; the process will be killed for using memory the JVM never counted.</p>
</div>

## 8. Edge cases

- **`long` and `double` are two slots in a frame** but are still atomic on 64-bit HotSpot; the spec permits non-atomic access for non-`volatile` 64-bit fields (Phase 25).
- **The identity hash is stored in the mark word on first use** — so calling `hashCode()` on an object can prevent certain lock optimizations and is not free the first time.
- **`-XX:ObjectAlignmentInBytes=16`** raises the compressed-oop ceiling to 64 GB, at the cost of more padding per object.
- **Metaspace `OutOfMemoryError` has nothing to do with `-Xmx`.** It usually means a class-loader leak (Module 22.1 §7).
- **`CodeCache is full`** disables the JIT and the application silently drops to interpreted speed. Watch for "CodeCache is full. Compiler has been disabled" in the log.
- **Thread stacks are reserved, not committed** — 1 000 threads at `-Xss1m` reserve 1 GB of address space but commit only the pages actually touched.
- **Escape analysis can make an object never exist** (Module 22.3), so "every object is on the heap" is true of the spec's model, not always of the machine code.
- **A `String` is two objects** since Java 9 (the `String` plus its `byte[]`), and compact strings store Latin-1 in one byte per character with a `coder` flag.
- **Arrays are limited to `Integer.MAX_VALUE` elements**, and in practice `MAX_VALUE - 8` on HotSpot because of the header.
- **`-Xmx` and `-Xms` equal** avoids heap resizing pauses; in containers prefer `-XX:MaxRAMPercentage=75`.

## 9. Common mistakes

- Sizing a container to `-Xmx` and getting OOM-killed.
- Choosing a 33 GB heap and losing to a 31 GB one.
- Assuming field declaration order is memory order.
- Assuming an object's size is the sum of its fields.
- Using an array of small objects for numeric work.
- Blaming the GC for what is really a cache-miss problem.
- Creating thousands of platform threads without accounting for stack reservation.
- Ignoring `OutOfMemoryError: Metaspace` as "just raise the limit".
- Not monitoring code cache in a large, long-running application.
- Treating heap dumps as the whole picture when the leak is in direct memory.

## 10. Interview questions

**Beginner** — 1. Name the JVM memory areas. 2. What is on the stack versus the heap? 3. What is `StackOverflowError` versus `OutOfMemoryError`?

**Intermediate** — 4. What does a stack frame contain? 5. Where does class metadata live since Java 8? 6. Why does `-Xmx4g` not mean a 4 GB process? 7. How big is `new Object()`?

**Advanced** — 8. Describe the HotSpot object header field by field. 9. What are compressed oops and where does 32 GB come from? 10. Why can a 33 GB heap hold less than a 31 GB heap? 11. What is a TLAB and why is Java allocation ~10 instructions?

**Senior** — 12. Explain why `Point[]` performs worse than `vector<Point>` and give two mitigations. 13. A container is OOM-killed while heap usage sits at 40%. Give five hypotheses and how to test each. 14. What does Valhalla change about everything in this module?

## 11. Follow-ups

- *After Q7:* "And `new Long(1)`? `new byte[10]`? Show your arithmetic."
- *After Q9:* "What is zero-based versus based, and how do you tell which you have?"
- *After Q11:* "So why is Java allocation sometimes still slow?" → the collector, not the allocator.
- *After Q12:* "How would you measure the difference?" → perf counters for cache misses, not just wall clock.
- *After Q13:* → Metaspace, code cache, thread stacks, direct buffers, native libraries.

## 12. Exercise

1. Add JOL to a project and print the layout of: `Object`, `Integer`, `Long`, a class with `byte, long, byte, long`, a class with the same fields reordered, `byte[10]`, and `"abc"`. Explain every padding byte.
2. Run the same heap-heavy benchmark with `-Xmx31g` and `-Xmx33g` and report peak live set and throughput. Confirm the oops mode with `-Xlog:gc+heap+coops`.
3. Benchmark summing a field over `Point[1_000_000]` versus two `double[1_000_000]` arrays. Then measure L1/LLC misses with `perf stat` and connect the numbers.
4. Write a recursion that overflows the stack and measure the depth reached at `-Xss256k`, `-Xss1m`, and `-Xss8m`. Explain the ratio and why it is not exactly linear.
5. Fill the code cache with `-XX:ReservedCodeCacheSize=5m` on a large application. Capture the log line, then measure the throughput drop after the JIT disables itself.

## 13. Output prediction

```java
import java.lang.management.*;
import java.util.*;

public class Main {
    static int depth = 0;
    static void recurse() { depth++; recurse(); }

    public static void main(String[] args) {
        System.out.println(Runtime.getRuntime().maxMemory() / (1024 * 1024) + " MB max");
        System.out.println(Runtime.getRuntime().availableProcessors());

        for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans())
            System.out.println(p.getName() + " | " + p.getType());

        try { recurse(); }
        catch (StackOverflowError e) { System.out.println("depth > " + (depth > 1000)); }

        long[] a = new long[3];
        Object[] b = new Object[3];
        System.out.println(a.length + " " + b.length + " " + b[0]);
        System.out.println(a.getClass().getName() + " " + b.getClass().getName());

        Object o = new Object();
        int h1 = System.identityHashCode(o), h2 = System.identityHashCode(o);
        System.out.println(h1 == h2);
        System.out.println(o.hashCode() == h1);

        String s = "hello";
        System.out.println(s.getClass().getName());

        var list = new ArrayList<Integer>();
        for (int i = 0; i < 5; i++) list.add(i);
        System.out.println(list.get(0) == list.get(0));
        var big = new ArrayList<Integer>();
        for (int i = 1000; i < 1005; i++) big.add(i);
        System.out.println(big.get(0).equals(1000));

        try { new int[Integer.MAX_VALUE]; }
        catch (Throwable t) { System.out.println(t.getClass().getSimpleName()); }
    }
}
```

## 14. Mastery check

1. Name the six spec regions and how HotSpot realises each.
2. What is in a stack frame, and which two sizes are compile-time constants?
3. Draw the HotSpot object header with byte offsets, with and without compressed oops.
4. Compute the size of `new Object()`, `new Long(1L)`, and `new byte[10]`, showing the padding.
5. Explain compressed oops, the encoding formula, and where 32 GB comes from.
6. Why can a larger heap hold a smaller live set?
7. Describe TLAB allocation and why it needs no lock.
8. Explain why `Point[]` is pointer chasing and name two mitigations.
9. List five memory regions outside `-Xmx` that a container limit must cover.
10. Which of everything in this module is `[JVMS]` and which is `[HotSpot]`?
