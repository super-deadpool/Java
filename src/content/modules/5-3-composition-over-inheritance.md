---
title: "Composition, Delegation, and Designing for Change"
phase: 5
order: 3
minutes: 25
summary: "Why 'favor composition over inheritance' is a statement about coupling, how to apply it mechanically, and what a class must promise if it does allow subclassing."
tags: ["composition", "delegation", "design", "inheritance", "coupling"]
---

## 1. Concept

**Inheritance** (`extends`) creates an *is-a* relationship and couples a subclass to the superclass's implementation — including its **self-use**: which of its own public methods it calls internally, something almost never documented and free to change in any release.

**Composition** holds another object as a field and forwards to it. The coupling is to the other type's *public contract* only.

The guidance — from *Effective Java* item 18 — is not "never inherit". It is: **inherit only within a package you control, or from a class explicitly designed and documented for extension.** Otherwise compose.

## 2. Why

Module 2.4 §10 showed the mechanism: `CountingSet extends HashSet` double-counts because `HashSet.addAll` calls `add`. Nothing in `HashSet`'s contract said it would, and nothing says it will keep doing so. Inheritance made a private implementation detail of the superclass into part of the subclass's correctness.

Two more failure modes: a superclass adding a method in a later version can silently override or clash with yours (a subclass's `add(E)` suddenly overriding a new superclass method with different semantics), and inheritance is a permanent commitment — the single `extends` slot is spent.

## 3. Mental model

> Inheritance says "I am whatever they are, including whatever they do internally." Composition says "I use them." **Extend a contract, not an implementation.**

## 4. The mechanical transformation

```java
// Inheritance version — fragile
public class InstrumentedSet<E> extends HashSet<E> { ... }
```

```java
// Composition version, in two pieces: a reusable forwarding class + the wrapper
public class ForwardingSet<E> implements Set<E> {
    private final Set<E> delegate;
    public ForwardingSet(Set<E> delegate) { this.delegate = Objects.requireNonNull(delegate); }

    @Override public boolean add(E e)                            { return delegate.add(e); }
    @Override public boolean addAll(Collection<? extends E> c)   { return delegate.addAll(c); }
    @Override public boolean remove(Object o)                    { return delegate.remove(o); }
    @Override public int size()                                  { return delegate.size(); }
    @Override public Iterator<E> iterator()                      { return delegate.iterator(); }
    // ... the rest of Set, all one-liners
}

public class InstrumentedSet<E> extends ForwardingSet<E> {
    private int addCount;
    public InstrumentedSet(Set<E> s) { super(s); }
    @Override public boolean add(E e)                          { addCount++; return super.add(e); }
    @Override public boolean addAll(Collection<? extends E> c) { addCount += c.size(); return super.addAll(c); }
    public int addCount() { return addCount; }
}
```

The counting is now correct regardless of how the delegate implements `addAll`, and `InstrumentedSet` works with **any** `Set` — `TreeSet`, `LinkedHashSet`, a concurrent one — which the inheritance version could not do. This wrapper shape is the **Decorator pattern** (Phase 27), and the JDK uses it everywhere: `Collections.unmodifiableList`, `BufferedInputStream`, `InputStreamReader`.

The one real cost: writing the forwarding methods (an IDE generates them), and the "self-use" problem inverted — a wrapped object passed to something that registers callbacks on `this` will call back to the *delegate*, not your wrapper (the SELF problem). Rare, but know it exists.

## 5. Delegation with interfaces and lambdas

```java
// Strategy by composition — no hierarchy at all
public final class PriceCalculator {
    private final DiscountPolicy discount;          // an interface; often a lambda
    private final TaxPolicy tax;

    public PriceCalculator(DiscountPolicy discount, TaxPolicy tax) { ... }
    public long price(Order o) { return tax.apply(discount.apply(o.subtotal())); }
}

var calc = new PriceCalculator(subtotal -> subtotal * 90 / 100, subtotal -> subtotal * 120 / 100);
```

Compare with an inheritance design: `AbstractCalculator` → `DiscountedCalculator` → `DiscountedTaxedCalculator`. Every combination needs a class; with composition, combinations are constructor arguments. That combinatorial explosion is the clearest practical argument for composition.

## 6. If you do design for inheritance

An extensible class owes its subclasses a documented contract:

1. **Document self-use.** "This implementation of `addAll` calls `add`." (The JDK's `@implSpec` javadoc tag exists for exactly this.)
2. **Provide well-chosen `protected` hooks** — and no more; each one is API you must support forever.
3. **Never call an overridable method from a constructor**, `clone()`, or `readObject()` (Module 1.3 §6).
4. **Test by writing subclasses** before publishing.
5. **Otherwise, make the class `final`** — or `sealed` with an explicit `permits` list, which lets you allow extension by *named* types only (Java 17+).

If you cannot commit to items 1–4, item 5 is the honest choice.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> private inheritance (<code>class D : private B</code>) expresses "implemented in terms of" without exposing the base type — the language distinguishes implementation reuse from subtyping. Multiple inheritance also makes mixins natural.</p>
<p><strong>Java:</strong> all inheritance is public inheritance, so <em>every</em> use of <code>extends</code> is a subtyping claim. There is no way to say "reuse the code but don't be a Set" — which is exactly why composition carries more weight in Java than in C++.</p>
</div>

| Intent | C++ | Java |
| --- | --- | --- |
| "Implemented in terms of" | private inheritance | composition + delegation |
| "Is a" | public inheritance | `extends` / `implements` |
| Mixin | multiple inheritance, CRTP | interface + default methods, or composition |
| Static polymorphism, zero cost | templates / CRTP | none — generics are erased |
| Sealing a hierarchy | `final` | `final` or `sealed ... permits` |

## 8. Common mistakes

- `extends` to reuse three methods.
- Extending a class you do not own and cannot pin the version of.
- Deep hierarchies (4+ levels) where behaviour is assembled by overriding across levels.
- `protected` fields — permanent representation exposure.
- Believing an abstract base class is "safe" to extend just because it is abstract.
- Composition with a leaky wrapper that exposes the delegate via a getter.

## 9. Interview questions

**Beginner** — 1. Difference between is-a and has-a? 2. What is delegation? 3. Give an example of composition in the JDK.

**Intermediate** — 4. Why does `CountingSet extends HashSet` break? 5. What is the fragile base class problem? 6. Name three costs of inheritance that composition avoids.

**Advanced** — 7. What must a class document to be safely extensible? 8. What is the SELF problem in wrapper classes? 9. Why is composition more important in Java than in C++? 10. How do `sealed` types change the trade-off?

**Senior** — 11. You inherit a 6-level hierarchy. Describe your refactoring strategy and how you'd keep it safe. 12. When is inheritance clearly the right answer? 13. How does Spring's proxying interact with `final` methods and inheritance?

## 10. Follow-ups

- *After Q4:* "Would documenting the self-use fix it?" → yes, and that is what `AbstractSet` does — which is why extending the *abstract* class is safer than the concrete one.
- *After Q6:* "Which cost is unique to Java?" → the single `extends` slot, and no private inheritance.
- *After Q13:* "Why does a `final` method break a CGLIB proxy?" → it cannot be overridden, so the advice never runs.

## 11. Exercise

1. Write `ForwardingList<E>` and then `TimingList<E>` that logs the duration of every mutating call.
2. Now implement the same thing by extending `ArrayList` and find a method whose timing is double-counted.
3. Convert a hierarchy `Report → PdfReport → EncryptedPdfReport → WatermarkedEncryptedPdfReport` into composition with decorators; show that the four combinations become two independent decorators.
4. Write down which design you would ship if the class were public API, and why.

## 12. Output prediction

```java
class MySet<E> extends HashSet<E> {
    int adds;
    @Override public boolean add(E e) { adds++; return super.add(e); }
    @Override public boolean addAll(Collection<? extends E> c) { adds += c.size(); return super.addAll(c); }
}
public class Main {
    public static void main(String[] args) {
        MySet<String> s = new MySet<>();
        s.addAll(List.of("a", "b", "c"));
        System.out.println(s.adds + " " + s.size());
    }
}
```

## 13. Mastery check

1. State the composition-over-inheritance rule in its full, conditional form.
2. Explain the fragile base class problem with a concrete mechanism.
3. What is self-use and why does it matter to subclasses?
4. Write the transformation from an inheriting wrapper to a forwarding wrapper in five steps.
5. What is the SELF problem, and when does it actually bite?
6. List the five obligations of a class designed for inheritance.
7. Why is there no Java equivalent of C++ private inheritance, and what replaces it?
8. When does inheritance beat composition? Give two genuine cases.
9. How do `sealed` hierarchies change what "designed for extension" means?
10. Why does the combinatorial explosion argument favour composition — give a four-way example.
