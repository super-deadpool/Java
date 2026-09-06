---
title: "Primitives, References, and why int is not Integer"
phase: 1
order: 2
minutes: 35
summary: "Java's two-world type system: eight primitives that are values, everything else a reference to a heap object — plus the autoboxing that hides the border and the bugs that leak through it."
tags: ["types", "primitives", "autoboxing", "null", "promotion"]
---

## 1. Concept

Java has exactly **two kinds of types**, and the boundary between them explains a disproportionate share of Java behaviour.

**Primitive types** — `boolean`, `byte` (8), `short` (16), `char` (16, *unsigned*), `int` (32), `long` (64), `float` (32), `double` (64). A variable of primitive type **holds the value itself**. There is no identity, no null, no header, no indirection. `int` is 4 bytes of storage and nothing else.

**Reference types** — classes, interfaces, arrays, enums, records, and `null`'s type. A variable of reference type holds a **reference to an object on the heap** (in practice a pointer, possibly compressed — but the JVMS deliberately does not say). Two references can point to the same object; a reference can be `null`; every object carries a header and participates in GC.

Everything else follows: `==` compares what the variable holds (a value, or a reference), so on primitives it means "same value" and on references it means "same object". Generics only accept reference types. `null` only exists on the reference side.

The eight primitives each have a **wrapper class** — `Integer`, `Long`, `Double`, `Boolean`, `Character`, `Byte`, `Short`, `Float` — immutable objects holding one primitive field, so a primitive can enter the object world (collections, generics, `Object`).

## 2. Why Java has it

A pure "everything is an object" language is elegant and slow: every `int` becomes an allocation and a pointer chase, and arithmetic loses the ability to live in registers. Java's designers took the pragmatic split — primitives for arithmetic performance, objects for everything else — and accepted the seam.

**Autoboxing** (Java 5) papers over the seam so you can write `list.add(3)` instead of `list.add(Integer.valueOf(3))`. It buys ergonomics and it buys three specific classes of bug (§9). Knowing exactly where the compiler inserts a `valueOf` or an `intValue` is the entire skill here.

<div class="note">
<span class="label">Where this is going</span>
<p>Project Valhalla aims to remove the seam with value classes — objects with no identity, flattenable into arrays and fields. As of Java 25 it is still in preview/incubation, not something to build on. Mentioning it correctly ("not yet shipped, aims to kill the primitive/reference divide") is a strong senior signal; claiming you use it is not.</p>
</div>

## 3. Mental model

> A primitive variable **is** a box of bits. A reference variable is a **luggage tag** for a box that lives on the heap. `==` always compares the thing in your hand — bits, or tags. Autoboxing is the compiler silently calling `Integer.valueOf(...)` / `.intValue()` at the border, and `valueOf` **caches small values**, which is why `==` on boxed types works right up until it doesn't.

## 4. Syntax

```java
int      count   = 42;          // value
Integer  boxed   = 42;          // autoboxing: Integer.valueOf(42)
int      back    = boxed;       // unboxing: boxed.intValue()

long     wide    = count;       // widening: implicit, lossless (int → long)
int      narrow  = (int) wide;  // narrowing: explicit cast, may truncate silently
double   d       = 1 / 2;       // 0.0 — integer division happens first
char     c       = 'A' + 1;     // 'B' — constant expression, fits in char
Object   any     = count;       // boxes to Integer, then widens the reference
```

## 5. Minimal example — the classic

```java
Integer a = 127, b = 127;
Integer c = 128, d = 128;
System.out.println(a == b);   // true
System.out.println(c == d);   // false
System.out.println(c.equals(d)); // true
```

**[JLS §5.1.7]** `Integer.valueOf` is *required* to cache the range −128..127 (and `Boolean`, `Byte`, `Character` ≤ 127, `Short` and `Integer` in that range). Outside it, caching is permitted but not required, so `valueOf(128)` normally allocates. `==` on `Integer` is a reference comparison; it accidentally agrees with value comparison inside the cache. This is specified behaviour, not a HotSpot quirk — and the cache's upper bound is tunable with `-XX:AutoBoxCacheMax`.

## 6. Realistic example — where this actually bites

```java
// BAD: a boxed accumulator in a hot loop
public long totalMinorUnits(List<Order> orders) {
    Long total = 0L;                       // Long, not long
    for (Order o : orders) {
        total += o.amountMinor();          // unbox, add, box → one allocation per order
    }
    return total;
}
```

