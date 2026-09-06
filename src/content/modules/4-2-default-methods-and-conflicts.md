---
title: "Default Methods, Conflicts, and Functional Interfaces"
phase: 4
order: 2
minutes: 30
summary: "How Java resolves two inherited implementations of the same method, the Interface.super escape hatch, and what makes an interface functional."
tags: ["default-methods", "diamond", "functional-interface", "interface-evolution"]
---

## 1. Concept

Since Java 8 an interface may carry implementations. That reintroduces the possibility of inheriting **two** implementations of one signature, so the JLS defines a resolution order. Three rules, applied in order:

1. **Class wins.** A method inherited from a superclass always beats any interface default.
2. **Most specific interface wins.** If one candidate interface extends the other, the sub-interface's default wins.
3. **Otherwise it is a compile error** — the class must override the method. It may delegate explicitly with `Interface.super.method()`.

Note the shape of the answer: Java never picks arbitrarily. Ambiguity is either resolved by a rule the reader can apply, or refused.

## 2. Why

The rules follow from what each construct means. A class is the *implementation*; interfaces are *contracts with fallbacks*, so class beats interface. A sub-interface refines its parent, so it beats it. Two unrelated interfaces have no ordering — inventing one (declaration order, alphabetical) would make behaviour depend on something meaningless, so the compiler asks the author instead.

## 3. Mental model

> Defaults are **fallbacks, not inheritance**. Real implementations outrank them; more specific fallbacks outrank vaguer ones; equally-ranked fallbacks are a question only you can answer.

## 4. The rules in code

```java
interface Logger      { default String prefix() { return "LOG"; } }
interface AuditLogger extends Logger { default String prefix() { return "AUDIT"; } }

class A implements Logger, AuditLogger { }
// prefix() -> "AUDIT"   (rule 2: most specific interface)

interface Alpha { default String tag() { return "alpha"; } }
interface Beta  { default String tag() { return "beta"; } }

class B implements Alpha, Beta { }          // COMPILE ERROR: inherits unrelated defaults for tag()

class C implements Alpha, Beta {
    @Override public String tag() {
        return Alpha.super.tag() + "+" + Beta.super.tag();   // explicit disambiguation
    }
}

class Base { public String tag() { return "base"; } }
class D extends Base implements Alpha { }
// tag() -> "base"       (rule 1: class wins, even though Base knows nothing about Alpha)
```

`Interface.super.method()` is only legal for a **direct** superinterface of the enclosing class, and only when that interface actually declares a default for the method.

## 5. Static and private interface methods

```java
public interface Validator<T> {
    boolean test(T value);

    static <T> Validator<T> not(Validator<T> v) { return x -> !v.test(x); }   // static: NOT inherited
    default Validator<T> and(Validator<T> other) { return x -> test(x) && check(other, x); }
    private boolean check(Validator<T> other, T x) { return other.test(x); }  // Java 9+ helper
}
```

- `static` interface methods are **not inherited**: `SomeImpl.not(...)` does not compile; you must write `Validator.not(...)`. This deliberately avoids the static-hiding confusion of classes (Module 2.2).
- `private` interface methods exist so defaults can share code without exposing it in the API.

## 6. Functional interfaces

A **functional interface** has exactly one abstract method (SAM), so it can be the target type of a lambda or method reference. `default` and `static` methods do not count, and neither do public `Object` methods (`equals`, `hashCode`, `toString`).

```java
@FunctionalInterface                       // optional, but it makes the constraint a compile error
public interface Transformer<T, R> {
    R apply(T input);                      // the single abstract method
    default <V> Transformer<T, V> then(Transformer<R, V> next) {
        return x -> next.apply(apply(x));  // combinators live as defaults — this is the pattern
    }
}

Transformer<String, Integer> len = String::length;
Transformer<String, String> pipeline = len.then(n -> "len=" + n);
```

That combinator style is exactly how `Comparator`, `Predicate` and `Function` are built in the JDK: one abstract method plus a family of `default` combinators. Phase 11 covers how the lambda itself is compiled.

## 7. Interface evolution — the real use case

```java
public interface Repository<T> {
    Optional<T> findById(long id);

    // Added in v2.0. Existing implementers keep compiling AND keep running.
    default List<T> findAllById(Collection<Long> ids) {
        return ids.stream().map(this::findById).flatMap(Optional::stream).toList();
    }
}
```

**[JVMS]** This is **binary compatible**: already-compiled implementers do not need recompilation, because the default lives in the interface's class file and is found through the interface hierarchy at resolution time. Adding an *abstract* method instead would compile-break every implementer and throw `AbstractMethodError` for pre-compiled ones.

