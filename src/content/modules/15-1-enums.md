---
title: "Enums: full classes wearing constant clothing"
phase: 15
order: 1
minutes: 40
summary: "What javac generates for an enum, why constant-specific bodies create anonymous subclasses, how EnumSet fits 64 constants in a long, and why ordinal() must never reach a database."
tags: ["enum", "enumset", "enummap", "singleton", "ordinal"]
---

## 1. Concept

A Java enum is **a class with a fixed set of instances**, created eagerly and exactly once.

```java
public enum Status { ACTIVE, SUSPENDED, CLOSED }
```

That is not sugar for an `int`. It compiles to roughly:

```java
public final class Status extends java.lang.Enum<Status> {
    public static final Status ACTIVE    = new Status("ACTIVE", 0);
    public static final Status SUSPENDED = new Status("SUSPENDED", 1);
    public static final Status CLOSED    = new Status("CLOSED", 2);
    private static final Status[] $VALUES = { ACTIVE, SUSPENDED, CLOSED };

    private Status(String name, int ordinal) { super(name, ordinal); }
    public static Status[] values()          { return $VALUES.clone(); }
    public static Status valueOf(String n)   { return Enum.valueOf(Status.class, n); }
}
```

So an enum constant is a **singleton object** of a real class, and everything a class can do — fields, constructors, methods, interfaces — an enum can do.

## 2. Why Java has it

The alternative, in Java before 1.5 and in C to this day, is the **int-constant pattern**:

```java
public static final int STATUS_ACTIVE = 0;      // typeless, printless, rangeless, unenumerable
void setStatus(int status);                     // setStatus(42) compiles; setStatus(DAY_MONDAY) compiles
```

Every problem with that is fixed by the enum: type safety (`setStatus(Priority.HIGH)` does not compile), a readable `toString`, namespacing, a compile-time-known set you can iterate and `switch` exhaustively over, and — because constants are objects — the ability to attach data and behaviour.

## 3. What you can put in one

```java
public enum Planet {
    MERCURY(3.303e+23, 2.4397e6),
    EARTH  (5.976e+24, 6.37814e6);              // constants FIRST, semicolon after the last

    private final double mass, radius;          // fields — make them final

    Planet(double mass, double radius) {        // constructor: implicitly private, cannot be called
        this.mass = mass; this.radius = radius;
    }

    public double surfaceGravity() { return 6.67300E-11 * mass / (radius * radius); }
}
```

**Constant-specific bodies** let each constant override behaviour — the strategy pattern with no extra types:

```java
public enum Operation {
    PLUS("+")  { public double apply(double a, double b) { return a + b; } },
    MINUS("-") { public double apply(double a, double b) { return a - b; } },
    TIMES("*") { public double apply(double a, double b) { return a * b; } };

    private final String symbol;
    Operation(String symbol) { this.symbol = symbol; }
    public abstract double apply(double a, double b);       // every constant must implement it
    @Override public String toString() { return symbol; }
}
```

**Enums may implement interfaces** (they cannot extend a class — they already extend `Enum`):

```java
public interface Rule { boolean test(Order o); }
public enum StandardRules implements Rule {
    NON_EMPTY { public boolean test(Order o) { return !o.lines().isEmpty(); } },
    PAID      { public boolean test(Order o) { return o.paid(); } };
}
// Extensibility: other enums can implement Rule too, and callers accept List<Rule>
```

That is the standard idiom for an "extensible enum": you cannot subclass an enum, but you can have several enums implement one interface.

## 4. The inherited API

**[JDK]** From `java.lang.Enum`:

| Member | Behaviour |
| --- | --- |
| `name()` | The identifier as written. `final` |
| `ordinal()` | Declaration position, from 0. `final` |
| `toString()` | Returns `name()` by default; **overridable** |
| `equals` / `hashCode` | `final`, identity-based — `==` is always correct and preferred |
| `compareTo` | `final`, by `ordinal()` |
| `getDeclaringClass()` | The enum type, even for a constant with a body |
| `clone()` | `final`, always throws `CloneNotSupportedException` |
| `Enum.valueOf(Class, name)` | The backing of the generated `valueOf` |

And the two **synthetic statics** javac generates per enum:

- `values()` — returns a **clone of the backing array on every call**. That is a defensive copy (the array is mutable and shared) and it is an allocation. In a hot loop, cache it:

  ```java
  private static final Status[] VALUES = values();      // clone once
  // or, better when you want a Set
  private static final Set<Status> ALL = EnumSet.allOf(Status.class);   // immutable-ish, cheap
  ```