Every `+=` compiles to `Long.valueOf(total.longValue() + o.amountMinor())`. A million orders is a million short-lived `Long` objects. (Escape analysis sometimes rescues this; it reliably does not when `total` outlives the loop body or the loop is not compiled.) Fixing it is one character:

```java
public long totalMinorUnits(List<Order> orders) {
    long total = 0L;
    for (Order o : orders) total += o.amountMinor();
    return total;
}
```

And when the collection itself must hold numbers in bulk, the honest options are primitive arrays, `IntStream`/`LongStream`, or a primitive-collection library (Eclipse Collections, fastutil, HPPC) — because `List<Integer>` is an array of pointers to individually allocated boxes, with the cache behaviour that implies.

```java
// A subtler one: Map.get returns null, and unboxing null throws.
Map<String, Integer> counts = new HashMap<>();
int n = counts.get("missing");             // NullPointerException, not 0
int safe = counts.getOrDefault("missing", 0);   // correct
```

## 7. What happens internally

**[JLS]** Autoboxing/unboxing is pure compiler desugaring — no runtime support:

| You write | javac emits |
| --- | --- |
| `Integer x = 5;` | `Integer.valueOf(5)` |
| `int y = x;` | `x.intValue()` |
| `x + 1` where `x` is `Integer` | `x.intValue() + 1` |
| `list.add(5)` | `list.add(Integer.valueOf(5))` |
| `if (boolObj)` | `boolObj.booleanValue()` |

**[JVMS]** The bytecode has separate instruction families per primitive type (`iadd`/`ladd`/`fadd`/`dadd`, `iload`/`aload`, …). There is no generic "add". `boolean`, `byte`, `short` and `char` have **no arithmetic instructions at all** — they are computed as `int` and truncated back. This is not an optimisation detail; it is why the rules in §8 exist.

**Numeric promotion [JLS §5.6]** — the rules, in order:
1. If either operand is `double` → both to `double`; else `float`; else if either is `long` → `long`;
2. **otherwise both are promoted to `int`.** Hence `byte + byte` is an `int`, and `short s = s + 1;` does not compile while `s += 1;` does (compound assignment has an implicit narrowing cast — a specified footgun).

**[HotSpot]** An `Integer` on a 64-bit JVM with compressed oops typically costs 16 bytes (12-byte header + 4-byte `int` value, padded), plus a 4-byte reference to reach it — roughly **5× the memory of an `int`, in a different cache line**. That memory-layout difference, not the allocation, is usually what shows up in a profiler for large `List<Integer>`s.

**`float`/`double` [JLS]** are IEEE-754 and, since Java 17, *always* strictly so (`strictfp` became the only behaviour). `0.1 + 0.2 != 0.3` for the same reasons as in C++. `NaN != NaN` — including `Double.NaN == Double.NaN` being `false` — but `Double.valueOf(NaN).equals(Double.valueOf(NaN))` is **true**, and `-0.0 == 0.0` is true while `Double.valueOf(-0.0).equals(0.0)` is **false**. Those two inversions exist so that `HashMap` and sorting behave consistently, and they are excellent senior interview material.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>int</code>, <code>Foo</code>, <code>Foo&amp;</code>, <code>Foo*</code>, <code>const Foo&amp;</code> are all distinct; objects can live on the stack, in a member, or on the heap; you choose. <code>sizeof</code> tells you the truth; <code>int</code> is at least 16 bits, typically 32; <code>char</code> may be signed or unsigned; overflow of a signed integer is UB.</p>
<p><strong>Java:</strong> non-primitive objects are <em>always</em> heap-conceptual and always reached by reference. There is no <code>Foo</code>-by-value, no <code>Foo*</code> arithmetic, no <code>const</code> reference. Sizes are fixed by the spec on every platform. Signed overflow wraps, defined. <code>char</code> is unsigned 16-bit UTF-16 code unit. There is no <code>unsigned</code> keyword.</p>
</div>

