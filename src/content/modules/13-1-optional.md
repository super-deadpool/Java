---
title: "Optional: a return-type tool, not a null replacement"
phase: 13
order: 1
minutes: 35
summary: "What Optional was designed for, the orElse/orElseGet distinction, why it is a value-based class, and the four uses its own designers call misuse."
tags: ["optional", "null", "value-based", "api-design"]
---

## 1. Concept

`Optional<T>` is an immutable container holding either one non-null value or nothing.

```java
Optional<User> findByEmail(String email);          // "there may be no such user" — in the type
```

It exists to make **"no result" a documented part of a method's signature** instead of a fact you learn from an NPE. That is the entire design goal, and every judgement about correct use follows from it.

**[JDK]** Brian Goetz, who specified it: *"Optional is intended to provide a limited mechanism for library method return types where there is a clear need to represent 'no result', and where using null for that is overwhelmingly likely to cause errors."*

Note what that does **not** say: it is not a general null-safety mechanism, not a field type, and not a parameter type.

## 2. Why Java has it

Before Java 8, "no result" had three encodings and no way to tell them apart at a call site:

```java
User u = repo.findByEmail(e);      // returns null? throws? returns a sentinel? read the docs
Integer count = map.get(key);      // null means absent... or means the stored value was null
String s = props.getProperty(k);   // null
```

`null` is assignable to every reference type, so the compiler cannot help. `Optional` makes absence a **distinct static type**, so `findByEmail(e).getName()` does not compile — you are forced to say what happens when there is nothing.

Java could not retrofit it: changing `Map.get` to return `Optional` would break every program ever written. So `Optional` appears only on APIs introduced from Java 8 onward — `Stream.findFirst`, `Stream.min/max/reduce`, `Optional`-returning `java.time` and `ProcessHandle` methods — plus your own new code.

## 3. Mental model

> `Optional<T>` is **a stream of zero or one element**. Every operation on it has a stream counterpart, and that is not a coincidence — `map`, `filter`, `flatMap` mean exactly what they do on a stream.

```java
Optional.of(x)          ~  Stream.of(x)
Optional.empty()        ~  Stream.empty()
opt.map(f)              ~  stream.map(f)
opt.filter(p)           ~  stream.filter(p)
opt.flatMap(f)          ~  stream.flatMap(f)
opt.ifPresent(c)        ~  stream.forEach(c)
opt.stream()            // Java 9 — literally converts one into the other
```

The second half of the model, and the one that stops misuse:

> An `Optional` reference **can itself be null**. It is an ordinary object. `Optional` does not eliminate null; it relocates the question to one place where the compiler can see it.

## 4. The API

```java
// creation
Optional.of(v)             // NullPointerException if v is null — assert non-null
Optional.ofNullable(v)     // empty if v is null — the bridge from legacy APIs
Optional.empty()

// interrogation
isPresent()   isEmpty()          // Java 11
get()                            // throws NoSuchElementException; avoid — use orElseThrow()
orElse(other)                    // ALWAYS evaluates `other`
orElseGet(supplier)              // evaluates only when empty
orElseThrow()                    // NoSuchElementException — Java 10, the readable get()
orElseThrow(supplier)            // your exception

// transformation
map(fn)                          // Optional<U>; empty stays empty; a null result becomes empty
flatMap(fn)                      // fn returns Optional<U>; no nesting
filter(pred)                     // empty if the predicate fails
or(supplier)                     // Java 9 — fallback Optional
stream()                         // Java 9 — 0 or 1 element

// consumption
ifPresent(consumer)
ifPresentOrElse(consumer, runnable)   // Java 9
```

## 5. orElse versus orElseGet

The most-asked question in this module, and a real production bug.

```java
// orElse: the argument is an EXPRESSION — evaluated before the call, every time
String name = opt.orElse(loadDefaultFromDatabase());     // DB hit even when opt is present

// orElseGet: the argument is a SUPPLIER — invoked only when empty
String name = opt.orElseGet(() -> loadDefaultFromDatabase());
```

Java evaluates arguments eagerly; there is no lazy-parameter mechanism. `orElse` therefore always computes its fallback. Use `orElse` for cheap constants (`orElse("")`, `orElse(0)`, `orElse(List.of())`) and `orElseGet` for anything that allocates, hits I/O, or has side effects.

