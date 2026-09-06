---
title: "The Collections Framework: interfaces, views, and factories"
phase: 8
order: 1
minutes: 30
summary: "The interface hierarchy, what each contract actually promises, the view collections that share storage, and how to pick an implementation."
tags: ["collections", "list", "set", "map", "iterable"]
---

## 1. Concept

```text
Iterable<T>
└── Collection<E>
    ├── List<E>        ordered, indexed, duplicates allowed
    ├── Set<E>         no duplicates, defined by equals/hashCode
    │   └── SortedSet<E> → NavigableSet<E>
    └── Queue<E>       insertion/removal at ends, with ordering policy
        └── Deque<E>   double-ended: both a queue and a stack

Map<K, V>              NOT a Collection — an association, not a bag of elements
└── SortedMap<K, V> → NavigableMap<K, V>
```

`Map` is deliberately outside `Collection`: a map is not a collection of elements but of *mappings*, and it exposes its contents as three **views** — `keySet()`, `values()`, `entrySet()` — that are backed by the map itself.

Java 21 added **`SequencedCollection`** / `SequencedSet` / `SequencedMap`, retrofitted onto types with a defined encounter order, giving them a uniform `getFirst`, `getLast`, `addFirst`, `addLast`, `removeFirst`, `removeLast` and `reversed()`. Before that, getting the last element of a `LinkedHashSet` required iterating it.

## 2. Why the framework looks like this

Three design decisions explain almost everything:

1. **Interfaces over implementations.** Declare `List`, instantiate `ArrayList`. Every API in the JDK takes the interface, so implementations are swappable.
2. **Optional operations.** `add` on an unmodifiable list throws `UnsupportedOperationException` rather than the interface being split into mutable/immutable halves. This was a pragmatic 1998 choice to keep the hierarchy small; it is widely regarded as a mistake, because it moves a type error to run time — but it is what you have.
3. **Views, not copies.** `subList`, `keySet`, `Arrays.asList`, `Collections.unmodifiableList` all *share storage* with their source. Cheap, and a frequent source of surprise.

## 3. Mental model

> **Program to the interface; choose the implementation by data structure.** And always ask of a returned collection: is this a copy, a view, or the live object?

## 4. Choosing an implementation

| Need | Use | Why |
| --- | --- | --- |
| Default list | `ArrayList` | contiguous array, O(1) index, cache-friendly |
| Frequent add/remove at both ends | `ArrayDeque` | circular buffer; beats `LinkedList` at almost everything |
| Default set | `HashSet` | O(1) contains |
| Insertion-ordered set/map | `LinkedHashSet` / `LinkedHashMap` | hash + linked list |
| Sorted set/map, range queries | `TreeSet` / `TreeMap` | red-black tree, O(log n), `NavigableMap` operations |
| Default map | `HashMap` | O(1) get/put |
| Concurrent map | `ConcurrentHashMap` | lock-striped/CAS, no global lock |
| Priority ordering | `PriorityQueue` | binary heap, O(log n) offer/poll |
| Producer/consumer handoff | `ArrayBlockingQueue`, `LinkedBlockingQueue` | blocking semantics |
| Keys are enum constants | `EnumMap` / `EnumSet` | array/bitset-backed, extremely fast |
| Small fixed content | `List.of`, `Map.of`, `Set.of` | immutable, compact, null-hostile |

Two implementations you should know but rarely use: **`Vector`** and **`Hashtable`** are the Java 1.0 synchronised collections, kept only for compatibility; every method is synchronised, which is both too slow and too weak (compound operations still race). **`Stack`** extends `Vector` and iterates in the wrong order — use `ArrayDeque` instead.

## 5. Views — the part that surprises people

