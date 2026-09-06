---
title: "Sealed types and pattern matching: algebraic data types in Java"
phase: 14
order: 2
minutes: 50
summary: "sealed + records + switch patterns gives Java closed sum types with compile-time exhaustiveness — the feature that finally retires the visitor pattern."
tags: ["sealed", "pattern-matching", "record-patterns", "switch", "exhaustiveness"]
---

## 1. Concept

Three features that were designed together and only pay off together:

```java
// 1. sealed: a hierarchy the compiler knows is closed
sealed interface Shape permits Circle, Rectangle, Triangle {}
record Circle(double r)                 implements Shape {}
record Rectangle(double w, double h)    implements Shape {}
record Triangle(double b, double h)     implements Shape {}

// 2 + 3. pattern matching in switch, with record deconstruction — and NO default,
//        because the compiler can prove the switch is exhaustive
static double area(Shape s) {
    return switch (s) {
        case Circle(double r)            -> Math.PI * r * r;
        case Rectangle(double w, double h) -> w * h;
        case Triangle(double b, double h)  -> b * h / 2;
    };
}
```

That is an **algebraic data type**: a fixed set of alternatives, each carrying data, consumed by exhaustive case analysis. Java arrived at it two decades after ML and Haskell, via Scala and Kotlin, and did it without breaking the existing object model.

## 2. Why Java has it

Java's inheritance offers exactly two settings: **open** (anyone may extend) or **`final`** (nobody may). There was no way to say *"these three and no others"*, which is what you need for:

- **Exhaustiveness.** If the compiler cannot enumerate the subtypes, it cannot check that you handled them all, so every `switch` needs a `default` that hides new cases.
- **API control.** A public interface with package-private implementations is the pre-sealed hack; it fails as soon as clients need to *name* the implementations.
- **The visitor pattern.** The whole pattern exists to simulate exhaustive dispatch over a closed hierarchy in a language without it. Sealed types make it unnecessary.

The other half — pattern matching — removes the `instanceof` + cast dance that every polymorphism-refusing branch in Java has always required.

## 3. Sealed types

```java
public sealed class Node permits Leaf, Branch { }
public final class Leaf extends Node { }
public non-sealed class Branch extends Node { }     // reopens the hierarchy below this point
```

The rules **[JLS]**:

| Rule | Detail |
| --- | --- |
| Every permitted subclass must be declared `final`, `sealed`, or `non-sealed` | No fourth option; this is what makes closure transitive |
| Permitted subclasses must be **accessible** to the sealed class at compile time | So the compiler can check them |
| Same **module**, or if unnamed module, same **package** | Cannot be sealed across a classpath boundary |
| Each permitted subclass must **directly** extend/implement the sealed type | No skipping levels |
| `permits` may be omitted if all subclasses are in the **same source file** | Common for small ADTs |
| A sealed **interface** may permit records, enums, and classes | Records are implicitly `final` |
| Local classes and anonymous classes may not implement a sealed type | They are unnameable, so unenumerable |

`non-sealed` is the escape hatch: `Branch` above says "the hierarchy is closed at `Node`, but open below `Branch`". It is the only hyphenated keyword in Java.

```java
// A canonical ADT — one file, no permits clause needed
public sealed interface Result<T> {
    record Ok<T>(T value)                implements Result<T> {}
    record Err<T>(String message, Throwable cause) implements Result<T> {}
}
```

## 4. Pattern matching for `instanceof`

**[JLS]** Java 16. A **type pattern** binds the narrowed value:

```java
// before
if (o instanceof String) { String s = (String) o; if (s.length() > 2) { ... } }

// after
if (o instanceof String s && s.length() > 2) { ... }
```

**Flow scoping** is the subtle part: the binding is in scope exactly where the pattern is **definitely true**.

```java
if (o instanceof String s) { use(s); }            // in scope inside the then-branch
if (!(o instanceof String s)) return;
use(s);                                            // in scope AFTER the if — the else path returned

if (o instanceof String s || s.isEmpty()) { }      // ERROR: s not definitely assigned on the || path
while (o instanceof Node n) { o = n.next(); }      // in scope in the body
```

This is not a new scoping rule invented for patterns — it is the same definite-assignment analysis Java has always used for `final` locals, applied to bindings.

## 5. Pattern matching for `switch`

**[JLS]** Java 21. Case labels can be patterns, with three additions.

