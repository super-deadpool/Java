---
title: "Stream pipelines: laziness, the sink chain, and what a terminal operation really triggers"
phase: 12
order: 1
minutes: 50
summary: "A stream is a one-shot, lazy, element-at-a-time pipeline over a Spliterator — not a collection. What that buys, what it costs, and where a plain loop still wins."
tags: ["streams", "laziness", "spliterator", "short-circuit", "intstream"]
---

## 1. Concept

A stream is **a description of a computation over a sequence**, not a container.

```java
List<String> names = people.stream()          // SOURCE          — nothing runs yet
        .filter(p -> p.age() >= 18)           // INTERMEDIATE    — nothing runs yet
        .map(Person::name)                    // INTERMEDIATE    — nothing runs yet
        .sorted()                             // INTERMEDIATE    — nothing runs yet
        .toList();                            // TERMINAL        — now everything runs
```

Five properties define it, and each has a consequence you can be asked about:

| Property | Consequence |
| --- | --- |
| **No storage** | A stream holds no elements; it pulls from a source |
| **Lazy** | Intermediate ops build a plan; nothing executes until a terminal op |
| **Single-use** | Reusing a stream throws `IllegalStateException` |
| **Non-mutating** | The source is not modified; `sorted()` does not sort the list |
| **Possibly infinite** | `Stream.iterate` / `generate` are fine as long as something short-circuits |

## 2. Why Java has streams

Java 8's real goal was **parallelism you can opt into by changing one word**. That required taking the loop away from you: as long as *you* write the `for`, the library cannot decide to split the work. Externalising iteration (`Iterator`, you pull) had to become internal iteration (you hand over a function, the library pushes).

Everything else follows from that decision. Laziness exists so a whole pipeline can be fused into one traversal. `Spliterator` exists so the source can be split. Non-interference and statelessness are required so splitting is safe. The functional style is not decoration; it is the precondition for `.parallel()` meaning anything.

## 3. Mental model

> A pipeline is **not** stage-by-stage over the whole collection. It is **element-by-element down the whole pipeline** — depth-first, one element at a time, from source to terminal, then the next element.

This is the single most clarifying fact about streams, and `peek` proves it:

```java
Stream.of("a", "b", "c")
      .peek(s -> System.out.println("  filter sees " + s))
      .filter(s -> !s.equals("b"))
      .peek(s -> System.out.println("    map sees " + s))
      .map(String::toUpperCase)
      .forEach(s -> System.out.println("      got " + s));
```

```text
  filter sees a
    map sees a
      got A
  filter sees b          <-- b is dropped here; it never reaches map
  filter sees c
    map sees c
      got C
```

A list-based implementation would print all three "filter sees" lines first. The stream does not, and that is why `findFirst()` on a million-element source can touch one element.

**Stateful operations break the vertical flow.** `sorted()` and `distinct()` must see everything before they can emit anything, so they act as **barriers** that buffer the stream. That is why they are also the operations that hurt in parallel (Module 12.3).

## 4. The operation catalogue

```java
// SOURCES
collection.stream()                      collection.parallelStream()
Arrays.stream(arr)                       Arrays.stream(arr, from, to)
Stream.of(a, b, c)                       Stream.ofNullable(x)          // 0 or 1 element, Java 9
Stream.empty()                           Stream.concat(s1, s2)
Stream.iterate(seed, f)                  Stream.iterate(seed, hasNext, next)   // Java 9, finite
Stream.generate(supplier)                // infinite, unordered
IntStream.range(0, n)                    IntStream.rangeClosed(1, n)
"a,b".chars()                            Pattern.compile(",").splitAsStream(s)
Files.lines(path)                        // AutoCloseable — MUST be closed
new Random().ints(100, 0, 10)

// STATELESS INTERMEDIATE — element in, 0..n out, no memory
map  mapToInt/Long/Double  mapToObj  flatMap  flatMapToInt  mapMulti (16)
filter  peek  boxed  asLongStream

// STATEFUL INTERMEDIATE — needs memory or full traversal
sorted  sorted(cmp)  distinct  limit(n)  skip(n)  takeWhile(p) (9)  dropWhile(p) (9)

// SHORT-CIRCUITING (intermediate or terminal)
limit  takeWhile  findFirst  findAny  anyMatch  allMatch  noneMatch

// TERMINAL
forEach  forEachOrdered  toArray  toList (16)  collect  reduce
min  max  count  sum/average/summaryStatistics (primitive streams)
anyMatch  allMatch  noneMatch  findFirst  findAny  iterator  spliterator
```

