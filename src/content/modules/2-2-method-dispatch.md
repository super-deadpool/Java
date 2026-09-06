---
title: "Method Dispatch: overriding, overloading, hiding, and why fields aren't polymorphic"
phase: 2
order: 2
minutes: 45
summary: "The single most tested area in Java interviews: what the compiler decides, what the JVM decides, and why Parent p = new Child() behaves differently for methods, fields and statics."
tags: ["inheritance", "dispatch", "overriding", "overloading", "polymorphism"]
---

## 1. Concept

Java resolves a call in **two stages**, and almost every trick question lives in the gap between them:

1. **Compile time** — using the *static type* of the receiver and the *static types* of the arguments, `javac` picks a **method signature** (name + parameter types) and writes it into the class file. This is where **overload resolution** happens.
2. **Run time** — using the *actual class* of the receiver object, the JVM picks the **implementation** of that signature. This is where **overriding** takes effect.

Everything else follows from that one split:

| Member | Bound using | So with `Parent p = new Child()` |
| --- | --- | --- |
| Instance method | runtime class | `Child`'s override runs |
| Field | **static type** | `Parent`'s field is read |
| `static` method | **static type** | `Parent`'s method runs |
| `private` method | static type (not inherited) | `Parent`'s own |
| Overload choice | **static types of arguments** | chosen from `Parent`'s declared methods |

**Overriding** = same signature, subclass, runtime dispatch. **Overloading** = same name, different parameter list, compile-time choice. **Hiding** = a `static` method or a field with the same name in a subclass — no dispatch at all, just shadowing.

## 2. Why Java has it

Virtual dispatch by default is what makes subtype polymorphism the default programming style: you code against `List`, and the runtime picks `ArrayList`'s implementation. Java made every instance method virtual (unlike C++'s opt-in `virtual`) because the JIT can devirtualise the common cases anyway (Module 1.1 §7) — the cost the language pays is recovered by the runtime.

Fields and statics are *not* dispatched because they are not part of the polymorphic contract: a field is storage belonging to a specific class in the hierarchy, and both classes' fields genuinely exist in the object simultaneously.

## 3. Mental model

> The compiler chooses **what to call** from the type of the variable. The JVM chooses **whose code runs** from the type of the object. Fields and statics never reach stage two.

## 4. Syntax

```java
class Parent {
    String name = "parent";
    void speak()          { System.out.println("parent speaks"); }
    static void id()      { System.out.println("Parent.id"); }
    void greet(Object o)  { System.out.println("Parent.greet(Object)"); }
}

class Child extends Parent {
    String name = "child";                       // HIDES Parent.name (both fields exist)
    @Override void speak() { System.out.println("child speaks"); }
    static void id()      { System.out.println("Child.id"); }   // HIDES Parent.id
    void greet(String s)  { System.out.println("Child.greet(String)"); }  // OVERLOAD, not override
}
```

`@Override` is optional but you should treat it as mandatory: it turns a silent overload mistake into a compile error.

## 5. Minimal example — the canonical matrix

```java
Parent p = new Child();

p.speak();            // "child speaks"     → virtual dispatch, runtime type wins
System.out.println(p.name);  // "parent"    → field access, static type wins
p.id();               // "Parent.id"        → static method, static type wins
p.greet("hello");     // "Parent.greet(Object)"  → Child.greet(String) is invisible to type Parent

Child c = (Child) p;
System.out.println(c.name);  // "child"
c.greet("hello");     // "Child.greet(String)"
System.out.println(((Parent) c).name);   // "parent"  — a cast changes the static type only
```

Read that last line carefully: casting a reference cannot change the object, but it *does* change which field the compiler picks. Both `name` fields exist in the one object at the same time.

## 6. Realistic example

