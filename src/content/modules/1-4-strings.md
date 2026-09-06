---
title: "Strings: immutability, the pool, and concatenation"
phase: 1
order: 4
minutes: 35
summary: "Why String is immutable, what the string pool really is, what the compiler does to your + operators, and when StringBuilder is a fix versus a superstition."
tags: ["string", "immutability", "string-pool", "stringbuilder", "intern"]
---

## 1. Concept

`java.lang.String` is an **immutable** reference type: once constructed, its contents never change. Every "modification" — `substring`, `toUpperCase`, `+`, `replace`, `trim` — returns a *new* `String`. The class is `final`, so nobody can subclass it and break that promise.

Two consequences you must be able to state instantly:

- **`==` compares references, `.equals()` compares contents.** Always.
- Because `String` is immutable and its `hashCode` is cached, it is a safe map key, safely shared between threads with no synchronisation, and safe to hand out from a getter without defensive copying.

The **string pool** (the *CONSTANT_String* intern table) is a JVM-managed table holding one canonical `String` object per distinct literal value. All string literals in all loaded classes are automatically interned, so identical literals *are* the same object.

## 2. Why Java has it

Immutability was chosen for three reasons at once, and interviewers like all three named:

1. **Safety** — strings are used for class names, file paths, URLs, SQL, permissions. A mutable string could be validated and then changed before use (a TOCTOU attack).
2. **Sharing / pooling** — if the value can never change, one object can back every occurrence of `"application/json"` in a codebase. Memory saved, equality often decidable by pointer.
3. **Hash caching and thread safety** — the hash can be computed once and cached; no synchronisation is needed to share the object.

The price is allocation churn on manipulation, which is why `StringBuilder` exists.

## 3. Mental model

> Think of `String` as a **shared immutable value object with an accidental identity**. The pool means literals with the same characters *are* the same object; `new String("x")` deliberately opts out of that; runtime-built strings are never pooled unless you call `intern()`. `==` therefore returns "true" often enough to trick you and "false" exactly when it matters.

## 4. Syntax

```java
String a = "hello";                    // literal → interned, in the pool
String b = "hel" + "lo";               // compile-time constant expression → same pooled object
String c = new String("hello");        // explicit new object; NOT the pooled one
String d = c.intern();                 // the pooled instance for this value

String greeting = String.join(", ", "a", "b");    // "a, b"
String block = """
    {"status": "ok"}
    """;                                // text block, Java 15+
String f = "user=%s id=%d".formatted(name, id);   // Java 15+, instance form of String.format
```

## 5. Minimal example

```java
String a = "hello";
String b = "hello";
String c = new String("hello");
String d = c.intern();
String e = "hel";
String f = e + "lo";                 // e is not a constant → runtime concatenation

System.out.println(a == b);          // true  — same pooled literal
System.out.println(a == c);          // false — new object
System.out.println(a == d);          // true  — intern() returns the pooled one
System.out.println(a == f);          // false — built at runtime, not interned
System.out.println(a.equals(f));     // true  — contents
```

Now change one word:

```java
final String e = "hel";              // now a compile-time constant
String f = e + "lo";                 // folded by javac into the literal "hello"
System.out.println(a == f);          // true
```

**[JLS §3.10.5 / §15.29]** That flip is specified: constant expressions are folded at compile time and their result is interned. `final` on a local with a constant initialiser is what makes it a constant expression. This is the sharpest small demonstration that `==` on strings tests an implementation-visible artifact, not a semantic property.

## 6. Realistic example

```java
// BAD — O(n²) copying, one throwaway String and one throwaway StringBuilder per iteration
public String toCsv(List<Order> orders) {
    String out = "";
    for (Order o : orders) {
        out += o.id() + "," + o.amountMinor() + "\n";
    }
    return out;
}
```

```java
// GOOD — one buffer, amortised growth
public String toCsv(List<Order> orders) {
    StringBuilder sb = new StringBuilder(orders.size() * 24);   // size hint avoids regrowth
    for (Order o : orders) {
        sb.append(o.id()).append(',').append(o.amountMinor()).append('\n');
    }
    return sb.toString();
}
```

