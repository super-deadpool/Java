---
title: "Iterators: the enhanced for loop, fail-fast, and weakly consistent traversal"
phase: 10
order: 1
minutes: 40
summary: "What the for-each loop compiles to, why ConcurrentModificationException is a debugging aid rather than a guarantee, and how concurrent collections traverse without one."
tags: ["iterator", "iterable", "concurrentmodification", "spliterator", "listiterator"]
---

## 1. Concept

Three interfaces, in dependency order:

```java
public interface Iterable<T> {
    Iterator<T> iterator();
    default void forEach(Consumer<? super T> action) { ... }
    default Spliterator<T> spliterator() { ... }          // Java 8+, feeds streams
}

public interface Iterator<E> {
    boolean hasNext();
    E next();                                    // throws NoSuchElementException when exhausted
    default void remove() { throw new UnsupportedOperationException(); }
    default void forEachRemaining(Consumer<? super E> action) { ... }
}

public interface ListIterator<E> extends Iterator<E> {
    boolean hasPrevious();  E previous();
    int nextIndex();        int previousIndex();
    void set(E e);          void add(E e);       // set replaces the last returned element
}
```

An `Iterator` is a **one-shot, forward-only cursor**. It cannot be copied, reset, or rewound. Getting a second traversal means calling `iterator()` again.

## 2. What the enhanced for loop actually is

**[JLS 14.14.2]** It is pure syntax sugar with two desugarings chosen by the static type of the expression.

```java
// Over an Iterable
for (String s : list) { use(s); }
// compiles to exactly:
for (Iterator<String> it = list.iterator(); it.hasNext(); ) {
    String s = it.next();
    use(s);
}

// Over an array — no Iterator object exists
for (String s : arr) { use(s); }
// compiles to exactly:
for (int i = 0; i < arr.length; i++) {          // arr and length hoisted into synthetic locals
    String s = arr[i];
    use(s);
}
```

Three consequences that come straight from the desugaring:

- **You cannot remove during a for-each.** The `Iterator` is in a synthetic variable you have no name for. To remove, write the loop out and call `it.remove()`, or use `removeIf`.
- **The loop variable is a fresh local each iteration**, so it is effectively final and capturable by a lambda. (In the array form the *index* is not.)
- **`arr.length` is evaluated once.** Growing an array is impossible anyway, but reassigning `arr` inside the loop does not change the traversal.

## 3. Mental model

> An `Iterator` is a **cursor sitting between two elements**. `next()` steps it forward and hands you the element it stepped over. `remove()` deletes that element — the one just stepped over, not the one ahead.

`ListIterator` makes the cursor bidirectional, which is why `nextIndex()` and `previousIndex()` always differ by exactly one, and why alternating `next()`/`previous()` returns the **same element repeatedly** rather than advancing.

## 4. Removing and modifying during traversal

```java
// The only safe in-place removal with a plain Iterator
for (Iterator<Order> it = orders.iterator(); it.hasNext(); ) {
    if (it.next().isCancelled()) it.remove();
}

// Java 8+: shorter, and on ArrayList substantially faster (§6)
orders.removeIf(Order::isCancelled);

// ListIterator can also replace and insert
for (ListIterator<String> it = lines.listIterator(); it.hasNext(); ) {
    String line = it.next();
    if (line.isBlank())        it.remove();
    else if (line.endsWith(":")) { it.set(line.strip()); it.add("  (section)"); }
    //  add() inserts BEFORE the cursor, so the new element is not visited
}

// Structural modification through the collection while an iterator is live: broken
for (String s : list) {
    if (s.isEmpty()) list.remove(s);            // ConcurrentModificationException
}
```

`it.remove()` may be called **once per `next()`**, and never before the first `next()`; otherwise `IllegalStateException`. `Iterator.remove` is optional — `List.of(...)`, `Arrays.asList(...)`, `Collections.unmodifiableList(...)` and `CopyOnWriteArrayList` all throw `UnsupportedOperationException`.

## 5. Realistic example — a custom Iterable

Expose an internal structure for traversal without exposing the structure.