```java
public abstract class PaymentProcessor {
    public final PaymentResult process(Payment payment) {   // template method — final on purpose
        validate(payment);
        var result = charge(payment);
        audit(payment, result);
        return result;
    }

    protected void validate(Payment p) {                    // overridable hook with a default
        if (p.amountMinor() <= 0) throw new IllegalArgumentException("non-positive amount");
    }

    protected abstract PaymentResult charge(Payment p);     // must be overridden

    private void audit(Payment p, PaymentResult r) { /* ... */ }   // private: never overridden
}

public final class StripeProcessor extends PaymentProcessor {
    @Override protected PaymentResult charge(Payment p) { /* ... */ }
    @Override protected void validate(Payment p) {
        super.validate(p);                                  // extend, don't replace
        if (p.currency().equals("XXX")) throw new IllegalArgumentException("bad currency");
    }
}
```

The three modifiers here are a design vocabulary: `final` on `process` fixes the algorithm, `abstract` on `charge` forces a decision, `private` on `audit` makes it un-overridable so its behaviour cannot be subverted by a subclass.

## 7. What happens internally

**[JVMS]** There are five call instructions, and knowing which one `javac` emits *is* the answer to most dispatch questions:

| Instruction | Used for | Dispatch |
| --- | --- | --- |
| `invokestatic` | `static` methods | none — target fixed at link time |
| `invokespecial` | constructors, `super.m()`, `private` methods | none — exact target |
| `invokevirtual` | ordinary instance methods on a class type | virtual, on the runtime class |
| `invokeinterface` | instance methods on an interface type | virtual, via the interface table |
| `invokedynamic` | lambdas, string concat, pattern switch | resolved once by a bootstrap method |

Field access is `getfield` / `putfield` (and `getstatic` / `putstatic`), each naming a specific class in its constant-pool reference — that reference is computed from the **static type**, which is the entire explanation of field hiding.

**[HotSpot]** Each class has a **vtable**: an array of method entries where an override occupies the *same slot* as the method it overrides. `invokevirtual` becomes "load the class pointer from the header, index a fixed slot". Interfaces need an extra step (**itables**) because a class implements many interfaces and slots cannot line up — which is why `invokeinterface` is nominally slower, though the JIT usually erases the difference with inline caches. And once C2 has a profile, a monomorphic call site becomes a guarded direct call with the body inlined.

**Bridge methods [JLS/JVMS]:** covariant return types and generic overrides produce synthetic *bridge* methods so the vtable slot still matches the erased signature:

```java
class Animal { Animal reproduce() { return new Animal(); } }
class Cat extends Animal { @Override Cat reproduce() { return new Cat(); } }
// javac emits in Cat: Cat reproduce()  AND  synthetic bridge Animal reproduce() { return reproduce(); }
```

**Overload resolution [JLS §15.12]** proceeds in three phases, stopping at the first that finds an applicable method: **(1)** no boxing, no varargs; **(2)** boxing/unboxing allowed; **(3)** varargs allowed. Within a phase the *most specific* applicable method wins. This is why `f(1)` prefers `f(long)` over `f(Integer)` over `f(int...)`.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> methods are non-virtual by default; you opt in with <code>virtual</code>. A base-class method with the same name <em>hides</em> all base overloads unless you write <code>using Base::f;</code>. Calls through a value are statically bound; only calls through pointers/references dispatch.</p>
<p><strong>Java:</strong> every instance method is virtual unless it is <code>static</code>, <code>private</code>, or <code>final</code>. There are no values-of-class-type, so every call through a reference dispatches. Overloads from the superclass are <strong>always visible</strong> in the subclass — Java has no name hiding for methods, only for fields and statics.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Default binding | Static; `virtual` opts in | Virtual; `final`/`private`/`static` opt out |
| Overload set across inheritance | Base overloads hidden by any same-name derived method | Base overloads remain candidates |
| Covariant returns | Supported (raw pointers/refs) | Supported, implemented via bridge methods |
| Calling base version | `Base::f()` | `super.f()` — one level only, no `Grandparent.f()` |
| Devirtualisation | Only when the type is statically known (or LTO/PGO) | Routinely, at runtime, from a profile |
| Field with the same name | Shadowing; resolved by static type | Identical behaviour — both fields exist |
| Static method "override" | Not possible | Not possible either; it is hiding |
| Pure virtual | `= 0` | `abstract` |
| Multiple dispatch | Neither language has it — both are single-dispatch on the receiver | Same; visitor pattern is the workaround |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Assuming a non-<code>virtual</code>-looking method is statically bound.</strong> In Java it dispatches unless you explicitly stopped it.</p>
<p><strong>Expecting overloads to be hidden.</strong> Adding <code>void f(String)</code> to a subclass does not hide <code>f(Object)</code>; you now have two overloads and the compiler picks by static argument type.</p>
<p><strong>Believing <code>final</code> makes calls faster.</strong> C2 already devirtualises via class-hierarchy analysis. <code>final</code> here is about design intent and API stability.</p>
<p><strong>Expecting fields to dispatch because methods do.</strong> They never have, in either language.</p>
</div>

