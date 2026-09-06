---
title: "Sets and Sorted Collections: HashSet, LinkedHashSet, TreeSet, TreeMap"
phase: 8
order: 3
minutes: 30
summary: "How each set is actually implemented, what ordering guarantees you get, and the NavigableMap operations that make TreeMap worth its log n."
tags: ["hashset", "treeset", "treemap", "navigablemap", "ordering"]
---

## 1. The three sets

| Set | Backed by | Ordering | `add`/`contains` | Nulls |
| --- | --- | --- | --- | --- |
| `HashSet` | a `HashMap` with a dummy value | **none** — and it can change on resize | O(1) average | one null |
| `LinkedHashSet` | a `LinkedHashMap` | insertion order | O(1) average | one null |
| `TreeSet` | a `TreeMap` (red-black tree) | sorted by `Comparable`/`Comparator` | O(log n) | ✗ NPE |

**[JDK]** `HashSet` really is a `HashMap`:

```java
private transient HashMap<E, Object> map;
private static final Object PRESENT = new Object();
public boolean add(E e) { return map.put(e, PRESENT) == null; }
```

So everything in the HashMap module (8.4) — hashing, buckets, resizing, treeification, the mutable-key bug — applies to `HashSet` verbatim.

`LinkedHashSet` adds a doubly linked list threaded through the entries, costing two extra references per element and buying a **deterministic iteration order**. That determinism is worth more than people expect: it makes tests reproducible and output diffable.

## 2. Ordering: `Comparable` vs `Comparator`

```java
public record Version(int major, int minor) implements Comparable<Version> {
    @Override public int compareTo(Version o) {                 // NATURAL ordering: one per type
        return Comparator.comparingInt(Version::major)
                         .thenComparingInt(Version::minor)
                         .compare(this, o);
    }
}

var byMinorDesc = Comparator.comparingInt(Version::minor).reversed();   // an alternative ordering
var set = new TreeSet<>(byMinorDesc);                                    // supplied at construction
```

The contract for `compareTo`: **antisymmetric** (`sgn(a.compareTo(b)) == -sgn(b.compareTo(a))`), **transitive**, and **consistent** — and *strongly recommended* to be consistent with `equals`, i.e. `a.compareTo(b) == 0` exactly when `a.equals(b)`.

Why "strongly recommended" and not required: a `TreeSet` decides membership by `compareTo`, **not** by `equals`. So an inconsistent comparator makes a `TreeSet` behave differently from a `HashSet` on the same data:

```java
var ts = new TreeSet<String>(String.CASE_INSENSITIVE_ORDER);
ts.add("Hello"); ts.add("HELLO");
System.out.println(ts.size());          // 1 — compare says equal
var hs = new HashSet<>(List.of("Hello", "HELLO"));
System.out.println(hs.size());          // 2 — equals says different
```

`BigDecimal` is the JDK's own famous example: `new BigDecimal("1.0").equals(new BigDecimal("1.00"))` is `false`, but `compareTo` returns `0`. So a `HashSet` holds both and a `TreeSet` holds one.

## 3. `TreeMap` / `NavigableMap` — what you buy with O(log n)

The reason to accept log n is the *range* operations, which no hash structure can offer:

```java
NavigableMap<Integer, String> m = new TreeMap<>(Map.of(10, "a", 20, "b", 30, "c"));

m.firstKey(); m.lastKey();                  // 10, 30
m.floorKey(25);                             // 20  — greatest key <= 25
m.ceilingKey(25);                           // 30  — smallest key >= 25
m.lowerKey(20);                             // 10  — strictly less
m.higherKey(20);                            // 30  — strictly greater
m.headMap(20, true);                        // {10=a, 20=b}  — a VIEW
m.subMap(10, true, 20, false);              // {10=a}
m.descendingMap();                          // reversed VIEW
m.pollFirstEntry();                         // remove and return the smallest
```

