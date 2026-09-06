---
title: "Casting, instanceof, and why Java forbids multiple class inheritance"
phase: 2
order: 4
minutes: 35
summary: "Upcasting and downcasting, pattern matching for instanceof, the diamond problem and Java's answer to it, and the case for composition over inheritance."
tags: ["casting", "instanceof", "pattern-matching", "diamond", "composition"]
---

## 1. Concept

**Upcasting** (`Child` → `Parent`) is always safe, implicit, and free — it changes only the *static type* of the expression. **Downcasting** (`Parent` → `Child`) is a claim the compiler cannot verify, so it is checked at run time: if the object is not actually a `Child`, you get a `ClassCastException`.

`instanceof` asks "is the runtime class of this object assignable to that type?" — and since Java 16 it can bind the result in one step:

```java
if (shape instanceof Circle c && c.radius() > 10) { ... }   // pattern matching for instanceof
```

Java permits **single class inheritance** and **multiple interface inheritance**. That asymmetry is the language's answer to the diamond problem, and understanding *why* it is drawn at exactly that line is a standard interview target.

## 2. Why Java has it

Multiple inheritance of **state** creates a genuine ambiguity: if `D` extends both `B` and `C`, and both extend `A`, does `D` have one copy of `A`'s fields or two? C++ answers with virtual inheritance, a vtable-offset mechanism most programmers get wrong at least once. Java's designers judged the complexity not worth the payoff and forbade it outright.

Multiple inheritance of **type** (interfaces) has no such ambiguity — an interface historically had no state and no implementation, so inheriting two of them can conflict only in *names*, which the compiler can force you to resolve. When default methods arrived in Java 8, they reintroduced inherited *behaviour*, so the JLS gained explicit conflict rules (Phase 4) — but still no inherited *state*, which is the part that would have created the diamond.

## 3. Mental model

> A reference is a **view** onto an object. Casting changes the view, never the object. `instanceof` asks what the object really is. And Java's rule is simple: **inherit state once, inherit types freely.**

## 4. Syntax

```java
Object o = "hello";

// old style
if (o instanceof String) {
    String s = (String) o;
    System.out.println(s.length());
}

// Java 16+
if (o instanceof String s && !s.isEmpty()) {
    System.out.println(s.length());
}

// Java 21: pattern matching in switch, with exhaustiveness over a sealed hierarchy
static String describe(Shape shape) {
    return switch (shape) {
        case Circle c    -> "circle r=" + c.radius();
        case Square s    -> "square side=" + s.side();
        case null        -> "none";
        default          -> "other";
    };
}
```

## 5. Minimal example

```java
class Animal {}
class Dog extends Animal { void bark() {} }
class Cat extends Animal {}

Animal a = new Dog();       // upcast: implicit
Dog d = (Dog) a;            // downcast: checked, succeeds
Cat c = (Cat) a;            // compiles (Animal → Cat is plausible), throws ClassCastException

String s = (String) a;      // does NOT compile — the types are provably unrelated
```

The distinction matters: `javac` rejects a cast only when it can prove the conversion is impossible. Between a class and any of its subclasses — or to any interface, since a subclass might implement it — the check is deferred to run time.

## 6. Realistic example — replacing a cast chain

```java
// BAD: type-testing chain, no exhaustiveness, easy to forget a case
public double area(Shape s) {
    if (s instanceof Circle) return Math.PI * Math.pow(((Circle) s).radius(), 2);
    if (s instanceof Square) return Math.pow(((Square) s).side(), 2);
    throw new IllegalArgumentException("unknown shape: " + s);
}
```

```java
// GOOD (polymorphism): the hierarchy owns the behaviour
public sealed interface Shape permits Circle, Square {
    double area();
}
public record Circle(double radius) implements Shape {
    @Override public double area() { return Math.PI * radius * radius; }
}
public record Square(double side) implements Shape {
    @Override public double area() { return side * side; }
}
```

```java
// ALSO GOOD (sealed + switch): when the operation does not belong to the type
public String render(Shape s) {
    return switch (s) {                       // exhaustive: no default needed, Java 21
        case Circle c -> "○ " + c.radius();
        case Square q -> "□ " + q.side();
    };
}
```

The choice between the last two is the classic **expression problem**: virtual methods make it easy to add new *types*, sealed hierarchies plus switches make it easy to add new *operations*. Sealed types let you pick per situation and have the compiler check exhaustiveness either way.

## 7. What happens internally

**[JVMS]** `(Cast)` compiles to the `checkcast` instruction: it throws `ClassCastException` if the object is not an instance of the target type, and passes `null` through unchanged. `instanceof` compiles to the `instanceof` instruction, which pushes 0 for `null` — which is why `null instanceof T` is always `false` and never throws.