```java
List<String> list = new ArrayList<>(List.of("a", "b", "c", "d"));
List<String> sub = list.subList(1, 3);       // a VIEW over [b, c]
sub.set(0, "B");
System.out.println(list);                    // [a, B, c, d]  — the source changed
sub.clear();
System.out.println(list);                    // [a, d]        — removing from the view removes from the source
list.add("e");
System.out.println(sub.size());              // ConcurrentModificationException — structural change to the source

Map<String, Integer> map = new HashMap<>(Map.of("a", 1, "b", 2));
Set<String> keys = map.keySet();             // a VIEW
keys.remove("a");
System.out.println(map);                     // {b=2} — removing a key removes the mapping
// keys.add("c");                            // UnsupportedOperationException — you cannot add through it

List<String> fixed = Arrays.asList("x", "y");// a VIEW over the array: fixed size, mutable elements
fixed.set(0, "z");                           // OK
// fixed.add("w");                           // UnsupportedOperationException
```

The rule: `subList`, `keySet`, `values`, `entrySet`, `Arrays.asList`, `Collections.unmodifiable*`, `List.reversed()` are **views**; `List.copyOf`, `new ArrayList<>(other)`, `stream().toList()` are **copies**.

## 6. Immutable factories and null behaviour

```java
List<String> a = List.of("x", "y");            // Java 9+: immutable, null-hostile, compact
Map<String, Integer> m = Map.of("k", 1);       // unspecified iteration order (randomised per JVM run!)
Set<String> s = Set.copyOf(other);

// List.of(null);              // NullPointerException
// a.add("z");                 // UnsupportedOperationException
List<String> t = someStream.toList();          // Java 16+: immutable, ALLOWS nulls
List<String> c = someStream.collect(Collectors.toList());  // mutability UNSPECIFIED — don't rely on it
```

Null behaviour differs per implementation and gets asked about constantly:

| Collection | null key | null value(s) |
| --- | --- | --- |
| `HashMap` | one allowed | allowed |
| `LinkedHashMap` | one allowed | allowed |
| `TreeMap` | ✗ NPE (natural ordering) | allowed |
| `Hashtable` | ✗ NPE | ✗ NPE |
| `ConcurrentHashMap` | ✗ NPE | ✗ NPE |
| `ArrayList` / `LinkedList` | — | allowed |
| `HashSet` / `LinkedHashSet` | one allowed | — |
| `TreeSet` | ✗ NPE | — |
| `ArrayDeque` | — | ✗ NPE |
| `List.of` / `Map.of` / `Set.of` | ✗ NPE | ✗ NPE |

`ConcurrentHashMap` forbids nulls for a specific reason worth quoting: with concurrent access, `map.get(k) == null` would be ambiguous between "absent" and "mapped to null", and there is no way to disambiguate atomically.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ STL:</strong> containers are value types with copy semantics; algorithms are free functions parameterised by iterators; the container/algorithm split is the whole design. Iterators are first-class and support arithmetic; there is no common base class or interface — the coupling is via templates and concepts.</p>
<p><strong>Java:</strong> collections are reference types with interface polymorphism; algorithms are either methods on the interface (<code>sort</code>, <code>removeIf</code>) or static utilities (<code>Collections.*</code>) or stream pipelines. Iterators are minimal (<code>hasNext</code>/<code>next</code>), and there is no iterator arithmetic.</p>
</div>

| C++ | Java | Note |
| --- | --- | --- |
| `std::vector<T>` | `ArrayList<E>` | same growth strategy; Java boxes primitives |
| `std::list<T>` | `LinkedList<E>` | doubly linked; rarely the right choice in Java |
| `std::deque<T>` | `ArrayDeque<E>` | different internals, similar use |
| `std::unordered_map` | `HashMap` | Java has no per-map hasher |
| `std::map` | `TreeMap` | both red-black trees |
| `std::set` / `unordered_set` | `TreeSet` / `HashSet` | same split |
| `std::priority_queue` | `PriorityQueue` | Java's is a min-heap by default; C++'s is a max-heap |
| `std::array<T,N>` | `T[]` | Java arrays know their length |
| Iterator invalidation → UB | `ConcurrentModificationException` (best-effort) | Java fails loudly, usually |
| Copy on assignment | Reference sharing | The single biggest porting hazard |
| `const` container | `List.of` / unmodifiable view (runtime error) | No compile-time enforcement |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Assigning a collection and expecting a copy.</strong> <code>List&lt;String&gt; b = a;</code> is one list with two names.</p>
<p><strong>Reaching for <code>LinkedList</code> because <code>std::list</code> has O(1) splice.</strong> Java's <code>LinkedList</code> has no splice, allocates a node per element, and loses to <code>ArrayList</code> on nearly every real workload.</p>
<p><strong>Expecting iterator arithmetic.</strong> <code>it + 5</code> does not exist; use index access on a <code>List</code>, or <code>ListIterator</code>.</p>
<p><strong>Assuming an unmodifiable collection is checked at compile time.</strong> It throws at run time.</p>
</div>