## 9. Edge cases

```java
// 1. null receiver, static method — no NPE, because nothing is dereferenced
Parent p = null;
p.id();                    // prints "Parent.id"  (compiles to invokestatic)
p.speak();                 // NullPointerException

// 2. covariant return with generics
class Box<T> { T get() { return null; } }
class StringBox extends Box<String> { @Override String get() { return "s"; } }
// bridge: Object get() { return get(); }  — visible in javap, invisible in source

// 3. overriding narrows nothing, widens access only
class A { protected Object f() throws IOException { return null; } }
class B extends A {
    @Override public String f() { return ""; }        // legal: wider access, covariant return,
}                                                     // fewer checked exceptions

// 4. you cannot reduce visibility
class C extends A { @Override private Object f() { return null; } }  // compile error

// 5. static method hiding requires the same staticness
class D { static void m() {} }
class E extends D { void m() {} }   // compile error: instance method cannot override static

// 6. super only goes one level
class X { void m() {} }
class Y extends X { void m() { super.m(); } }
class Z extends Y { void m() { /* X.super.m() is illegal for classes */ } }

// 7. private methods are not inherited, so this is NOT an override
class F { private void g() { System.out.println("F"); } void call() { g(); } }
class G extends F { public void g() { System.out.println("G"); } }
new G().call();            // prints "F"
```

Number 7 is the crisp answer to "why does `private` prevent overriding?": a private method is not part of the subclass's namespace at all, so `javac` emits `invokespecial` to `F.g` and there is nothing to dispatch.

## 10. Common mistakes

- Omitting `@Override` and silently creating an overload — `equals(MyType)` instead of `equals(Object)` is the classic, and it breaks every collection (Phase 3).
- Expecting `p.field` to be polymorphic; hiding fields at all.
- Calling an overridable method from a constructor (Module 1.3 §6).
- Relying on `static` methods being "overridden" in a subclass.
- Overloading on types related by subtyping or by boxing, which makes call sites depend on declared types in ways readers cannot predict.
- Widening `throws` in an override — the compiler rejects it, and the reason (Liskov) is worth being able to state.

## 11. Interview questions

**Beginner**
1. Overriding vs overloading — define both and give one example of each.
2. With `Parent p = new Child()`, which `speak()` runs and why?
3. What does `@Override` do?

**Intermediate**
4. Why is `p.name` the parent's field while `p.speak()` is the child's method?
5. Why are static methods not overridden? What is the correct term?
6. Which rules constrain an override's return type, access modifier and `throws` clause?
7. `p.id()` where `p` is `null` — what happens?

**Advanced**
8. Name the five invoke instructions and what each is used for.
9. What is a bridge method and what creates one?
10. Explain overload resolution's three phases, and predict `f(1)` given `f(long)`, `f(Integer)`, `f(int...)`.
11. Why does `private` prevent overriding, in bytecode terms?

**Senior / deep dive**
12. How does HotSpot make virtual dispatch cheap, and when does that break down?
13. Your subclass adds `void handle(String)` while the base has `void handle(Object)`. A caller holding the base type passes a `String`. What runs, and why is this a design smell?
14. How would you design a class so that its behaviour cannot be changed by subclassing, without making it `final`?
15. Explain the interaction between generics erasure, overriding, and bridge methods in `Comparable<T>`.