```java
/** A fixed-capacity ring buffer that iterates oldest → newest. */
public final class RingBuffer<E> implements Iterable<E> {
    private final Object[] items;
    private int head, size, modCount;

    public RingBuffer(int capacity) { items = new Object[capacity]; }

    public void add(E e) {
        if (size == items.length) { items[head] = e; head = (head + 1) % items.length; }
        else                      { items[(head + size) % items.length] = e; size++; }
        modCount++;                                        // every structural change
    }

    @Override public Iterator<E> iterator() {
        return new Iterator<>() {
            private int visited = 0;
            private final int expectedModCount = modCount; // snapshot at creation

            @Override public boolean hasNext() { return visited < size; }

            @Override @SuppressWarnings("unchecked")
            public E next() {
                if (modCount != expectedModCount) throw new ConcurrentModificationException();
                if (visited >= size) throw new NoSuchElementException();
                return (E) items[(head + visited++) % items.length];
            }
        };
    }
}
```

Implementing `Iterable` is what buys you the for-each loop, `forEach`, and — via the default `spliterator()` — `StreamSupport.stream(this.spliterator(), false)`.

## 6. What happens internally

**[JDK]** Every non-concurrent collection carries an `int modCount`, incremented on every **structural modification** (one that changes the size, or in `HashMap`'s case also rehashes). Each iterator snapshots it as `expectedModCount` and re-checks:

```java
// ArrayList.Itr
final void checkForComodification() {
    if (modCount != expectedModCount) throw new ConcurrentModificationException();
}
```

Three things follow, and all three are interview material:

**`CME` is best-effort.** **[JDK javadoc]** *"Note that fail-fast behavior cannot be guaranteed as it is, generally speaking, impossible to make any hard guarantees in the presence of unsynchronized concurrent modification. Fail-fast iterators throw `ConcurrentModificationException` on a best-effort basis. Therefore, it would be wrong to write a program that depended on this exception for its correctness: it should be used only to detect bugs."*

**The famous false negative.** `ArrayList.Itr.hasNext()` is `cursor != size`. Remove the **second-to-last** element and the loop exits without ever calling `next()` again — no check, no exception, one element silently skipped:

```java
var l = new ArrayList<>(List.of("a", "b", "c"));
for (String s : l) { if (s.equals("b")) l.remove(s); }   // no exception; result [a, c]

var m = new ArrayList<>(List.of("a", "b", "c"));
for (String s : m) { if (s.equals("a")) m.remove(s); }   // CME
```

**Single-threaded CME is the common case.** The name says "concurrent" but the overwhelming majority of these are one thread modifying a collection it is iterating.

**`removeIf` on `ArrayList` is not a loop around `remove`.** **[JDK]** It makes one pass building a bit set of survivors and a second pass compacting, so it is O(n) total. `while (it.hasNext()) if (p) it.remove();` is O(n²) — each `remove` does an `arraycopy` of the tail.

**`ArrayList.forEach` and `Iterable.forEach`** also check `modCount`, at the end of the loop rather than per element.

**Weakly consistent iterators** — the concurrent collections' answer. **[JDK]** They:

- never throw `ConcurrentModificationException`;
- reflect the state of the collection at **some point at or since** the iterator was created;
- may or may not reflect modifications made after creation;
- traverse each element **at most once**.

| Collection | Iterator kind | Supports `remove()` | Notes |
| --- | --- | --- | --- |
| `ArrayList`, `HashMap`, `TreeMap`, `ArrayDeque` | fail-fast | ✅ | best-effort detection |
| `ConcurrentHashMap` | weakly consistent | ✅ | walks the bin table live |
| `ConcurrentLinkedQueue/Deque`, `ConcurrentSkipListMap` | weakly consistent | ✅ | |
| `CopyOnWriteArrayList/Set` | **snapshot** | ❌ `UnsupportedOperationException` | iterates the array as of creation; later writes invisible |
| `Collections.synchronizedList` | fail-fast | ✅ | *you* must hold the lock across the whole traversal |

`Collections.synchronizedX` is the sharpest edge here: each method is synchronized, but a traversal is many method calls, so you must lock manually:

```java
List<String> sync = Collections.synchronizedList(new ArrayList<>());
synchronized (sync) {                       // required; not optional
    for (String s : sync) { ... }
}
```

**`Spliterator`** (Java 8+) is the parallel-capable successor and the thing streams actually run on:

```java
public interface Spliterator<T> {
    boolean tryAdvance(Consumer<? super T> action);   // hasNext + next fused: one virtual call
    Spliterator<T> trySplit();                        // hand off ~half to another thread, or null
    long estimateSize();
    int characteristics();     // ORDERED DISTINCT SORTED SIZED NONNULL IMMUTABLE CONCURRENT SUBSIZED
}
```

Fusing `hasNext`/`next` halves the virtual calls; `SIZED | SUBSIZED` on an `ArrayList` is what lets a parallel stream split by index into perfectly balanced halves, and its absence on a `LinkedList` is a large part of why parallel streams over one perform badly (Module 12.3).

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++</strong> iterators are generalized pointers used in <strong>half-open pairs</strong> <code>[begin, end)</code>. They are values: copyable, comparable, arithmetic-capable at the random-access tier, and organised into <em>categories</em> that algorithms constrain on. Modifying a container invalidates iterators according to precise per-container rules, and using an invalidated one is <strong>undefined behaviour</strong> — usually silent corruption.</p>
<p><strong>Java</strong> has one iterator category — roughly C++'s input iterator with a <code>hasNext()</code> lookahead — held as a heap object, not a value. There is no <code>end()</code>, no arithmetic, no copying, no <code>const_iterator</code>. In exchange, modification during traversal is <em>usually detected</em> and turned into an exception instead of undefined behaviour.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Shape | `begin()`/`end()` pair | single cursor + `hasNext()` |
| Categories | input / forward / bidirectional / random-access / contiguous | `Iterator`, plus `ListIterator` for bidirectional |
| Value semantics | copyable, comparable, `it + n` | object reference; none of that |
| Erase during traversal | `it = c.erase(it);` returns the next valid iterator | `it.remove();` — iterator stays valid |
| Invalid use | Undefined behaviour | `ConcurrentModificationException`, best-effort |
| Read-only view | `const_iterator` | none — use an unmodifiable wrapper |
| Range abstraction | C++20 ranges/views, lazy | Streams (Phase 12) |
| Parallel split | `std::execution::par` over ranges | `Spliterator.trySplit()` |

Erasure is the concrete daily difference: `for (auto it = v.begin(); it != v.end(); )` with `it = v.erase(it)` versus `else ++it` is the C++ pattern; Java's `it.remove()` leaves the iterator positioned correctly with no reassignment.

## 8. Edge cases

- **`next()` without `hasNext()`** throws `NoSuchElementException`, not `IndexOutOfBounds`.
- **Two iterators over one list, one removing.** The removing iterator updates `expectedModCount` for itself only; the other one throws on its next `next()`.
- **Nested loops over the same list** with an inner `remove` throw in the *outer* loop.
- **`Map` iteration** goes through `entrySet()`. `entry.setValue(v)` is legal and writes through — it is **not** a structural modification, so no `modCount` bump. Adding a key during iteration is structural and throws.
- **`keySet().iterator().remove()`** removes the whole mapping.
- **Sublist views** (`list.subList(...)`) share `modCount` with the backing list; structurally modifying the parent invalidates the view — the view throws `ConcurrentModificationException` on its next use.
- **`Arrays.asList(arr)`** is a fixed-size view: `set` works, `remove`/`add` throw.
- **`Iterator` is not `AutoCloseable`.** An iterator over a file-backed source leaks unless the source is closed separately; `Files.lines()` returns a `Stream`, which *is* closeable — use it in try-with-resources.
- **`CopyOnWriteArrayList` iteration is a snapshot**, so a loop over it never sees concurrent adds and `it.remove()` always throws. That is the intended design, not a bug.
- **Java 21 sequenced collections:** `list.reversed()` returns a *view* whose iterator walks backwards, which is cheaper and clearer than a manual `ListIterator` at `list.size()`.

## 9. Common mistakes

- `list.remove(x)` inside a for-each — the single most common `CME`.
- Relying on `CME` to detect a threading bug. It is best-effort; the absence of it proves nothing.
- Assuming the third-from-last removal behaves like the second-from-last. It does not.
- `while (it.hasNext()) { if (p(it.next())) it.remove(); }` on a large `ArrayList` — O(n²); use `removeIf`.
- Calling `it.remove()` twice, or before any `next()` — `IllegalStateException`.
- Iterating a `Collections.synchronizedList` without holding its monitor.
- Expecting `CopyOnWriteArrayList` iteration to see concurrent writes.
- Storing an `Iterator` in a field and re-iterating it.
- Forgetting `modCount` in a custom collection, so its iterators are silently non-fail-fast.
- Using `entrySet()` entries after the iteration has moved past them — they are views, not copies.

## 10. Interview questions

**Beginner** — 1. What does the enhanced for loop compile to? 2. Why can you not call `list.remove` inside one? 3. Difference between `Iterator` and `ListIterator`?

**Intermediate** — 4. How does fail-fast detection work? 5. When is `Iterator.remove` legal? 6. What is `ConcurrentModificationException` and is it always about threads? 7. What does `removeIf` do differently from a remove loop?

**Advanced** — 8. Show an input where removing during a for-each does **not** throw, and explain precisely why. 9. Define "weakly consistent" with all four of its guarantees. 10. Why does `CopyOnWriteArrayList`'s iterator refuse `remove()`? 11. What does `Spliterator` add over `Iterator`, and why does fusing `hasNext`/`next` matter?

**Senior** — 12. A service throws `ConcurrentModificationException` in production roughly once a week and never in tests. Give three distinct root causes and how you would distinguish them. 13. Design an iterator over a paginated remote API: lazy, resource-safe, and honest about what it guarantees. 14. Why is `Collections.synchronizedMap` still unsafe for iteration when every method is synchronized?

## 11. Follow-ups

- *After Q4:* "So is it a correctness guarantee?" → No — best-effort, bug detection only.
- *After Q8:* "Which element gets skipped, and does the list end up correct?"
- *After Q9:* "Does weakly consistent mean you see a consistent snapshot?" → No; that is `CopyOnWriteArrayList`.
- *After Q12:* → single-threaded remove-in-loop; genuine data race; a shared `subList` or `keySet` view.
- *After Q14:* "What is the fix if you cannot switch to `ConcurrentHashMap`?" → lock across the whole traversal.

## 12. Exercise

1. Implement `Iterable<T>` for a singly linked list you write yourself, with a working `modCount` and an `Iterator` that supports `remove()`. Write a test proving `remove()` is rejected before the first `next()`.
2. Reproduce the second-to-last false negative on `ArrayList`, then repeat with `LinkedList` and `HashSet` and explain the differences.
3. Benchmark `removeIf(p)` against an iterator-remove loop on an `ArrayList` of 1 000 000 elements where `p` matches half. Explain the ratio.
4. Write a `Spliterator` for your linked list that reports `ORDERED | NONNULL` and returns `null` from `trySplit()`. Feed it to a parallel stream and measure; then implement a real `trySplit` and measure again.
5. Write a lazy `Iterable<Row>` over a paginated HTTP API that fetches page N+1 only when the caller exhausts page N, and state explicitly what it guarantees about concurrent server-side changes.

## 13. Output prediction

```java
import java.util.*;

public class Main {
    public static void main(String[] args) {
        var a = new ArrayList<>(List.of("x", "y", "z"));
        for (String s : a) if (s.equals("y")) a.remove(s);
        System.out.println(a);

        var b = new ArrayList<>(List.of("x", "y", "z", "w"));
        try { for (String s : b) if (s.equals("y")) b.remove(s); System.out.println("no throw " + b); }
        catch (ConcurrentModificationException e) { System.out.println("CME " + b); }

        var m = new HashMap<String, Integer>(Map.of("a", 1, "b", 2));
        for (var e : m.entrySet()) e.setValue(e.getValue() * 10);
        System.out.println(new TreeMap<>(m));

        var it = List.of(1, 2, 3).listIterator();
        System.out.println(it.next() + " " + it.next() + " " + it.previous() + " " + it.nextIndex());

        var cow = new java.util.concurrent.CopyOnWriteArrayList<>(List.of(1, 2, 3));
        var cit = cow.iterator();
        cow.add(4);
        int n = 0; while (cit.hasNext()) { cit.next(); n++; }
        System.out.println(n + " " + cow.size());

        var big = new ArrayList<>(List.of(1, 2, 3, 4, 5, 6));
        var sub = big.subList(1, 4);
        big.add(7);
        try { System.out.println(sub); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 14. Mastery check

1. Write both desugarings of the enhanced for loop from memory.
2. Explain `modCount`/`expectedModCount` and name every place `modCount` is incremented in an `ArrayList`.
3. Give the exact `ArrayList` scenario in which removing during a for-each does not throw, and say what the loop skips.
4. Quote the guarantee that fail-fast iteration actually offers.
5. List the four properties of a weakly consistent iterator.
6. Why is `removeIf` asymptotically better than an iterator-remove loop on an `ArrayList`?
7. Why does `CopyOnWriteArrayList` have a snapshot iterator, and what does that cost?
8. What are the two rules governing when `Iterator.remove()` may be called?
9. Name four `Spliterator` characteristics and say what each enables.
10. Why does `Collections.synchronizedList` still require manual locking to iterate?
