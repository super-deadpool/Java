---
title: "Comparable and Comparator: ordering, composition, and contract violations"
phase: 9
order: 1
minutes: 45
summary: "Natural order versus imposed order, the comparator combinators that replaced hand-written compare methods, and what happens at runtime when your ordering is not a total order."
tags: ["comparable", "comparator", "sorting", "timsort", "treemap"]
---

## 1. Concept

Java splits ordering into two interfaces that answer two different questions.

```java
public interface Comparable<T> {              // "I have a natural order"
    int compareTo(T o);
}

public interface Comparator<T> {              // "here is an order for T, defined elsewhere"
    int compare(T a, T b);
}
```

Both return an **int whose sign is the answer**: negative if the first argument sorts earlier, zero if the two are ordered equivalently, positive otherwise. The magnitude means nothing. `compareTo` is a property of the type; `Comparator` is a separate object you pass in, and you can have as many as you like.

**[JDK]** Types with a natural order: all wrapper types, `String` (lexicographic by UTF-16 code unit), `BigDecimal`, `BigInteger`, every `java.time` type, every `enum` (by `ordinal()`), `File`, `Duration`. Types deliberately without one: `Object`, most domain classes, and — notably — **records do not get a `compareTo` generated**.

## 2. Why Java has both

`Comparable` puts the order in the type, which is right when there is one obviously correct order (`Integer`, `LocalDate`). But the type author cannot anticipate every sort a caller needs, and cannot change the natural order of a class they do not own. `Comparator` decouples the ordering from the data, which is why every sorting API in the JDK takes an optional one:

```java
list.sort(null);                    // natural ordering — Comparable required
list.sort(byLastName);              // imposed ordering — Comparable not required
new TreeMap<>();                    // natural
new TreeMap<>(byLastName);          // imposed
Collections.max(c), Collections.max(c, cmp);
Stream.sorted(), Stream.sorted(cmp), Stream.min(cmp), Stream.max(cmp);
PriorityQueue<>(cmp);
```

## 3. Mental model

> `compareTo` is `a - b` in spirit: **"how does `a` stand relative to `b`?"**
> Read `x.compareTo(y) < 0` as `x < y`. Never read the number itself.

An ordering must be a **total order on the elements you sort**:

| Rule | Statement |
| --- | --- |
| Antisymmetry | `sgn(x.compareTo(y)) == -sgn(y.compareTo(x))` for all `x, y` |
| Transitivity | `x > y && y > z` ⟹ `x > z` |
| Substitution | `x.compareTo(y) == 0` ⟹ `sgn(x.compareTo(z)) == sgn(y.compareTo(z))` for all `z` |
| Exception symmetry | If `x.compareTo(y)` throws, so must `y.compareTo(x)` |
| *Strongly recommended* | `(x.compareTo(y) == 0) == x.equals(y)` — **consistent with equals** |

**[JLS]/[JDK]** The last one is not enforced, and violating it is the source of the most confusing behaviour in this module (§8).

## 4. Writing them

Never subtract. Delegate.

```java
// WRONG — silently broken for large or negative values
public int compareTo(Point p) { return this.x - p.x; }        // overflows: 2_000_000_000 - (-2_000_000_000)

// RIGHT
public int compareTo(Point p) { return Integer.compare(this.x, p.x); }
```

`Integer.compare`, `Long.compare`, `Double.compare`, `Boolean.compare`, `Character.compare` all exist and all do the right thing. `Double.compare` additionally imposes a **total** order where `<` does not: it orders `-0.0 < 0.0` and puts `NaN` above everything, so a `double[]` containing `NaN` sorts deterministically.

Multi-field the old way, and the way you should write today:

```java
record Employee(String dept, String name, int salary, LocalDate hired) {}

// Hand-rolled: correct but noisy, and every extra field is another chance to typo
static final Comparator<Employee> OLD = (a, b) -> {
    int c = a.dept().compareTo(b.dept());
    if (c != 0) return c;
    c = Integer.compare(b.salary(), a.salary());       // descending: arguments swapped
    if (c != 0) return c;
    return a.name().compareTo(b.name());
};

// Combinators: this is the idiom to reach for
static final Comparator<Employee> BY_DEPT_THEN_PAY =
        Comparator.comparing(Employee::dept)
                  .thenComparing(Employee::salary, Comparator.reverseOrder())
                  .thenComparing(Employee::name);
```

The full toolbox:

