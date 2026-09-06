---
title: "Generics: type parameters, bounds, and inference"
phase: 6
order: 1
minutes: 35
summary: "Generic classes, methods and bounds — and the first hard truth for a C++ programmer: Java generics are a compile-time checking device, not a code-generation device."
tags: ["generics", "type-parameters", "bounds", "inference", "templates"]
---

## 1. Concept

A generic type parameterises a class or method over a type:

```java
public class Box<T> {                      // T is a type parameter
    private T value;
    public void set(T v) { value = v; }
    public T get() { return value; }
}
Box<String> b = new Box<>();               // String is a type argument
```

The compiler checks every use against the type argument and inserts the casts. At run time **the type argument is gone** — `Box<String>` and `Box<Integer>` are the same class, `Box`. That is **erasure**, covered fully in Module 6.3; everything in this module is shaped by it.

Java generics apply to **classes, interfaces, methods and constructors**, and type arguments must be **reference types** — `List<int>` does not exist.

## 2. Why Java has it

Before Java 5, collections stored `Object` and every read needed a cast:

```java
List names = new ArrayList();
names.add("alice");
String s = (String) names.get(0);          // unchecked by the compiler; ClassCastException at run time
names.add(42);                             // nothing stops this
```

Generics move that failure from run time to compile time, and remove the casts from your source (the compiler still emits them). The design constraint was **migration compatibility**: existing code and existing class files had to keep working, and a `List` from 2003 had to interoperate with a `List<String>` from 2005. That constraint is why Java chose erasure — and why Java generics cannot do several things C++ templates do.

## 3. Mental model

> A type parameter is a **promise to the compiler**, not a runtime entity. `javac` type-checks your code as if `T` were real, then erases it to `Object` (or the bound) and inserts casts. One class file serves every instantiation.

## 4. Generic methods

```java
public static <T> List<T> repeat(T item, int times) {          // <T> before the return type
    var out = new ArrayList<T>();
    for (int i = 0; i < times; i++) out.add(item);
    return out;
}

var strings = repeat("x", 3);              // T inferred as String
var explicit = Main.<Integer>repeat(1, 3); // explicit type argument, rarely needed
```

A generic method's parameter is independent of the class's. Use a generic method whenever the relationship between parameters and return type is what you are expressing:

```java
public static <T> T firstNonNull(T a, T b) { return a != null ? a : b; }
public static <K, V> Map<V, K> invert(Map<K, V> map) { ... }
```

## 5. Bounded type parameters

```java
// Upper bound: T is at least a Number, so Number's methods are available
public static <T extends Number> double sum(List<T> nums) {
    double total = 0;
    for (T n : nums) total += n.doubleValue();     // legal because of the bound
    return total;
}

// Multiple bounds: class first (at most one), then interfaces
public static <T extends Comparable<T> & Serializable> T max(List<T> list) { ... }

// Recursive (f-bounded) generic — the standard idiom for "comparable with itself"
public static <T extends Comparable<? super T>> T max(Collection<T> c) { ... }
```

That last signature is `Collections.max`'s, and being able to read it is a mid-level interview marker: *T must be comparable to T or to some supertype of T* — which allows `max(List<Integer>)` where `Integer implements Comparable<Integer>`, and also a `Dog` list where only `Animal implements Comparable<Animal>`.

**Note there is no lower bound on a type parameter.** `<T super Foo>` does not exist; lower bounds appear only on wildcards (Module 6.2).

## 6. Realistic example

```java
public interface Repository<T, ID> {
    Optional<T> findById(ID id);
    List<T> findAll();
    <S extends T> S save(S entity);            // method-level parameter: returns the exact subtype
    void deleteById(ID id);
}

public abstract class AbstractRepository<T extends Entity<ID>, ID> implements Repository<T, ID> {
    private final Map<ID, T> store = new ConcurrentHashMap<>();

    @Override public Optional<T> findById(ID id) { return Optional.ofNullable(store.get(id)); }
    @Override public <S extends T> S save(S entity) { store.put(entity.id(), entity); return entity; }
}
```

