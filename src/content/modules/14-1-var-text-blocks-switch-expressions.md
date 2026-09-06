---
title: "var, text blocks, switch expressions, and the modern collection APIs"
phase: 14
order: 1
minutes: 45
summary: "The syntax-level modernisation of Java: where var is legal and what it actually infers, the text-block indentation algorithm, switch as an expression, and the Java 9/21 collection factories."
tags: ["var", "text-blocks", "switch-expressions", "list-of", "sequenced-collections"]
---

## 1. `var` — local variable type inference

**[JLS]** Java 10 added `var` for **local variables only**. It is not `auto`, and it is not dynamic typing: the variable has a single static type, inferred from the initializer, checked at compile time.

Legal:

```java
var list   = new ArrayList<String>();          // ArrayList<String>
var entry  = map.entrySet().iterator().next(); // Map.Entry<K,V>
for (var e : map.entrySet()) { ... }
for (var i = 0; i < n; i++) { ... }
try (var in = Files.newInputStream(p)) { ... }
var lambda = (Runnable) () -> {};              // needs the cast — see below
(var a, var b) -> a + b                        // Java 11: lambda parameters, so you can annotate them
```

Illegal, and each for a reason:

```java
var x;                            // no initializer — nothing to infer from
var x = null;                     // the null type is not denotable
var f = () -> 1;                  // a lambda has no standalone type (Module 11.1)
var m = String::length;           // same
var arr = { 1, 2, 3 };            // array initializer shorthand needs a target type
private var field = 1;            // fields
void m(var x) { }                 // method parameters
var m() { return 1; }             // return types
catch (var e) { }                 // catch parameters
```

`var` is a **reserved type name**, not a keyword: `int var = 3;` still compiles, and a class named `var` does not (it is banned as a type name).

**What it actually infers is worth knowing.** The inferred type may be one you cannot write:

```java
var o = new Object() { int x = 1; };
o.x;                              // works — the type is the anonymous class type, non-denotable

var s = new ArrayList<>();        // ArrayList<Object>, not "ArrayList<something later"
s.add("a"); s.add(1);             // both compile. Diamond + var is a trap

var c = condition ? "s" : 1;      // an intersection type: Comparable<?> & Serializable
```

`var` also captures the **static** type, so `var x = getList()` where `getList()` returns `List<String>` gives you `List<String>`, not `ArrayList<String>` — the same as writing the declaration out.

**Style** — the OpenJDK guidance, condensed: use `var` when the initializer makes the type obvious (`new`, a factory with the type in its name, a cast). Avoid it when the right-hand side is an opaque call (`var r = process(x);`) or when the inferred type is wider or narrower than the reader expects. Do not use it to hide a long generic type that is long because the design is wrong.

## 2. Text blocks

**[JLS]** Java 15. Three double-quotes, a mandatory line terminator after the opening delimiter, and **automatic incidental-whitespace removal**.

```java
String json = """
        {
          "id": %d,
          "name": "%s"
        }""".formatted(id, name);
```

The stripping algorithm, precisely — this is what gets asked:

1. Split into lines.
2. Compute the **minimum indentation** across all non-blank lines **and the line containing the closing delimiter**.
3. Remove that many leading white-space characters from every line.
4. Strip trailing white space from every line.

So the position of the closing `"""` controls the result:

```java
String a = """
        hello
        """;          // closing delimiter at column 8 -> "hello\n"
String b = """
        hello
    """;              // closing delimiter at column 4 -> "    hello\n"
String c = """
        hello""";     // no trailing newline -> "hello"
```

Escapes still work, plus two that only exist in text blocks:

```java
\<newline>   // line continuation: joins this line to the next with NO \n
\s           // a literal space that survives trailing-whitespace stripping
```

```java
String sql = """
        SELECT id, name \
        FROM users \
        WHERE active = true""";       // one line, no newlines at all
```

**Line terminators are always `\n`**, regardless of the source file's encoding or the platform — a text block written on Windows still produces `\n`. `String.stripIndent()`, `translateEscapes()`, `formatted()` and `String.lines()` were added alongside.

## 3. Switch expressions

**[JLS]** Java 14. A `switch` can now **produce a value**, and the arrow form removes fall-through.