```java
Comparator.naturalOrder()                      // requires Comparable
Comparator.reverseOrder()
Comparator.comparing(keyExtractor)             // key must be Comparable
Comparator.comparing(keyExtractor, keyComparator)
Comparator.comparingInt / comparingLong / comparingDouble   // no boxing
cmp.thenComparing(...)  /  thenComparingInt(...)
cmp.reversed()
Comparator.nullsFirst(cmp) / nullsLast(cmp)    // wraps a comparator to tolerate null elements
```

## 5. Realistic example

Sort orders by priority tier, then by promised delivery date, then by id — with nulls tolerated and no boxing on the numeric key.

```java
record Order(String id, int tier, LocalDate promised, String customer) {}

static final Comparator<Order> DISPATCH_ORDER =
        Comparator.comparingInt(Order::tier).reversed()                        // tier 3 first
                  .thenComparing(Order::promised, Comparator.nullsLast(Comparator.naturalOrder()))
                  .thenComparing(Order::id);                                   // total: id is unique

List<Order> queue = new ArrayList<>(orders);
queue.sort(DISPATCH_ORDER);

// Same comparator, reused everywhere ordering is needed
Order next   = orders.stream().min(DISPATCH_ORDER).orElseThrow();
var  pq      = new PriorityQueue<>(DISPATCH_ORDER);
var  byTier  = new TreeMap<Integer, List<Order>>(Comparator.reverseOrder());
var  sorted  = orders.stream().sorted(DISPATCH_ORDER).toList();
```

**Watch the placement of `reversed()`.** It reverses *everything to its left*:

```java
comparing(Order::tier).reversed().thenComparing(Order::id)   // tier DESC, then id ASC
comparing(Order::tier).thenComparing(Order::id).reversed()   // tier DESC, then id DESC
```

Ending a comparator chain with a **unique** key (`id` here) makes it a **strict total order**, which removes any dependence on sort stability. That is the cheapest way to make output reproducible.

## 6. What happens internally

**[JDK]** `list.sort(cmp)` copies to an array, sorts the array, writes it back through the list iterator. Which sort runs depends on the element type:

| Input | Algorithm | Stable | Notes |
| --- | --- | --- | --- |
| `int[]`, `long[]`, `double[]`, … | Dual-pivot quicksort (Java 7+); insertion sort under ~47 elements | n/a | No comparator possible; identical primitives are indistinguishable |
| `Object[]`, `List<T>` | **TimSort** | ✅ | Adaptive merge sort; O(n) on already-sorted or reverse-sorted runs |
| `Arrays.parallelSort` | Parallel merge over the common ForkJoinPool above a threshold | ✅ | Falls back to sequential for small arrays |

**TimSort** finds naturally ordered *runs*, extends short ones with binary insertion sort, and merges runs while maintaining size invariants on a stack. On real data — logs, partially updated lists, concatenated sorted sources — it beats a plain merge sort substantially, and a fully sorted list costs a single O(n) scan.

**[JDK]** TimSort's merge invariants assume the comparator is a valid total order. When it is not, the merge can read past a run boundary, and Java raises:

```text
java.lang.IllegalArgumentException: Comparison method violates its general contract!
```

This is a **detector, not a guarantee** — it fires only when the inconsistency happens to break an invariant, which typically means it appears at ~32+ elements and not in your unit test with three. The escape hatch `-Djava.util.Arrays.useLegacyMergeSort=true` restores the pre-Java-7 merge sort, which silently produces a garbage order instead of throwing. Use it to confirm a diagnosis, never as a fix.

**Comparator is an interface with one abstract method**, so a lambda comparator becomes an `invokedynamic` call site (Phase 11), and the sort's inner loop makes a **virtual call per comparison**. That is why `comparingInt` matters: `comparing(Employee::salary)` boxes an `Integer` on every comparison — for a million-element sort that is ~20 million allocations.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++</strong> orders with a <em>strict weak ordering</em> predicate: <code>comp(a,b)</code> returns <code>bool</code>, and "equivalent" means <code>!comp(a,b) &amp;&amp; !comp(b,a)</code>. The comparator is a <strong>template parameter</strong>, so <code>std::sort</code> inlines it — the comparison is often a single instruction with no call at all.</p>
<p><strong>Java</strong> orders with a three-way <code>int</code>, closer to C++20's <code>&lt;=&gt;</code> than to <code>operator&lt;</code>. The comparator is an <strong>object</strong>, so the call is virtual; the JIT can inline it when the call site is monomorphic, and cannot when one sort routine is shared across many comparator types (Phase 22).</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Comparison shape | `bool comp(a,b)`, or `<=>` (C++20) | `int compare(a,b)` |
| Where it lives | Template parameter — compile-time | Object — runtime |
| Default sort | `std::sort` — introsort, **not stable** | TimSort — **stable** |
| Stable sort | `std::stable_sort` (may allocate) | the default |
| Ordered container | `std::set/map`, `std::less<T>` | `TreeSet/TreeMap`, `compareTo` |
| Equivalence in that container | `!(a<b) && !(b<a)` | `compare(a,b) == 0` |
| Broken ordering | **Undefined behaviour** — reads out of bounds, crashes | `IllegalArgumentException`, sometimes |
| Cost of a comparison | Usually inlined to nothing | Virtual call; boxing if you are careless |

