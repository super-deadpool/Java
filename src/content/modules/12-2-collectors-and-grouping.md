---
title: "Collectors: mutable reduction, grouping, and writing your own"
phase: 12
order: 2
minutes: 45
summary: "Why collect exists alongside reduce, the five parts of a Collector, the full downstream catalogue, and the toMap traps that show up in production."
tags: ["collectors", "groupingby", "tomap", "reduce", "teeing"]
---

## 1. Concept

`reduce` performs an **immutable reduction**: it combines values into a new value each step. `collect` performs a **mutable reduction**: it accumulates into a container.

```java
// immutable reduction — a new Integer each step (cheap; ints are small)
int sum = nums.stream().reduce(0, Integer::sum);

// mutable reduction — one StringBuilder, appended to (the immutable version is O(n²))
String joined = names.stream().collect(Collectors.joining(", "));
```

That distinction is the whole reason `collect` exists. `reduce(a, b -> a + b)` over strings allocates a new `String` per element and copies everything before it — quadratic. A `Collector` gives the library a container to mutate, plus enough structure to do it **in parallel safely**.

## 2. The Collector interface

```java
public interface Collector<T, A, R> {      // T = element, A = accumulator, R = result
    Supplier<A>          supplier();       // make a fresh empty container
    BiConsumer<A, T>     accumulator();    // fold one element into a container
    BinaryOperator<A>    combiner();       // merge two containers (parallel only)
    Function<A, R>       finisher();       // final transform; identity if IDENTITY_FINISH
    Set<Characteristics> characteristics();// CONCURRENT, UNORDERED, IDENTITY_FINISH
}
```

The three-argument `collect` is the same thing without a named type, and is the fastest way to understand it:

```java
List<String> out = stream.collect(
        ArrayList::new,               // supplier
        ArrayList::add,               // accumulator
        ArrayList::addAll);           // combiner
```

Contract requirements, all of which matter in parallel:

- The supplier must return a **fresh, empty** container each call.
- The accumulator must be **associative** with the combiner: folding then merging must equal folding in order.
- The combiner may be called on partial results in **any grouping**.
- `CONCURRENT` means: a *single* container is shared and the accumulator is safe to call from multiple threads. It is only used when the stream is parallel *and* (`UNORDERED` or the collector is order-insensitive).

## 3. The catalogue

**Terminal shapes** — what you get out:

```java
toList()               // mutable ArrayList (unspecified type, but is one today)
toSet()                // mutable HashSet — UNORDERED
toCollection(TreeSet::new)               // pick the implementation yourself
toUnmodifiableList/Set/Map()             // Java 10; reject nulls
joining()  joining(sep)  joining(sep, prefix, suffix)
counting()
summingInt/Long/Double(fn)   averagingInt/Long/Double(fn)   summarizingInt(fn)
minBy(cmp)  maxBy(cmp)                   // return Optional<T>
reducing(identity, op)  reducing(identity, mapper, op)
```

**Downstream shapes** — collectors that wrap another collector:

```java
mapping(fn, downstream)          // transform before collecting
filtering(pred, downstream)      // Java 9 — differs from a stream filter, see §5
flatMapping(fn, downstream)      // Java 9
collectingAndThen(down, finish)  // post-process the result
teeing(down1, down2, merger)     // Java 12 — two collectors, one pass
```

**Grouping:**

```java
groupingBy(classifier)                              // Map<K, List<T>>
groupingBy(classifier, downstream)                  // Map<K, D>
groupingBy(classifier, mapFactory, downstream)      // choose the Map implementation
groupingByConcurrent(...)                           // ConcurrentHashMap, CONCURRENT | UNORDERED
partitioningBy(predicate)                           // Map<Boolean, List<T>> — always both keys
partitioningBy(predicate, downstream)
toMap(keyFn, valueFn)                               // throws on duplicate keys
toMap(keyFn, valueFn, mergeFn)
toMap(keyFn, valueFn, mergeFn, mapSupplier)
```

## 4. Realistic example