`<S extends T> S save(S entity)` is worth studying: it preserves the caller's exact type, so `save(new Order(...))` returns an `Order`, not a `T`. That trick — a method type parameter bounded by the class type parameter — appears throughout Spring Data and Guava.

## 7. Type inference

```java
Map<String, List<Integer>> m = new HashMap<>();       // diamond (Java 7): infer from the target
var list = new ArrayList<String>();                   // var (Java 10): infer from the initialiser
var bad = new ArrayList<>();                          // infers ArrayList<Object> — almost never wanted

List<String> empty = Collections.emptyList();         // inferred from the assignment target
process(Collections.emptyList());                     // inferred from the parameter type (Java 8+)
```

**[JLS §18]** Java's inference solves constraints from the arguments *and* from the target type (poly expressions), which is why `Collections.emptyList()` works in both positions. It does not infer type parameters from the *body* of a method, and it never infers a type argument you did not have enough information for — you get `Object` or a compile error rather than a guess.

## 8. C++ comparison — the important one

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ templates:</strong> a code-generation mechanism. Each instantiation compiles a fresh copy with the actual type substituted, so <code>vector&lt;int&gt;</code> stores real <code>int</code>s, <code>T</code> can be a primitive, <code>sizeof(T)</code> works, <code>new T()</code> works, and specialisations can differ arbitrarily. Type checking happens at instantiation (pre-concepts, with famously bad errors).</p>
<p><strong>Java generics:</strong> a type-checking mechanism. One class file for all instantiations, type arguments erased, only reference types allowed. Type checking happens once, at the <em>declaration</em>, so errors are local and readable — but nothing about <code>T</code> is available at run time.</p>
</div>

| Capability | C++ templates | Java generics |
| --- | --- | --- |
| `T` = primitive | ✅ `vector<int>` | ❌ — `List<Integer>`, with boxing |
| Code per instantiation | ✅ separate, optimisable | ❌ one erased class |
| `new T()` | ✅ | ❌ — need a `Supplier<T>` or `Class<T>` |
| `T.staticMethod()` | ✅ | ❌ |
| `sizeof(T)`, `T::value_type` | ✅ | ❌ |
| Specialisation (`template<> class X<bool>`) | ✅ | ❌ — no specialisation of any kind |
| Non-type parameters (`array<T, 5>`) | ✅ | ❌ |
| Constraints | concepts (C++20) / SFINAE | bounds (`extends`) — simpler, checked at declaration |
| Where errors appear | At instantiation, often deep | At the generic declaration, once |
| Runtime type info | Full — each instantiation is a real type | None — `List<String>.class` does not exist |
| Binary size | Grows per instantiation | Constant |
| Variance | Templates are invariant; you write overloads | Invariant, with wildcards for variance (Module 6.2) |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Expecting <code>List&lt;int&gt;</code>.</strong> Primitives cannot be type arguments; you pay for boxing (Module 1.2) or use <code>int[]</code>/<code>IntStream</code>.</p>
<p><strong>Expecting duck typing.</strong> A template can call <code>t.foo()</code> if the instantiating type happens to have <code>foo</code>. Java requires a bound: <code>&lt;T extends HasFoo&gt;</code>. Java's model is nominal, not structural.</p>
<p><strong>Expecting per-type performance.</strong> There is no monomorphisation, so no per-type inlining or layout benefit. Valhalla aims to change this; it has not yet.</p>
<p><strong>Expecting <code>new T()</code> or <code>T.class</code> to work.</strong> They cannot — Module 6.3 explains why and gives the workarounds.</p>
</div>

## 9. Edge cases

