---
title: "Records: transparent carriers for immutable data"
phase: 5
order: 2
minutes: 25
summary: "What javac generates, what the compact constructor is for, where records fit, and the cases where a record is the wrong tool."
tags: ["records", "immutability", "modern-java", "data-classes"]
---

## 1. Concept

A **record** (final in Java 16) is a class whose state is declared in its header and whose API is derived from that state:

```java
public record Point(int x, int y) { }
```

`javac` generates: a `private final` field per component; a public accessor per component named exactly like the component (`x()`, not `getX()`); a canonical constructor; and `equals`, `hashCode` and `toString` derived from all components. The class is implicitly `final` and extends `java.lang.Record` — so a record can implement interfaces but can never extend a class.

The word in the JEP is **transparent carrier**: the API tells you the state, and the state tells you the API. That is the semantic contract, not just a code-generation convenience.

## 2. Why

Java accumulated an enormous amount of boilerplate for what is conceptually a tuple with names: 60 lines of getters, `equals`, `hashCode` and `toString` for a 3-field DTO, every line a place for a bug (a field forgotten in `equals` is invisible until a `HashSet` misbehaves). Records make the correct version the shortest version.

## 3. Mental model

> A record is a **named tuple with a contract**: `new R(r.a(), r.b()).equals(r)` must hold. If your type cannot honour that — because it has hidden state, identity, or mutable components — it should not be a record.

## 4. Syntax and the constructors

```java
public record Range(int low, int high) {

    // COMPACT canonical constructor: no parameter list, no field assignment — javac adds those.
    public Range {
        if (low > high) throw new IllegalArgumentException(low + " > " + high);
        low = Math.max(low, 0);         // you may REASSIGN the parameter; the field gets the new value
    }

    // Additional constructors must delegate to the canonical one.
    public Range(int high) { this(0, high); }

    // Extra methods are fine.
    public int length() { return high - low; }

    // You may override any generated member.
    @Override public String toString() { return "[" + low + ", " + high + ")"; }

    // Static members are fine.
    public static Range empty() { return new Range(0, 0); }
}
```

Three rules worth memorising: the compact constructor takes no parameter list and assigns no fields; every other constructor must eventually call the canonical one; you may not add instance fields beyond the components.

## 5. Realistic example

```java
public sealed interface Event permits OrderPlaced, OrderShipped { Instant at(); }

public record OrderPlaced(long orderId, Instant at, List<LineItem> items) implements Event {
    public OrderPlaced {
        Objects.requireNonNull(at);
        items = List.copyOf(items);        // defensive copy INSIDE the compact constructor
    }
}
public record OrderShipped(long orderId, Instant at, String carrier) implements Event { }

static String describe(Event e) {
    return switch (e) {                                        // exhaustive over the sealed interface
        case OrderPlaced(long id, var at, var items) -> "placed " + id + " x" + items.size();
        case OrderShipped(long id, var at, String c) -> "shipped " + id + " via " + c;
    };
}
```

That `case OrderPlaced(long id, ...)` is a **record deconstruction pattern** (Java 21) — it works *because* a record's components are its state, which is the payoff of the transparency contract. Records + sealed interfaces + pattern switches is the modern Java way to model a closed set of data shapes.

## 6. What happens internally

**[JVMS]** A record class carries a `Record` attribute listing its components (name + descriptor + generic signature). That attribute is what reflection (`Class.getRecordComponents()`), serialization and pattern matching read — it is why record deconstruction does not need to guess which accessor corresponds to which field.

**[JLS]** The generated `equals` compares components using `==` for primitives (with `Double.compare`/`Float.compare` semantics for floating point, so `NaN` equals `NaN` and `0.0` does not equal `-0.0`) and `Objects.equals` for references. `hashCode` combines component hashes in an unspecified way — **the exact algorithm is not specified, so never persist a record's hash code**. `toString` is `Name[a=1, b=2]`.

**[JVMS, Java 16+]** The generated `equals`/`hashCode`/`toString` are implemented with `invokedynamic` to `ObjectMethods.bootstrap`, so the logic lives in the JDK rather than being emitted into every record class file — smaller class files, and one place to fix bugs.

**Serialization [JDK]:** records deserialize through their **canonical constructor**, so validation actually runs. That is a genuine improvement over classic Java serialization, which bypasses constructors entirely (Phase 20).

## 7. When a record is the wrong tool

- **Identity matters.** Two structurally identical entities that are different things (a database row with the same values) should not be `equals`.
- **You need mutable state.** Records are shallowly immutable by construction.
- **You need to hide the representation.** A record publishes its state; if the fields are an implementation detail you intend to change, use a class.
- **You need inheritance.** Records cannot extend classes and are final.
- **A component is an array.** `equals`/`hashCode` fall back to array identity — override manually or wrap the array.
- **Framework requires a no-arg constructor + setters** (older JPA, some serializers). Check support before modelling entities as records; Jackson and modern JPA handle records, older stacks do not.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> an aggregate <code>struct</code> plus <code>auto operator&lt;=&gt;(const Point&amp;) const = default;</code> (C++20) gives you memberwise comparison; structured bindings destructure it; it is a value type with copy semantics.</p>
<p><strong>Java:</strong> a record is the closest analogue — memberwise <code>equals</code>/<code>hashCode</code>, deconstruction patterns instead of structured bindings — but it is still a <em>reference</em> type. Two records with equal components are <code>equals</code> but not <code>==</code>, and assignment shares rather than copies.</p>
</div>