- `valueOf(String)` — **throws `IllegalArgumentException`** for an unknown name, and `NullPointerException` for null. It is case-sensitive and matches `name()`, never `toString()`.

For lenient parsing, build your own map in a static initializer:

```java
private static final Map<String, Status> BY_CODE =
        Arrays.stream(values()).collect(toUnmodifiableMap(s -> s.code, s -> s));
public static Optional<Status> fromCode(String c) { return Optional.ofNullable(BY_CODE.get(c)); }
```

## 5. `EnumSet` and `EnumMap`

Both exploit the fact that the constant set is known and small, and both are **substantially** faster than the hash-based equivalents.

**[JDK]** `EnumSet` is abstract with two implementations chosen by `EnumSet.noneOf`:

- `RegularEnumSet` — up to **64** constants: the entire set is **one `long` bitmask**. `add`/`contains`/`remove` are single bit operations; `addAll`/`retainAll`/`removeAll` are one `|`, `&`, `& ~`. Iteration walks set bits.
- `JumboEnumSet` — more than 64: a `long[]`.

```java
EnumSet.noneOf(Day.class)     EnumSet.allOf(Day.class)      EnumSet.of(MON, WED)
EnumSet.range(MON, FRI)       EnumSet.complementOf(weekend) EnumSet.copyOf(collection)
```

`EnumMap` is an **`Object[]` indexed by `ordinal()`**, plus a parallel notion of "present". No hashing, no collisions, no `equals` calls, iteration in **ordinal order**, and null values are permitted (null keys are not).

```java
Map<Day, List<Task>> byDay = new EnumMap<>(Day.class);       // not new HashMap<>()
```

Use them by default for enum keys. The only reason not to is that `EnumMap`'s constructor needs the `Class` object, which a generic method may not have.

## 6. Enums as singletons

**[Effective Java, Item 3]** A single-element enum is the best singleton implementation in Java:

```java
public enum ConnectionPool {
    INSTANCE;
    private final DataSource ds = build();
    public Connection get() { return ds.getConnection(); }
}
```

It is better than the static-field and holder idioms for three specific reasons:

1. **Serialization-safe by construction.** Enums serialize as their `name()` and deserialize via `Enum.valueOf` — no `readResolve` to remember, and the "serialization creates a second instance" bug is impossible.
2. **Reflection-safe.** `Constructor.newInstance` on an enum throws `IllegalArgumentException("Cannot reflectively create enum objects")`.
3. **Thread-safe initialization for free** — the constants are created in the class's static initializer, and **[JLS 12.4]** class initialization is guaranteed to happen exactly once with a happens-before edge to every use (Phase 25).

The cost: an enum cannot extend a class, and initialization is eager at first *use of the class*, not first use of the instance.

## 7. What happens internally

**Constant-specific bodies create anonymous subclasses.** `Operation.PLUS` from §3 is not an `Operation` — it is an instance of the synthetic class `Operation$1`:

```java
Operation.PLUS.getClass()               // class Operation$1
Operation.PLUS.getDeclaringClass()      // class Operation   <-- use this
Operation.class.isEnum()                // true
Operation.PLUS.getClass().isEnum()      // FALSE — a constant body's class is not itself an enum
```

Consequence: the enum type is only *implicitly* `final` when no constant has a body. With bodies it is compiled as `abstract` with sealed-like subclasses. Any code doing `x.getClass() == Operation.class` breaks.

**`switch` over an enum** compiles differently in the two forms. The colon form generates a synthetic `$SwitchMap$` `int[]`, built in a static initializer of a synthetic class, mapping `ordinal()` → a dense case index:

```java
switch (status) { case ACTIVE: ... }
// becomes roughly:
switch (SwitchMap.$SwitchMap$Status[status.ordinal()]) { case 1: ... }
```

The indirection exists **so that recompiling the enum does not break the switch's class file**: ordinals may shift, but the map is rebuilt at class initialization by `valueOf` lookups. The arrow form on Java 21+ may instead use the `typeSwitch` bootstrap (Module 14.2).

**Initialization order is the one real footgun.** Constants are created *before* the enum's static fields:

```java
public enum Currency {
    USD("$"), EUR("€");
    private static final Map<String, Currency> BY_SYMBOL = new HashMap<>();
    Currency(String symbol) {
        BY_SYMBOL.put(symbol, this);      // NullPointerException — BY_SYMBOL is still null!
    }
}
```

**[JLS 8.9.2]** It is a compile-time error to reference a non-constant static field from an enum constructor, precisely because of this. The fix is a `static {}` block **after** the constants, or a static holder class:

```java
private static final Map<String, Currency> BY_SYMBOL = new HashMap<>();
static { for (Currency c : values()) BY_SYMBOL.put(c.symbol, c); }
```

**`ordinal()` is a serialization hazard.** It is declaration order, and declaration order changes. Anything that outlives the JVM — a database column, a wire protocol, a cache, a file — must store `name()` or an explicit stable code field, never the ordinal. **[JDK]** The javadoc says `ordinal()` "is designed for use by sophisticated enum-based data structures such as `EnumSet` and `EnumMap`"; that is the entire intended audience.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ enums are integers.</strong> An unscoped <code>enum</code> converts implicitly to <code>int</code> and leaks its names into the enclosing scope; <code>enum class</code> (C++11) fixes both — scoped names, no implicit conversion, a specifiable underlying type — but it is still <em>only</em> a number. There are no methods, no fields, no constructors, no iteration, no name strings, and no exhaustiveness guarantee (<code>-Wswitch</code> is a warning, and any integer can be cast in).</p>
<p><strong>Java enums are objects.</strong> Each constant is a singleton instance of a real class, so it can carry state and behaviour, be a map key with zero hashing cost, be switched over exhaustively as a compile error, and print its own name. The price is that they are heap objects with identity, and that you cannot do arithmetic on them or extend them.</p>
</div>

| Concern | C++ `enum class` | Java `enum` |
| --- | --- | --- |
| Underlying representation | An integer | An object reference |
| Methods / fields | ✗ | ✅ |
| Per-constant behaviour | ✗ (a `switch` or a table) | Constant-specific bodies |
| Name at runtime | ✗ (until C++26 reflection; `magic_enum` otherwise) | `name()`, `toString()` |
| Iterate all values | ✗ (write a table) | `values()`, `EnumSet.allOf` |
| Parse from string | Write it | `valueOf` |
| Exhaustive switch | Warning only | Compile **error** for switch expressions |
| Out-of-range value | `static_cast<E>(99)` is legal-ish | Impossible |
| Bit flags | `enum` + `|` on the ints, natural | `EnumSet` — same performance, type-safe |
| Interfaces | ✗ | ✅ |
| Cost of a set of flags | One int | One `long` inside a `RegularEnumSet` object |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Reaching for <code>ordinal()</code> the way you would use the underlying integer of an <code>enum class</code> — for bit flags, array indices you persist, or wire values. In Java the ordinal is an implementation detail of declaration order; use <code>EnumSet</code> for flags and an explicit <code>code</code> field for anything persisted.</p>
<p>Using <code>equals</code> or <code>compareTo</code> where <code>==</code> is right. Enum identity is guaranteed, so <code>==</code> is correct, faster, and null-safe.</p>
</div>

## 9. Edge cases

- **`values()` allocates a clone on every call.** Cache it, or use `EnumSet.allOf`.
- **An enum with a constant body is not `final`** and its constants' `getClass()` is a synthetic subclass.
- **`valueOf` matches `name()`, not `toString()`.** Overriding `toString` and expecting round-tripping is a classic bug.
- **Enum constants may be `null` as a variable value.** `Status s = null; switch (s)` throws NPE unless `case null` exists (Java 21+).
- **`EnumSet` is not thread-safe** and is not immutable; `Collections.unmodifiableSet` or `Set.copyOf` if you expose it.
- **`EnumMap` allows null values but not null keys.**
- **`Enum.compareTo` is by ordinal**, so a `TreeSet<MyEnum>` reorders itself when you reorder the declaration.
- **Enums can have static factory methods and static state**, and that state is *shared mutable global state* with all the usual problems.
- **`switch` on an enum with a `default`** silently absorbs new constants; omit `default` to get the compile error.
- **An enum nested in an interface or class is implicitly `static`.**
- **Adding a constant is a source- and binary-compatible change to the enum**, but breaks exhaustive switches in un-recompiled callers at runtime (Module 14.1 §3).
- **`java.util.EnumSet.copyOf(Collection)`** throws if the collection is empty and is not an `EnumSet` — there is no way to infer the enum class.

## 10. Common mistakes

- Persisting `ordinal()` to a database or a wire format.
- `HashMap<MyEnum, V>` instead of `EnumMap`.
- `Set<MyEnum>` as a `HashSet` instead of `EnumSet`.
- Calling `values()` inside a loop.
- Referencing a static field from an enum constructor.
- `default` in every enum switch.
- Overriding `toString` and then calling `valueOf(x.toString())`.
- Using `.equals()` instead of `==`.
- Trying to subclass an enum, instead of having several enums implement an interface.
- Putting mutable state in an enum constant and sharing it across threads.

