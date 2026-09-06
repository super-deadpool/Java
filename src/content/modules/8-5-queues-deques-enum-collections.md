---
title: "Queues, Deques, PriorityQueue, and the Enum Collections"
phase: 8
order: 5
minutes: 25
summary: "ArrayDeque as the default stack and queue, how a binary heap behaves, and why EnumMap and EnumSet are in a performance class of their own."
tags: ["queue", "deque", "arraydeque", "priorityqueue", "enumset", "enummap"]
---

## 1. `Queue` and `Deque` contracts

`Queue` declares each operation twice — once throwing, once returning a sentinel. Knowing both columns is a standard interview check:

| Operation | Throws on failure | Returns special value |
| --- | --- | --- |
| Insert | `add(e)` → `IllegalStateException` | `offer(e)` → `false` |
| Remove | `remove()` → `NoSuchElementException` | `poll()` → `null` |
| Examine | `element()` → `NoSuchElementException` | `peek()` → `null` |

`Deque` adds the ends explicitly — `addFirst`/`addLast`, `pollFirst`/`pollLast`, `peekFirst`/`peekLast` — plus stack aliases `push`/`pop`/`peek` which operate on the **head**.

## 2. `ArrayDeque` — the one to reach for

**[JDK]** A circular buffer: an array plus `head` and `tail` indices, capacity always a power of two so wraparound is a mask. Both ends are O(1) amortised; growth doubles.

```java
Deque<Task> queue = new ArrayDeque<>();
queue.addLast(task);            // enqueue
Task next = queue.pollFirst();  // dequeue

Deque<Frame> stack = new ArrayDeque<>();
stack.push(frame);              // == addFirst
Frame top = stack.pop();        // == removeFirst
```

It beats `LinkedList` as a queue (no node allocation, cache-friendly) and beats `Stack` as a stack (no synchronisation, and it iterates in the right order — `Stack` iterates bottom-to-top because it extends `Vector`). **It rejects `null`**, because `null` is the "empty" sentinel returned by `poll` and `peek`.

## 3. `PriorityQueue` — a binary heap

**[JDK]** An array-backed binary min-heap ordered by `Comparable` or a `Comparator`:

- `offer` / `poll` — O(log n) (sift up / sift down)
- `peek` — O(1)
- `remove(Object)` / `contains` — **O(n)**, a linear scan
- **Iteration order is NOT sorted.** It is heap array order. Only `poll` returns elements in priority order.

```java
var pq = new PriorityQueue<Task>(Comparator.comparingInt(Task::priority));   // min-heap: lowest first
var maxHeap = new PriorityQueue<Integer>(Comparator.reverseOrder());

// The top-k idiom: keep a min-heap of size k, poll the smallest when it overflows
static <T> List<T> topK(Collection<T> items, int k, Comparator<T> cmp) {
    var heap = new PriorityQueue<>(cmp);
    for (T item : items) {
        heap.offer(item);
        if (heap.size() > k) heap.poll();      // drop the worst
    }
    return new ArrayList<>(heap);              // O(n log k), not O(n log n)
}
```

`PriorityQueue` is unbounded and **not** thread-safe; `PriorityBlockingQueue` is the concurrent version. Ties are broken arbitrarily — it is not stable, so add a sequence number to the comparator if FIFO-within-priority matters.

## 4. Blocking queues (preview of Phase 24)

```java
BlockingQueue<Job> q = new ArrayBlockingQueue<>(1000);    // bounded — provides BACKPRESSURE
q.put(job);            // blocks while full
Job j = q.take();      // blocks while empty
q.offer(job, 100, TimeUnit.MILLISECONDS);                 // bounded wait
```

| Implementation | Notes |
| --- | --- |
| `ArrayBlockingQueue` | bounded, single lock, fixed array — the safe default |
| `LinkedBlockingQueue` | optionally bounded; separate put/take locks, higher throughput |
| `SynchronousQueue` | zero capacity; each put waits for a take — a handoff (used by `newCachedThreadPool`) |
| `LinkedTransferQueue` | unbounded, `transfer()` waits for a consumer |
| `DelayQueue` / `PriorityBlockingQueue` | scheduled and priority variants |

