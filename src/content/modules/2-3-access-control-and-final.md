---
title: "Access Control, final, and the Rules of Extension"
phase: 2
order: 3
minutes: 30
summary: "The four access levels and what protected really means, plus final on classes, methods, fields and locals — and what each one is actually protecting."
tags: ["access-modifiers", "protected", "final", "encapsulation", "packages"]
---

## 1. Concept

Java has **four** access levels, ordered from most to least restrictive:

| Modifier | Same class | Same package | Subclass, other package | Anywhere |
| --- | --- | --- | --- | --- |
| `private` | ✅ | ❌ | ❌ | ❌ |
| *(none)* — package-private | ✅ | ✅ | ❌ | ❌ |
| `protected` | ✅ | ✅ | ✅ *(restricted — see §7)* | ❌ |
| `public` | ✅ | ✅ | ✅ | ✅ |

Note the default: **no modifier means package-private**, not public and not private. That default is deliberate — a class with no modifier is invisible outside its package, which makes packages the real unit of encapsulation in Java.

`final` means "cannot be reassigned or redefined", and it means something different on each target:

- **`final` class** — cannot be extended (`String`, `Integer`, all records, all enums with no constant bodies).
- **`final` method** — cannot be overridden. Still virtual in principle, but the JIT knows there is one implementation.
- **`final` field** — assigned exactly once, in the declaration or in every constructor. Gains the JMM freeze guarantee (Phase 25).
- **`final` local / parameter** — cannot be reassigned; required conceptually for lambda capture (Java 8 relaxed this to *effectively final*).

## 2. Why Java has it

Access control in Java exists to make an API's **contract** enforceable rather than advisory: what is not `public` cannot be depended on, so it can change. `protected` exists to expose an extension seam to subclasses without exposing it to callers. `final` exists so that an author can say "this decision is not yours to change" — which is a security property for `String`, an invariant-protection property for immutable classes, and a maintenance property for template methods.

The module system (Java 9+) added a second, stronger layer: even a `public` class is inaccessible from another module unless its package is `exports`ed. "Public" now means "public *within what the module exports*".

## 3. Mental model

> Access control answers **"who may name this?"**; `final` answers **"who may change this?"**. Neither is a runtime security boundary on its own — but combined with the verifier and the module system they are the only reason a library can promise anything at all.

## 4. Syntax

```java
package com.acme.billing;

public final class Invoice {              // public API, closed to extension
    private final long id;                // internal state
    final String traceId;                 // package-private: visible to tests in the same package
    protected static final int MAX = 100; // pointless here — a final class has no subclasses

    public Invoice(long id, String traceId) { this.id = id; this.traceId = traceId; }
    public long id() { return id; }
    private void internalRecalculate() { }
}
```

## 5. Minimal example — the protected surprise

```java
package a;
public class Parent {
    protected void helper() { }
}
```

```java
package b;
import a.Parent;
public class Child extends Parent {
    void test(Parent p, Child c, Object o) {
        this.helper();      // OK   — through its own type
        c.helper();         // OK   — through Child (or a subtype of Child)
        p.helper();         // COMPILE ERROR — through Parent, from another package
    }
}
```

**[JLS §6.6.2]** From a different package, a subclass may access a `protected` member **only through a reference whose type is that subclass (or a subclass of it)**. Access is granted to *your own inheritance chain*, not to every instance of the superclass. This rule is why `Object.clone()` is so awkward to call, and it is a reliable senior-level question.

## 6. Realistic example

```java
// com.acme.orders — the exported API surface is deliberately tiny
public interface OrderService {                 // public: the contract
    OrderId place(NewOrder order);
}

final class DefaultOrderService implements OrderService {   // package-private: the implementation
    private final OrderRepository repo;                     // private: collaborators
    DefaultOrderService(OrderRepository repo) { this.repo = repo; }
    @Override public OrderId place(NewOrder order) { /* ... */ }
}

public final class OrderServices {              // public factory — the only way in
    private OrderServices() {}
    public static OrderService create(OrderRepository repo) {
        return new DefaultOrderService(repo);
    }
}
```

Callers can only name `OrderService` and `OrderServices`. The implementation class can be renamed, split, or replaced without breaking anyone — that is the entire point of the default access level.

## 7. What happens internally