Both languages have the identical trap that container "equality" is comparator equivalence, not `==`/`equals`. C++ just does not have a second equality to disagree with.

## 8. Edge cases

**Inconsistent with equals — `TreeSet` and `HashSet` disagree.**

```java
var a = new BigDecimal("1.0");
var b = new BigDecimal("1.00");
a.equals(b);            // false  — equals compares scale
a.compareTo(b);         // 0      — compareTo compares value

new HashSet<>(List.of(a, b)).size();   // 2
new TreeSet<>(List.of(a, b)).size();   // 1   <-- the second add is a no-op
```

`TreeSet`/`TreeMap` are documented as behaving "inconsistently with `equals`" in exactly this situation: they are `Set`s and `Map`s whose contracts are stated in terms of `equals`, but whose implementations only ever call `compareTo`. `contains`, `remove`, `equals` on the set — all use the comparator. `String.CASE_INSENSITIVE_ORDER` has the same property: a `TreeSet` built on it treats `"HELLO"` and `"hello"` as one element.

**A comparator that is not transitive.** The classic broken "sort by rating with a tolerance":

```java
// BROKEN: not transitive. 1.0 ~ 1.4, 1.4 ~ 1.8, but 1.0 < 1.8
(a, b) -> Math.abs(a.rating() - b.rating()) < 0.5 ? 0 : Double.compare(a.rating(), b.rating());
```

**Antisymmetry violated by asymmetric null handling** — `(a,b) -> a == null ? -1 : a.compareTo(b)` says `null < null`. Use `nullsFirst`.

**Mutating a key inside a `TreeMap`** breaks it the same way mutating a `HashMap` key does (Module 3.2): the entry is stranded at a position the search path no longer reaches.

**`thenComparing` ambiguity.** `Comparator` has both `thenComparing(Function)` and `thenComparing(Comparator)`, and an implicit lambda matches neither uniquely:

```java
cmp.thenComparing(p -> p.name());                 // does not compile — ambiguous
cmp.thenComparing(Person::name);                  // fine — method reference resolves
cmp.thenComparing((Person p) -> p.name());        // fine — explicit parameter type
```

**`Comparator.reverseOrder()` versus `Collections.reverseOrder()`** are the same thing; `cmp.reversed()` is `Collections.reverseOrder(cmp)`. All three flip `null` handling too, so `nullsFirst(...).reversed()` puts nulls last.

**Enums compare by `ordinal()`**, i.e. declaration order — so reordering enum constants silently changes every `TreeSet<MyEnum>`, `EnumSet` iteration, and sort in the system.

**`Collections.sort` on an immutable list** throws `UnsupportedOperationException`; `List.of(...)` cannot be sorted in place. `stream().sorted().toList()` is the fix.

## 9. Common mistakes

- `return a.x - b.x;` — overflows. Use `Integer.compare`.
- `Comparator.comparing(Employee::salary)` in a hot sort — boxes; use `comparingInt`.
- Misplacing `.reversed()` at the end of a chain and reversing the tiebreakers too.
- Assuming a sort is stable when you never gave it a total order — then wondering why output differs between runs after a parallel stream.
- Implementing `compareTo` and not `equals`/`hashCode`, then putting the type in a `HashSet`.
- Implementing `equals` in a way that disagrees with `compareTo` and using both a `HashMap` and a `TreeMap`.
- Sorting with an ordering that depends on mutable state that changes mid-sort.
- Catching `IllegalArgumentException` from `sort` instead of fixing the comparator.
- `Comparable<Object>` instead of `Comparable<MyType>` — legacy raw style; forces a cast in every implementation.

## 10. Interview questions

**Beginner** — 1. Difference between `Comparable` and `Comparator`? 2. What does the return value of `compareTo` mean? 3. How do you sort a `List<String>` descending?

**Intermediate** — 4. Why is `a - b` a bad `compareTo` body? 5. What does "consistent with `equals`" mean and why is it only *recommended*? 6. Is Java's sort stable? For which inputs? 7. What does `reversed()` reverse in a chained comparator?

