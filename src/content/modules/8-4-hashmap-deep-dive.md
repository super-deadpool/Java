---
title: "HashMap: buckets, resizing, treeification, and everything that can go wrong"
phase: 8
order: 4
minutes: 50
summary: "The single most asked-about class in Java interviews, taken apart: the hash spread, the power-of-two index, the resize split trick, the tree fallback, and the concurrency failures."
tags: ["hashmap", "hashing", "resize", "treeification", "concurrenthashmap"]
---

## 1. Concept

`HashMap` is an array of **bins** (buckets). Each bin holds either nothing, a linked list of nodes, or — past a threshold — a red-black tree. A key's bin is computed from its hash; within the bin, keys are compared with `equals`.

**[JDK]** The fields:

```java
transient Node<K,V>[] table;   // the bin array; length is ALWAYS a power of two; lazily allocated
transient int size;            // number of mappings
int threshold;                 // resize when size exceeds this: capacity * loadFactor
final float loadFactor;        // default 0.75
transient int modCount;        // structural modification counter (fail-fast iterators)

static class Node<K,V> { final int hash; final K key; V value; Node<K,V> next; }
```

Defaults: capacity **16**, load factor **0.75**, so the first resize happens when the 13th entry is added.

## 2. The lookup path, step by step

```java
// 1. Spread the hash
static int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}

// 2. Index into the table
int index = (table.length - 1) & hash;

// 3. Walk the bin
//    first check the head (the overwhelmingly common case), then the list or tree
//    match is: e.hash == hash && (e.key == key || key.equals(e.key))
```

Three details, each a standard question:

**Why `^ (h >>> 16)`?** Because the index is `(n-1) & hash` and `n` is a power of two, only the **low bits** of the hash select the bin. A `hashCode` that varies only in its high bits (very common — e.g. `Integer.hashCode` is the value itself, and object hashes with aligned addresses) would collide massively. XOR-ing the top 16 bits down mixes high-bit entropy into the low bits, cheaply — one shift and one XOR, no full avalanche function.

**Why is capacity a power of two?** So the index can be `(n-1) & hash` — a single AND — instead of `hash % n`, an integer division roughly 20–40× more expensive. `tableSizeFor` rounds any requested capacity up to the next power of two.

**Why check `e.hash == hash` before `equals`?** The cached int comparison rejects almost all non-matches without calling a potentially expensive `equals` (imagine long strings).

**Null key:** hashes to 0, lands in bin 0. One null key is allowed; `HashMap` special-cases it rather than calling `hashCode` on it.

## 3. Resizing

When `size > threshold`, the table **doubles** and every entry is redistributed. The Java 8+ split is elegant and worth knowing precisely:

Because capacity doubles and is a power of two, the new index differs from the old only by **one bit** — the bit at the old capacity:

```text
oldCap = 16 (10000b), newCap = 32
newIndex = hash & 31 = (hash & 15) | (hash & 16)

So:  (hash & oldCap) == 0  →  stays at index j
     (hash & oldCap) != 0  →  moves to index j + oldCap
```

Each bin is therefore split into exactly two lists — a "lo" list and a "hi" list — in **one pass, with no rehashing and no recomputation**, preserving relative order within each list.

```java
// The consequence in practice: 100 000 inserts into a default-sized map does this
// 16 → 32 → 64 → ... → 262 144, thirteen full rehashes, each O(n).
var sized = new HashMap<String, String>(100_000 / 0.75f + 1 > 0 ? (int)(100_000 / 0.75f) + 1 : 16);
var better = HashMap.<String, String>newHashMap(100_000);   // Java 19+: does the arithmetic for you
```

**Why 0.75?** A space/time compromise. **[JDK source]** The class comment notes that with a good hash and a 0.75 load factor, bin occupancy follows a Poisson distribution with λ = 0.5 — so a bin holding 8 or more entries has probability under 1 in 10 million. Lower load factor = more memory, fewer collisions; higher = the reverse. 0.75 also makes `threshold` computable by a shift on power-of-two capacities.