```java
static String describe(Object o) {
    return switch (o) {
        case null                       -> "nothing";              // explicit null case
        case Integer i when i < 0       -> "negative " + i;        // guarded pattern
        case Integer i                  -> "int " + i;
        case String s when s.isBlank()  -> "blank string";
        case String s                   -> "string of " + s.length();
        case int[] arr                  -> "int array of " + arr.length;
        default                         -> "other";
    };
}
```

**Null.** A pattern `switch` throws `NullPointerException` on a null selector **unless** a `case null` label exists — preserving the behaviour of every pre-existing switch, while letting new code opt in. `case null, default ->` is a legal combined label.

**Guards** use `when`, a contextual keyword, and are evaluated *after* the type test.

**Dominance.** The compiler rejects a case that can never be reached because an earlier one subsumes it:

```java
switch (o) {
    case Object obj -> "any";
    case String s   -> "string";      // ERROR: this case label is dominated by a preceding label
}
```

Order matters: put the specific cases first, guarded before unguarded for the same type.

**Exhaustiveness.** A pattern `switch` **expression** must be exhaustive; a pattern `switch` **statement** must be too (unlike an old-style statement switch). Exhaustive means: covered by a `default`, or the selector is a sealed type / enum whose alternatives are all matched.

## 6. Record patterns

**[JLS]** Java 21. Deconstruct a record in the pattern itself, and nest arbitrarily.

```java
sealed interface Expr permits Num, Add, Mul, Neg {}
record Num(int v)                implements Expr {}
record Add(Expr left, Expr right) implements Expr {}
record Mul(Expr left, Expr right) implements Expr {}
record Neg(Expr e)               implements Expr {}

static int eval(Expr e) {
    return switch (e) {
        case Num(int v)                 -> v;
        case Add(Expr l, Expr r)        -> eval(l) + eval(r);
        case Mul(Num(int a), Num(int b))-> a * b;              // nested pattern
        case Mul(Expr l, Expr r)        -> eval(l) * eval(r);  // must come after the more specific one
        case Neg(Expr inner)            -> -eval(inner);
    };
}

// Simplification rules read like the algebra they encode
static Expr simplify(Expr e) {
    return switch (e) {
        case Mul(Num(int a), var r) when a == 0 -> new Num(0);
        case Mul(Num(int a), var r) when a == 1 -> simplify(r);
        case Add(var l, Num(int b))  when b == 0 -> simplify(l);
        case Neg(Neg(var inner))                -> simplify(inner);
        default                                  -> e;
    };
}
```

`var` is allowed in a record pattern component and infers the component's declared type. Nested patterns can only be applied to **record** components — there is no general deconstruction for ordinary classes yet.

Compare against the code this replaces:

```java
// The visitor pattern: 1 interface + 1 method per type + an accept() in every node + a class per operation
interface ExprVisitor<R> { R visitNum(Num n); R visitAdd(Add a); R visitMul(Mul m); R visitNeg(Neg n); }
```

## 7. What happens internally

**[JVMS]** `sealed` is a class-file attribute, `PermittedSubclasses`, holding the list of permitted types. The JVM enforces it **at class load and link time**: defining a class that extends a sealed type without being listed throws `IncompatibleClassChangeError`. Reflection exposes it:

```java
Shape.class.isSealed();                   // true
Shape.class.getPermittedSubclasses();     // [Circle.class, Rectangle.class, Triangle.class]
```

So sealing is not just a compiler fiction — it survives into the runtime and cannot be defeated by compiling a rogue subclass separately.

**Pattern switch compiles to `invokedynamic`.** **[JDK]** The bootstrap is `SwitchBootstraps.typeSwitch`, which receives the case labels and returns a `CallSite` whose method takes `(selector, startIndex)` and returns the **index of the first matching label** — or `-1` for null and `labels.length` for no match. javac then emits an ordinary `tableswitch` on that index, followed by the casts and binding stores.

```text
aload_1
iconst_0
invokedynamic #N typeSwitch:(Ljava/lang/Object;I)I
tableswitch { 0: ..., 1: ..., 2: ..., default: ... }
```

Two consequences worth stating:

- The type tests happen in the bootstrap-produced method, **in source order**, so a long pattern switch is a linear sequence of `instanceof` checks — not a constant-time jump. Ordering the common case first is a real optimisation for hot switches.
- Because the labels are baked into the call site at compile time, changing the sealed hierarchy without recompiling the switch produces a runtime failure rather than silent misbehaviour: **`MatchException`** when nothing matches an exhaustive switch.