## 11. Interview questions

**Beginner** — 1. What is a Java enum, really? 2. Can an enum have fields and methods? 3. How do you get all constants?

**Intermediate** — 4. Why can't an enum extend a class? 5. What does `valueOf` throw for a bad name? 6. Why is `==` safe for enums? 7. Why `EnumMap` over `HashMap`?

**Advanced** — 8. What does `values()` cost, and why? 9. What class is `Operation.PLUS` an instance of, and why does it matter? 10. How is `EnumSet` implemented for ≤64 constants and beyond? 11. Why can't an enum constructor reference a static field of the enum?

**Senior** — 12. Why is a single-element enum the best singleton? Give all three reasons. 13. Explain the `$SwitchMap$` indirection and the separate-compilation problem it solves. 14. Design an extensible set of validation rules where third parties can add rules but the core set is enum-backed. What do you give up?

## 12. Follow-ups

- *After Q3:* "What does that call allocate?"
- *After Q6:* "Is `equals` wrong?" → no, just slower and less null-obvious.
- *After Q9:* "So is the enum type `final`?" → not when a constant has a body.
- *After Q11:* "Show the fix." → a static block after the constants.
- *After Q12:* "What do you lose versus a class-based singleton?" → no superclass, eager init.

## 13. Exercise

1. Write `Operation` from §3 with four operations and a `symbol` field, plus a static `fromSymbol(String)` lookup built in a static block. Prove `PLUS.getClass() != Operation.class`.
2. Implement a `Permission` enum with 70 constants and confirm via `getClass()` that `EnumSet.noneOf` gives you a `JumboEnumSet`. Then benchmark `EnumSet` versus `HashSet` for `contains` at 10 M calls.
3. Benchmark `values()` in a hot loop versus a cached array versus `EnumSet.allOf`, and report the allocation rate of each.
4. Write an enum with a `code` field, persist it two ways (ordinal and code), reorder the constants, and show the data corruption from the ordinal version.
5. Build an extensible rule system: a `Rule` interface, a core enum implementing it, a second enum from a "plugin", and a registry that composes both. Write down what you lost versus a single enum.

## 14. Output prediction

```java
import java.util.*;

enum Op {
    ADD("+") { int apply(int a, int b) { return a + b; } },
    SUB("-") { int apply(int a, int b) { return a - b; } };
    final String sym;
    Op(String sym) { this.sym = sym; }
    abstract int apply(int a, int b);
    @Override public String toString() { return sym; }
}

enum Color { RED, GREEN, BLUE }

public class Main {
    public static void main(String[] args) {
        System.out.println(Op.ADD + " " + Op.ADD.name() + " " + Op.ADD.ordinal());
        System.out.println(Op.ADD.getClass().getSimpleName() + " " +
                           Op.ADD.getDeclaringClass().getSimpleName());
        System.out.println(Op.class.isEnum() + " " + Op.ADD.getClass().isEnum());

        System.out.println(Op.valueOf("ADD").apply(2, 3));
        try { Op.valueOf("+"); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        System.out.println(Color.values() == Color.values());
        System.out.println(Arrays.equals(Color.values(), Color.values()));

        var s = EnumSet.range(Color.RED, Color.GREEN);
        System.out.println(s + " " + EnumSet.complementOf(s));

        Map<Color, Integer> m = new EnumMap<>(Color.class);
        m.put(Color.BLUE, 3); m.put(Color.RED, 1);
        System.out.println(m);
        m.put(Color.GREEN, null);
        System.out.println(m + " " + m.containsKey(Color.GREEN) + " " + m.get(Color.GREEN));

        System.out.println(Color.RED.compareTo(Color.BLUE));
        System.out.println(new TreeSet<>(List.of(Color.BLUE, Color.RED)));

        Color c = null;
        try { switch (c) { case RED -> System.out.println("r"); default -> System.out.println("d"); } }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 15. Mastery check

1. Write out, from memory, the class javac generates for `enum Status { A, B }`.
2. Why can an enum implement an interface but not extend a class?
3. What does `values()` return and what does each call cost?
4. Explain what a constant-specific body compiles to and two things it changes.
5. Describe `RegularEnumSet` and `JumboEnumSet`, including the 64 boundary.
6. Describe `EnumMap`'s representation and every property that follows from it.
7. Give the three reasons a single-element enum is the best singleton.
8. Why is referencing a static field from an enum constructor a compile error, and what is the fix?
9. Explain the `$SwitchMap$` array and the problem it exists to solve.
10. State the rule for `ordinal()` in persisted data, and what to use instead.
