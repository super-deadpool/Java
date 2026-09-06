---
title: "Lists: ArrayList, LinkedList, and why LinkedList is almost always wrong"
phase: 8
order: 2
minutes: 25
summary: "Growth strategy, memory layout, complexity in theory versus cache behaviour in practice, and the modern list APIs."
tags: ["arraylist", "linkedlist", "list", "performance", "cache"]
---

## 1. `ArrayList` internals

An `ArrayList` is an `Object[]` plus a `size`:

```java
transient Object[] elementData;
private int size;
```

- **`get(i)` / `set(i)`** — O(1), a direct array index.
- **`add(e)`** — amortised O(1). When full, it grows to **oldCapacity + (oldCapacity >> 1)** — i.e. 1.5×, not 2× — allocates a new array and `System.arraycopy`s. **[JDK]** A default-constructed `ArrayList` starts with a shared empty array and allocates 10 slots on first add, so an empty list is cheap.
- **`add(i, e)` / `remove(i)`** — O(n), because everything after `i` shifts by one `arraycopy`.
- **`contains` / `indexOf`** — O(n).
- **Memory** — one contiguous array of references, plus (for boxed types) the boxes themselves.

```java
var list = new ArrayList<String>(10_000);   // capacity hint: avoids ~14 grow-and-copy cycles
list.trimToSize();                          // release the slack after building
```

## 2. `LinkedList` internals

A doubly linked list of nodes; it implements both `List` and `Deque`:

```java
private static class Node<E> { E item; Node<E> next; Node<E> prev; }
```

- **`get(i)`** — O(n). It walks from whichever end is closer. This is the killer: an indexed `for` loop over a `LinkedList` is O(n²).
- **`add(e)` / `addFirst` / `removeFirst`** — O(1).
- **`add(i, e)`** — O(n) to *find* the position, O(1) to link.
- **Memory** — each element costs a `Node` object: header + three references, roughly **40 bytes per element on top of the element itself**, scattered across the heap.

## 3. The practical verdict

The textbook table says "`LinkedList` is O(1) for insertion, `ArrayList` is O(n)". Real measurements almost always disagree, for two reasons:

1. **`ArrayList`'s O(n) is a `System.arraycopy`** — an intrinsified, vectorised block memory move of a contiguous region. `LinkedList`'s O(1) is a pointer chase to *find* the position first, and each node is a cache miss.
2. **Cache locality.** An `ArrayList` walk reads sequential memory and the prefetcher keeps up. A `LinkedList` walk jumps to a random address per element — on modern hardware that is one to two orders of magnitude worse than the asymptotic analysis suggests.

**Use `ArrayList` by default.** Use `ArrayDeque` when you need queue/stack behaviour. `LinkedList` is defensible only when you hold an `Iterator` at the insertion point and are inserting or removing there repeatedly — a genuinely rare shape. Even the JDK's own author has said it exists mostly for historical reasons.

## 4. The rest of the list family

| Class | What it is | Verdict |
| --- | --- | --- |
| `ArrayList` | resizable array | the default |
| `LinkedList` | doubly linked list, also a `Deque` | almost never |
| `Vector` | synchronised `ArrayList` from Java 1.0 | legacy; per-method locking is both slow and insufficient |
| `Stack` | extends `Vector`; iterates **bottom-to-top** | legacy; use `ArrayDeque` |
| `CopyOnWriteArrayList` | copies the whole array on every write | excellent for read-mostly listener lists; O(n) per write |
| `List.of(...)` | immutable, null-hostile, field-specialised for small sizes | for constants and returns |
| `Arrays.asList(a)` | fixed-size **view** over an array | interop only |

## 5. Modern list APIs

```java
list.removeIf(s -> s.isBlank());                  // Java 8, one pass, no iterator juggling
list.replaceAll(String::trim);                    // in place
list.sort(Comparator.comparing(Person::name));    // Java 8; Collections.sort delegates here
var copy = List.copyOf(list);                     // Java 10, immutable copy
var fromStream = stream.toList();                 // Java 16, immutable, allows nulls
var first = list.getFirst();                      // Java 21 SequencedCollection
var reversed = list.reversed();                   // Java 21, a VIEW in reverse order
```

**[JDK]** `List.sort` uses **TimSort** for objects — a stable, adaptive merge sort that is O(n) on already-sorted input and O(n log n) worst case. Primitive arrays (`Arrays.sort(int[])`) use a **dual-pivot quicksort**, which is *not* stable — stability is meaningless for primitives, and quicksort avoids the extra array. Knowing why the two differ is a good interview answer.

## 6. Removal traps