The same trap appears in `Objects.requireNonNullElse` versus `requireNonNullElseGet`, in `Map.getOrDefault` (eager) versus `computeIfAbsent` (lazy), and in logging (`log.debug(msg)` versus the `Supplier` overload).

## 6. Realistic example

```java
// Legacy nested-null version
public String zipOf(Order order) {
    if (order != null) {
        Customer c = order.getCustomer();
        if (c != null) {
            Address a = c.getAddress();
            if (a != null && a.getZip() != null) return a.getZip().toUpperCase();
        }
    }
    return "UNKNOWN";
}

// With Optional-returning accessors on the domain model
public String zipOf(Order order) {
    return Optional.ofNullable(order)
            .flatMap(Order::customer)            // Optional<Customer>  -> flatMap
            .flatMap(Customer::address)          // Optional<Address>
            .map(Address::zip)                   // String              -> map
            .map(String::toUpperCase)
            .orElse("UNKNOWN");
}

// Fallback chains read well with or()
Optional<Config> cfg = fromEnv()
        .or(this::fromFile)
        .or(this::fromClasspath);
Config c = cfg.orElseThrow(() -> new IllegalStateException("no config source"));

// Optional.stream() is the clean filter-and-unwrap in a pipeline
List<User> users = ids.stream()
        .map(repo::findById)                     // Stream<Optional<User>>
        .flatMap(Optional::stream)               // Stream<User>, empties dropped
        .toList();
```

`map` when the mapper returns a plain value, `flatMap` when it returns an `Optional` — otherwise you get `Optional<Optional<X>>`. Same rule as streams.

## 7. What happens internally

**[JDK]** The implementation is trivial:

```java
public final class Optional<T> {
    private static final Optional<?> EMPTY = new Optional<>(null);
    private final T value;                  // null iff empty
    public T get() { if (value == null) throw new NoSuchElementException("No value present"); return value; }
}
```

One field, one shared `EMPTY` singleton, and `final`. Three consequences:

**Every non-empty `Optional` is an allocation.** In a hot loop returning `Optional` per element, that is one object per iteration on top of the value. Escape analysis (Phase 22) frequently eliminates it when the `Optional` never leaves the method, and cannot when it is returned across an un-inlined boundary. This is why `OptionalInt`/`OptionalLong`/`OptionalDouble` exist — and why they have a deliberately reduced API (no `map`, no `flatMap`, no `filter`), so you convert to a real value quickly rather than building primitive-optional pipelines.

**`Optional` is a *value-based class*.** **[JDK]** The javadoc says instances are "value-based", which means:

- they are `final` and immutable;
- **`==` is meaningless** — use `equals`, which compares the contained values;
- they may be freely cached/substituted, so identity is not stable;
- **synchronizing on one, or using it as a lock or an identity-map key, is documented as a mistake** and is expected to throw once Valhalla lands.

`Optional.of("a").equals(Optional.of("a"))` is `true`; `==` is unspecified.

**`Optional` is not `Serializable`.** Deliberately. That alone rules it out as a field of a serializable entity, a DTO, or anything crossing a Java-serialization boundary. Most JSON mappers need explicit module support (`Jdk8Module` for Jackson) to handle it.

## 8. The four documented misuses

<div class="note">
<span class="label">Note</span>
<p>These are not style opinions — each has a concrete failure attached.</p>
</div>

**As a field.** Adds an allocation and an indirection per instance, is not serializable, breaks most ORM and mapper tooling, and buys nothing: the class controls its own invariants and can simply document that a field may be null, or use a null object.

```java
class Order { private Optional<Discount> discount; }   // no
class Order { private Discount discount; public Optional<Discount> discount() { return Optional.ofNullable(discount); } }   // yes
```

**As a parameter.** Now callers must write `f(Optional.of(x))` at every site, and you still have to handle `f(null)`. Overload the method or accept a nullable argument instead.

**In a collection.** `List<Optional<String>>` and `Map<K, Optional<V>>` are strictly worse than absence: a map already expresses "no value for this key" by not containing the key.

**Returning an empty `Optional` where an empty collection is the answer.** `Optional<List<Item>>` forces every caller through `orElse(List.of())`. Return the empty list.