```java
// ALSO GOOD, and clearer when the shape fits
public String toCsv(List<Order> orders) {
    return orders.stream()
        .map(o -> o.id() + "," + o.amountMinor())
        .collect(Collectors.joining("\n", "", "\n"));
}
```

The rule is not "never use `+`". It is: **`+` inside a loop is quadratic; `+` in a single expression is fine and often optimal.**

## 7. What happens internally

### Representation — compact strings

**[HotSpot, Java 9+]** `String` no longer wraps a `char[]`. It wraps a `byte[]` plus a one-byte `coder` flag: strings whose characters all fit in Latin-1 are stored one byte per character; anything else is UTF-16, two bytes per character. For typical ASCII-heavy server workloads this roughly halved string footprint — a real, measurable change ("compact strings", JEP 254). Note the API is unchanged: `charAt` still returns a UTF-16 `char`, and `length()` still counts **UTF-16 code units**, so an emoji outside the BMP has `length() == 2`.

### The pool

**[JVMS/HotSpot]** The pool is a hash table of references. Since **Java 7** the pooled `String` objects live in the **normal heap** (in Java 6 and earlier they lived in PermGen, which is why `intern()` used to be a way to blow up PermGen). The table itself is a native structure sized by `-XX:StringTableSize`; entries are weakly referenced, so unreferenced interned strings can be collected. Literals are interned automatically at class resolution.

### Concatenation

**[Java 8 and earlier]** `javac` desugared `a + b + c` into `new StringBuilder().append(a).append(b).append(c).toString()`.

**[Java 9+, JEP 280]** `javac` emits a single **`invokedynamic`** to `StringConcatFactory.makeConcatWithConstants`. At first execution, the JDK builds an optimised `MethodHandle` chain for that exact shape — commonly computing the exact final size and filling one array, with no `StringBuilder` at all. This is why the "always use StringBuilder" advice is now often wrong for straight-line code, and why modern JDKs can beat hand-written `StringBuilder` chains: the strategy can change without recompiling your code.

**In a loop**, however, each iteration is a separate concat call producing a whole new string, so the total work is O(n²) in the accumulated length regardless of strategy. That part did not change.

### hashCode

**[JDK implementation, and it is public knowledge]** `String.hashCode()` is `s[0]*31^(n-1) + s[1]*31^(n-2) + … + s[n-1]`, cached in a `hash` field (with a `hashIsZero` flag since Java 13 so that genuinely-zero hashes are not recomputed). The cache is written without synchronisation — a benign data race, safe precisely because the computation is deterministic and the field is an `int` (no word tearing).

### `intern()`

Native method; returns the canonical instance, adding the string to the table if absent. **[HotSpot]** It is not free — a native call plus a hash-table probe — and heavy `intern()` use on a large table is a known performance trap. Prefer a `HashMap`-based canonicaliser you control, or `ConcurrentHashMap#putIfAbsent`, when you need deduplication. Modern G1 also offers automatic **string deduplication** (`-XX:+UseStringDeduplication`) which merges the backing arrays of equal strings during GC without touching identity.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>std::string</code> is a mutable value type with an owning buffer, SSO for short strings, deterministic destruction, and <code>==</code> that compares <em>contents</em>. Passing by value copies; passing by <code>const&amp;</code> avoids the copy.</p>
<p><strong>Java:</strong> <code>String</code> is an immutable heap object accessed by reference. Assignment copies the reference, never the characters — so "passing a string" is always free. <code>==</code> compares references. There is no SSO, no destructor, no <code>c_str()</code>.</p>
</div>