| C++ | Java | Difference that matters |
| --- | --- | --- |
| `Foo f;` (stack object) | *(no equivalent)* | Java's `Foo f;` is a reference. Value semantics for your own types do not exist (until Valhalla) |
| `Foo* p = nullptr;` | `Foo f = null;` | Same idea; Java has no pointer arithmetic and no dangling references |
| `Foo& r` | reference variable | Java references are **rebindable** (like `Foo*`), not bound-once (like `Foo&`) |
| `std::optional<int>` | `Integer` (nullable) or `OptionalInt` | Java's "nullable int" is a heap object, not a flat optional |
| `unsigned int` | none — use `int` + `Integer.divideUnsigned`, `compareUnsigned`, `toUnsignedLong` | A frequent surprise porting bit-twiddling code |
| `char` (1 byte) | `byte` (signed 8-bit) or `char` (unsigned 16-bit UTF-16) | `char` is **not** a byte. Text vs bytes is a hard boundary in Java |
| `>>` on signed | `>>` (arithmetic) and `>>>` (logical) | Java adds `>>>` precisely because there is no `unsigned` |
| `int8_t`…`int64_t` fixed widths | fixed by spec | Java has no `size_t`, no `long long`, no platform variance |
| implicit narrowing conversions warn | narrowing **requires** a cast | except in compound assignment (`s += 1`) — the one hole |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Reaching for <code>==</code> on wrappers.</strong> In C++ <code>a == b</code> on value types compares values. In Java it compares references for every reference type — <code>Integer</code>, <code>String</code>, everything. Use <code>.equals()</code>, or unbox one side deliberately.</p>
<p><strong>Assuming <code>Integer</code> is a lightweight typedef of <code>int</code>.</strong> It is a heap object with identity, nullability, and 4× the footprint.</p>
<p><strong>Expecting <code>char</code> arithmetic and <code>byte</code> arithmetic to stay in type.</strong> They promote to <code>int</code>; assignment back requires a cast.</p>
<p><strong>Looking for <code>unsigned</code>.</strong> There is none. <code>byte</code> is signed, so <code>b &amp; 0xFF</code> is idiomatic and necessary.</p>
</div>

## 9. Edge cases

```java
Integer i = null;
int j = i;                       // NPE — unboxing null

Long  l = 1L;
System.out.println(l.equals(1)); // false! Integer(1).equals is asked of a Long → type mismatch

List<Integer> list = new ArrayList<>(List.of(1, 2, 3));
list.remove(1);                  // removes INDEX 1 → [1, 3]
list.remove(Integer.valueOf(1)); // removes the VALUE 1 → [2, 3]

Object o = true ? Integer.valueOf(1) : Double.valueOf(2.0);
System.out.println(o);           // 1.0 — the conditional operator promotes both branches

char c = 'a';
c += 1;                          // fine (implicit narrowing in compound assignment)
// c = c + 1;                    // does not compile: int cannot be assigned to char

System.out.println('a' + 1);     // 98    — int arithmetic
System.out.println("" + 'a' + 1);// "a1"  — string concatenation
System.out.println(1 + 2 + "x"); // "3x"  — left to right
System.out.println("x" + 1 + 2); // "x12"

System.out.println(0.1 + 0.2 == 0.3);      // false
System.out.println(Double.NaN == Double.NaN);            // false
System.out.println(Double.valueOf(Double.NaN)
        .equals(Double.valueOf(Double.NaN)));            // true
System.out.println(Math.abs(Integer.MIN_VALUE));         // negative! overflow, defined
```

The ternary one (`1` printing as `1.0`) is worth pausing on: **[JLS §15.25]** the conditional operator computes a single result type by binary numeric promotion, so the `Integer` branch is unboxed, widened to `double`, and re-boxed as `Double`. The branch not taken changed the type of the branch taken.

## 10. Common mistakes

- `int x = map.get(k);` when the key may be absent → NPE. Use `getOrDefault`.
- `==` between `Integer`s that works in tests (values < 128) and fails in production.
- Boxed accumulators / boxed loop counters in hot code.
- `List<Integer>.remove(int)` vs `remove(Object)` overload confusion.
- `Long.equals(Integer)` silently false — especially in `Map<Long, ?>` lookups done with an `int` literal key.
- Using `float`/`double` for money. Use `long` minor units or `BigDecimal`; never `double`.
- `byte b = (byte) 200;` then wondering why it prints `-56`.
- Treating `char` as a byte when decoding — encoding must be explicit (`new String(bytes, StandardCharsets.UTF_8)`).

## 11. Interview questions

**Beginner**
1. Name the eight primitives and their sizes. Which one has an unspecified size in C++ but a fixed one in Java?
2. What is autoboxing? Show what the compiler generates.
3. Why does `int x = someInteger;` risk an exception?

**Intermediate**
4. Explain why `a == b` is `true` for `Integer` 127 and `false` for 128.
5. Why does `short s = 1; s = s + 1;` fail to compile while `s += 1;` compiles?
6. What is the memory cost of `List<Integer>` versus `int[]` for a million elements?
7. Why can't a generic type parameter be a primitive?