The one design lesson: **prefer a bounded queue.** An unbounded work queue converts an overload into an `OutOfMemoryError` instead of applying backpressure.

## 5. `EnumSet` and `EnumMap` — the fast path

These are special-cased because enum constants have a small, dense, known-at-load-time set of ordinals.

**[JDK]** `EnumSet` is abstract with two implementations: `RegularEnumSet` for ≤ 64 constants, backed by a **single `long` used as a bit vector**, and `JumboEnumSet` backed by a `long[]`. Membership is a bit test; union, intersection and difference are single machine instructions. It cannot get faster than that.

**[JDK]** `EnumMap` is backed by a plain `Object[]` indexed by `ordinal()`. No hashing, no collisions, no boxing of the key, iteration in **natural (declaration) order**, and near-zero memory overhead.

```java
enum Permission { READ, WRITE, DELETE, ADMIN }

var perms = EnumSet.of(Permission.READ, Permission.WRITE);
var all   = EnumSet.allOf(Permission.class);
var none  = EnumSet.noneOf(Permission.class);
var most  = EnumSet.complementOf(EnumSet.of(Permission.ADMIN));
var range = EnumSet.range(Permission.READ, Permission.DELETE);

var handlers = new EnumMap<Permission, Handler>(Permission.class);   // needs the Class for the ordinals
handlers.put(Permission.READ, readHandler);
```

**Rule: if the key or element type is an enum, use `EnumMap`/`EnumSet`.** Not `HashMap`/`HashSet`. The difference is not marginal — it is an array index versus a hash, and a bit versus a `Node` object. This is one of the easiest real performance wins in Java and a strong signal in an interview.

Both reject `null` elements/keys and are not thread-safe (`Collections.synchronizedMap` or a `ConcurrentHashMap` if you need that).

## 6. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>std::queue</code> and <code>std::stack</code> are <em>adaptors</em> over a container (<code>deque</code> by default) — they restrict an interface rather than provide a structure. <code>std::priority_queue</code> is a <strong>max</strong>-heap by default over <code>operator&lt;</code>.</p>
<p><strong>Java:</strong> <code>Queue</code>/<code>Deque</code> are interfaces with real implementations behind them, and <code>PriorityQueue</code> is a <strong>min</strong>-heap by default. That default flip catches almost everyone once.</p>
</div>

| C++ | Java |
| --- | --- |
| `std::deque<T>` | `ArrayDeque<E>` (different internals, same role) |
| `std::queue<T>` (adaptor) | `Queue<E>` interface + `ArrayDeque` |
| `std::stack<T>` (adaptor) | `Deque<E>` + `push`/`pop` (never `Stack`) |
| `std::priority_queue` — **max**-heap | `PriorityQueue` — **min**-heap |
| `std::bitset<N>` for flag sets | `EnumSet` (a bit vector, but type-safe) |
| `std::array<V, N>` indexed by enum | `EnumMap` |
| No blocking queue in the standard library | `BlockingQueue` family |

## 7. Edge cases

```java
new ArrayDeque<String>().add(null);          // NullPointerException

var pq = new PriorityQueue<>(List.of(5, 1, 3));
System.out.println(pq);                      // [1, 5, 3] — heap order, NOT sorted
System.out.println(pq.poll() + " " + pq.poll() + " " + pq.poll());   // 1 3 5

var q = new ArrayDeque<Integer>();
System.out.println(q.poll());                // null   — sentinel
// System.out.println(q.remove());           // NoSuchElementException

var stack = new ArrayDeque<Integer>();
stack.push(1); stack.push(2);
System.out.println(stack);                   // [2, 1] — head first, i.e. top first
var legacy = new Stack<Integer>();
legacy.push(1); legacy.push(2);
System.out.println(legacy);                  // [1, 2] — bottom first. Opposite!

EnumSet.noneOf(Permission.class).add(null);  // NullPointerException
// new EnumMap<Permission, String>();        // needs the Class object or a source map
```