| Concern | C++ `std::string` | Java `String` |
| --- | --- | --- |
| Mutability | Mutable (`s[0] = 'x'`, `append`) | Immutable; every op returns a new object |
| `==` | Value comparison | **Reference** comparison — use `.equals()` |
| Copy on assign | Yes (deep copy or move) | No — reference copy |
| Encoding | Bytes; encoding is your problem | UTF-16 code units, Latin-1-compacted internally |
| Interning | None (`std::string_view` of a literal is nearest) | Automatic for literals; `intern()` on demand |
| Mutable buffer | `std::string` itself, `reserve()` | `StringBuilder` (+ `setLength`, capacity hint) |
| Thread safety | None; shared mutable strings need locks | Immutable → freely shareable. `StringBuffer` is the synchronised builder |
| Substring cost | Copy (`substr`) | Copy since Java 7 (before that it shared the array and leaked) |
| Formatting | `std::format` / streams | `String.format`, `formatted`, text blocks |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Using <code>==</code> on strings.</strong> It compiles. It even works for literals. It fails on anything read from a file, socket, or database — the worst possible failure mode: correct in tests, wrong in production.</p>
<p><strong>Assuming <code>+</code> is a copy-heavy disaster everywhere.</strong> A single-expression concat compiles to one <code>invokedynamic</code> and typically one allocation.</p>
<p><strong>Expecting <code>length()</code> to be a character count.</strong> It counts UTF-16 code units. Use <code>codePointCount</code> for characters, and remember grapheme clusters are a third thing again.</p>
<p><strong>Reaching for <code>intern()</code> as an optimisation.</strong> It is a synchronising native call into a global table. Usually the wrong tool.</p>
<p><strong>Expecting a mutable string type.</strong> <code>StringBuilder</code> is it — and it is not a <code>String</code>, does not override <code>equals</code>, and must be <code>toString()</code>-ed.</p>
</div>

## 9. Edge cases

```java
System.out.println("a" + "b" == "ab");               // true  — constant folding
String s = "a"; System.out.println(s + "b" == "ab"); // false — runtime concat
System.out.println(("a" + "b").intern() == "ab");    // true

String n = null;
System.out.println("value: " + n);                   // "value: null" — no NPE
System.out.println(n.length());                      // NPE

System.out.println("".isEmpty());       // true
System.out.println("  ".isBlank());     // true  (Java 11+)
System.out.println("abc".substring(3)); // ""    — legal, index == length
System.out.println("abc".substring(4)); // StringIndexOutOfBoundsException

System.out.println("😀".length());          // 2 — one code point, two UTF-16 units
System.out.println("😀".codePointCount(0, 2)); // 1

System.out.println("HELLO".toLowerCase());  // locale-sensitive! In Turkish locale "I" → "ı"
                                            // use toLowerCase(Locale.ROOT) for protocol strings

StringBuilder sb1 = new StringBuilder("x"), sb2 = new StringBuilder("x");
System.out.println(sb1.equals(sb2));        // false — StringBuilder does not override equals
System.out.println(sb1.toString().equals(sb2.toString())); // true

switch (command) { case "start" -> ...; }   // switch on String works via hashCode + equals
```

The locale one is a genuine production bug generator: `toUpperCase()` without a locale has broken authentication and protocol parsing in real systems ("i".toUpperCase() is "İ" in a Turkish locale). Rule: **any string that is data for a machine gets `Locale.ROOT`; only user-facing text gets the default locale.**

## 10. Common mistakes

- `==` instead of `.equals()`.
- `s.equals("literal")` when `s` may be null — prefer `"literal".equals(s)` or `Objects.equals(a, b)`.
- `+=` in a loop.
- `new String("literal")` — pointless allocation; there is never a good reason.
- `intern()` as a "memory optimisation" without measuring.
- `toUpperCase()`/`toLowerCase()`/`String.format()` without a `Locale` for machine-readable data.
- Using `String` for passwords (an immutable object you cannot wipe; `char[]` at least can be zeroed).
- Assuming `split` takes a plain string — it takes a **regex**, so `"a.b".split(".")` returns an empty array.
- Building SQL by concatenation. This is an injection bug, not a style preference.
- Using `StringBuffer` in new code — it is the legacy synchronised version; `StringBuilder` is the one you want.

## 11. Interview questions

**Beginner**
1. Why is `String` immutable? Give three distinct reasons.
2. `==` versus `.equals()` for strings — when do they agree by accident?
3. `String` vs `StringBuilder` vs `StringBuffer`.

**Intermediate**
4. What is the string pool? Which strings end up in it automatically?
5. How many `String` objects does `String s = new String("abc");` involve?
6. Why is `+` in a loop O(n²) even on modern JDKs?
7. What does `intern()` do and when would you use it?

