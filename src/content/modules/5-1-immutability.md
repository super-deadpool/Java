---
title: "Immutability and Defensive Copying"
phase: 5
order: 1
minutes: 30
summary: "How to build a class whose state cannot change, why every escape route matters, and what immutability buys you in a language with no const."
tags: ["immutability", "defensive-copying", "encapsulation", "thread-safety"]
---

## 1. Concept

An **immutable** object's observable state never changes after construction. Java gives you no keyword for it — no `const`, no `const` methods, no compiler enforcement. Immutability is a set of five design obligations you take on:

1. **No mutators.** No setters, no methods that change a field.
2. **`final` class** (or private constructor + static factories), so nobody overrides a method and adds mutation.
3. **All fields `private final`.**
4. **Defensively copy mutable inputs** in the constructor.
5. **Defensively copy mutable outputs** in getters — or return an unmodifiable view.

Rules 4 and 5 are the ones people forget, and they are what separates a genuinely immutable class from one that merely looks immutable.

## 2. Why

Immutable objects are: **thread-safe with no synchronisation** (there is no write to race with); **safe hash keys** (their hash cannot drift, Module 3.2 §7); **freely shareable** without defensive copies at every boundary; and **easy to reason about** — an object you were handed cannot change under you.

Java leans on this heavily: `String`, all wrappers, `BigDecimal`, `LocalDate` and all of `java.time`, `List.of(...)`, records. Every one of those decisions was made to remove a class of bug.

## 3. Mental model

> Immutability in Java is **enforced by the boundary, not by the type system**. Every reference that crosses into or out of your object is a potential leak; `final` seals the variable, you have to seal the object graph yourself.

## 4. The leaks

```java
// BROKEN — looks immutable, isn't
public final class Period {
    private final Date start;                    // Date is mutable (legacy)
    private final List<String> tags;

    public Period(Date start, List<String> tags) {
        this.start = start;                      // LEAK 1: caller keeps a reference
        this.tags = tags;
    }
    public Date start()        { return start; } // LEAK 2: caller gets a mutable reference
    public List<String> tags() { return tags; }
}
```

```java
Date d = new Date();
List<String> t = new ArrayList<>(List.of("a"));
Period p = new Period(d, t);
d.setTime(0);          // mutated through leak 1
t.add("b");            // mutated through leak 1
p.start().setTime(1);  // mutated through leak 2
p.tags().add("c");     // mutated through leak 2
```

```java
// FIXED
public final class Period {
    private final Instant start;                       // immutable type — no copy needed at all
    private final List<String> tags;

    public Period(Instant start, List<String> tags) {
        this.start = Objects.requireNonNull(start);
        this.tags = List.copyOf(tags);                 // copy, and the copy is unmodifiable
    }
    public Instant start()        { return start; }    // safe: Instant is immutable
    public List<String> tags()    { return tags; }     // safe: already unmodifiable
}
```

Two lessons: **copy in the constructor, not just in the getter** (validation must run on the copy you keep, otherwise a caller can mutate between check and use — a TOCTOU bug); and **prefer immutable field types** so no copying is needed at all.

## 5. Copy techniques

| Field type | Copy in | Copy out |
| --- | --- | --- |
| `List`/`Set`/`Map` | `List.copyOf(x)` (Java 10+; rejects nulls) | nothing — the copy is unmodifiable |
| Legacy pre-Java-10 | `new ArrayList<>(x)` | `Collections.unmodifiableList(list)` |
| Array | `x.clone()` or `Arrays.copyOf` | `.clone()` on every read, or expose `List.of(...)` |
| `Date` | `new Date(x.getTime())` | same — or migrate to `Instant` |
| Nested mutable objects | a deep copy, or redesign them as immutable | same |

`Collections.unmodifiableList(list)` returns a **view**: if you keep the underlying list and mutate it, the "unmodifiable" view changes too. `List.copyOf` makes a real copy. Know the difference — it is a common interview probe.

## 6. Realistic example — withers

```java
public record Money(String currency, long minorUnits) implements Comparable<Money> {
    public Money {                                       // compact canonical constructor: validation
        Objects.requireNonNull(currency);
        if (currency.length() != 3) throw new IllegalArgumentException(currency);
    }
    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(currency, Math.addExact(minorUnits, other.minorUnits));   // new instance
    }
    public Money withCurrency(String c) { return new Money(c, minorUnits); }
    @Override public int compareTo(Money o) { requireSameCurrency(o); return Long.compare(minorUnits, o.minorUnits); }
    private void requireSameCurrency(Money o) {
        if (!currency.equals(o.currency)) throw new IllegalArgumentException("currency mismatch");
    }
}
```

Every "modification" returns a new object. That is the functional style Java's own `java.time` uses (`date.plusDays(1)`), and it is why those APIs are safe to share across threads.

**When immutability costs too much:** building a 100 000-element list one `withX` at a time allocates 100 000 objects. The standard answer is a **mutable builder producing an immutable result** (`StringBuilder` → `String`, `Stream.collect` → `List`), which confines mutation to one thread and one scope.

## 7. What happens internally

**[JMM, Phase 25]** A `final` field written in a constructor is guaranteed visible to any thread that sees the object **provided `this` did not escape during construction**. That is the *final field freeze* guarantee, and it is why a correctly built immutable object needs no synchronisation. Break the rule (publish `this` early, or use a non-final field) and another thread may legally see a default value.