**Exhaustiveness is a compile-time proof about a specific compilation.** Add a fourth `Shape` and recompile only that file, and every un-recompiled exhaustive switch is now a `MatchException` waiting to happen. This is the exact same class of separate-compilation hazard as an enum gaining a constant (Module 14.1 §3), and the reason CI should compile the whole module.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p>The C++ equivalent of a sealed hierarchy is <strong><code>std::variant&lt;A, B, C&gt;</code></strong> with <code>std::visit</code>. It is a genuine closed sum type: the alternatives are in the type, and <code>std::visit</code> with an exhaustive overload set fails to compile if a visitor cannot handle every alternative. The usual ergonomics are the <code>overloaded</code> lambda trick, and <code>std::get_if</code> for a manual if-chain.</p>
<p>The differences that matter: <code>variant</code> is a <strong>value</strong> — inline storage sized to the largest alternative, no allocation, no inheritance. Java's sealed hierarchy is <strong>reference-based</strong>, so alternatives can vary in size, participate in normal inheritance, and be extended below a <code>non-sealed</code> point. And Java has <strong>true deconstruction</strong> — <code>case Add(Num(int a), var r)</code> nests, where <code>std::visit</code> gives you the whole alternative and you destructure it yourself.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Closed sum type | `std::variant<A,B,C>` | `sealed interface ... permits` |
| Storage | Inline, size of the largest alternative | Reference to a heap object |
| Exhaustive dispatch | `std::visit` + overload set (compile error if incomplete) | pattern `switch` (compile error if inexhaustive) |
| Deconstruction | Structured bindings, one level, on the alternative | Nested record patterns, any depth |
| Guards | `if` inside the visitor | `when` clauses |
| Runtime enforcement | Type-system only | `PermittedSubclasses` checked by the JVM |
| Extending later | Change the variant, recompile all users | `non-sealed`, or add a permit + recompile |
| Empty/absent state | `std::monostate` | A dedicated record, or `null` with `case null` |
| Cost of dispatch | Jump table over the index | Linear `instanceof` chain via `typeSwitch` |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Expecting <code>switch</code> over patterns to be a jump table. It is a sequence of type tests. For a hot 12-arm switch, order matters; for a truly hot dispatch, virtual dispatch on the interface is still faster.</p>
<p>Reaching for pattern matching where polymorphism belongs. If every alternative implements the operation the same shape, put an abstract method on the sealed interface. Use patterns when the operation is <em>not</em> the type's business — serialisation, rendering, optimisation passes — which is exactly when you would have written a visitor in C++.</p>
</div>

## 9. Edge cases

- **A sealed type with a `default` in the switch** is legal but throws away the compile error you sealed it for. Prefer exhaustiveness without `default`.
- **Generic sealed types**: exhaustiveness accounts for type arguments, so `case Ok<String> ok` may not be allowed where the compiler cannot prove the cast is safe. Use `case Ok<?>` or a `var` pattern.
- **`case null` and `default` in the same arm** (`case null, default ->`) is the only way to combine them; a bare `default` does **not** match null.
- **Primitive type patterns** (`case int i` over a primitive selector) are a later feature; in Java 21 patterns match reference types, plus arrays.
- **Guards are not part of exhaustiveness.** `case Circle c when c.r() > 0` does not cover `Circle`; the compiler still demands an unguarded arm.
- **Dominance across guards:** an unguarded `case String s` dominates every later `case String s when ...`.
- **Records with a compact constructor that normalises** deconstruct to the *stored* components, not the constructor arguments.
- **`instanceof` with a pattern and a generic type** (`o instanceof List<String> l`) is rejected as unsafe unless the cast is provably safe — erasure again (Phase 6).
- **Sealed + `enum`**: an enum implementing a sealed interface participates in exhaustiveness at the enum-constant level only when the switch is over the enum type.
- **`MatchException`** is new in 21 and wraps an exception thrown by a record's accessor during deconstruction, in addition to the no-match case.

## 10. Common mistakes

- Adding `default` to every sealed switch out of habit.
- Ordering a general case before a specific one and hitting a dominance error — or worse, in an `if`-chain, silently shadowing it.
- Using pattern matching where a virtual method belongs.
- Forgetting that a pattern switch NPEs on null unless `case null` is present.
- Assuming exhaustiveness is checked at runtime — it is a compile-time proof about that compilation unit.
- Deploying a partially recompiled module after adding a permitted subclass.
- Trying to seal across a classpath (non-module) package boundary.
- Declaring a permitted subclass without `final`/`sealed`/`non-sealed`.
- Writing a deeply nested record pattern that is less readable than three lines of code.
- Expecting deconstruction to work on non-record classes.

## 11. Interview questions