## 4. Treeification

**[JDK 8+]** If a bin reaches **8** nodes (`TREEIFY_THRESHOLD`) *and* the table is at least **64** (`MIN_TREEIFY_CAPACITY`), that bin becomes a red-black tree, turning worst-case bin lookup from O(n) into O(log n). If the table is smaller than 64, the map **resizes instead** — a small table with a long chain usually just needs more bins. On removal, a tree bin reverts to a list at **6** nodes (`UNTREEIFY_THRESHOLD`); the gap between 8 and 6 provides hysteresis so that a bin hovering at the boundary does not convert back and forth.

Tree bins order nodes by hash; when hashes tie, by the keys' natural ordering if they implement `Comparable`, and failing that by a deterministic tie-break on identity hash codes.

**Why this was added:** the 2011 hash-collision denial-of-service class of attack. An attacker who can choose keys (JSON field names, HTTP parameters) can force thousands of collisions into one bin, turning every insert into an O(n) walk and a single request into minutes of CPU. Treeification caps the damage at O(log n). It is a **mitigation**, not a fix — the real fix for attacker-controlled keys is a randomised hash or a size limit.

## 5. The concurrency failures

`HashMap` is **not thread-safe**, and the failure modes differ by version — a favourite senior question:

**Java 7 and earlier:** resize transferred entries with **head insertion**, which reversed each bin's order. Two threads resizing simultaneously could link two nodes into a **cycle**, and a subsequent `get` would spin forever at 100% CPU. Infinite loop, no exception, no stack trace pointing anywhere useful.