**[HotSpot]** A type check against a class is a small fixed-cost operation (a comparison against the class pointer, or a depth-indexed lookup in a super-type cache); a check against an interface is more expensive because a class may implement many. When the check's outcome is stable, C2 folds it away entirely after inlining.

**[JLS]** Pattern matching for `instanceof` is a compiler feature: `o instanceof String s` desugars to an `instanceof` plus a `checkcast` plus a store, with **flow scoping** — `s` is in scope exactly where the pattern provably matched, which is why `if (!(o instanceof String s)) return;` leaves `s` usable for the rest of the method.

**[JLS, Java 21]** Pattern switches compile to an `invokedynamic` call to `SwitchBootstraps.typeSwitch`, which returns an index for the matching case — so a long chain of type tests becomes one bootstrap-managed dispatch rather than n sequential `instanceof`s.

**Arrays are covariant [JLS]:** `Dog[]` *is a* `Animal[]`, which is unsound and therefore checked at run time by `aastore`:

```java
Object[] objects = new String[1];
objects[0] = 42;              // compiles; throws ArrayStoreException at run time
```

Generics fixed this by being **invariant** (`List<Dog>` is not a `List<Animal>`) — Phase 6.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>static_cast</code> for compile-time-known conversions, <code>dynamic_cast</code> for checked downcasts (returns <code>nullptr</code> for pointers, throws for references, and requires RTTI), <code>reinterpret_cast</code> to lie to the compiler. Multiple inheritance is supported, with <code>virtual</code> bases for the diamond.</p>
<p><strong>Java:</strong> one cast syntax, always checked, never reinterpreting bits. There is no <code>reinterpret_cast</code> equivalent and no way to defeat the type system with a cast — the verifier and <code>checkcast</code> make it impossible.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Checked downcast | `dynamic_cast<D*>(p)` → `nullptr` on failure | `(D) p` → `ClassCastException`; test first with `instanceof` |
| "Try to cast" idiom | `if (auto* d = dynamic_cast<D*>(p))` | `if (p instanceof D d)` — the direct analogue, since Java 16 |
| RTTI cost | Opt-in; often disabled in embedded builds | Always on; type info is in the object header |
| Reinterpreting memory | `reinterpret_cast`, unions | Impossible |
| Multiple inheritance | Supported; `virtual` base classes for diamonds | Classes: forbidden. Interfaces: unlimited |
| Mixins | Multiple inheritance or CRTP | Interfaces with default methods, or composition |
| Array variance | Arrays are not covariant; `D**` ≠ `B**` | Arrays **are** covariant, checked by `ArrayStoreException` |
| Static polymorphism | Templates, CRTP, zero-cost | Generics are erased; no CRTP equivalent with the same power |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Expecting a failed cast to yield null.</strong> Java throws. The <code>dynamic_cast</code>-to-null idiom becomes <code>instanceof</code> pattern matching.</p>
<p><strong>Reaching for multiple inheritance to share implementation.</strong> Use an interface with default methods for a small contract, or — usually better — composition and delegation.</p>
<p><strong>Assuming arrays behave like <code>std::vector</code> with respect to variance.</strong> Java arrays are covariant, which means a store can fail at run time. Prefer <code>List&lt;T&gt;</code>.</p>
<p><strong>Using casts to work around a design problem.</strong> In C++ a cast is sometimes a legitimate performance tool; in Java a downcast in business logic is nearly always a modelling failure.</p>
</div>

## 9. The diamond problem, concretely

```text
      A            C++: does D have one A or two?
     / \                Answer: two, unless B and C inherit A virtually.
    B   C               Ambiguity must be resolved by the programmer at every use.
     \ /
      D
```

Java's position, stated precisely:

- **State**: impossible. A class has exactly one superclass, so every field is inherited through exactly one path.
- **Type**: unlimited. Implementing `Runnable`, `Comparable<T>` and `Serializable` creates no ambiguity, because there is nothing to inherit but signatures.
- **Behaviour** (since Java 8 default methods): possible, so the JLS defines resolution rules — the most specific interface wins; an unresolvable tie is a **compile error**, and you fix it with `Interface.super.method()`. Class implementations always beat interface defaults ("class wins"). Details in Phase 4.

The design lesson worth carrying: Java did not "solve" the diamond problem, it **removed the case that made it hard** (inherited state) and made the remaining case a compile error rather than a silent choice.

## 10. Inheritance vs composition

```java
// BAD: the textbook broken inheritance
public class CountingSet<E> extends HashSet<E> {
    private int addCount;
    @Override public boolean add(E e) { addCount++; return super.add(e); }
    @Override public boolean addAll(Collection<? extends E> c) {
        addCount += c.size();
        return super.addAll(c);        // HashSet.addAll calls add() internally → double counting
    }
    public int addCount() { return addCount; }
}
```