## 8. Common mistakes

- Using `LinkedList` as a queue instead of `ArrayDeque`.
- Using `Stack` (synchronised, wrong iteration order).
- Expecting `PriorityQueue` iteration or `toString` to be sorted.
- `pq.remove(x)` in a loop — O(n) each, so O(n²).
- Unbounded work queues in a thread pool.
- `HashMap` keyed by an enum.
- Forgetting `ArrayDeque`, `PriorityQueue` and `EnumMap` all reject nulls.
- Mutating an object's priority field while it sits in a `PriorityQueue` (the heap invariant is not re-established).

## 9. Interview questions

**Beginner** — 1. Queue vs Deque vs Stack? 2. `offer` vs `add`, `poll` vs `remove`? 3. What is `PriorityQueue` ordered by?

**Intermediate** — 4. Why `ArrayDeque` over `LinkedList`? 5. Why is `PriorityQueue` iteration unsorted? 6. Why do these collections reject null? 7. What is `EnumSet` backed by?

**Advanced** — 8. Complexity of every `PriorityQueue` operation, including `remove(Object)`. 9. Implement top-k in O(n log k). 10. Compare the four main `BlockingQueue`s and their use cases. 11. Why is `EnumMap` faster than `HashMap`, precisely?

**Senior** — 12. Design a work queue with backpressure and priority. 13. What happens when an unbounded queue meets a slow consumer? 14. When is `SynchronousQueue` the right choice? 15. You need a priority queue with decrease-key. What do you do?

## 10. Follow-ups

- *After Q5:* "How do you get sorted output?" → drain with `poll`, or use a `TreeSet` if elements are unique.
- *After Q11:* "How much memory does an `EnumSet` of 10 constants use?" → one `long`.
- *After Q15:* → an index map from element to heap position, or lazy deletion with a `visited` set (the standard Dijkstra trick).

## 11. Exercise

1. Implement a task scheduler over `PriorityQueue<Task>` ordered by `(priority, sequenceNumber)`; show that the sequence number restores FIFO for equal priorities.
2. Implement top-k with a bounded min-heap and compare against `sort().limit(k)` for n = 1 000 000, k = 10.
3. Replace a `HashMap<DayOfWeek, List<Event>>` with an `EnumMap` and measure both lookup time and retained size.
4. Build a producer/consumer with `ArrayBlockingQueue(10)` and one slow consumer; observe the producer blocking. Then switch to `LinkedBlockingQueue()` unbounded and watch heap usage climb instead.

## 12. Output prediction

```java
public class Main {
    public static void main(String[] args) {
        Queue<Integer> pq = new PriorityQueue<>(List.of(5, 1, 3, 2));
        System.out.println(pq);
        StringBuilder sb = new StringBuilder();
        while (!pq.isEmpty()) sb.append(pq.poll()).append(" ");
        System.out.println(sb);

        Deque<Integer> d = new ArrayDeque<>();
        d.push(1); d.push(2); d.addLast(3);
        System.out.println(d + " " + d.peek() + " " + d.peekLast());

        Queue<Integer> empty = new ArrayDeque<>();
        System.out.println(empty.poll());
        try { empty.remove(); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 13. Mastery check

1. Give the six `Queue` methods in two columns and say what each does on failure.
2. What is `ArrayDeque` backed by, and why must its capacity be a power of two?
3. Why does `ArrayDeque` reject null?
4. Give the complexity of `offer`, `poll`, `peek`, `contains` and `remove(Object)` on a `PriorityQueue`.
5. Why is `PriorityQueue` iteration not sorted, and how do you get sorted output?
6. Write the top-k algorithm and state its complexity.
7. What is `EnumSet` backed by for 30 constants? For 100?
8. What is `EnumMap` backed by, and why does it need the `Class` object?
9. Name the four main `BlockingQueue` implementations and one use for each.
10. Why is a bounded queue almost always the right choice in a server?