**Advanced**
8. What changed in string concatenation in Java 9, and why did it change?
9. What are compact strings and what did they cost or buy?
10. Explain the benign data race in `String.hashCode()` and why it is safe.
11. Where does the string pool live, and what changed in Java 7?

**Senior / deep dive**
12. A heap dump shows 40% of the heap is `char[]`/`byte[]` behind `String`s, most of them duplicates. Give three fixes and their trade-offs.
13. Why did `substring` change from O(1) to O(n) in Java 7?
14. Why is `String` `final`, and what attack does that prevent?
15. How does `switch` on a `String` compile, and what does that imply about hash collisions?

## 12. Follow-up questions to expect

- *After Q4:* "Does `new String("a").intern() == "a"` hold? Does it also hold after a GC?"
- *After Q5:* "How many at *runtime* versus how many exist in the class file's constant pool?" (Two objects at most, one of which was already there.)
- *After Q6:* "Would a `StringBuilder` in the loop fix the complexity, or just the constant factor?"
- *After Q8:* "What is the advantage of `invokedynamic` here over `javac` emitting `StringBuilder` calls?" → the strategy is chosen by the *runtime*, so old bytecode benefits from new JDKs.
- *After Q12:* "How does G1 string deduplication differ from `intern()`?" → dedup merges backing arrays during GC, preserves identity, requires no code change.

## 13. Coding exercise

Write a small benchmark harness (or reason it out precisely, then verify with JMH) comparing four ways to build a 100 000-line report:

1. `String +=` in a loop.
2. `StringBuilder` with default capacity.
3. `StringBuilder` with a correct capacity hint.
4. `Collectors.joining()`.

Then answer:
- Which two are asymptotically different, and which two differ only by a constant?
- How much does the capacity hint actually save, and where does that saving come from (hint: `Arrays.copyOf` on growth)?
- Now make each line contain a non-Latin-1 character and re-measure. Explain the difference using §7.

## 14. Output prediction

**A**
```java
public class Main {
    public static void main(String[] args) {
        String a = "java";
        String b = "ja" + "va";
        String c = new String("java");
        String part = "ja";
        String d = part + "va";
        System.out.println((a == b) + " " + (a == c) + " " + (a == d) + " " + (a == d.intern()));
    }
}
```

**B**
```java
public class Main {
    public static void main(String[] args) {
        String s = null;
        System.out.println("x" + s + s);
        System.out.println(s + 1);
    }
}
```

**C**
```java
public class Main {
    public static void main(String[] args) {
        System.out.println("a.b.c".split("\\.").length);
        System.out.println("a.b.c".split(".").length);
        System.out.println("a,b,,,".split(",").length);
        System.out.println("".split(",").length);
    }
}
```

**D**
```java
public class Main {
    public static void main(String[] args) {
        String s = "hello";
        s.toUpperCase();
        s.concat(" world");
        System.out.println(s);
        System.out.println(s.replace('l', 'L'));
        System.out.println(s);
    }
}
```

**E**
```java
public class Main {
    public static void main(String[] args) {
        StringBuilder sb = new StringBuilder("ab");
        System.out.println(sb == sb.append("c"));
        System.out.println(sb.equals(new StringBuilder("abc")));
        System.out.println(sb.reverse());
        System.out.println(sb);
    }
}
```

## 15. Mastery check

1. Give three independent reasons `String` is immutable, and name the one that is a security argument.
2. Precisely when does `==` on two `String`s return `true`? Enumerate every case.
3. What does `javac` do with `"a" + "b"`, and what does it do with `x + "b"`? Name the exact mechanism for each on Java 9+.
4. Why is `+=` in a loop still quadratic after JEP 280?
5. Where do interned strings live, in which Java version did that change, and what failure mode did the old placement cause?
6. Explain compact strings: representation, what it saved, and what it did *not* change in the API.
7. Why is `String.hashCode()`'s cache safe without synchronisation, and what property of `int` fields does that rely on?
8. `"I".toLowerCase()` — under what circumstances is the result not `"i"`, and what is the rule that prevents the bug?
9. When should you *not* use `intern()`, and what would you use instead for deduplication?
10. Contrast `String`, `StringBuilder`, and `StringBuffer` on mutability, thread safety, and when each is correct in 2026 code.