Real uses: time-series lookups ("the last value at or before this timestamp" is `floorEntry`), rate-limiting windows, interval maps, leaderboards, IP-range tables. If you find yourself sorting a `HashMap`'s keys on every request, a `TreeMap` is the answer.

**[JDK]** `TreeMap` is a **red-black tree**: a self-balancing BST guaranteeing height ≤ 2·log₂(n+1), so `get`/`put`/`remove` are O(log n) worst case — not just average, which is `HashMap`'s weakness under adversarial input.

## 4. Realistic example

```java
// "What was the price at 14:32?" — the classic floorEntry use
public final class PriceHistory {
    private final NavigableMap<Instant, Long> pricesByTime = new TreeMap<>();

    public void record(Instant at, long priceMinor) { pricesByTime.put(at, priceMinor); }

    public OptionalLong priceAt(Instant at) {
        var entry = pricesByTime.floorEntry(at);          // most recent price at or before `at`
        return entry == null ? OptionalLong.empty() : OptionalLong.of(entry.getValue());
    }

    public NavigableMap<Instant, Long> between(Instant from, Instant to) {
        return pricesByTime.subMap(from, true, to, false);   // a live view, no copying
    }
}
```

## 5. Set operations

```java
var a = new HashSet<>(List.of(1, 2, 3));
var b = Set.of(2, 3, 4);

a.retainAll(b);    // intersection → [2, 3]      (mutates a)
a.addAll(b);       // union
a.removeAll(b);    // difference
a.containsAll(b);  // subset test
```

These are O(n) or O(n·m) depending on the argument's `contains` cost — `removeAll` on two `ArrayList`s is O(n·m), a classic accidental quadratic. Convert the argument to a `Set` first.

## 6. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>std::set</code>/<code>std::map</code> are red-black trees ordered by <code>operator&lt;</code> or a comparator supplied as a <em>template parameter</em>; <code>unordered_set</code>/<code>unordered_map</code> are hash tables with the hasher also a template parameter. Ordering and hashing are properties of the container.</p>
<p><strong>Java:</strong> hashing is a property of the <em>type</em> (<code>hashCode</code>), while ordering may be either the type's natural order (<code>Comparable</code>) or a per-container <code>Comparator</code>. So Java lets you vary ordering per container but not hashing.</p>
</div>

| C++ | Java | Note |
| --- | --- | --- |
| `std::set` | `TreeSet` | both red-black trees |
| `std::unordered_set` | `HashSet` | Java has no per-set hasher |
| `lower_bound` / `upper_bound` | `ceilingKey` / `higherKey` | Java's names are less symmetric; learn the four |
| `equal_range` | `subMap(k, true, k, true)` | |
| Comparator as template arg | `Comparator` constructor arg | Java's is a runtime value |
| Equivalence via `!(a<b) && !(b<a)` | `compareTo(a,b) == 0` | **identical semantics** — and the same trap versus `equals` |

The C++ notion that "a `std::set` decides equivalence by `<`, not `==`" transfers exactly to `TreeSet`. A C++ programmer who internalised that will get Java's version right immediately.

## 7. Edge cases

```java
new TreeSet<String>().add(null);            // NullPointerException
new TreeSet<>(Comparator.nullsFirst(Comparator.<String>naturalOrder())).add(null);   // works

var set = new TreeSet<>(List.of(3, 1, 2));
System.out.println(set);                     // [1, 2, 3]

record P(String n) {}
// new TreeSet<P>().add(new P("x"));         // ClassCastException: P cannot be cast to Comparable

var hs = new HashSet<>(List.of("a", "b", "c"));
System.out.println(hs);                      // order unspecified — and may differ between runs/JDKs

var lhs = new LinkedHashSet<>(List.of("c", "a", "b"));
System.out.println(lhs);                     // [c, a, b] — insertion order, guaranteed

// A TreeSet with an inconsistent comparator "loses" elements
var ci = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
ci.addAll(List.of("a", "A", "b"));
System.out.println(ci);                      // [a, b]
```

## 8. Common mistakes