```java
record Sale(String region, String product, LocalDate date, long cents, String rep) {}

// 1. Two-level grouping with a numeric summary at the leaves
Map<String, Map<String, LongSummaryStatistics>> byRegionThenProduct =
    sales.stream().collect(groupingBy(Sale::region,
                           groupingBy(Sale::product,
                           summarizingLong(Sale::cents))));

// 2. Group, then reduce each group to one element and unwrap the Optional
Map<String, Sale> biggestPerRegion =
    sales.stream().collect(groupingBy(Sale::region,
                           collectingAndThen(maxBy(comparingLong(Sale::cents)), Optional::orElseThrow)));

// 3. Group into a sorted map, of distinct rep names, not a List
Map<String, Set<String>> repsByRegion =
    sales.stream().collect(groupingBy(Sale::region, TreeMap::new,
                           mapping(Sale::rep, toCollection(TreeSet::new))));

// 4. toMap with an explicit merge — the version that does not throw
Map<String, Long> totalByProduct =
    sales.stream().collect(toMap(Sale::product, Sale::cents, Long::sum));

// 5. teeing: count and sum in ONE pass instead of two pipelines
record Summary(long count, long cents) {}
Summary s = sales.stream().collect(teeing(counting(), summingLong(Sale::cents), Summary::new));

// 6. partitioningBy always yields both keys — even when one side is empty
Map<Boolean, List<Sale>> split = sales.stream().collect(partitioningBy(x -> x.cents() > 100_000));
split.get(true); split.get(false);       // neither is ever null
```

## 5. filtering versus filter, and mapping versus map

The Java 9 downstream collectors are not redundant with the stream operations, and the difference is **which groups exist**:

```java
// filter drops elements BEFORE classification: empty groups disappear entirely
sales.stream().filter(s -> s.cents() > 1000)
     .collect(groupingBy(Sale::region, counting()));
// -> regions with no big sales are ABSENT from the map

// filtering drops elements AFTER classification: every group survives, possibly at 0
sales.stream()
     .collect(groupingBy(Sale::region, filtering(s -> s.cents() > 1000, counting())));
// -> every region appears, with count 0 where nothing matched
```

Which you want depends on whether "region with zero big sales" is a row in your report. This is one of the crispest interview distinctions in the whole Streams API.

## 6. What happens internally

**[JDK]** `Collectors` returns instances of `CollectorImpl`, a record-like holder of the five functions. `ReduceOps.makeRef(collector)` turns it into a terminal op whose `Sink` is:

```java
begin()  -> container = supplier.get();
accept(t)-> accumulator.accept(container, t);
end()    -> // sequential: done. finisher applied by evaluate()
```

In **parallel**, the `ReduceTask` is a `ForkJoinTask` that splits the spliterator, produces one container per leaf, and merges pairwise up the tree with the **combiner**. Two paths exist:

- **Non-concurrent (the default):** *k* containers, *k−1* combiner calls. `groupingBy` therefore builds many `HashMap`s and merges them — merging maps is not cheap.
- **`CONCURRENT | UNORDERED`:** one shared container, no combiner calls. `groupingByConcurrent` accumulates straight into a single `ConcurrentHashMap`. The stream must be parallel and unordered for this path to be taken; a `CONCURRENT` collector used sequentially just accumulates into one container anyway.

**`IDENTITY_FINISH`** lets the framework skip the finisher call and cast, which is why `toList()` is marked with it and `toUnmodifiableList()` is not.

**`toMap` internals explain both of its traps:**

```java
// Trap 1: duplicate key
Map<String, Sale> m = sales.stream().collect(toMap(Sale::product, s -> s));
// java.lang.IllegalStateException: Duplicate key shoes (attempted merging values ... and ...)

// Trap 2: null value — NOT an "allowed null" like HashMap.put
Map<String, String> n = users.stream().collect(toMap(User::id, User::nickname));
// NullPointerException if any nickname is null
```

**[JDK]** `toMap` accumulates with `map.merge(k, v, mergeFunction)`, and `Map.merge` is specified to throw `NullPointerException` on a null value — and, worse, to **remove** the entry if the merge function returns null. So `toMap` cannot represent a null value at all, while `groupingBy`+`mapping` can. The fix when you need nulls is `collect(HashMap::new, (m, x) -> m.put(k(x), v(x)), HashMap::putAll)`.

`groupingBy`'s classifier may not return null either — same reason.

**Writing your own collector.** Only worth it when you need a container the JDK does not offer:

```java
/** Collect into a bounded top-N, never holding more than n elements. */
static <T> Collector<T, ?, List<T>> topN(int n, Comparator<? super T> cmp) {
    return Collector.of(
        () -> new PriorityQueue<T>(cmp),                       // supplier: min-heap by cmp
        (pq, t) -> { pq.offer(t); if (pq.size() > n) pq.poll(); },   // accumulator
        (a, b) -> { b.forEach(t -> { a.offer(t); if (a.size() > n) a.poll(); }); return a; },
        pq -> { var l = new ArrayList<>(pq); l.sort(cmp.reversed()); return l; }   // finisher
    );
}
Collector.of(supplier, accumulator, combiner, finisher, Characteristics...);
```