```java
class Box<T> {
    // static T shared;                     // ERROR: static context has no type parameter
    // T create() { return new T(); }       // ERROR: cannot instantiate T
    // void f(T t) { if (t instanceof T) {} }   // ERROR: illegal generic type for instanceof
    T[] array;                              // declaration is fine
    // T[] make() { return new T[10]; }     // ERROR: generic array creation
}

class Pair<A, B> { }
Pair<String, String> p;                     // both parameters may be the same type

interface I<T> { void f(T t); }
class C implements I<String> { public void f(String s) {} }   // fine
// class D implements I<String>, I<Integer> {}                // ERROR: same interface twice

<T> void f(List<T> a, List<T> b) {}
f(List.of("a"), List.of(1));                // compiles! T inferred as Object (or a lub type)
```

That last one surprises people: inference will find a common supertype rather than failing, so a signature that *looks* like it enforces "both lists have the same element type" often does not.

## 10. Common mistakes

- Using raw types (`List` instead of `List<String>`) — this silently disables generic checking for the *entire* expression.
- `var x = new ArrayList<>();` → `ArrayList<Object>`.
- Trying to overload on erased signatures: `void f(List<String>)` and `void f(List<Integer>)` do not compile — same erasure.
- Using a type parameter in a `static` field or method of the class.
- Over-generifying: a type parameter used exactly once in a signature is usually a wildcard in disguise.
- Ignoring "unchecked" warnings instead of understanding them.

## 11. Interview questions

**Beginner** — 1. Why were generics added? 2. What is a type parameter vs a type argument? 3. Why can't you write `List<int>`?

**Intermediate** — 4. What is a bounded type parameter? Give a use. 5. Difference between a generic class and a generic method. 6. Why can't a static field use the class's type parameter? 7. What is a raw type and what does using one cost you?

**Advanced** — 8. Read `<T extends Comparable<? super T>>` aloud and justify each part. 9. Why can't you overload on `List<String>` vs `List<Integer>`? 10. How does `<S extends T> S save(S)` differ from `T save(T)`? 11. Where does Java infer type arguments from?

**Senior** — 12. Compare Java generics with C++ templates on five axes and say which problems each design solves. 13. Why did Java choose erasure? What would reification have cost? 14. Design a type-safe heterogeneous container.

## 12. Follow-ups

- *After Q3:* "What is the performance consequence, and what does Valhalla propose?"
- *After Q7:* "Does `List` behave like `List<Object>`?" → no — it disables checking, which is worse.
- *After Q14:* → `Map<Class<T>, T>` with `Class.cast`, the `Typesafe Heterogeneous Container` pattern.

## 13. Exercise

Implement `Result<T, E>` — a value that is either a success or a failure:
1. `static <T, E> Result<T, E> ok(T value)` and `err(E error)`;
2. `<U> Result<U, E> map(Function<? super T, ? extends U> f)`;
3. `T orElse(T fallback)` and `<X extends Throwable> T orElseThrow(Function<E, X> f) throws X`;
4. Make it a sealed interface with two records.

Then explain why `orElseThrow`'s signature needs its own type parameter and what `throws X` buys you.

## 14. Output prediction

```java
public class Main {
    static <T> void f(List<T> a, List<T> b) { System.out.println("generic"); }
    public static void main(String[] args) {
        List raw = new ArrayList<String>();
        raw.add(42);
        List<String> typed = raw;
        System.out.println(typed.size());
        String s = typed.get(0);
        System.out.println(s);
    }
}
```

## 15. Mastery check

1. What problem did generics solve, and what constraint shaped their design?
2. Why must type arguments be reference types?
3. Write a generic method signature that returns the caller's exact subtype.
4. Explain `<T extends Comparable<? super T>>` clause by clause.
5. Why is a static member forbidden from using the class's type parameter?
6. Give three things a C++ template can do that Java generics cannot, with the workaround for each.
7. Why does `void f(List<String>)` clash with `void f(List<Integer>)`?
8. What is a raw type and what exactly does it disable?
9. Where does the compiler get type arguments when you write `Collections.emptyList()` as an argument?
10. What would reified generics have cost Java in 2004?