- Putting mutable objects in a `HashSet` and mutating them (Module 3.2 §7).
- Assuming `HashSet` iteration order is stable across runs or JDK versions.
- A comparator inconsistent with `equals` in a `TreeSet`, then wondering where elements went.
- A comparator that is not transitive → `IllegalArgumentException: Comparison method violates its general contract!` from TimSort.
- `removeAll(list)` where the argument is a `List` — accidentally O(n·m).
- Using `TreeMap` where a `HashMap` would do (log n for nothing).
- Sorting a map's keys on every request instead of using a `TreeMap`.

## 9. Interview questions

**Beginner** — 1. Difference between the three sets? 2. How does `HashSet` prevent duplicates? 3. What ordering does `TreeSet` use?

**Intermediate** — 4. What is `HashSet` actually backed by? 5. Why does `TreeSet` reject nulls? 6. `Comparable` vs `Comparator`? 7. What does "consistent with equals" mean and what breaks without it?

**Advanced** — 8. Give five `NavigableMap` methods and a real use for each. 9. Why is `TreeMap` O(log n) *worst case* while `HashMap` is only O(1) *average*? 10. Explain the `BigDecimal` equals/compareTo discrepancy and its consequences. 11. Where does "Comparison method violates its general contract" come from?

**Senior** — 12. Design a time-series store answering "value at or before T" and range queries. 13. When would you accept `TreeMap`'s log n over `HashMap`'s O(1)? 14. How would you implement a case-insensitive set that still distinguishes case on retrieval?

## 10. Follow-ups

- *After Q4:* "What is the value in that map?" → a shared `PRESENT` sentinel.
- *After Q9:* "So when does `HashMap` degrade, and what did Java 8 do about it?" → treeification (Module 8.4).
- *After Q12:* "How do you handle two events at the same instant?" → a `NavigableMap<Instant, List<T>>`, or a compound key.

## 11. Exercise

1. Build `PriceHistory` from §4 and test `floorEntry` at, before, and after every recorded instant.
2. Add a `TreeSet` of user names with `String.CASE_INSENSITIVE_ORDER`; show that adding "Bob" then "BOB" yields one element, and explain which one survives.
3. Write a comparator that is not transitive and trigger TimSort's contract exception with a list of 40 elements (it needs enough elements to take the merge path).
4. Convert an O(n·m) `removeAll` into O(n) and measure.

## 12. Output prediction

```java
public class Main {
    public static void main(String[] args) {
        Set<String> ci = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        ci.addAll(List.of("Hello", "HELLO", "world"));
        System.out.println(ci.size() + " " + ci);

        Set<BigDecimal> hs = new HashSet<>(List.of(new BigDecimal("1.0"), new BigDecimal("1.00")));
        Set<BigDecimal> ts = new TreeSet<>(List.of(new BigDecimal("1.0"), new BigDecimal("1.00")));
        System.out.println(hs.size() + " " + ts.size());

        NavigableMap<Integer, String> m = new TreeMap<>(Map.of(10, "a", 20, "b"));
        System.out.println(m.floorKey(15) + " " + m.ceilingKey(15) + " " + m.higherKey(20));

        Set<Integer> lhs = new LinkedHashSet<>(List.of(3, 1, 2));
        System.out.println(lhs);
    }
}
```

## 13. Mastery check

1. What is `HashSet` backed by, and what is stored as the value?
2. Give the ordering, complexity and null behaviour of all three sets.
3. State the `compareTo` contract and the consistency recommendation.
4. Show, in code, a case where `TreeSet` and `HashSet` disagree about size.
5. Name five `NavigableMap` methods and a production use for each.
6. Why is `TreeMap`'s O(log n) a *worst-case* guarantee, and when does that matter?
7. What triggers "Comparison method violates its general contract" and how do you fix it?
8. Why does `TreeSet` reject null, and how do you work around it?
9. Map the C++ `set`/`unordered_set` equivalence rules onto Java's, and name the shared trap.
10. When is `LinkedHashSet` worth its extra two references per element?