`allMatch` and `noneMatch` short-circuit on the **first counterexample**; `allMatch` on an empty stream is `true` (vacuous truth) and `anyMatch` is `false`.

## 5. Realistic example

```java
// Parse a log file, keep 5xx responses in a window, and summarise by endpoint —
// one pass, bounded memory, file handle closed deterministically.
record Entry(Instant at, String endpoint, int status, long micros) {}

try (Stream<String> lines = Files.lines(path, StandardCharsets.UTF_8)) {
    Map<String, LongSummaryStatistics> stats = lines
            .map(LogParser::parse)                      // Optional<Entry>
            .flatMap(Optional::stream)                  // Java 9: drop the empties
            .dropWhile(e -> e.at().isBefore(windowStart))
            .takeWhile(e -> e.at().isBefore(windowEnd))
            .filter(e -> e.status() >= 500)
            .collect(Collectors.groupingBy(Entry::endpoint,
                     Collectors.summarizingLong(Entry::micros)));
    report(stats);
}
```

Three things this gets right: the file stream is in try-with-resources (streams over I/O are `AutoCloseable` and leak otherwise); `takeWhile` stops reading once the window ends rather than reading the whole file; `flatMap(Optional::stream)` is the idiomatic filter-and-unwrap.

And the counterexample — **when not to use a stream**:

```java
// A loop is clearer and faster. Streams are not a style rule.
int total = 0;
for (Order o : orders) {
    if (o.isCancelled()) continue;
    if (o.total() > cap) { log.warn("over cap: {}", o.id()); break; }   // break + logging + accumulate
    total += o.total();
}
```

Reach for a loop when you need `break` with side effects, mutate the source, index arithmetic, checked exceptions, or a stack trace you can read.

## 6. What happens internally

**[JDK]** The implementation is `AbstractPipeline` and its subclasses (`ReferencePipeline`, `IntPipeline`, …). Two structures matter.

**The pipeline is a linked list of stages, built as you call intermediate operations.** Each stage records its `StreamOpFlag`s and how to wrap a downstream `Sink`. Nothing traverses.

**A terminal operation builds a `Sink` chain from the last stage backwards to the first, then pushes.**

```java
// Sink is Consumer plus lifecycle
interface Sink<T> extends Consumer<T> {
    default void begin(long size) {}
    default void end() {}
    default boolean cancellationRequested() { return false; }
}
```

`AbstractPipeline.copyInto` then does, essentially:

```java
sink.begin(spliterator.getExactSizeIfKnown());
spliterator.forEachRemaining(sink);        // push every element into the head of the chain
sink.end();
```

Each stage's sink calls `downstream.accept(...)` zero or more times. `filter`'s sink calls it conditionally; `map`'s calls it with a transformed value; `flatMap`'s calls it per sub-element. That chain of `accept` calls **is** the vertical traversal from §3, and it is why the whole pipeline is one traversal with no intermediate collections.

When any stage can short-circuit, `copyInto` uses the cancellable form instead:

```java
while (!sink.cancellationRequested() && spliterator.tryAdvance(sink)) { }
```

`limit`'s sink returns `true` from `cancellationRequested()` once it has emitted *n* elements, and that propagates up the chain to stop the source pull. This is why `takeWhile` on `Files.lines` genuinely stops reading the file.

**`StreamOpFlag`s propagate and drive optimizations.** Each source and operation declares whether it preserves/clears/injects `SIZED`, `ORDERED`, `DISTINCT`, `SORTED`. Consequences you can observe:

```java
// Java 9+: count() sees SIZED with no size-changing ops, so it SKIPS the traversal entirely
long n = list.stream().peek(System.out::println).count();     // prints NOTHING
long m = list.stream().filter(x -> true).peek(...).count();   // filter clears SIZED -> peek runs

list.stream().sorted().distinct()                             // distinct is cheap: SORTED is set
list.stream().distinct().sorted()                             // distinct must hash everything
```

**Single-use** is enforced by a `linkedOrConsumed` flag on the pipeline head:

```text
java.lang.IllegalStateException: stream has already been operated upon or closed
```

**Primitive streams** exist for the same reason `IntPredicate` does (Module 11.2): `Stream<Integer>` boxes. `mapToInt` / `mapToObj` / `boxed` move between the two worlds, and `IntStream` adds `sum()`, `average()`, `max()`, `summaryStatistics()` which the object stream does not have.

