---
title: "Abstract Classes vs Interfaces: choosing an extension mechanism"
phase: 4
order: 1
minutes: 30
summary: "What each can express, what each costs, and the architectural rule for choosing — plus why 'interface for contract, abstract class for shared code' is only half the answer."
tags: ["abstract", "interface", "design", "contracts"]
---

## 1. Concept

An **abstract class** is a class that cannot be instantiated and may declare `abstract` methods with no body. It can have state, constructors, any access level, and `final` methods.

An **interface** is a pure type declaration that a class may *implement*. Since Java 8 it may also carry `default` and `static` methods, and since Java 9 `private` helper methods — but it can never have instance state.

| Capability | Abstract class | Interface |
| --- | --- | --- |
| Instance fields (state) | ✅ | ❌ (only `public static final` constants) |
| Constructors | ✅ | ❌ |
| Method bodies | ✅ | ✅ since Java 8 (`default`, `static`, `private`) |
| `final` methods (block overriding) | ✅ | ❌ — a `default` method is always overridable |
| Non-public members | ✅ | Only `private` helpers; everything else is implicitly `public` |
| How many can a class have? | **One** | **Many** |
| Can it be retrofitted onto existing types? | Only by editing the hierarchy | ✅ — anyone can implement it |

## 2. Why Java has both

Interfaces exist because Java forbids multiple class inheritance (Module 2.4): they give multiple *typing* without multiple *state*. Abstract classes exist because some hierarchies genuinely share state and construction logic — `AbstractList` holds `modCount`; a `Reader` holds a lock.

The Java 8 addition of default methods came from a concrete crisis: adding `stream()` to `Collection` would have broken every existing implementation. Default methods let an interface grow without breaking implementers — **interface evolution** is the reason they exist, not "interfaces with code".

## 3. Mental model

> An interface says **what a thing can do**; an abstract class says **what a thing partly is**. You can be many things (interfaces) but you can only *be* one thing (superclass). Prefer interfaces for the type, and use an abstract class — if at all — as a convenience for implementers.

## 4. The skeletal-implementation pattern

The JDK's own answer to "interface or abstract class" is **both**:

```java
public interface List<E> extends Collection<E> { ... }        // the type + contract
public abstract class AbstractList<E> implements List<E> {    // the shared machinery
    protected transient int modCount = 0;
    public abstract E get(int index);                         // the primitives a subclass must supply
    public int indexOf(Object o) { /* implemented via get()+size() */ }
}
public class ArrayList<E> extends AbstractList<E> { ... }
```

Callers depend on `List`. Implementers may extend `AbstractList` to get 80% for free, or implement `List` directly if they already have a superclass. You get the multiple-inheritance freedom of interfaces *and* the code reuse of classes.

Write your own the same way:

```java
public interface EventHandler {
    void handle(Event e);
    default boolean supports(Event e) { return true; }
}

public abstract class RetryingEventHandler implements EventHandler {
    private final int maxAttempts;
    protected RetryingEventHandler(int maxAttempts) { this.maxAttempts = maxAttempts; }

    @Override public final void handle(Event e) {           // final: the retry loop is not negotiable
        for (int attempt = 1; ; attempt++) {
            try { doHandle(e); return; }
            catch (TransientException ex) { if (attempt == maxAttempts) throw ex; }
        }
    }
    protected abstract void doHandle(Event e);
}
```

## 5. Choosing — the decision procedure

1. **Is it a capability that unrelated types should be able to claim?** → interface (`Comparable`, `AutoCloseable`, `Serializable`).
2. **Does it need instance state or a constructor invariant?** → abstract class.
3. **Do you need to forbid overriding part of the behaviour?** → abstract class with `final` methods (template method). Interfaces cannot do this.
4. **Will third parties implement it, and will you need to add methods later?** → interface, and plan `default` methods carefully.
5. **Both?** → interface for the type, optional abstract skeletal class for implementers. This is the default answer for library design.

A useful negative rule: **do not use an abstract class merely to share three utility methods.** That spends the single-inheritance slot for the rest of the type's life. Use a static utility class or composition.

## 6. What happens internally

**[JVMS]** An abstract class is a normal class with `ACC_ABSTRACT`; `new` on it fails verification. An interface has `ACC_INTERFACE | ACC_ABSTRACT`; its fields are implicitly `ACC_PUBLIC ACC_STATIC ACC_FINAL` and its abstract methods `ACC_PUBLIC ACC_ABSTRACT`.

Calls through a class type use `invokevirtual` (vtable slot); calls through an interface type use `invokeinterface`, which must search the receiver's **itable** because interface methods cannot be assigned consistent vtable indices across unrelated classes. **[HotSpot]** the JIT usually erases this difference with inline caches, so "interfaces are slower" is a micro-detail, not a design input — with one exception worth knowing: a **megamorphic interface call site** (many receiver types) is genuinely more expensive than a megamorphic virtual one.

**[JLS]** A `default` method lives in the interface class file as a normal method with a body; implementing classes do **not** get a copy. Resolution happens at run time via the interface hierarchy, which is why adding a default method to an interface is binary-compatible with already-compiled implementers.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> an "interface" is an abstract base class with only pure virtual functions, inherited alongside others via multiple inheritance. There is no language distinction — an ABC can also have state, a constructor, and non-virtual functions, and you can inherit several of them (with the diamond consequences).</p>
<p><strong>Java:</strong> the distinction is a language rule. Interfaces cannot hold state, which is exactly what makes "implement as many as you like" safe.</p>
</div>