**[JVMS]** Access modifiers become flags in the class file (`ACC_PUBLIC`, `ACC_PRIVATE`, `ACC_PROTECTED`, `ACC_FINAL`, …) and are enforced by the **JVM during resolution**, not merely by `javac`. An illegal access that somehow reaches the runtime throws `IllegalAccessError`. Package-private is encoded as *no* access flag, and package identity for access checks is the pair *(package name, defining class loader)* — two classes in the same-named package loaded by different loaders are **not** package mates.

**[JVMS, Java 11+]** `private` members of nested classes used to require synthetic accessor methods (`access$000`), because at the class-file level an outer and inner class are separate classes. Since Java 11 the **nest-based access control** attributes (`NestHost`/`NestMembers`) let the JVM allow direct private access within a nest, and those synthetic bridges are gone.

**[JVMS]** `ACC_FINAL` on a class makes any attempt to load a subclass fail verification with `VerifyError`. On a method, it makes an override fail at class load. So `final` is not merely a `javac` rule — you cannot bypass it with hand-written bytecode.

**[HotSpot]** `final` fields of *other* objects can be trusted for constant folding in limited, implementation-defined circumstances (`static final` fields of initialised classes are treated as true constants; instance finals are trusted for some cases and not others, and reflection can write them, which is why the JVM has to be careful). Do not build a mental model where `final` implies a machine-level guarantee of immutability — build one where it implies a *language* guarantee about assignment plus a *JMM* guarantee about safe publication.

**[Java 9+ modules]** `exports` controls which packages are readable at all; `opens` controls deep reflection. This is why `setAccessible(true)` on JDK internals now fails with `InaccessibleObjectException` instead of quietly working.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> access is per-class with <code>public</code>/<code>protected</code>/<code>private</code> sections, plus <code>friend</code>; inheritance itself has an access level (<code>class D : private B</code>); there is no package concept, and namespaces do not restrict access.</p>
<p><strong>Java:</strong> access is per-member, always written on the member; there is no <code>friend</code>, no private/protected inheritance (all inheritance is public), and an extra level — package-private — that has no C++ equivalent.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Default for a class member | `private` (class), `public` (struct) | package-private |
| Granting selective access | `friend` | Same package, or a nested class, or a module boundary |
| Private inheritance | `class D : private B` | Does not exist — use composition |
| `protected` from another unit | Any instance of the base | Only via your own subtype (§5) |
| Sealing a hierarchy | `final` (C++11) | `final`, or `sealed` + `permits` (Java 17) |
| `const` method | Yes | No equivalent at all |
| Enforcement | Compile time only; casts defeat it | Compile time **and** JVM resolution; reflection can defeat it unless the module is closed |
| Header/impl split | `.h` / `.cpp` | Interface + package-private implementation class |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Assuming no modifier means private.</strong> It means package-private, which is broader than <code>private</code> and narrower than <code>public</code>. Forgetting this quietly widens your API.</p>
<p><strong>Looking for <code>friend</code>.</strong> There is none. The Java answers are: same package, nested classes (nestmates), or a sealed hierarchy.</p>
<p><strong>Reading <code>final</code> as <code>const</code>.</strong> Repeating this from Module 1.3 because it is the most persistent error: <code>final</code> constrains the variable, not the object, and there is no <code>const</code>-correctness anywhere in Java.</p>
<p><strong>Expecting <code>protected</code> to work like C++'s.</strong> The cross-package restriction in §5 has no C++ analogue.</p>
</div>

## 9. Edge cases

```java
// 1. A top-level class may only be public or package-private
private class Nope {}        // compile error at top level; fine as a nested class

// 2. A public class must live in a file of the same name
// 3. final field assigned in a constructor — every constructor must assign it exactly once
class A {
    final int x;
    A()      { x = 1; }
    A(int v) { x = v; }      // OK
    A(boolean b) { }         // compile error: x might not have been initialized
}

// 4. final does not mean immutable
final int[] arr = {1, 2, 3};
arr[0] = 99;                 // perfectly legal

// 5. final can be defeated by reflection (unless the module is closed and, for records/hidden
//    classes, not even then) — which is why "final == constant" is a JIT question, not a law
// 6. an interface's fields are implicitly public static final; its methods implicitly public
interface I { int MAX = 10; void m(); }    // MAX is a constant, m() is public abstract

// 7. effectively final: no 'final' keyword needed for capture
int total = 0;
Runnable r = () -> System.out.println(total);   // fine — never reassigned
// total = 1;                                    // adding this breaks the lambda above
```

## 10. Common mistakes