| C++ | Java record |
| --- | --- |
| `struct` aggregate | record header components |
| `= default` comparisons | generated `equals`/`hashCode` |
| structured bindings `auto [x, y] = p;` | record patterns `case Point(int x, int y)` |
| value semantics, copies | reference semantics, sharing (immutability makes that safe) |
| `const` members | implicitly final components |
| No inheritance restriction | record is implicitly `final`, cannot extend |

## 9. Edge cases

```java
record R(int a) {
    // int b;                       // ERROR: no additional instance fields
    static int counter;             // OK: static fields allowed
}

record S(List<String> items) { }
var list = new ArrayList<>(List.of("a"));
var s = new S(list);
list.add("b");
System.out.println(s.items());      // [a, b] — records are SHALLOWLY immutable

record T(int[] data) { }
System.out.println(new T(new int[]{1}).equals(new T(new int[]{1})));   // false

record U(double d) { }
System.out.println(new U(Double.NaN).equals(new U(Double.NaN)));   // true  (unlike ==)
System.out.println(new U(0.0).equals(new U(-0.0)));                // false (unlike ==)

record V(String name) {
    V { name = name.trim(); }       // compact constructor may reassign parameters
}
System.out.println(new V("  x ").name());   // "x"

record W() { }                       // legal: a zero-component record, a singleton-ish value
record Local(int x) { }              // records may be declared locally inside a method (Java 16)
```

## 10. Common mistakes

- Writing `getX()` accessors by hand and wondering why patterns and serializers ignore them.
- Assuming deep immutability.
- Using a record for a JPA entity without checking the provider.
- Overriding the canonical constructor with the full form and forgetting to assign a field (`javac` catches it, but the compact form makes it impossible).
- Persisting `hashCode()` values.
- Putting business logic that needs hidden state into a record.

## 11. Interview questions

**Beginner** — 1. What does a record generate? 2. Can a record extend a class? 3. Are records immutable?

**Intermediate** — 4. What is a compact constructor and what can it do? 5. How do you validate a record's arguments? 6. What are the accessor naming rules and why do they matter?

**Advanced** — 7. How does record `equals` treat `double` components, and why? 8. How does a record deserialize, and why is that safer? 9. What is the `Record` class-file attribute used for? 10. Why is a record's `hashCode` algorithm unspecified?

**Senior** — 11. Design an event-sourced domain with records and sealed interfaces; where do you put behaviour? 12. When would you refuse to use a record for a data class? 13. How do records interact with Valhalla value classes conceptually?

## 12. Follow-ups

- *After Q4:* "Can it assign to `this.x`?" → no; it assigns the parameters, javac does the fields.
- *After Q7:* "So `new R(NaN).equals(new R(NaN))` is…?" → true, unlike `==`.
- *After Q12:* "What about a record with a `byte[]` payload?" → override equals/hashCode or wrap.

## 13. Exercise

Convert this to a record, preserving behaviour exactly:

```java
public final class Coordinate {
    private final double lat, lon;
    public Coordinate(double lat, double lon) {
        if (Math.abs(lat) > 90) throw new IllegalArgumentException("lat");
        this.lat = lat; this.lon = lon;
    }
    public double getLat() { return lat; }
    public double getLon() { return lon; }
    @Override public boolean equals(Object o) { /* lat/lon compared with == */ }
    @Override public int hashCode() { /* ... */ }
}
```

Then list every behavioural difference you introduced (hint: `==` vs `Double.compare`, accessor names, finality, serialization).

## 14. Output prediction

```java
record P(String n, List<Integer> xs) {}
public class Main {
    public static void main(String[] args) {
        var list = new ArrayList<>(List.of(1));
        var a = new P("x", list);
        var b = new P("x", List.of(1));
        System.out.println(a.equals(b));
        list.add(2);
        System.out.println(a.equals(b));
        System.out.println(a);
        System.out.println(a == new P("x", a.xs()));
        System.out.println(a.equals(new P("x", a.xs())));
    }
}
```

## 15. Mastery check

1. List everything `javac` generates for a record.
2. What are the three constructor rules?
3. Why is a record implicitly final, and what does that mean for pattern matching?
4. How does record `equals` handle `double` and array components?
5. Why is the generated `hashCode` unspecified, and what must you never do because of it?
6. What is the `Record` attribute and which three features consume it?
7. Why is record deserialization safer than classic serialization?
8. Give four situations where a record is the wrong choice.
9. What does "transparent carrier" mean as a contract, not a slogan?
10. Map records onto their nearest C++20 constructs, and name the one difference that matters most.