Check every custom collector against the contract: fresh container per supplier call, associative accumulate/combine, and no reliance on encounter order unless you omit `UNORDERED`.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p>C++ has no <code>Collector</code>. The equivalents are spread across <code>std::accumulate</code> (immutable fold), <code>std::transform_reduce</code> (map + fold, with an execution policy), <code>std::reduce</code> (unordered fold requiring associativity — exactly Java's parallel contract), and hand-written loops into a <code>std::map</code> for grouping. C++23 adds <code>std::ranges::to&lt;Container&gt;()</code>, which covers only the <code>toList</code>/<code>toSet</code> end of the catalogue.</p>
<p>The idea Java packages up and C++ leaves to you is <strong>the combiner</strong>: a reusable object that knows how to merge two partial results, which is what makes <code>groupingBy</code> parallelisable without you writing the merge.</p>
</div>

| Task | C++ | Java |
| --- | --- | --- |
| Fold | `std::accumulate` (ordered) | `reduce(identity, op)` |
| Parallel fold | `std::reduce` (associativity required) | `reduce` / `collect` on a parallel stream |
| Map + fold | `std::transform_reduce` | `mapToInt(...).sum()` |
| Into a container | loop, or `ranges::to` (C++23) | `collect(toList())` |
| Group by key | loop into `std::map<K, vector<V>>` | `collect(groupingBy(k))` |
| Multi-statistic in one pass | one loop, several accumulators | `teeing`, or `summarizingInt` |
| Merge partials | You write it | The `combiner` |

## 8. Edge cases

- **`reduce` requires associativity**; `(a, b) -> a - b` gives different answers in parallel.
- **Three-argument `reduce(identity, accumulator, combiner)`** exists for the case where the accumulator's types differ — it is the immutable-reduction analogue of a collector and is almost always the wrong choice versus `collect`.
- **`Collectors.toList()` return type is unspecified** — do not cast it to `ArrayList`. Use `toCollection(ArrayList::new)` if you need a guarantee.
- **`Stream.toList()` (Java 16) is unmodifiable and allows nulls**; `Collectors.toUnmodifiableList()` rejects nulls. Different contracts (Module 12.1 §8).
- **`groupingBy` returns a `HashMap`** — unordered. Pass `LinkedHashMap::new` or `TreeMap::new` if the report needs order.
- **`counting()` returns `Long`**, not `Integer` or `int`.
- **`averagingInt` returns `Double` and gives `0.0` for an empty group**, whereas `summarizingInt` on empty gives `average = 0.0`, `min = Integer.MAX_VALUE`, `max = Integer.MIN_VALUE`. Reporting the min of an empty group as `MAX_VALUE` is a real bug shape.
- **`minBy`/`maxBy` return `Optional`**; wrapped in `groupingBy` that means `Map<K, Optional<T>>` unless you add `collectingAndThen`.
- **`joining()` on an empty stream** returns `""`; with prefix/suffix it returns just `prefix + suffix`.
- **Nested `groupingBy` with a `TreeMap` factory** applies the factory only at the level you passed it to.
- **A `CONCURRENT` collector on an ordered parallel stream** silently falls back to the non-concurrent path — you get correctness, not the speed you expected.

## 9. Common mistakes

- `toMap` with duplicate keys and no merge function, discovered in production.
- `toMap` where a value can be null.
- `reduce(new StringBuilder(), (sb, s) -> sb.append(s), ...)` — mutable accumulation through `reduce`; breaks in parallel.
- String concatenation with `reduce` — O(n²); use `joining()`.
- `groupingBy(...)` then `.entrySet().stream().sorted(...)` when a `TreeMap::new` factory would do.
- Forgetting `collectingAndThen` and shipping `Map<K, Optional<V>>` to a caller.
- Using `filter` when the report needs the empty groups (§5).
- Two pipelines over the same source to compute two aggregates, instead of `teeing` or `summarizing`.
- A custom collector whose supplier returns a shared container.
- Assuming `groupingByConcurrent` is faster without measuring — on a sequential stream it does nothing.

## 10. Interview questions

**Beginner** — 1. What does `collect` do? 2. What does `groupingBy` return? 3. How do you join strings from a stream?

**Intermediate** — 4. `reduce` versus `collect` — when does each apply? 5. What are the three arguments of the simple `collect`? 6. What happens on a duplicate key in `toMap`? 7. What does `partitioningBy` guarantee that `groupingBy` does not?

**Advanced** — 8. Name the five parts of `Collector` and what each does. 9. What does the combiner do and when is it called? 10. Difference between `filter` before `groupingBy` and `filtering` inside it. 11. Why does `toMap` throw on a null value when `HashMap.put(k, null)` is legal?

**Senior** — 12. Explain the three `Characteristics` and what each enables in the parallel path. 13. Write a collector computing a bounded top-N in O(n log k) with O(k) memory, and argue it satisfies the contract. 14. A `groupingBy` over 200 M records is spending most of its time in the parallel combiner. Explain and fix.

## 11. Follow-ups

- *After Q4:* "Why is string concatenation with `reduce` quadratic?"
- *After Q6:* "Give the two-line fix." → a merge function.
- *After Q9:* "Is the combiner called on a sequential stream?" → no.
- *After Q11:* "So how do you collect a map that must hold nulls?" → three-arg `collect`.
- *After Q14:* → `groupingByConcurrent` + `unordered()`, or partition by key upstream.

## 12. Exercise

1. Given `List<Employee>`, produce: count per department; the highest-paid employee per department as an `Employee` (not `Optional`); a `TreeMap` of department to a sorted set of names; total payroll per department as `Map<String, Long>`; and a single-pass `(headcount, payroll)` record.
2. Write `filter`-before and `filtering`-inside versions of the same report and diff the key sets.
3. Implement `topN` from §6, test it against a sort-and-limit baseline on 10 M elements, and compare time and peak memory.
4. Write a collector that produces `Map<K, List<V>>` **preserving encounter order at both levels** and prove it works on a parallel ordered stream.
5. Deliberately break associativity in a custom combiner and find the smallest input where sequential and parallel results diverge.

## 13. Output prediction

```java
import java.util.*;
import java.util.stream.*;
import static java.util.stream.Collectors.*;

record P(String team, String name, int score) {}

public class Main {
    public static void main(String[] args) {
        var ps = List.of(new P("a", "x", 5), new P("a", "y", 9), new P("b", "z", 3));

        System.out.println(ps.stream().collect(groupingBy(P::team, counting())));
        System.out.println(ps.stream().collect(groupingBy(P::team, mapping(P::name, toList()))));
        System.out.println(ps.stream().collect(groupingBy(P::team, maxBy(Comparator.comparingInt(P::score)))));
        System.out.println(ps.stream().collect(partitioningBy(p -> p.score() > 100)));

        System.out.println(ps.stream().filter(p -> p.score() > 4)
                             .collect(groupingBy(P::team, counting())));
        System.out.println(ps.stream()
                             .collect(groupingBy(P::team, filtering(p -> p.score() > 4, counting()))));

        System.out.println(ps.stream().collect(toMap(P::team, P::score, Integer::sum)));
        try { ps.stream().collect(toMap(P::team, P::score)); }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var stats = Stream.<P>of().collect(summarizingInt(P::score));
        System.out.println(stats.getMin() + " " + stats.getMax() + " " + stats.getAverage());

        System.out.println(Stream.<String>of().collect(joining(",", "[", "]")));
        System.out.println(ps.stream().map(P::name).collect(joining("-")));
        System.out.println(ps.stream().collect(teeing(counting(), summingInt(P::score), (c, s) -> c + ":" + s)));
    }
}
```

## 14. Mastery check

1. Define mutable versus immutable reduction and give a case where the difference is asymptotic.
2. Name the five members of `Collector` and state the contract on each.
3. When is the combiner invoked, and what must be true of it?
4. Explain all three `Characteristics` and their effect on the parallel path.
5. Give both `toMap` failure modes and the exact fix for each.
6. Explain why `toMap` cannot hold a null value, tracing it to `Map.merge`.
7. Contrast `filter` before `groupingBy` with `filtering` inside it, and say when each is correct.
8. Write, from memory, a two-level `groupingBy` producing a `TreeMap` of `Map<String, Long>`.
9. What does `collectingAndThen` solve in a grouping pipeline?
10. What does `teeing` avoid, and what is its one-pass guarantee?