**[HotSpot]** `static final` fields of initialised classes are treated as true constants and folded into compiled code. Instance `final` fields are trusted for some optimisations — the JIT can hoist reads across calls it has inlined — but reflection can write them, so the trust is heuristic and version-dependent. Do not design on it; design on the JMM guarantee, which is specified.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>const</code> is part of the type system and propagates — a <code>const Foo&amp;</code> gives you access only to <code>const</code> methods, and the compiler enforces it transitively at every call. Copies are the default when you pass by value.</p>
<p><strong>Java:</strong> nothing propagates. <code>final</code> stops reassignment of one variable. There is no <code>const</code> parameter, no <code>const</code> method, no read-only view of a type unless someone designed one (<code>List.of</code>, <code>Collections.unmodifiable*</code>) — and those throw at run time rather than failing to compile.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Read-only parameter | `const Foo&` — compiler-enforced | Nothing. Pass an immutable type or copy defensively |
| Read-only view | `const` reference / `std::span<const T>` | `List.copyOf`, `Collections.unmodifiableList` — runtime `UnsupportedOperationException` |
| Deep immutability | `const` propagates through members | You must design it in |
| Cost of sharing | Copy or careful lifetime management | Free — share the reference |
| Enforcement point | Compile time | Design time; run time for view wrappers |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Believing <code>final</code> gives <code>const</code>-correctness.</strong> It gives one non-reassignable variable and nothing else.</p>
<p><strong>Returning a collection field directly</strong> because "the caller shouldn't modify it". They can and eventually will.</p>
<p><strong>Assuming an unmodifiable wrapper is a copy.</strong> It is a view over a list you may still be mutating.</p>
<p><strong>Copying defensively everywhere out of habit.</strong> In Java the right fix is usually to make the *type* immutable, not to copy at every boundary.</p>
</div>

## 9. Edge cases

```java
List<String> src = new ArrayList<>(List.of("a"));
List<String> view = Collections.unmodifiableList(src);
List<String> copy = List.copyOf(src);
src.add("b");
System.out.println(view);   // [a, b]   — the view tracks the source
System.out.println(copy);   // [a]      — the copy does not

List.of("a", null);          // NullPointerException — List.of rejects nulls
Arrays.asList("a", "b").set(0, "z");   // works: fixed-size but MUTABLE
Arrays.asList("a").add("b");           // UnsupportedOperationException

record R(int[] data) {}                        // record equality on an array is IDENTITY-based
new R(new int[]{1}).equals(new R(new int[]{1}));   // false

final Map<String, List<String>> m = Map.of("k", new ArrayList<>());
m.get("k").add("mutable!");   // the map is immutable; its VALUES are not — shallow immutability
```

## 10. Common mistakes

- Copying on the way out but not on the way in (or vice versa).
- Validating the caller's object, then storing the caller's object.
- Shallow copies of nested mutable structures.
- Exposing an array field.
- Using `Collections.unmodifiableX` while keeping a mutable reference to the backing collection.
- Making a class immutable but giving it a mutable superclass field.
- Forgetting that a record's components can themselves be mutable.

## 11. Interview questions

**Beginner** — 1. What makes a class immutable? 2. Name five immutable JDK classes. 3. Why is `String` immutable?

**Intermediate** — 4. What is defensive copying, and where must it happen? 5. `Collections.unmodifiableList` vs `List.copyOf`? 6. Why must an immutable class be `final`? 7. Why are immutable objects thread-safe?

**Advanced** — 8. What exactly does the JMM guarantee about `final` fields, and what breaks it? 9. Show an immutable-looking class with three leaks. 10. What is shallow vs deep immutability, and which do records give you? 11. When does immutability cost too much, and what is the standard remedy?

**Senior** — 12. Design an immutable domain model for orders with 20 fields and optional updates. 13. How does immutability interact with JPA/Hibernate, and what compromises are typical? 14. Argue against immutability for a specific case.

## 12. Follow-ups

- *After Q6:* "What if you can't make it final?" → private constructor + static factories.
- *After Q8:* "Show me code where a final field is observed as null."
- *After Q11:* "Name two JDK APIs built on mutable-builder → immutable-result."

## 13. Exercise

Take this class and find every mutation path, then fix it without changing the public method signatures:

```java
public class Config {
    public final String[] hosts;
    private final Map<String, String> props;
    private final Date created;
    public Config(String[] hosts, Map<String, String> props, Date created) {
        this.hosts = hosts; this.props = props; this.created = created;
    }
    public Map<String, String> props() { return props; }
    public Date created() { return created; }
}
```

Write a test that mutates the object through each path *before* you fix it, and watch each test start failing as you fix them.

## 14. Output prediction

```java
public class Main {
    public static void main(String[] args) {
        List<String> base = new ArrayList<>(List.of("a"));
        List<String> unmod = Collections.unmodifiableList(base);
        List<String> copy = List.copyOf(base);
        base.add("b");
        System.out.println(unmod + " " + copy);
        try { unmod.add("c"); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        int[] arr = {1, 2};
        final int[] alias = arr;
        alias[0] = 9;
        System.out.println(arr[0]);
    }
}
```

## 15. Mastery check

1. List the five obligations of an immutable class and say which two are most often skipped.
2. Why must copying happen in the constructor and not only in the getter?
3. Difference between an unmodifiable view and a copy, with a code example.
4. What does the JMM guarantee about `final` fields and what is the precondition?
5. Why are immutable objects safe hash keys?
6. What is shallow immutability? Give a `Map.of` example.
7. Why is there no `const` in Java, and what do you use instead at API boundaries?
8. When is immutability the wrong choice, and what pattern replaces it?
9. Why must an immutable class be final, and what is the alternative?
10. What does a record give you for free, and what does it not protect against?