```java
// Statement, old form: fall-through, break required, shared scope, no value
switch (day) {
    case SATURDAY:
    case SUNDAY:
        type = "weekend";
        break;
    default:
        type = "weekday";
}

// Expression, arrow form
String type = switch (day) {
    case SATURDAY, SUNDAY -> "weekend";
    default               -> "weekday";
};

// Arrow form with a block needs yield to produce the value
int rating = switch (grade) {
    case "A" -> 4;
    case "B" -> 3;
    default  -> {
        log.warn("unknown grade {}", grade);
        yield 0;                                 // NOT return — return exits the method
    }
};
```

The rules that differ from the statement form:

| Rule | Switch expression |
| --- | --- |
| Fall-through | None in the arrow form; each arm is independent |
| `break` with a value | Removed; use `yield` |
| **Exhaustiveness** | **Required.** Every input must match an arm |
| `default` | Required unless the selector is an enum (or sealed type, Module 14.2) with all cases covered |
| Scope | Each arm has its own scope; the colon form shares one |
| `null` selector | `NullPointerException`, unless a `case null` arm exists (Java 21) |
| Mixing `->` and `:` | Not allowed in one switch |

Enum exhaustiveness is the practical win: an exhaustive enum switch needs no `default`, so **adding a constant to the enum becomes a compile error at every switch** instead of silently falling into `default`. Deliberately omitting `default` is how you get that.

**[JDK]** If the enum gains a constant *after* compilation and the class is not recompiled, the switch throws `MatchException` (Java 21+) or `IncompatibleClassChangeError` — a runtime signal rather than silent wrong behaviour.

## 4. Immutable collection factories

**[JDK]** Java 9 added the static factories. They are not the same thing as the old wrappers:

```java
List.of("a", "b")                      // a NEW immutable list
Set.of(1, 2, 3)
Map.of("k", 1, "k2", 2)                // up to 10 pairs
Map.ofEntries(Map.entry("k", 1), ...)  // any number
List.copyOf(existing)                  // immutable snapshot; returns the same object if already immutable

Collections.unmodifiableList(existing) // a VIEW — mutating `existing` changes the view
Arrays.asList(arr)                     // a fixed-size VIEW over the array; set() writes through
```

Their behaviour is deliberately strict:

- **Null-hostile.** `List.of("a", null)` throws `NullPointerException`; `contains(null)` throws too.
- **Duplicate-hostile.** `Set.of(1, 1)` and duplicate keys in `Map.of` throw `IllegalArgumentException` at construction.
- **Structurally immutable**, not deeply immutable — the *elements* can still be mutable objects.
- **`Set.of` and `Map.of` iteration order is randomised per JVM run.** **[JDK]** They mix a per-JVM `SALT` into iteration, specifically so no one can depend on the order. A test that passes locally and fails in CI on a `Set.of` iteration is this.
- Small sizes have **specialised implementations** (`List12`, `ListN`, `Set12`, `SetN`, `MapN`) with no array header for 1–2 elements, so they are smaller than an `ArrayList` as well as faster.

## 5. Sequenced collections

**[JDK]** Java 21 finally gave "has a defined first and last" a type. Before it, getting the last element of a `LinkedHashSet` required a full iteration.

```java
interface SequencedCollection<E> extends Collection<E> {
    SequencedCollection<E> reversed();          // a VIEW, not a copy
    void addFirst(E e);  void addLast(E e);
    E getFirst();        E getLast();           // NoSuchElementException when empty
    E removeFirst();     E removeLast();
}
interface SequencedSet<E> extends SequencedCollection<E>, Set<E> { SequencedSet<E> reversed(); }
interface SequencedMap<K,V> extends Map<K,V> {
    SequencedMap<K,V> reversed();
    Map.Entry<K,V> firstEntry(); lastEntry(); pollFirstEntry(); pollLastEntry();
    V putFirst(K k, V v);  V putLast(K k, V v);
    SequencedSet<K> sequencedKeySet();  SequencedCollection<V> sequencedValues();  SequencedSet<Entry<K,V>> sequencedEntrySet();
}
```

Retrofitted onto `List`, `Deque`, `LinkedHashSet`, `SortedSet`, `LinkedHashMap`, `SortedMap`. Note `List.reversed()` is a **view**: cheap, and writes through.

```java
var lru = new LinkedHashSet<>(List.of("a", "b", "c"));
lru.getLast();                     // "c"  — was O(n) before Java 21
for (var s : lru.reversed()) ...   // no copy
```