**Advanced**
8. `Double.NaN == Double.NaN` is false but `Double.valueOf(NaN).equals(...)` is true. Why did the designers do that?
9. Walk through the type rules for `true ? 1 : 2.0`.
10. What does `Math.abs(Integer.MIN_VALUE)` return, and is that a bug in the JDK?
11. How would you represent an unsigned 64-bit value in Java, and what breaks?

**Senior / deep dive**
12. You profile a service and see 30% of allocation is `java.lang.Integer`. How do you find the cause and what are your options?
13. What is Project Valhalla trying to change, and what current Java behaviour would become impossible or different?
14. Why does `-XX:AutoBoxCacheMax` exist, and why is relying on it a bad idea?
15. Explain how escape analysis interacts with boxing, and why you cannot count on it.

## 12. Follow-up questions to expect

- *After Q4:* "Where is that cache specified, and what is its range for `Byte`, `Character`, `Boolean`?" then "does `new Integer(5) == new Integer(5)` ever return true?" (and: `new Integer(...)` is deprecated for removal — why?)
- *After Q6:* "Which one has better cache locality and why?" → `int[]` is contiguous; `Integer[]` is pointers into scattered heap.
- *After Q7:* "So how do streams avoid boxing?" → `IntStream`, `LongStream`, `DoubleStream`, and the `mapToInt`/`boxed` boundary.
- *After Q10:* "How do you write an overflow-safe absolute value?" → `Math.absExact` (Java 15+), or `Math.floorMod` for the modulo case.
- *After Q12:* "Which JFR event or profiler view would you use?" → allocation profiling by class + call site (JFR `ObjectAllocationSample`, async-profiler `-e alloc`).

## 13. Coding exercise

Implement a frequency counter two ways and measure the difference:

```java
interface Counter {
    void add(String word);
    long countOf(String word);
}
```

1. Version A: `HashMap<String, Integer>` with `merge(word, 1, Integer::sum)`.
2. Version B: `HashMap<String, long[]>` where the value is a one-element array used as a mutable box (a common real-world trick), or `LongAdder` values.
3. Feed both 5 million words drawn from a 10 000-word vocabulary. Compare allocation counts, not wall-clock time first — then wall-clock after a proper warm-up.
4. Explain precisely where version A allocates and why version B mostly does not. Then explain why version A is still the right default in most code.

## 14. Output prediction

**A**
```java
public class Main {
    public static void main(String[] args) {
        Integer a = 1000, b = 1000;
        System.out.println(a == b);
        System.out.println(a.equals(b));
        int c = 1000;
        System.out.println(a == c);
    }
}
```

**B**
```java
public class Main {
    public static void main(String[] args) {
        Map<String, Integer> m = new HashMap<>();
        m.put("a", 1);
        m.put("b", null);
        System.out.println(m.get("a") + 1);
        System.out.println(m.containsKey("b"));
        System.out.println(m.get("b") + 1);
    }
}
```

**C**
```java
public class Main {
    public static void main(String[] args) {
        byte b = 10;
        b += 300;
        System.out.println(b);
        System.out.println((int) (char) (byte) -1);
    }
}
```

**D**
```java
public class Main {
    static void f(long x)    { System.out.println("long"); }
    static void f(Integer x) { System.out.println("Integer"); }
    static void f(Object x)  { System.out.println("Object"); }
    static void f(int... x)  { System.out.println("varargs"); }
    public static void main(String[] args) {
        f(1);
    }
}
```

(D is testing overload resolution order: phase 1 — no boxing, no varargs; phase 2 — boxing allowed; phase 3 — varargs. Work out which phase finds a match first.)

## 15. Mastery check

1. State the two kinds of Java types and one consequence of the distinction for `==`, one for `null`, one for generics, and one for memory layout.
2. Exactly which conversions does `javac` insert for `Integer x = 5; int y = x + 1;`? Write the bytecode-level calls.
3. Why is the `Integer` cache range specified rather than left to implementations?
4. Explain `short s = 1; s += 1;` in terms of JLS §5.6 and compound-assignment narrowing.
5. Give three distinct runtime failures that autoboxing can cause, with a one-line reproduction each.
6. Why is `Long.valueOf(1).equals(Integer.valueOf(1))` false, and why is this dangerous in a `Map`?
7. What is the result type of `true ? 1 : 2.0`, and what happened to the untaken branch?
8. `float`/`double` in Java vs C++: name one thing Java guarantees that C++ historically did not.
9. How do you do unsigned arithmetic in Java, and what does `>>>` have to do with it?
10. A `List<Integer>` of 10 million entries versus an `int[]` of 10 million: estimate both footprints and explain the gap.