`addAll` of three elements reports six. The bug is not in the code — it is in the *assumption* that `HashSet` will not call its own public methods. Inheritance couples you to a superclass's undocumented self-use.

```java
// GOOD: composition + delegation
public class CountingSet<E> implements Set<E> {
    private final Set<E> delegate;
    private int addCount;
    public CountingSet(Set<E> delegate) { this.delegate = delegate; }

    @Override public boolean add(E e) { addCount++; return delegate.add(e); }
    @Override public boolean addAll(Collection<? extends E> c) {
        addCount += c.size(); return delegate.addAll(c);
    }
    public int addCount() { return addCount; }
    // ... remaining Set methods delegate to `delegate`
}
```

The rule of thumb: **inherit only when the subclass genuinely *is a* substitutable kind of the superclass, and the superclass was designed and documented for extension.** Otherwise compose. If you do design for inheritance, document your self-use, or make the class `final`.

## 11. Interview questions

**Beginner**
1. What is upcasting and why does it never fail?
2. What exception does a bad downcast throw, and how do you avoid it?
3. What does `null instanceof String` return?

**Intermediate**
4. Why does `(String) someAnimal` fail to compile while `(Cat) someAnimal` compiles?
5. What is pattern matching for `instanceof` and what is flow scoping?
6. Why are Java arrays covariant, and what runtime exception does that cause?
7. Why does Java allow multiple interface inheritance but not multiple class inheritance?

**Advanced**
8. What bytecode do `instanceof` and a cast produce, and how do they treat `null`?
9. Explain the diamond problem and Java's exact position on state, type and behaviour.
10. What does a Java 21 pattern switch compile to?
11. Give the `CountingSet` example and explain why inheritance broke it.

**Senior / deep dive**
12. Sealed interfaces plus pattern switches versus virtual methods — when do you choose each? (Name the expression problem.)
13. How would you design a class to be safely extensible? List the obligations.
14. Why is `List<Dog>` not a `List<Animal>` while `Dog[]` is an `Animal[]`? Which design is right and why did Java ship both?
15. You inherit a codebase with a five-level hierarchy and downcasts in the service layer. What is your refactoring plan?

## 12. Follow-up questions to expect

- *After Q5:* "Explain the scope of `s` in `if (!(o instanceof String s)) return;`" → the rest of the method.
- *After Q7:* "Default methods added behaviour to interfaces — did that recreate the diamond?" → conflict rules, `Interface.super`, class-wins.
- *After Q11:* "How would you fix it without composition?" → you cannot, reliably; the alternative is documenting self-use, which is what `AbstractSet` does.
- *After Q14:* "So how do you write a method that accepts a list of any animal?" → `List<? extends Animal>` (Phase 6).

## 13. Coding exercise

1. Model a small expression language: `sealed interface Expr permits Num, Add, Mul`, with records for each.
2. Write `eval(Expr)` twice — once as a virtual method on each record, once as an exhaustive pattern switch. Delete a `permits` entry and observe which version fails to compile.
3. Add a new operation `prettyPrint`. Note which design made it easy.
4. Add a new type `Neg`. Note which design made *that* easy.
5. Write one paragraph on the trade-off you just demonstrated.

## 14. Output prediction

**A**
```java
public class Main {
    public static void main(String[] args) {
        Object[] objects = new String[2];
        objects[0] = "ok";
        System.out.println(objects[0]);
        objects[1] = 42;
        System.out.println("done");
    }
}
```

**B**
```java
public class Main {
    public static void main(String[] args) {
        Object o = null;
        System.out.println(o instanceof String);
        String s = (String) o;
        System.out.println("s=" + s);
        System.out.println(((String) o).length());
    }
}
```

**C**
```java
class A {}
class B extends A {}
public class Main {
    public static void main(String[] args) {
        A a = new A();
        B b = (B) a;
        System.out.println(b);
    }
}
```

**D**
```java
public class Main {
    static String f(Object o) {
        if (!(o instanceof Integer i)) return "not int";
        return "int " + (i + 1);
    }
    public static void main(String[] args) {
        System.out.println(f(41));
        System.out.println(f("41"));
    }
}
```

## 15. Mastery check

1. Why is upcasting free and downcasting checked? What instruction implements each?
2. When does `javac` reject a cast outright rather than deferring to run time?
3. What does `instanceof` do with `null`, and why is that useful?
4. Explain flow scoping with an example where the binding survives an early `return`.
5. State Java's rule on multiple inheritance in three parts — state, type, behaviour — and justify each.
6. Why is C++'s virtual inheritance not needed in Java?
7. Give a case where array covariance produces a runtime error that generics would have caught at compile time.
8. Explain the `CountingSet` bug without using the word "bug" — describe the coupling.
9. Name three obligations of a class that is designed for inheritance.
10. Describe the expression problem and how sealed types plus pattern matching change the trade-off.