## 8. Common mistakes

- Declaring a variable as `ArrayList` instead of `List`.
- Assuming `Collectors.toList()` returns a mutable or immutable list — it is unspecified; use `toList()` or `Collectors.toCollection(ArrayList::new)` deliberately.
- Mutating a source collection while holding a `subList` view.
- Using `Arrays.asList(...)` and then calling `add`.
- Using `Vector`, `Hashtable` or `Stack` in new code.
- Believing `Collections.synchronizedMap` makes compound operations safe (it does not — see Phase 24).
- Relying on `Map.of` iteration order — it is deliberately randomised per JVM run to stop people depending on it.

## 9. Interview questions

**Beginner** — 1. Draw the collection interfaces. 2. Why is `Map` not a `Collection`? 3. `List` vs `Set` vs `Map` — when do you use each?

**Intermediate** — 4. What is a view collection? Name four. 5. Which collections allow nulls? 6. `Arrays.asList` vs `List.of` vs `new ArrayList<>(...)`? 7. What are optional operations and why do they exist?

**Advanced** — 8. Why does `ConcurrentHashMap` forbid null values? 9. What did `SequencedCollection` fix? 10. What happens if you structurally modify a list that has a live `subList`? 11. Why is `Stack` discouraged?

**Senior** — 12. You need an insertion-ordered map with an LRU eviction policy. What do you use and how? 13. Design the collection choice for a request-scoped cache of 50 entries. 14. Critique the optional-operations design and describe what a modern alternative would look like.

## 10. Follow-ups

- *After Q4:* "So does `map.keySet().removeIf(...)` change the map?" → yes.
- *After Q6:* "Which one can I sort?" → only the mutable ones; `List.of` throws.
- *After Q12:* → `LinkedHashMap` with `accessOrder = true` and an overridden `removeEldestEntry`.

## 11. Exercise

1. Build a `LinkedHashMap`-based LRU cache with a capacity of 3 by overriding `removeEldestEntry`. Prove the eviction order with a test.
2. Take a `List<String>`, obtain a `subList`, mutate through the view, then structurally modify the source and catch the exception.
3. Write a method that returns a defensive, unmodifiable snapshot of an internal list; then write the test that proves a caller cannot affect your state through it.

## 12. Output prediction

```java
public class Main {
    public static void main(String[] args) {
        List<String> list = new ArrayList<>(List.of("a", "b", "c"));
        List<String> view = list.subList(0, 2);
        view.set(0, "A");
        System.out.println(list);
        List<String> fixed = Arrays.asList("x", "y");
        fixed.set(0, "z");
        System.out.println(fixed);
        try { fixed.add("w"); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        Map<String, Integer> m = new HashMap<>();
        m.put(null, 1);
        System.out.println(m.get(null));
        try { Map.of("a", 1).put("b", 2); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 13. Mastery check

1. Draw the interface hierarchy including `SequencedCollection`.
2. Why is `Map` outside `Collection`, and what are its three views?
3. Define a view collection and list six of them in the JDK.
4. Give the null-tolerance rules for `HashMap`, `TreeMap`, `ConcurrentHashMap` and `List.of`.
5. Why does `ConcurrentHashMap` reject null values? Give the ambiguity argument.
6. `Arrays.asList` — what exactly can and cannot be done with the result?
7. What are optional operations, and what design would replace them today?
8. What happens to a `subList` when its source is structurally modified?
9. Name three legacy collections and their modern replacements.
10. Contrast the STL container/algorithm split with Java's interface/stream design.