`addFirst`/`addLast` on a `SortedSet` throw `UnsupportedOperationException` — you cannot choose position in a sorted structure.

## 6. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong><code>auto</code></strong> is far broader than <code>var</code>: it works for return types (<code>auto f() -&gt; ...</code>, C++14 deduction), function parameters via generic lambdas and C++20 abbreviated templates, structured bindings, and non-type template parameters. It also has <em>decay</em> semantics — <code>auto x = vec[0]</code> copies, <code>auto&amp;</code> or <code>decltype(auto)</code> is needed to bind a reference. Java has no value semantics and no references to distinguish, so <code>var</code> has none of that subtlety and, correspondingly, none of the reach.</p>
<p><strong>Raw string literals</strong> <code>R"delim(...)delim"</code> are C++'s text blocks, but they are <em>completely</em> raw: no escape processing and, crucially, <strong>no indentation stripping</strong> — leading whitespace ends up in the string. Java's incidental-whitespace algorithm is the feature C++ lacks.</p>
<p><strong>switch</strong> in C++ still falls through by default (<code>[[fallthrough]]</code> only silences the warning) and is a statement, never an expression. The C++ workaround is an immediately-invoked lambda or a chain of ternaries.</p>
</div>

| Feature | C++ | Java |
| --- | --- | --- |
| Type inference | `auto`, `decltype`, `decltype(auto)` — locals, returns, params | `var` — locals only |
| Reference vs value in inference | `auto` / `auto&` / `auto&&` | Not applicable — everything is a reference |
| Raw strings | `R"(...)"` — no indent handling | Text blocks — incidental indent stripped |
| Switch fall-through | Default behaviour | None in the arrow form |
| Switch as expression | ✗ | ✅ with `yield` |
| Exhaustiveness checking | Warning only (`-Wswitch`) | Compile **error** for expressions |
| Immutable list literal | `const std::vector` / `std::array`, `initializer_list` | `List.of(...)` |
| Null in a container | `nullptr` is a valid value | `List.of` rejects it |
| First/last of an ordered set | `*s.begin()`, `*s.rbegin()` | `getFirst()`, `getLast()` (21) |
| Reverse view | `std::views::reverse` | `reversed()` (21) |

## 7. Edge cases

- **`var` + diamond** gives `ArrayList<Object>` — almost never what you meant.
- **`var` with a conditional** can infer an intersection type you cannot name, which then leaks into an error message you cannot read.
- **`var` in a `for` header** applies to the whole declaration: `for (var i = 0, j = 1; ...)` is illegal (multiple declarators are banned).
- **A text block's first line is always empty** — the content starts on the line after `"""`. `"""abc"""` does not compile.
- **Trailing spaces in a text block are stripped**, so use `\s` when you need them (fixed-width formats, some protocols).
- **Text blocks do not interpolate.** Use `.formatted(...)`. There is no `${}`.
- **A `yield` inside a lambda inside a switch arm** yields from the switch, not the lambda — but `return` inside that lambda returns from the lambda. Read carefully.
- **`switch` on a `String` is a hash-based two-step lookup** in bytecode (`hashCode` switch, then `equals`); on an enum it compiles to a `tableswitch` over ordinals via a synthetic `$SwitchMap$` array.
- **`List.of(...).contains(null)`** throws rather than returning `false`. Legacy code doing null-tolerant `contains` breaks when you swap in `List.of`.
- **`List.copyOf(list)` returns `list` itself** when it is already an immutable list of the same kind — so it is not always a defensive copy of a mutable input's *identity*.
- **`reversed()` is a view**: `list.reversed().set(0, x)` writes to the original's last element.

## 8. Common mistakes

- `var list = new ArrayList<>();` then wondering why everything is `Object`.
- Using `var` for an opaque call result and making the code unreadable.
- Putting the closing `"""` at column 0 and getting a fully indented string.
- Expecting text blocks to interpolate variables.
- Using `return` where `yield` was meant inside a switch arm block.
- Adding `default` to an exhaustive enum switch, losing the compile error when a constant is added.
- Assuming `Set.of` iteration order is stable across runs.
- `List.of(a, b)` where `a` might be null.
- Treating `Collections.unmodifiableList(x)` as immutable when `x` is still reachable and mutable.
- Iterating a `LinkedHashSet` to get the last element on Java 21.

## 9. Interview questions

