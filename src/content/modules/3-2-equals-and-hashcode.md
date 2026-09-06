---
title: "The equals/hashCode Contract"
phase: 3
order: 2
minutes: 40
summary: "The five equals rules, the hashCode rule that binds them to every hash-based collection, and the mutable-key bug that loses your data silently."
tags: ["equals", "hashcode", "contracts", "hashmap", "collections"]
---

## 1. Concept

Java distinguishes two kinds of sameness:

- **Reference equality** — `a == b`, "the same object". Cheap, always available, never overridable.
- **Logical equality** — `a.equals(b)`, "the same value". Defined by the class.

`equals` must satisfy five rules **[JLS / `Object` javadoc]**:

1. **Reflexive** — `x.equals(x)` is true.
2. **Symmetric** — `x.equals(y)` ⟺ `y.equals(x)`.
3. **Transitive** — `x.equals(y)` ∧ `y.equals(z)` ⟹ `x.equals(z)`.
4. **Consistent** — repeated calls give the same result while the objects are unchanged.
5. **Null-safe** — `x.equals(null)` is `false`, never an NPE.

`hashCode` must satisfy two:

1. **Equal objects must have equal hash codes.** (Unequal objects *may* share one — that is a collision, not a bug.)
2. **Consistent** — the value must not change while the fields used by `equals` do not change.

The first hashCode rule is the one that matters: **every hash-based collection in the JDK assumes it.** Break it and `HashMap`, `HashSet`, `ConcurrentHashMap`, `LinkedHashMap` and `Collectors.groupingBy` all silently lose entries.

## 2. Why Java has it

`HashMap` finds a key in O(1) by computing a bucket from the hash and then comparing with `equals` only inside that bucket. If two equal objects hash differently, they land in different buckets and the map never compares them — so a lookup for a value you just inserted returns `null`. The contract is not etiquette; it is the precondition for the algorithm.

## 3. Mental model

> `hashCode` chooses **which drawer** to look in. `equals` decides **which item in the drawer**. If equal things go in different drawers, you will never find them again — and nothing will tell you.

## 4. Correct implementation

```java
public final class Money {
    private final String currency;
    private final long minorUnits;

    @Override public boolean equals(Object o) {
        if (this == o) return true;                       // fast path
        if (!(o instanceof Money other)) return false;    // handles null AND type in one test
        return minorUnits == other.minorUnits
            && currency.equals(other.currency);
    }

    @Override public int hashCode() {
        return Objects.hash(currency, minorUnits);        // convenient; allocates a varargs array
    }

    @Override public String toString() { return minorUnits + " " + currency; }
}
```

For hot paths, hand-roll the hash to avoid the array allocation:

```java
@Override public int hashCode() {
    int result = currency.hashCode();
    result = 31 * result + Long.hashCode(minorUnits);
    return result;
}
```

31 is used because it is odd, prime, and `31 * i` compiles to `(i << 5) - i`. Any odd multiplier works; consistency matters more than the constant.

**Or use a record**, which generates all three correctly from the components:

```java
public record Money(String currency, long minorUnits) { }
```

## 5. `instanceof` vs `getClass()`

```java
// instanceof: allows a subclass to be equal to a superclass instance.
// Symmetry survives only if the subclass does not add state to equals.
if (!(o instanceof Money other)) return false;

// getClass(): strict. Symmetric and transitive by construction,
// but breaks Liskov — a Money and a TaxedMoney can never be equal.
if (o == null || getClass() != o.getClass()) return false;
```

There is no universally right answer, and interviewers know it. The defensible positions: use `getClass()` when the class is `final` or the hierarchy has real value distinctions; use `instanceof` when you are comparing against an interface contract (as `AbstractList` does — an `ArrayList` and a `LinkedList` with the same elements *are* equal, deliberately). Best of all: **make value classes `final` or records** and the question disappears.

## 6. The three classic contract violations

```java
// A. Symmetry broken by a "convenient" cross-type equals
public final class CaseInsensitiveString {
    private final String s;
    @Override public boolean equals(Object o) {
        if (o instanceof CaseInsensitiveString c) return s.equalsIgnoreCase(c.s);
        if (o instanceof String str) return s.equalsIgnoreCase(str);   // BUG
        return false;
    }
}
// cis.equals("abc") is true; "abc".equals(cis) is false.
// A List.contains() may find it or not, depending on argument order inside the JDK.
```