**Java 8+:** the split preserves order, so the cycle is gone. But the map is still unsafe: concurrent `put`s can **lose updates** (two threads read the same bin head and one overwrites the other's link), `size` can drift, and a resize racing with a read can return `null` for a present key. No exception is guaranteed.

The correct answers, in order of preference:

```java
Map<K,V> m = new ConcurrentHashMap<>();                    // the default choice
Map<K,V> m = Collections.synchronizedMap(new HashMap<>()); // one global lock; compound ops still race
Map<K,V> m = new Hashtable<>();                            // legacy; don't
```

And note the trap that survives all of them:

```java
// STILL BROKEN even with ConcurrentHashMap — two atomic operations are not one atomic operation
if (!map.containsKey(k)) map.put(k, compute());
// Correct:
map.computeIfAbsent(k, key -> compute());                  // atomic, computed at most once per key
map.merge(k, 1, Integer::sum);                             // atomic counter increment
```

## 6. The map family compared

| | `HashMap` | `LinkedHashMap` | `TreeMap` | `ConcurrentHashMap` | `Hashtable` |
| --- | --- | --- | --- | --- | --- |
| Structure | array + lists/trees | + doubly linked list | red-black tree | array + CAS/bin locks | array + lists |
| get/put | O(1) avg, O(log n) worst | O(1) avg | O(log n) worst | O(1) avg | O(1) avg |
| Order | none, unstable | insertion or **access** | sorted | none | none |
| Null key/value | 1 key / yes | 1 key / yes | ✗ / yes | ✗ / ✗ | ✗ / ✗ |
| Thread-safe | ✗ | ✗ | ✗ | ✅ | ✅ (whole-object lock) |
| Iterator | fail-fast | fail-fast | fail-fast | **weakly consistent** | fail-fast (via `elements()`: not) |
| Extra memory | lowest | +2 refs/entry | tree nodes | counter cells | lowest |
| Use it for | everything | LRU caches, deterministic output | ranges, sorting | concurrency | never |

**`LinkedHashMap`'s two tricks:**

```java
// access-order + removeEldestEntry = a 3-line LRU cache
var lru = new LinkedHashMap<String, String>(16, 0.75f, true) {   // true = ACCESS order
    @Override protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
        return size() > 100;
    }
};
```

**`ConcurrentHashMap` internals [JDK 8+]:** no more segments (that was Java 7). An empty bin is filled with a **CAS**; a non-empty bin is locked by `synchronized` on its **head node** — so concurrency scales with the number of bins, not a fixed segment count. `size()` is maintained in a `baseCount` plus striped `CounterCell`s to avoid a contended counter, which is why `size()` is an **estimate** under concurrent modification. Its iterators are **weakly consistent**: they never throw `ConcurrentModificationException`, reflect some state at or after creation, and traverse each element at most once (Phase 10).

## 7. The API you should be using

```java
map.getOrDefault(k, 0);
map.putIfAbsent(k, v);
map.computeIfAbsent(k, key -> new ArrayList<>()).add(item);   // the multimap idiom
map.computeIfPresent(k, (key, v) -> v + 1);
map.compute(k, (key, v) -> v == null ? 1 : v + 1);
map.merge(k, 1, Integer::sum);                                 // the counter idiom
map.forEach((k, v) -> ...);
map.replaceAll((k, v) -> v.trim());
map.entrySet().removeIf(e -> e.getValue() == null);
```

`computeIfAbsent` + `merge` replace the vast majority of hand-written `if (map.containsKey(...))` blocks, and are atomic on `ConcurrentHashMap`. One caveat: **[JDK 9+]** modifying the map inside a `computeIfAbsent` mapping function throws `ConcurrentModificationException` — recursive computation is not allowed.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong><code>std::unordered_map</code>:</strong> hash and equality are template parameters, so one key type can be hashed differently per map. Collision resolution is <strong>separate chaining</strong> with buckets, like Java, but the standard requires <em>reference and pointer stability</em> — a rehash invalidates iterators but never invalidates references to elements. Bucket count is typically prime, and the index is <code>hash % bucket_count</code>.</p>
<p><strong>Java's <code>HashMap</code>:</strong> hash and equality come from the key type itself. Capacity is a power of two so the index is a mask. There is no reference stability question because you never hold a reference into the table — <code>Map.Entry</code> objects from an iterator are views and must not be retained.</p>
</div>

| Concern | `std::unordered_map` | `HashMap` |
| --- | --- | --- |
| Hash source | `std::hash<K>` template arg | `K.hashCode()` |
| Per-container hasher | ✅ | ❌ |
| Bucket count | usually prime, `% n` | power of two, `& (n-1)` |
| Max load factor | configurable, default 1.0 | 0.75 |
| Worst-case bin | O(n) chain | O(log n) tree since Java 8 |
| Reference stability | Guaranteed across rehash | N/A — no interior references |
| Ordered variant | `std::map` (RB tree) | `TreeMap` (RB tree) |
| Thread safety | none | none; `ConcurrentHashMap` provided |

## 9. Common mistakes

- Mutating a key after insertion (Module 3.2 §7) — the entry becomes unreachable but still counted.
- Using a mutable object, or one without `hashCode`, as a key.
- No initial capacity for a map you know will hold a million entries.
- `containsKey` + `get`, or `containsKey` + `put`, instead of `getOrDefault` / `computeIfAbsent` / `merge`.
- Assuming iteration order is stable, or that it matches insertion.
- Sharing a `HashMap` between threads "because writes are rare".
- Treating `ConcurrentHashMap`'s atomicity as covering multi-step logic.
- Retaining `Map.Entry` objects from an iterator past the iteration.
- A `hashCode` that returns a constant, or one that includes a field `equals` ignores.

## 10. Interview questions

**Beginner** — 1. How does `HashMap` work? 2. What is a collision and how is it handled? 3. Default capacity and load factor?

**Intermediate** — 4. What happens on `put` when the key already exists? 5. When does a resize happen and what does it cost? 6. Why must `equals` and `hashCode` agree? 7. Can `HashMap` have a null key?

**Advanced** — 8. Why `^ (h >>> 16)`? 9. Why is capacity a power of two? 10. Explain the Java 8 resize split and why it needs no rehashing. 11. What are the treeification thresholds and why are there two? 12. What was the Java 7 infinite-loop bug?

**Senior** — 13. Explain the hash-collision DoS attack and Java's mitigation, and say why it is only a mitigation. 14. How does `ConcurrentHashMap` achieve thread safety without a global lock, and why is `size()` approximate? 15. A production `HashMap.get` is showing up hot in a profile. Give five hypotheses and how you'd test each. 16. Design a bounded LRU cache; then make it thread-safe.

## 11. Follow-ups

- *After Q5:* "How would you avoid the resizes entirely?" → capacity hint / `HashMap.newHashMap`.
- *After Q10:* "Why does that preserve order, and why did Java 7's not?"
- *After Q13:* "What if the keys are attacker-controlled JSON field names?" → cap the field count, or use a keyed/randomised hash.
- *After Q14:* "So when is `size()` exact?" → when no concurrent modification is in flight.
- *After Q15:* → bad `hashCode`, mutated keys, giant keys with slow `equals`, resize storms, megamorphic call site, or the map simply being enormous.

## 12. Exercise

1. Implement a minimal `SimpleHashMap<K,V>` with an array of linked nodes, `put`, `get`, `remove`, and resizing at 0.75. Use `(n-1) & hash`.
2. Add the hash spreader and measure collision counts with and without it, using `Integer` keys that are multiples of 65 536.
3. Insert 1 000 keys whose `hashCode()` all return `42`. Measure `get` time. Now implement the "convert bin to `TreeMap` at 8 nodes" fallback and re-measure.
4. Benchmark `new HashMap<>()` versus `HashMap.newHashMap(1_000_000)` filling a million entries; explain the gap in terms of §3.
5. Write a concurrent test with 8 threads doing `put` on a shared `HashMap` and assert the final size. Watch it fail. Swap in `ConcurrentHashMap`.

## 13. Output prediction

```java
class BadKey {
    final String v;
    BadKey(String v) { this.v = v; }
    @Override public boolean equals(Object o) { return o instanceof BadKey b && b.v.equals(v); }
    // no hashCode
}
class MutableKey {
    int v; MutableKey(int v) { this.v = v; }
    @Override public boolean equals(Object o) { return o instanceof MutableKey m && m.v == v; }
    @Override public int hashCode() { return v; }
}
public class Main {
    public static void main(String[] args) {
        Map<BadKey, String> m1 = new HashMap<>();
        m1.put(new BadKey("a"), "x");
        System.out.println(m1.get(new BadKey("a")));

        Map<MutableKey, String> m2 = new HashMap<>();
        MutableKey k = new MutableKey(1);
        m2.put(k, "x");
        k.v = 2;
        System.out.println(m2.get(k) + " " + m2.get(new MutableKey(1)) + " " + m2.size());
        m2.put(new MutableKey(2), "y");
        System.out.println(m2.size());

        Map<String, Integer> counts = new HashMap<>();
        for (String w : List.of("a", "b", "a")) counts.merge(w, 1, Integer::sum);
        System.out.println(counts);

        Map<String, Integer> n = new HashMap<>();
        n.put(null, 1);
        System.out.println(n.get(null) + " " + n.containsKey(null));
    }
}
```

## 14. Mastery check

1. Describe the complete `get(key)` path from method call to returned value.
2. Write the `hash()` spreader and justify every operation in it.
3. Why is capacity a power of two, and what does that let the index computation avoid?
4. Explain the resize split trick with a worked example at oldCap = 16.
5. Give all four treeification-related constants and the rule involving each.
6. Explain the hash-collision DoS attack and precisely what treeification does and does not fix.
7. Describe the Java 7 infinite-loop failure and why Java 8 cannot reproduce it — then name what is *still* unsafe.
8. How does `ConcurrentHashMap` lock, and why is `size()` an estimate?
9. Give the four symptoms of mutating a key after insertion.
10. Rewrite `if (!m.containsKey(k)) m.put(k, f(k));` correctly, and say why the original is wrong even on a `ConcurrentHashMap`.