The positive rule: **`Optional` on the return type of a method whose "not found" case is normal and which the caller is likely to mishandle as null.** Repository lookups, parsers, config lookups, `findFirst`.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong><code>std::optional&lt;T&gt;</code></strong> is a <em>value type</em>: the <code>T</code> is stored inline alongside a bool, with no heap allocation and no indirection. It can be a member, a parameter, a return, or an element of a container at essentially zero cost, so C++ has none of Java's "misuse" list. It cannot itself be "null" — an <code>optional</code> object always exists. Access is <code>*o</code> / <code>o-&gt;</code> (UB if empty), <code>o.value()</code> (throws <code>bad_optional_access</code>), or <code>o.value_or(d)</code> (eager, exactly like <code>orElse</code>). C++23 added the monadic operations: <code>and_then</code> ≈ <code>flatMap</code>, <code>transform</code> ≈ <code>map</code>, <code>or_else</code> ≈ <code>or</code>.</p>
<p><strong>Java's <code>Optional</code></strong> is a heap object accessed through a reference that can itself be null, so it is a <em>signal</em> in an API rather than a zero-cost sum type. That difference is why C++ advice is "use <code>optional</code> anywhere it fits" and Java advice is "return types only".</p>
</div>

| Concern | `std::optional<T>` | `Optional<T>` |
| --- | --- | --- |
| Storage | Inline value + flag | Heap object holding a reference |
| Can the wrapper be absent? | No | Yes — the reference can be null |
| Cost of use | Zero-ish | One allocation (often elided) |
| As a member / parameter | Idiomatic | Documented misuse |
| Unchecked access | `*o` — undefined behaviour | `get()` — `NoSuchElementException` |
| Checked access | `o.value()` | `orElseThrow()` |
| Eager default | `value_or(d)` | `orElse(d)` |
| Lazy default | none (write an `if`) | `orElseGet(sup)` |
| Monadic ops | `and_then` / `transform` / `or_else` (C++23) | `flatMap` / `map` / `or` (Java 9) |
| References | `optional<T&>` not allowed until C++26 | Always references — that is all Java has |
| Comparison | `operator==` compares contents | `equals` compares contents; `==` meaningless |

## 10. Edge cases

- **`Optional.of(null)`** throws immediately. That is a feature: use it as an assertion.
- **`map` returning null yields `empty`**, not `Optional.of(null)`. So `map` silently collapses nulls.
- **`opt.get()`** is not deprecated but is discouraged; `orElseThrow()` is the same behaviour with a name that reads like what it does.
- **`isPresent()` + `get()`** is just an `if` with extra steps. If you write it, you wanted `ifPresent` / `map` / `orElse`.
- **`Optional` inside a `Stream.map`** gives `Stream<Optional<T>>` — use `flatMap(Optional::stream)`.
- **`OptionalInt` has no `map`.** Convert with `stream()` or `orElse` early.
- **`Optional` in a switch/pattern match** does nothing useful — it is not sealed and has no deconstruction pattern.
- **`Optional.equals`** compares contained values with `equals`, so `Optional.of(1).equals(Optional.of(1L))` is `false`.
- **`Optional.empty() == Optional.empty()`** happens to be `true` (the `EMPTY` singleton) — relying on it is exactly the value-based-class mistake.
- **A method that returns `Optional` must never return null.** Returning `null` instead of `Optional.empty()` is the worst outcome available and defeats the entire point.

## 11. Common mistakes

- `opt.get()` without a check.
- `orElse(expensiveCall())`.
- `if (opt.isPresent()) { ... opt.get() ... }`.
- `Optional` fields, parameters, or collection elements.
- `Optional<List<T>>` instead of an empty list.
- Returning `null` from an `Optional`-returning method.
- `Optional.of(mayBeNull)` where `ofNullable` was meant.
- Using `==` on optionals, or synchronizing on one.
- Putting `Optional` in a `Serializable` entity or a JPA field.
- `map` where `flatMap` was needed, producing `Optional<Optional<T>>`.

## 12. Interview questions

**Beginner** — 1. What problem does `Optional` solve? 2. Difference between `of` and `ofNullable`? 3. What does `orElse` do?