Guidance for library authors: a default should be a *correct but possibly suboptimal* implementation expressed only in terms of other methods of the same interface. If a correct default is impossible, the honest options are a new sub-interface, or a default that throws `UnsupportedOperationException` — a deliberate trade of compile-time breakage for runtime breakage.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> inheriting the same member from two bases is ambiguous at the point of use, and you disambiguate per call with <code>Base::f()</code> — or restructure with virtual inheritance. The ambiguity is a <em>use-site</em> error.</p>
<p><strong>Java:</strong> the ambiguity is a <em>declaration-site</em> error: the class does not compile at all until it overrides. Java also has an ordering rule (class &gt; specific interface &gt; general interface) that C++ has no equivalent of, because C++ bases are not ranked.</p>
<p><strong>Key difference:</strong> no state is ever inherited twice in Java, so there is no <code>virtual</code> base machinery and no object-layout consequence — only method selection.</p>
</div>

## 9. Edge cases

```java
interface X { default void m() {} }
interface Y extends X { void m(); }              // legal: re-abstracting a default
class Z implements Y { public void m() {} }      // now mandatory

interface P { default String s() { return "P"; } }
interface Q extends P { }
interface R extends P { }
class S implements Q, R { }                      // OK — both inherit the SAME default from P

interface T { String toString(); }                // legal (redeclaring an Object method as abstract)
                                                  // but T is still functional? No — Object methods
                                                  // don't count, so T has ZERO abstract methods.

@FunctionalInterface interface U { void a(); void b(); }   // compile error: two abstract methods

interface V { default void m() { System.out.println(this.getClass()); } }  // 'this' is the impl object
```

The "same default inherited by two paths" case (`Q`/`R` above) is a genuine diamond that Java accepts silently — because there is exactly one implementation, so nothing is ambiguous.

## 10. Common mistakes

- Assuming a default method can access instance state — it cannot; it may only call other interface methods.
- Trying `Interface.super.m()` for a non-direct superinterface, or for an abstract method.
- Expecting `static` interface methods to be inherited.
- Adding a `default` that is subtly wrong for some implementers, and never noticing because nobody overrides it.
- Declaring `@FunctionalInterface` then adding a second abstract method later, breaking every lambda call site.
- Using defaults as a mixin mechanism for shared state — the state has to live somewhere, and casting inside a default to reach it is a design failure.

## 11. Interview questions

**Beginner** — 1. What is a default method? 2. Why were they added? 3. What is a functional interface?

**Intermediate** — 4. Two interfaces define the same default. What happens? 5. What is `Interface.super.m()` and when is it legal? 6. Do implementers inherit `static` interface methods? 7. Does `@FunctionalInterface` change behaviour?

**Advanced** — 8. State the three resolution rules in order and justify each. 9. Why can't an interface default `equals`? 10. What is binary compatibility, and why is adding a default method binary compatible? 11. Can a sub-interface turn a default back into an abstract method?

**Senior** — 12. Compare adding a default method, a new sub-interface, and a default that throws — for a widely deployed public API. 13. Do default methods reintroduce the diamond problem? Defend your answer precisely. 14. How do `Comparator`'s combinators use defaults, and why is that a better design than a utility class?

## 12. Follow-ups

- *After Q4:* "Now make one interface extend the other and re-answer."
- *After Q8:* "Why is 'class wins' the right priority rather than 'most specific wins overall'?"
- *After Q13:* "What part of the classical diamond problem is genuinely absent?" → inherited state and object layout.

## 13. Exercise

1. Define `interface Shape { double area(); default String describe() { ... } }` and `interface Named { default String describe() { ... } }`.
2. Write a class implementing both and make it compile — twice: once by choosing one, once by combining both with `Interface.super`.
3. Add `interface NamedShape extends Shape, Named` that resolves the conflict once for all implementers.
4. Convert `Shape` into a functional interface and write three lambdas for it. Then add a second abstract method and observe every call site that breaks.

## 14. Output prediction

**A**
```java
interface A { default String f() { return "A"; } }
interface B extends A { default String f() { return "B"; } }
interface C extends A { }
class D implements B, C { }
public class Main { public static void main(String[] x) { System.out.println(new D().f()); } }
```

**B**
```java
class Base { public String f() { return "Base"; } }
interface I { default String f() { return "I"; } }
class Sub extends Base implements I { }
public class Main { public static void main(String[] x) { System.out.println(new Sub().f()); } }
```

**C**
```java
interface I { static String s() { return "static"; } default String d() { return "default"; } }
class K implements I { }
public class Main {
    public static void main(String[] args) {
        System.out.println(new K().d());
        // System.out.println(K.s());
        System.out.println(I.s());
    }
}
```

## 15. Mastery check

1. State the three conflict-resolution rules in order, with a justification for each.
2. When exactly is `Interface.super.m()` legal?
3. Why are `static` interface methods not inherited?
4. What is a functional interface, and which methods do not count toward the SAM count?
5. Why can a default method not access instance fields?
6. Explain binary compatibility using default methods as the example, and name the error the alternative causes.
7. Show a diamond that Java accepts silently and one it rejects, and explain the difference.
8. What can a sub-interface do to force implementers to override an inherited default?
9. Compare Java's declaration-site ambiguity error with C++'s use-site ambiguity error.
10. Give two situations where adding a default method is the wrong answer, with what you would do instead.