## 12. Follow-up questions to expect

- *After Q4:* "So how many `name` fields does the object have?" → two; then "how do you access the parent's from inside `Child`?" → `super.name` or `((Parent) this).name`.
- *After Q6:* "Why is *narrowing* access forbidden but widening allowed?" → Liskov substitution: a `Parent`-typed caller must keep working.
- *After Q8:* "Which one does a default interface method use?" → `invokeinterface` (Phase 4).
- *After Q10:* "Now add `f(Object)` and re-answer." Then "what if the argument is `null`?"
- *After Q12:* "What is a megamorphic call site and how do you spot one?" → 3+ receiver types at one site; inline-cache misses; visible in JIT logs.

## 13. Coding exercise

Build a three-level hierarchy `Shape → Polygon → Square` where each level declares:
- an instance method `describe()`,
- a `static` method `kind()`,
- a field `sides`,
- an overloaded `area(int)` / `area(double)`.

Then write a `main` that, using variables typed `Shape`, `Polygon` and `Square` all pointing at one `Square` instance, prints all four members through each variable — twelve lines of output. Predict every line first, then run it and explain each mismatch in terms of §1's table.

Finally: make `describe()` `final` in `Polygon` and see what breaks; make it `private` and explain what changed.

## 14. Output prediction

**A**
```java
class A { void f(Object o) { System.out.println("A.f(Object)"); } }
class B extends A {
    void f(String s) { System.out.println("B.f(String)"); }
    @Override void f(Object o) { System.out.println("B.f(Object)"); }
}
public class Main {
    public static void main(String[] args) {
        A a = new B();
        a.f("x");
        a.f((Object) "x");
        new B().f("x");
    }
}
```

**B**
```java
class P { int x = 10; int get() { return x; } }
class C extends P { int x = 20; int get() { return x; } }
public class Main {
    public static void main(String[] args) {
        P p = new C();
        System.out.println(p.x + " " + p.get() + " " + ((C) p).x + " " + ((P) new C()).get());
    }
}
```

**C**
```java
class Base {
    static String who() { return "Base"; }
    String name()       { return who(); }
}
class Sub extends Base {
    static String who() { return "Sub"; }
}
public class Main {
    public static void main(String[] args) {
        System.out.println(new Sub().name());
    }
}
```

**D**
```java
public class Main {
    static void f(long x)     { System.out.println("long"); }
    static void f(Integer x)  { System.out.println("Integer"); }
    static void f(Object x)   { System.out.println("Object"); }
    static void f(int... x)   { System.out.println("varargs"); }
    public static void main(String[] args) {
        f(1);
        f(Integer.valueOf(1));
        f(1L);
        f(null);
    }
}
```

**E**
```java
class Animal { Animal make() { System.out.println("Animal.make"); return this; } }
class Dog extends Animal { @Override Dog make() { System.out.println("Dog.make"); return this; } }
public class Main {
    public static void main(String[] args) {
        Animal a = new Dog();
        Animal r = a.make();
        System.out.println(r.getClass().getSimpleName());
    }
}
```

## 15. Mastery check

1. State precisely what is decided at compile time and what at run time for `receiver.m(arg)`.
2. Why are fields not polymorphic? Answer in terms of `getfield` and the constant pool.
3. Why is a `static` method call on a `null` reference not an NPE?
4. Give the five invoke instructions with one trigger each.
5. What is a bridge method, why does it exist, and name two language features that generate one.
6. List every legal way an override may differ from the method it overrides.
7. Explain the three phases of overload resolution and why `f(1)` with `f(long)`/`f(Integer)` present picks `f(long)`.
8. Why does `private` prevent overriding while `final` merely forbids it?
9. Contrast Java's "all methods virtual" with C++'s opt-in `virtual`, including what each costs and what recovers the cost.
10. A call site sees five different receiver types in production. Describe what HotSpot does and how it shows up in a profile.