**Advanced** — 8. Explain TimSort and why it is a good default for real data. 9. Where does "Comparison method violates its general contract!" come from, and why does it appear only on large inputs? 10. Why does `new TreeSet<>(List.of(new BigDecimal("1.0"), new BigDecimal("1.00")))` have size 1? 11. What is the cost difference between `comparing` and `comparingInt` at a million elements?

**Senior** — 12. You need a stable, reproducible ordering across JVM runs and across a parallel sort. What do you require of the comparator, and why? 13. A nightly job started failing with `IllegalArgumentException` from `Arrays.sort` after a data change. Walk through the diagnosis. 14. Design the ordering for a priority dispatch queue with three ranked criteria, null-tolerant, allocation-free in the comparison path, and safe to use as a `TreeMap` key ordering.

## 11. Follow-ups

- *After Q4:* "Give the exact input that overflows." → `Integer.MIN_VALUE` and any positive value.
- *After Q5:* "Name a JDK class that violates it deliberately." → `BigDecimal`; also `String.CASE_INSENSITIVE_ORDER`.
- *After Q6:* "Why is stability irrelevant for `int[]`?"
- *After Q9:* "Would the legacy merge sort flag fix it?" → No; it hides the throw and returns a wrong order.
- *After Q12:* "What makes stability unnecessary?" → A strict total order — end the chain on a unique key.

## 12. Exercise

1. Write `Version implements Comparable<Version>` for dotted versions of arbitrary length (`1.2` < `1.2.0.1` < `1.10`), with `equals`/`hashCode` consistent with it. Prove antisymmetry and transitivity with a property test over random versions.
2. Build the `Employee` comparator from §4 twice — hand-rolled and with combinators — and assert both produce identical orderings over 10 000 random employees.
3. Write the deliberately non-transitive "tolerance" comparator from §8, sort 1 000 random elements with it, and find the smallest input size at which `IllegalArgumentException` appears. Then re-run with `-Djava.util.Arrays.useLegacyMergeSort=true` and diff the outputs.
4. Benchmark `comparing(Employee::salary)` against `comparingInt(Employee::salary)` sorting 1 000 000 employees. Report allocation rate as well as time.
5. Put `BigDecimal("1.0")` and `BigDecimal("1.00")` into a `HashSet`, a `TreeSet`, and a `TreeSet` built on `Comparator.comparing(BigDecimal::toString)`. Explain all three sizes.

## 13. Output prediction

```java
import java.util.*;
import java.math.BigDecimal;

record P(String name, int age) {}

public class Main {
    public static void main(String[] args) {
        List<P> ps = new ArrayList<>(List.of(
            new P("ann", 30), new P("bob", 25), new P("cid", 30), new P("dee", 25)));

        ps.sort(Comparator.comparingInt(P::age).thenComparing(P::name).reversed());
        System.out.println(ps);

        System.out.println(Integer.MIN_VALUE - 1);
        System.out.println(Integer.compare(Integer.MIN_VALUE, 1));

        var t = new TreeSet<String>(String.CASE_INSENSITIVE_ORDER);
        t.add("Hello"); t.add("HELLO"); t.add("world");
        System.out.println(t + " " + t.size() + " " + t.contains("hELLO"));

        var d = new TreeSet<BigDecimal>();
        d.add(new BigDecimal("1.0")); d.add(new BigDecimal("1.00"));
        System.out.println(d);

        System.out.println(Double.compare(-0.0, 0.0) + " " + (-0.0 < 0.0));
        double[] arr = { 1.0, Double.NaN, -0.0, 0.0 };
        Arrays.sort(arr);
        System.out.println(Arrays.toString(arr));

        List<String> l = new ArrayList<>(List.of("bb", "a", "ccc"));
        l.sort(null);
        System.out.println(l);
    }
}
```

## 14. Mastery check

1. State all four hard rules of the `compareTo` contract, plus the recommended one.
2. Why is `a.x - b.x` wrong, and what is the exact failing input?
3. Explain why `TreeSet` can hold fewer elements than `HashSet` for the same input.
4. Which sort algorithm runs for `int[]`, for `Object[]`, and which of them is stable?
5. Describe TimSort in four sentences, including why it is fast on partially sorted data.
6. What triggers "Comparison method violates its general contract!", and why is it not raised reliably?
7. Rewrite `comparing(X::n).thenComparing(X::m).reversed()` so only the first key is descending.
8. When is sort stability irrelevant, and how do you make it so on purpose?
9. Why does `comparingInt` exist when `comparing` already works?
10. Give three JDK orderings that are deliberately inconsistent with `equals`.