```java
IntSummaryStatistics s = orders.stream().mapToInt(Order::total).summaryStatistics();
s.getCount(); s.getSum(); s.getMin(); s.getAverage(); s.getMax();     // one pass, no boxing
```

**`Stream.iterate(seed, f)` is `ORDERED` and unsized; `Stream.generate` is unordered and unsized.** Both are infinite and both parallelise badly (nothing to split).

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++20 ranges/views</strong> are the direct analogue: <code>v | std::views::filter(p) | std::views::transform(f)</code> composes lazily, evaluates on demand, and fuses into one traversal. But a view is a <strong>value describing a range</strong> — it is reusable, often multi-pass, and can be iterated with a plain <code>for</code>. It also stays in the type system: the composition's type is known at compile time and inlines completely.</p>
<p><strong>Java streams</strong> are single-use objects, always pull from a <code>Spliterator</code>, and always push through virtual <code>Sink.accept</code> calls. The upside Java has is <code>.parallel()</code>: C++ parallelism is a per-algorithm execution policy, not a property you flip on a lazy pipeline.</p>
</div>

| Concern | C++20 ranges | Java streams |
| --- | --- | --- |
| Laziness | ✅ views | ✅ intermediate ops |
| Reusable | ✅ a view can be iterated repeatedly | ❌ single-use |
| Iterable with `for` | ✅ | ❌ (only via `iterator()`) |
| Fusion | Compile-time, fully inlined | Runtime sink chain; JIT-inlined if monomorphic |
| Parallel | `std::execution::par` per algorithm | `.parallel()` on the pipeline |
| Primitives | Native — no boxing question | `IntStream`/`LongStream`/`DoubleStream` |
| Early exit | `break` out of the `for` | `limit` / `takeWhile` / `findFirst` |
| Cost model | Predictable, zero-overhead | Depends on JIT inlining and megamorphism |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Treating a <code>Stream</code> like a view and iterating it twice. It is closer to a <code>std::istream_iterator</code> range — consumed once.</p>
<p>Assuming fusion means zero cost. Each stage is a virtual <code>accept</code>; a pipeline shared across many lambda shapes becomes a megamorphic call site the JIT cannot inline, and then a stream really is slower than the loop (Phase 22).</p>
</div>

## 8. Edge cases

- **`peek` is for debugging only.** Its javadoc says so, and §6 shows it can be skipped entirely when `count()` elides the traversal.
- **`Files.lines` / `Files.walk` / `Files.list` must be closed.** A `Stream` from a collection need not be.
- **Modifying the source during the pipeline** is *interference*: `ConcurrentModificationException`, or worse, undefined results. `list.stream().forEach(list::remove)` is broken.
- **`forEach` has no encounter-order guarantee even sequentially** — in practice it is ordered, but only `forEachOrdered` promises it.
- **`findAny` may return any element**; sequentially it usually returns the first, which trains the wrong intuition before a `.parallel()` is added.
- **`Stream.iterate(0, i -> i + 1).limit(n)` versus `IntStream.range(0, n)`** — the second is `SIZED | SUBSIZED` and splits perfectly; the first does not.
- **`sorted()` on an infinite stream** never terminates. `distinct()` on one grows without bound.
- **`flatMap` closes each inner stream** after consuming it, but does not short-circuit *within* an inner stream in older releases — for huge inner streams prefer `mapMulti` (Java 16).
- **Nulls.** `Stream.of((Object) null)` is a one-element stream; `Stream.of(null)` alone is ambiguous/NPE. Most collectors reject null keys or values.
- **`toList()` (Java 16) returns an unmodifiable list that permits nulls**; `collect(Collectors.toList())` returns a mutable `ArrayList`; `collect(toUnmodifiableList())` rejects nulls. Three different contracts.

## 9. Common mistakes

- Reusing a stream variable.
- Forgetting try-with-resources on `Files.lines`.
- `peek` used for real side effects.
- `forEach(list::add)` instead of `collect` — defeats the design and breaks in parallel.
- `stream().filter(...).findFirst().get()` — `Optional.get` without a check (Phase 13).
- `Stream<Integer>` where `IntStream` belongs.
- `sorted()` before `filter()` — sorting elements you are about to throw away.
- `distinct()` on a type with no `equals`/`hashCode`.
- Chaining a stream where a three-line loop is clearer, then defending it as "functional".
- Assuming `.parallel()` is free (Module 12.3).