**Intermediate** — 4. `orElse` versus `orElseGet` — show the bug. 5. When do you use `map` versus `flatMap`? 6. Why is `isPresent()`/`get()` an antipattern? 7. Can an `Optional` reference be null?

**Advanced** — 8. Why is `Optional` not a field type? Give three reasons. 9. What does "value-based class" mean and what are you forbidden from doing? 10. Why is `Optional` not `Serializable`? 11. Why do `OptionalInt`/`OptionalLong` have a smaller API than `Optional`?

**Senior** — 12. Design the return types for a repository interface with find-one, find-many, and find-one-or-fail. Justify each. 13. A hot path returning `Optional` per element shows up in an allocation profile. Explain when escape analysis removes it and when it cannot. 14. Argue both sides of introducing `Optional` across an existing 500 kLOC codebase.

## 13. Follow-ups

- *After Q3:* "When is `orElse` actually the right choice?" → cheap constants.
- *After Q4:* "Name three other JDK API pairs with the same eager/lazy split."
- *After Q7:* "So does `Optional` eliminate NPEs?" → no; it relocates the decision.
- *After Q9:* "What will Valhalla change?" → identity-sensitive operations become errors.
- *After Q12:* → `Optional<T>`, `List<T>` (empty, never Optional), and a throwing variant.

## 14. Exercise

1. Take a method with three levels of nested null checks and rewrite it with `map`/`flatMap`/`orElse`. Then write both versions' bytecode sizes and decide honestly which is clearer.
2. Write a class where `orElse` triggers a database call on every lookup. Add a counter, prove it, then fix with `orElseGet`.
3. Implement `MyOptional<T>` with `map`, `flatMap`, `filter`, `orElse`, `orElseGet`, `or`, `stream`. Roughly 60 lines; it will teach you why `flatMap` cannot be written in terms of `map`.
4. Convert a repository interface returning `null` into one returning `Optional`, and list every call site that changed behaviour rather than just shape.
5. JMH: a method returning `Optional<Integer>` called 100 M times, inlined versus `@CompilerControl(DONT_INLINE)`. Report allocation rate for both and connect it to escape analysis.

## 15. Output prediction

```java
import java.util.*;
import java.util.function.*;

public class Main {
    static int calls = 0;
    static String expensive() { calls++; return "computed"; }

    public static void main(String[] args) {
        Optional<String> present = Optional.of("v");
        Optional<String> empty   = Optional.empty();

        System.out.println(present.orElse(expensive()) + " calls=" + calls);
        System.out.println(present.orElseGet(Main::expensive) + " calls=" + calls);
        System.out.println(empty.orElseGet(Main::expensive) + " calls=" + calls);

        System.out.println(Optional.ofNullable((String) null).map(String::length));
        System.out.println(Optional.of("abc").map(s -> (String) null).isPresent());

        Optional<Optional<String>> nested = Optional.of(Optional.of("x"));
        System.out.println(nested.flatMap(o -> o).get());

        System.out.println(Optional.empty() == Optional.empty());
        System.out.println(Optional.of(1).equals(Optional.of(1L)));

        List<Optional<String>> os = List.of(Optional.of("a"), Optional.empty(), Optional.of("b"));
        System.out.println(os.stream().flatMap(Optional::stream).toList());

        System.out.println(Optional.of("a").filter(s -> s.startsWith("z")).or(() -> Optional.of("fallback")).get());

        try { Optional.of((String) null); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        try { empty.orElseThrow(); }       catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 16. Mastery check

1. State `Optional`'s designed purpose in one sentence, and name the three uses it excludes.
2. Explain `orElse` versus `orElseGet` with the evaluation rule that causes the difference.
3. When does `map` become `flatMap`, and what goes wrong if you pick wrong?
4. Why is `Optional` not a field type? Give three independent reasons.
5. What does "value-based class" mean, and list every operation it forbids.
6. Why is `Optional` deliberately not `Serializable`?
7. Explain the allocation cost of `Optional` and exactly when escape analysis removes it.
8. Why do the primitive optionals have a restricted API?
9. Rewrite `if (o.isPresent()) use(o.get()); else fallback();` three different ways.
10. What is the single worst thing an `Optional`-returning method can do, and why?