```java
// B. Transitivity broken by adding state in a subclass
class Point { int x, y; /* equals compares x,y with instanceof */ }
class ColorPoint extends Point { Color c; /* equals also compares c */ }
// p.equals(cp1) true, p.equals(cp2) true, cp1.equals(cp2) false.
```

```java
// C. equals without hashCode
class Id { final int v; Id(int v){this.v=v;}
    @Override public boolean equals(Object o){ return o instanceof Id i && i.v == v; } }
Set<Id> set = new HashSet<>();
set.add(new Id(1));
set.contains(new Id(1));    // false — different identity hash codes, different buckets
```

## 7. Mutable keys — the silent data loss

```java
class Key { int v; Key(int v){this.v=v;}
    @Override public boolean equals(Object o){ return o instanceof Key k && k.v == v; }
    @Override public int hashCode(){ return v; } }

Map<Key, String> map = new HashMap<>();
Key k = new Key(1);
map.put(k, "value");
k.v = 2;                       // mutate a field that equals/hashCode use

map.get(k);                    // null   — hashes to a new bucket
map.get(new Key(1));           // null   — right bucket, but the stored key no longer equals it
map.containsKey(k);            // false
map.size();                    // 1      — the entry is there, unreachable
for (var e : map.entrySet()) System.out.println(e.getKey().v);   // 2 — you can still iterate it
```

This is a memory leak *and* a correctness bug, and nothing throws. **Rule: keys of hash-based collections must be immutable in every field `equals` reads.** The same applies to `TreeMap` keys and their `compareTo` fields, and to elements of a `HashSet`.

## 8. What happens internally

**[JDK]** `HashMap` does not use your `hashCode()` directly. It applies a spreading function:

```java
static int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

XOR-ing the high 16 bits down protects against hash codes that differ only in the high bits, because the bucket index is `hash & (capacity - 1)` — only the low bits are used. Then, within a bucket, lookup compares `hash == e.hash && (key == e.key || key.equals(e.key))` — note the `==` fast path, which is why interned strings and cached `Integer`s are quick.

**[JDK 8+]** A bucket whose chain exceeds 8 entries (in a table of at least 64) is converted into a **red-black tree**, degrading O(n) collision behaviour to O(log n). That was a response to hash-collision denial-of-service attacks. Full details in Phase 8.

**[HotSpot]** The default `hashCode` (identity hash) is generated lazily and stored in the object's mark word; it is *not* the memory address, and it survives GC moves precisely because it is stored rather than derived.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> you write <code>operator==</code> (or <code>= default</code> since C++20) and specialise <code>std::hash&lt;T&gt;</code> separately; <code>std::unordered_map</code> takes the hash and equality as <em>template parameters</em>, so a single type can be hashed differently in different maps.</p>
<p><strong>Java:</strong> equality and hashing are <strong>methods on the object</strong>, so every collection uses the same definition. There is no per-map hasher — the closest equivalents are <code>IdentityHashMap</code>, <code>TreeMap</code> with a <code>Comparator</code>, or wrapping the key in an adapter type.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Where equality lives | Free function / member operator, per container overridable | On the object, globally |
| Where hashing lives | `std::hash<T>` specialisation, per container overridable | `hashCode()` on the object |
| Consistency requirement | Same: equal ⟹ equal hashes | Same, and enforced by every JDK collection |
| Default | No implicit `==` (until `= default`) | Identity `equals`, identity `hashCode` |
| Mutating a key | UB-adjacent; the standard says the container is invalidated | No error; the entry becomes unreachable |
| Custom hash for one map | Trivial (template arg) | Needs a wrapper type or a different map |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Writing <code>equals(MyType other)</code>.</strong> That is an overload, not an override — <code>Object.equals(Object)</code> still runs inside collections. Always <code>@Override public boolean equals(Object o)</code>.</p>
<p><strong>Expecting <code>==</code> to compare values.</strong> It never does for reference types.</p>
<p><strong>Assuming you can supply a hasher per map.</strong> You cannot; the type owns its hash.</p>
</div>

## 10. Common mistakes

- Overriding `equals` without `hashCode`, or vice versa.
- Wrong signature: `equals(MyType)`.
- Including mutable fields, or derived/cached fields, in `equals`/`hashCode`.
- Including a collection field whose `hashCode` is expensive, in a class used as a hot map key.
- Returning a constant from `hashCode` — technically legal, turns every map into a linked list.
- Using arrays in `equals` without `Arrays.equals` (arrays use identity equality).
- Comparing `Double`/`Float` fields with `==` inside `equals` instead of `Double.compare` (`NaN` and `-0.0`).
- `equals` that depends on the current time, a random value, or a database round-trip — non-consistent.

## 11. Interview questions

**Beginner** — 1. Difference between `==` and `.equals()`? 2. Why override both `equals` and `hashCode`? 3. What does the default `equals` do?

**Intermediate** — 4. State all five `equals` rules. 5. What breaks if equal objects have different hash codes? 6. Must unequal objects have different hash codes? 7. `instanceof` vs `getClass()` in `equals`.

**Advanced** — 8. Show a symmetry violation and a transitivity violation. 9. Why can't you extend an instantiable value class and add a field to `equals`? 10. What does `HashMap` do to your `hashCode` before using it, and why? 11. What happens when a key mutates after insertion — precisely, at each of `get`, `containsKey`, `size` and iteration?

**Senior** — 12. Design equality for an entity with a database identity and a business key. Which do you use, and what breaks in a `Set` before the entity is persisted? 13. Why do `AbstractList` and `AbstractSet` use `instanceof` rather than `getClass`? 14. How do records implement `equals`, and what does that mean for a record with an array component? 15. A production `HashMap` degraded to O(n). Give three possible causes.

## 12. Follow-ups to expect

- *After Q5:* "Would you ever see an exception?" → no, that's what makes it dangerous.
- *After Q9:* "So how does `java.awt.Point`/`ColorPoint` handle it?" → it doesn't; the JDK has this bug, which is why the composition workaround exists.
- *After Q12:* "What is the JPA equals problem?" → id is null before persist, so hash changes after save; the usual answer is a business key or a UUID assigned in the constructor.
- *After Q14:* "So what do you do with a record containing a `byte[]`?" → override `equals`/`hashCode` manually with `Arrays.equals`/`Arrays.hashCode`, or wrap the array.

## 13. Exercise

1. Write `Version(int major, int minor, int patch)` with correct `equals`, `hashCode`, `toString`, and `Comparable`.
2. Put 100 000 `Version`s in a `HashSet`; verify no duplicates and measure lookup time.
3. Now change `hashCode` to `return 1;`. Re-measure. Explain the number you get in terms of §8's treeification.
4. Now make `major` mutable, insert, mutate, and write assertions showing all four symptoms from §7.
5. Convert to a `record` and delete everything you can.

## 14. Output prediction

**A**
```java
class Id {
    final int v; Id(int v) { this.v = v; }
    public boolean equals(Id o) { return o != null && o.v == v; }   // note the signature
    @Override public int hashCode() { return v; }
}
public class Main {
    public static void main(String[] args) {
        Set<Id> s = new HashSet<>();
        s.add(new Id(1));
        System.out.println(s.contains(new Id(1)));
        System.out.println(new Id(1).equals(new Id(1)));
        Object a = new Id(1), b = new Id(1);
        System.out.println(a.equals(b));
    }
}
```

**B**
```java
public class Main {
    public static void main(String[] args) {
        Map<int[], String> m = new HashMap<>();
        int[] k = {1, 2};
        m.put(k, "v");
        System.out.println(m.get(k));
        System.out.println(m.get(new int[]{1, 2}));
        System.out.println(List.of(1, 2).equals(Arrays.asList(1, 2)));
        System.out.println(new ArrayList<>(List.of(1,2)).equals(new LinkedList<>(List.of(1,2))));
    }
}
```

**C**
```java
record P(String name, double score) {}
public class Main {
    public static void main(String[] args) {
        System.out.println(new P("a", 0.0).equals(new P("a", -0.0)));
        System.out.println(new P("a", Double.NaN).equals(new P("a", Double.NaN)));
        System.out.println(0.0 == -0.0);
        System.out.println(Double.NaN == Double.NaN);
    }
}
```

## 15. Mastery check

1. State the five `equals` rules and the two `hashCode` rules.
2. Explain precisely why a `HashSet` "loses" an object whose `hashCode` is not overridden.
3. Construct a symmetry violation in three lines, and say which JDK method would behave inconsistently because of it.
4. Why does adding a field to `equals` in a subclass break transitivity? What is the standard fix?
5. What does `HashMap.hash()` do to your value and why?
6. Walk through every observable symptom of mutating a key after insertion.
7. `instanceof` vs `getClass()` — give one situation where each is the right choice.
8. Why must `hashCode` be consistent with `equals` but not injective?
9. How do records generate `equals`, and what component type breaks it?
10. Why can Java not supply a per-map hash function the way C++ can, and what do you do instead?