| C++ | Java |
| --- | --- |
| ABC with pure virtuals | `interface` |
| ABC with state + pure virtuals | `abstract class` |
| Multiple inheritance of ABCs | Multiple `implements` |
| Virtual inheritance for diamonds | Unnecessary — no inherited state |
| Non-virtual public method calling virtual protected ones (NVI idiom) | `final` public method calling `protected abstract` ones — the same template-method idiom |
| Mixins via CRTP or MI | `default` methods, or composition |
| `= 0` | `abstract` (implicit in an interface) |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Putting state in an interface.</strong> An interface field is a <code>public static final</code> constant shared by everyone, not per-instance state. This surprises people who read it as a member declaration.</p>
<p><strong>Expecting <code>default</code> to behave like a non-virtual base implementation.</strong> A default method is fully overridable and always loses to a class implementation (Module 4.2).</p>
<p><strong>Using an abstract class as the public type.</strong> It burns the implementer's one inheritance slot; publish the interface instead.</p>
</div>

## 8. Edge cases

```java
interface I {
    int X = 10;                    // public static final, NOT instance state
    void required();               // public abstract
    default void optional() { helper(); }
    static I noop() { return () -> {}; }   // static methods are NOT inherited by implementers
    private void helper() { }              // Java 9+
}

abstract class A implements I { }          // legal: an abstract class need not implement anything
// class B implements I { }                // error: required() not implemented

interface Marker { }                       // marker interface: type-level metadata (Serializable)

abstract class C { abstract void m(); C() { /* legal but m() would dispatch to a subclass */ } }

interface J { default String toString() { return "x"; } }   // ERROR: cannot default an Object method
```

That last rule is worth knowing: an interface may not provide a `default` for `equals`, `hashCode` or `toString`, because the class implementation from `Object` would always win anyway — the JLS forbids the misleading declaration outright.

## 9. Common mistakes

- Declaring an abstract class as the public API type.
- Adding a method to a published interface without a `default` (breaks every implementer at compile time — and existing compiled code throws `AbstractMethodError`).
- Using an interface constant as configuration ("constant interface antipattern") — put constants on a final class or an enum.
- Deep abstract-class hierarchies where each level adds one protected hook.
- Making a `default` method that touches state the interface cannot see, via casts.

## 10. Interview questions

**Beginner** — 1. Difference between an abstract class and an interface? 2. Can an abstract class have a constructor? Why? 3. Can an interface have fields?

**Intermediate** — 4. Why can a class implement many interfaces but extend one class? 5. Why were default methods added? 6. Can an interface declare `final` methods? Why not? 7. What is a marker interface and what replaced them?

**Advanced** — 8. What is a skeletal implementation and why does the JDK use both mechanisms? 9. What happens at run time if you add a method to an interface and don't recompile implementers? 10. Why may an interface not provide a default for `toString()`? 11. `invokevirtual` vs `invokeinterface` — what is actually different?

**Senior** — 12. You must add a method to a widely used public interface. Walk through your options and their compatibility consequences. 13. When is a default method the wrong tool? 14. Design an extension point that must remain source- and binary-compatible for five years.

## 11. Follow-ups

- *After Q5:* "Was `Collection.stream()` the only motive?" → also `Iterable.forEach`, `Comparator` combinators.
- *After Q9:* "Which error, exactly?" → `AbstractMethodError` at the call site, not at load time.
- *After Q12:* "What about adding a method with a default that throws `UnsupportedOperationException`?" → compiles everywhere, fails at run time; discuss when that trade is acceptable.

## 12. Exercise

Design a `Cache<K,V>` extension point:
1. an interface with `get`, `put`, `evictAll`, and a `default getOrCompute`;
2. an abstract skeletal class supplying statistics counters and requiring only `doGet`/`doPut`;
3. two implementations — one extending the skeleton, one implementing the interface directly because it already extends something else.

Then add a `size()` method to the interface *without breaking* either implementation, and write down which compatibility guarantee you relied on.

## 13. Output prediction

```java
interface A { default String name() { return "A"; } }
interface B { default String name() { return "B"; } }
class C implements A, B { }                                  // ?

abstract class D { D() { System.out.println(describe()); } abstract String describe(); }
class E extends D { private final String s = "E"; String describe() { return s; } }
// new E();                                                  // ?

interface F { int X = compute(); static int compute() { System.out.println("init F"); return 1; } }
class G implements F { }
// System.out.println(new G() instanceof F);                 // does "init F" print?
```

## 14. Mastery check

1. Give five capabilities an abstract class has that an interface does not.
2. Why can interfaces have no instance state, and what does that buy the language?
3. What problem did `default` methods solve, and what problem did they create?
4. Explain the skeletal-implementation pattern with a JDK example.
5. Why can't an interface declare a `final` method or default an `Object` method?
6. What error appears at run time when an implementer was compiled before a new interface method?
7. Give the five-step decision procedure for choosing between the two.
8. Map `interface`, `abstract class` and the template-method idiom onto their C++ equivalents.
9. When is `invokeinterface` genuinely more expensive than `invokevirtual`?
10. Why is a public abstract class a worse API type than an interface?