## 10. Interview questions

**Beginner** — 1. What is a stream and how is it different from a collection? 2. Intermediate versus terminal operations? 3. Why does a stream do nothing until the terminal op?

**Intermediate** — 4. Which operations short-circuit? 5. What is a stateful intermediate operation and why does it matter? 6. What happens if you use a stream twice? 7. Why do `IntStream`/`LongStream` exist?

**Advanced** — 8. Describe the traversal order of `filter → map → forEach` over three elements. 9. What is a `Sink` and how does a terminal operation drive one? 10. How does `limit` actually stop the source? 11. Why does `list.stream().peek(print).count()` print nothing on Java 9+?

**Senior** — 12. When is a stream the wrong tool? Give four concrete situations. 13. A stream pipeline is 3× slower than the equivalent loop in production but equal in JMH. Give three explanations. 14. Design a bounded-memory pipeline over a 40 GB file that stops at the first anomaly and closes every resource. Justify each operator.

## 11. Follow-ups

- *After Q3:* "So what does `stream()` cost if I never terminate it?" → an object; no traversal.
- *After Q8:* "Now change `forEach` to `sorted().forEach` — what changes?" → a barrier appears.
- *After Q10:* "Does that work through a `flatMap`?"
- *After Q11:* "How would you make `peek` run?" → add a size-changing op, or don't use `peek`.
- *After Q13:* → megamorphic call sites, boxing, and a benchmark whose data does not match production.

## 12. Exercise

1. Write the `peek`-tracing pipeline from §3 and predict the output before running it. Then add `.sorted()` between `filter` and `map` and predict again.
2. Implement `filter`, `map` and `limit` yourself over a `Spliterator` using a hand-written `Sink` chain, and make `limit` cancel the source. Roughly 80 lines.
3. Demonstrate the `count()` elision: show a pipeline where `peek` runs and one where it does not, and explain via `StreamOpFlag.SIZED`.
4. Take a 1 GB log file. Write (a) a `BufferedReader` loop, (b) a `Files.lines` pipeline, (c) the same with `.parallel()`. Measure all three and explain the ordering of the results.
5. Convert five loops from a codebase you know into streams. Keep the ones that got clearer; write one paragraph on each you reverted.

## 13. Output prediction

```java
import java.util.*;
import java.util.stream.*;

public class Main {
    public static void main(String[] args) {
        List.of(1, 2, 3, 4).stream()
            .peek(x -> System.out.print("p" + x + " "))
            .filter(x -> x % 2 == 0)
            .map(x -> x * 10)
            .forEach(x -> System.out.print("=" + x + " "));
        System.out.println();

        System.out.println(List.of(1, 2, 3).stream().peek(System.out::print).count());

        var s = Stream.of("a", "b");
        System.out.println(s.count());
        try { s.forEach(System.out::println); }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        System.out.println(Stream.<String>of().allMatch(x -> false) + " " +
                           Stream.<String>of().anyMatch(x -> true));

        System.out.println(Stream.iterate(1, i -> i * 2).limit(5).toList());
        System.out.println(IntStream.rangeClosed(1, 5).sum());

        List<List<Integer>> nested = List.of(List.of(1, 2), List.of(), List.of(3));
        System.out.println(nested.stream().flatMap(List::stream).toList());

        System.out.println(Stream.of(3, 1, 2, 1).sorted().distinct().toList());

        List<Integer> src = new ArrayList<>(List.of(1, 2, 3));
        var out = src.stream().map(x -> x * 2);
        src.add(4);
        System.out.println(out.toList());
    }
}
```

## 14. Mastery check

1. List the five defining properties of a stream and one consequence of each.
2. Explain, with the three-element trace, why traversal is vertical rather than horizontal.
3. Classify these as stateless / stateful / short-circuiting: `map`, `sorted`, `limit`, `distinct`, `takeWhile`, `flatMap`, `skip`.
4. Describe how a terminal operation builds and drives a `Sink` chain.
5. How does short-circuiting propagate from `limit` back to the source?
6. Explain the `count()` elision and the flag that causes it.
7. Give the three different `toList` contracts and when each matters.
8. Name every stream source that must be closed and say why.
9. Why do primitive streams exist, and what do they add beyond avoiding boxing?
10. Give four situations where a loop is the better answer, with reasons.