**Beginner** — 1. What is `var` and where is it legal? 2. What is a text block for? 3. What does the arrow form of switch change?

**Intermediate** — 4. What does `var x = new ArrayList<>()` infer? 5. Describe the incidental-whitespace rule. 6. When does a switch expression need a `default`? 7. `List.of` versus `Collections.unmodifiableList` versus `Arrays.asList`.

**Advanced** — 8. Name three things `var` cannot infer and why. 9. Why is `Set.of` iteration order randomised, and what breaks because of it? 10. `yield` versus `return` versus `break` in a switch. 11. What happens at runtime if an enum gains a constant after an exhaustive switch was compiled?

**Senior** — 12. Argue for and against a team-wide `var` policy, with concrete review rules. 13. Why did Java add sequenced collections in 21 rather than 8? What could not be done before, and what did retrofitting cost? 14. You are designing a config DSL. Compare text blocks, `.properties`, and a builder API on readability, validation, and diff friendliness.

## 10. Follow-ups

- *After Q1:* "Why not fields?" → readability of the public shape; inference across a whole class is not local.
- *After Q4:* "What is the fix?" → write the type argument.
- *After Q6:* "Show me an enum switch that fails to compile when the enum changes."
- *After Q9:* "How would you write a test that survives it?" → assert on a set, or sort.
- *After Q11:* "Which error, exactly, and since when?" → `MatchException` on 21+.

## 11. Exercise

1. Write ten declarations mixing `var` and explicit types; for each, state the inferred type before compiling, then verify with `javap`. Include the `new Object() { int x; }` and the ternary cases.
2. Produce five text blocks that yield exactly: `"hello"`, `"hello\n"`, `"    hello\n"`, `"a b"` (from two source lines), and a line with three trailing spaces. Assert each with `equals`.
3. Convert an enum-driven `if/else if` chain to a switch expression with no `default`, then add an enum constant and show the compile error.
4. Take a class using `Collections.unmodifiableList` over a field and demonstrate that a caller holding the original can still mutate it. Fix with `List.copyOf`.
5. Write a `LinkedHashMap`-backed LRU (Module 8.4) and rewrite its eviction using `SequencedMap.pollFirstEntry()`. Compare readability and complexity.

## 12. Output prediction

```java
import java.util.*;

public class Main {
    enum Day { MON, SAT, SUN }
    public static void main(String[] args) {
        var l = new ArrayList<>();
        l.add("a"); l.add(1);
        System.out.println(l);

        var x = true ? "s" : 1;
        System.out.println(x.getClass().getSimpleName());

        String a = """
                hi
                """;
        String b = """
                hi""";
        String c = """
                    hi
                """;
        System.out.println("[" + a + "][" + b + "][" + c + "]");
        System.out.println(a.length() + " " + b.length() + " " + c.length());

        String d = """
                one \
                two""";
        System.out.println("[" + d + "]");

        for (Day day : Day.values()) {
            String t = switch (day) {
                case SAT, SUN -> "weekend";
                case MON -> { String s = "week"; yield s + "day"; }
            };
            System.out.print(t + " ");
        }
        System.out.println();

        var s1 = Set.of(1, 2, 3);
        System.out.println(s1.size());
        try { Set.of(1, 1); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        try { List.of("a").contains(null); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var seq = new LinkedHashSet<>(List.of("p", "q", "r"));
        System.out.println(seq.getFirst() + " " + seq.getLast() + " " + seq.reversed());

        List<Integer> nums = new ArrayList<>(List.of(1, 2, 3));
        nums.reversed().set(0, 99);
        System.out.println(nums);
    }
}
```

## 13. Mastery check

1. List every place `var` is legal and every place it is not.
2. Give three initializers `var` cannot infer from, and say why each fails.
3. State the four steps of the text-block incidental-whitespace algorithm.
4. Produce, from memory, text blocks yielding `"hi"` and `"    hi\n"`.
5. What do `\<newline>` and `\s` do in a text block?
6. When must a switch expression have a `default`, and why would you deliberately omit one?
7. Explain `yield` versus `return` inside a switch arm.
8. Compare `List.of`, `List.copyOf`, `Collections.unmodifiableList`, and `Arrays.asList` on mutability, null handling, and whether they are views.
9. Why is `Set.of` iteration order randomised?
10. Name the three sequenced interfaces, three classes retrofitted onto each, and what `reversed()` returns.