```java
// WRONG — skips elements, or throws
for (String s : list) if (s.isEmpty()) list.remove(s);      // ConcurrentModificationException

// Correct: iterator removal
for (var it = list.iterator(); it.hasNext(); ) if (it.next().isEmpty()) it.remove();

// Better: removeIf
list.removeIf(String::isEmpty);

// The overload trap (Module 1.2)
List<Integer> nums = new ArrayList<>(List.of(10, 20, 30));
nums.remove(1);                      // removes INDEX 1 → [10, 30]
nums.remove(Integer.valueOf(10));    // removes the VALUE → [30]

// Backwards index loop is safe when removing by index
for (int i = list.size() - 1; i >= 0; i--) if (cond(list.get(i))) list.remove(i);
```

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>std::vector&lt;T&gt;</code> stores <code>T</code> <em>by value</em> — a <code>vector&lt;Point&gt;</code> is a contiguous block of Points, one cache line holding several. Growth is typically 2×; <code>reserve</code> is the capacity hint; iterators are invalidated by reallocation (UB if used after).</p>
<p><strong>Java:</strong> <code>ArrayList&lt;Point&gt;</code> stores <em>references</em> — the array is contiguous, but the Points are scattered wherever the allocator put them. You get one level of indirection on every element access that C++ does not have. Growth is 1.5×; the capacity hint is the constructor argument; stale iterators throw <code>ConcurrentModificationException</code> instead of being UB.</p>
<p><strong>Consequence:</strong> Java's "contiguous" is contiguous in <em>pointers</em>, not in data. For numeric work this is why <code>int[]</code> or a primitive-collection library beats <code>List&lt;Integer&gt;</code> by a large factor — and why Valhalla matters.</p>
</div>

| Operation | `std::vector` | `ArrayList` |
| --- | --- | --- |
| Element storage | by value, inline | by reference, indirect |
| Growth factor | usually 2× | 1.5× |
| Reserve | `reserve(n)` | `new ArrayList<>(n)` / `ensureCapacity` |
| Shrink | `shrink_to_fit()` | `trimToSize()` |
| Invalidated iterator | UB | `ConcurrentModificationException` (best-effort) |
| Sort | `std::sort` (introsort, unstable) | TimSort (stable) for objects |
| Remove by value | `erase(remove(...), end())` | `removeIf` |

## 8. Common mistakes

- Using `LinkedList` because "insertion is O(1)".
- Indexed loops over a `LinkedList` (silently O(n²)).
- No capacity hint when the final size is known.
- `list.remove(int)` vs `list.remove(Object)` confusion.
- Removing inside an enhanced `for`.
- `Vector`/`Stack` in new code.
- Assuming `Collectors.toList()` gives a mutable list.
- Using `CopyOnWriteArrayList` for a write-heavy collection.

## 9. Interview questions

**Beginner** — 1. `ArrayList` vs `LinkedList`? 2. How does `ArrayList` grow? 3. What is the default capacity?

**Intermediate** — 4. Complexity of `get`, `add`, `add(i,e)`, `remove(i)`, `contains` for both. 5. Why is `LinkedList` slower in practice despite better asymptotics? 6. How do you safely remove while iterating? 7. Why is `Vector` discouraged?

**Advanced** — 8. Why 1.5× growth rather than 2×? 9. Why does Java use TimSort for objects and quicksort for primitives? 10. What is `CopyOnWriteArrayList` for and what does it cost? 11. What is the memory overhead per element for each list type?

**Senior** — 12. A list of 10 million integers is causing GC pressure. Options? 13. Profile shows 40% of time in `ArrayList.grow`. What do you do? 14. When would you genuinely choose `LinkedList`?

## 10. Follow-ups

- *After Q5:* "Quantify it." → cache-miss cost, ~40 bytes/node overhead, pointer chasing.
- *After Q9:* "Why does stability not matter for primitives?" → equal primitives are indistinguishable.
- *After Q12:* → `int[]`, `IntStream`, fastutil/Eclipse Collections, or restructuring to avoid holding it all.

## 11. Exercise

Benchmark (with JMH, after warm-up) for n = 100 000:
1. Append to `ArrayList` with and without a capacity hint.
2. Iterate `ArrayList` vs `LinkedList` with an enhanced `for`, then with an indexed `for`.
3. Insert at index 0 for both.
4. `contains` for both.

Predict all eight results first. Explain every case where your prediction was wrong, in terms of §3.

## 12. Output prediction

```java
public class Main {
    public static void main(String[] args) {
        List<Integer> nums = new ArrayList<>(List.of(10, 20, 30));
        nums.remove(1);
        System.out.println(nums);
        nums.remove(Integer.valueOf(10));
        System.out.println(nums);

        List<String> l = new ArrayList<>(List.of("a", "", "b"));
        try { for (String s : l) if (s.isEmpty()) l.remove(s); }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        Deque<Integer> stack = new ArrayDeque<>();
        stack.push(1); stack.push(2);
        System.out.println(stack);
        Stack<Integer> old = new Stack<>();
        old.push(1); old.push(2);
        System.out.println(old);
    }
}
```

## 13. Mastery check

1. Give `ArrayList`'s internal fields and its exact growth formula.
2. Give the complexity table for both list types, then explain why it misleads.
3. What is the per-element memory overhead of `LinkedList`?
4. Why is `System.arraycopy` fast enough to beat pointer manipulation?
5. Three safe ways to remove elements during iteration.
6. Why TimSort for objects and dual-pivot quicksort for primitives?
7. When is `CopyOnWriteArrayList` right, and what is its write cost?
8. Contrast `std::vector<Point>` and `ArrayList<Point>` on memory layout, and give the performance consequence.
9. Why does `list.remove(1)` on a `List<Integer>` surprise people?
10. Name a workload where `LinkedList` genuinely wins.