**Beginner** — 1. What does `sealed` do? 2. What is a type pattern in `instanceof`? 3. What does a pattern `switch` do with null?

**Intermediate** — 4. What are the three legal modifiers on a permitted subclass, and why is one required? 5. What is flow scoping? Give an example where a binding is in scope after the `if`. 6. When is a `switch` expression exhaustive without a `default`? 7. What does `when` do and when is it evaluated?

**Advanced** — 8. Explain dominance and give a rejected example. 9. What does `sealed` compile to, and is it enforced at runtime? 10. How does a pattern `switch` execute — what does the bytecode look like? 11. Why do guards not contribute to exhaustiveness?

**Senior** — 12. Sealed hierarchy versus visitor versus polymorphism: give the decision rule and a case for each. 13. What breaks if you add a permitted subclass and redeploy only that jar? Trace it to the class file and the exception. 14. Design an expression/AST API for a query language: sealed shape, pattern-matched passes, and how you would keep it evolvable for third-party extensions.

## 12. Follow-ups

- *After Q1:* "How is it different from package-private constructors?" → subclasses can be public and named.
- *After Q4:* "What does `non-sealed` mean for exhaustiveness?" → the switch needs a `default` again below that point.
- *After Q6:* "Why would you deliberately omit `default`?"
- *After Q9:* "Can I defeat it with a separately compiled subclass?" → no; `IncompatibleClassChangeError`.
- *After Q12:* → polymorphism when the operation belongs to the type; patterns when it belongs to the consumer.

## 13. Exercise

1. Build the `Expr` ADT from §6 with `Num`, `Add`, `Mul`, `Neg`, and write `eval`, `simplify`, and `toInfixString` as three pattern-matching functions. Then write the same three as a visitor and compare line counts and the cost of adding a fifth node type.
2. Write a `sealed interface Result<T>` with `Ok`/`Err`, plus `map`, `flatMap`, `orElse` implemented with pattern switches. Compare with `Optional` (Phase 13) and say what `Result` gives you that `Optional` cannot.
3. Take a sealed switch with no `default`, add a permitted subclass, recompile **only** the subclass file, and observe the runtime failure. Record the exact exception and where it is thrown from.
4. Run `javap -c -v` on a pattern switch and locate the `typeSwitch` bootstrap and the `tableswitch`. Reorder the arms and confirm the bootstrap arguments change.
5. Write a JMH benchmark comparing a 10-arm pattern switch against a virtual method on the same sealed hierarchy, with the hot type first and last in the arm order. Explain the three numbers.

## 14. Output prediction

```java
sealed interface S permits A, B, C {}
record A(int x)          implements S {}
record B(String s)       implements S {}
record C(S inner)        implements S {}

public class Main {
    static String f(Object o) {
        return switch (o) {
            case null                      -> "null";
            case Integer i when i > 10     -> "big int";
            case Integer i                 -> "int " + i;
            case String s when s.isEmpty() -> "empty";
            case String s                  -> "str " + s.length();
            case C(A(int x))               -> "C(A(" + x + "))";
            case C(S inner)                -> "C(other)";
            case A a                       -> "A " + a.x();
            default                        -> "?";
        };
    }

    public static void main(String[] args) {
        System.out.println(f(null));
        System.out.println(f(5));
        System.out.println(f(50));
        System.out.println(f(""));
        System.out.println(f("abc"));
        System.out.println(f(new A(7)));
        System.out.println(f(new C(new A(3))));
        System.out.println(f(new C(new B("z"))));
        System.out.println(f(3.5));

        Object o = "hello";
        if (!(o instanceof String s)) { System.out.println("not a string"); return; }
        System.out.println(s.length());

        System.out.println(S.class.isSealed());
        for (var c : S.class.getPermittedSubclasses()) System.out.print(c.getSimpleName() + " ");
        System.out.println();
    }
}
```

## 15. Mastery check

1. State all six rules governing a sealed declaration and its permitted subclasses.
2. What does `non-sealed` mean, and what does it cost you?
3. Explain flow scoping with an example where the binding survives past the `if`.
4. Give the exact rule for null in a pattern `switch`.
5. Define dominance and show a rejected pair of case labels.
6. Why do guarded patterns not contribute to exhaustiveness?
7. Describe what `sealed` puts in the class file and how the JVM enforces it.
8. Walk through the bytecode of a pattern switch, naming the bootstrap method and what it returns.
9. Explain the separate-compilation hazard for exhaustive switches and the exception it produces.
10. Give the decision rule for sealed+patterns versus a virtual method, with one example of each.