- Making everything `public` "so tests can reach it" — put the test in the same package instead.
- Making fields `protected` as a matter of course: that publishes your representation to every future subclass and freezes it forever.
- Assuming `final` gives immutability or thread safety on its own.
- Forgetting that a `public` class in a non-exported module package is unreachable — a common Java-9-migration confusion.
- Using `protected` in a `final` class (harmless but meaningless — a signal that the author was not thinking).
- Relying on `setAccessible(true)` in library code; it breaks on module upgrades.

## 11. Interview questions

**Beginner**
1. Name the four access levels and what each permits.
2. What is the default access level? Where is it useful?
3. What does `final` mean on a class, a method, a field?

**Intermediate**
4. Why can an override widen access but not narrow it?
5. Give a case where `protected` access is refused from a subclass.
6. Is `final` the same as immutable? Demonstrate.
7. What is "effectively final" and which feature required it?

**Advanced**
8. How are access modifiers enforced — compiler, JVM, or both? What error appears at runtime?
9. What are nestmates and what problem did they solve?
10. How did the module system change the meaning of `public`?
11. Why is `String` `final`, and what would break if it were not?

**Senior / deep dive**
12. Design a library where the API is stable but every implementation class is replaceable. Which access levels do what?
13. When would you choose `sealed` over `final`, and what does `permits` buy you that package-private did not?
14. Can `final` fields be modified? Under what circumstances, and what does that do to the JMM guarantee?
15. Two classes with the same package name are loaded by different class loaders. Are they package mates? What breaks?

## 12. Follow-up questions to expect

- *After Q4:* "Which principle is that?" → Liskov substitution. Then: "does the same reasoning apply to `throws` and return types?"
- *After Q5:* "Why did the JLS authors add that restriction?" → so a subclass cannot use `protected` access to poke at *other* branches of the hierarchy.
- *After Q11:* "Give a concrete attack." → a mutable `String` passed to a security check, mutated afterwards; plus class-loading and file-path checks.
- *After Q13:* "How do sealed types interact with pattern-matching switch exhaustiveness?" (Phase 14.)

## 13. Coding exercise

Create packages `shapes` and `client`:

1. In `shapes`: a `public abstract class Shape` with a `protected double scale`, a `public abstract double area()`, a package-private `void debugDump()`, and a `final double scaledArea()`.
2. In `client`: a `public class Circle extends Shape`.

Now attempt, and explain each result:
- calling `debugDump()` from `Circle`;
- reading `otherShape.scale` from inside `Circle` where `otherShape` is declared `Shape`;
- reading `otherCircle.scale` where `otherCircle` is declared `Circle`;
- overriding `scaledArea()`;
- overriding `area()` with package-private access.

Then rewrite `Shape` so that no subclass can see `scale` at all, and say what you gave up.

## 14. Output prediction — compile or not, and why

**A**
```java
package p1;
public class A { protected int v = 1; }
```
```java
package p2;
import p1.A;
public class B extends A {
    void f(A a, B b) {
        System.out.println(this.v);
        System.out.println(b.v);
        System.out.println(a.v);
    }
}
```

**B**
```java
class A { public void m() {} }
class B extends A { @Override protected void m() {} }
```

**C**
```java
public class Main {
    public static void main(String[] args) {
        final StringBuilder sb = new StringBuilder("a");
        sb.append("b");
        System.out.println(sb);
        final int[] counter = {0};
        Runnable r = () -> counter[0]++;
        r.run(); r.run();
        System.out.println(counter[0]);
    }
}
```

**D**
```java
interface I { int X = compute(); static int compute() { return 5; } }
public class Main implements I {
    public static void main(String[] args) {
        System.out.println(X);
        // X = 6;
    }
}
```

## 15. Mastery check

1. Fill in the four-level access table from memory, including the subclass-in-another-package column.
2. State the `protected` cross-package rule precisely and give an example of code it rejects.
3. Why is package-private the default, and what design does that encourage?
4. What does `final` mean on each of: class, method, instance field, static field, local, parameter?
5. Give two things `final` does *not* give you that a C++ programmer might expect.
6. Are access rules enforced by the JVM? What is the runtime error and when would you see it?
7. What is a nest, and what did the JVM do before nestmates existed?
8. How does the module system change what `public` means, and which reflection call started failing?
9. Why can an override not reduce visibility? Name the principle and the concrete breakage.
10. When would you reach for `sealed` instead of `final` or package-private?
