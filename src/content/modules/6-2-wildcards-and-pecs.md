---
title: "Wildcards, Variance, and PECS"
phase: 6
order: 2
minutes: 35
summary: "Why List<Dog> is not a List<Animal>, what ? extends and ? super actually permit, and the rule that tells you which to use."
tags: ["generics", "wildcards", "variance", "pecs", "covariance"]
---

## 1. Concept

Generics are **invariant**: `List<Dog>` is not a subtype of `List<Animal>`, even though `Dog` is a subtype of `Animal`.

```java
List<Dog> dogs = new ArrayList<>();
List<Animal> animals = dogs;      // does not compile — and it must not
animals.add(new Cat());           // would put a Cat in a List<Dog>
Dog d = dogs.get(0);              // ClassCastException at run time
```

Invariance is the *correct* default. But it is often too strict, so Java provides **wildcards** to opt into variance at the use site:

- `List<? extends Animal>` — a list of *some unknown subtype* of Animal. **Covariant. You can read, not write.**
- `List<? super Dog>` — a list of *some unknown supertype* of Dog. **Contravariant. You can write, not read (except as `Object`).**
- `List<?>` — a list of some unknown type. Read as `Object`, write nothing (except `null`).

## 2. Why the read/write asymmetry

Reason from what the compiler knows.

`List<? extends Animal>` might actually be a `List<Dog>` or a `List<Cat>`. **Reading** is safe: whatever comes out is at least an `Animal`. **Writing** is not: the compiler cannot prove your `Cat` belongs in whatever list this really is, so it rejects every `add` except `null`.

`List<? super Dog>` might be a `List<Dog>`, `List<Animal>` or `List<Object>`. **Writing a `Dog`** is safe: a `Dog` fits in all of them. **Reading** gives you only `Object`, because the element type could be anything above `Dog`.

## 3. Mental model — PECS

> **Producer Extends, Consumer Super.** If the parameter *produces* values for you to read, use `? extends T`. If it *consumes* values you hand it, use `? super T`. If it does both, use a plain `T` and accept invariance.

```java
public static <T> void copy(List<? super T> dest, List<? extends T> src) {
    for (T item : src) dest.add(item);          // src produces, dest consumes
}
```

That signature is `Collections.copy`'s, and it is the canonical PECS illustration.

## 4. In the JDK

```java
// Producer: reads elements out of the argument
boolean addAll(Collection<? extends E> c);                 // Collection
void forEach(Consumer<? super T> action);                  // Iterable — consumer takes T in
<R> Stream<R> map(Function<? super T, ? extends R> f);     // Stream — both, in one signature
static <T> void sort(List<T> list, Comparator<? super T> c);  // Collections
void addAll(Collection<? super T> c);                      // a sink
```

Read `Function<? super T, ? extends R>`: the function *consumes* something T can be assigned to, and *produces* something assignable to R. That maximises what a caller may pass — a `Function<Object, Integer>` is acceptable where `Function<? super String, ? extends Number>` is required.

## 5. Realistic example

```java
// TOO STRICT — only accepts exactly List<Order>
public long totalOf(List<Order> orders) { ... }

// FLEXIBLE — accepts List<Order>, List<OnlineOrder>, List<PhoneOrder>
public long totalOf(List<? extends Order> orders) {
    long total = 0;
    for (Order o : orders) total += o.amountMinor();     // reading only: producer
    return total;
}

// A sink: accepts List<Order>, List<Object>, List<Payable>
public void collectInto(List<? super Order> sink, Order... orders) {
    for (Order o : orders) sink.add(o);                  // writing only: consumer
}
```

**API design rule:** use wildcards liberally on **parameters**; never use a wildcard as a **return type**, because it forces every caller to deal with the wildcard too.

## 6. What happens internally

**[JLS]** Wildcards are a compile-time device only — after erasure, `List<? extends Animal>`, `List<Animal>` and raw `List` are all just `List`. The compiler uses **capture conversion** to give the unknown type a name internally (`capture#1 of ? extends Animal`), which is what produces those baffling error messages:

```text
incompatible types: Object cannot be converted to capture#1 of ? extends Animal
```

That message means: "I know this is *some* subtype of Animal, but not which, so I cannot let you put anything into it."

The standard workaround when you need to name the captured type is a **capture helper**:

```java
public static void reverse(List<?> list) { reverseHelper(list); }         // public: wildcard
private static <T> void reverseHelper(List<T> list) {                     // private: named T
    for (int i = 0, j = list.size() - 1; i < j; i++, j--) {
        T tmp = list.get(i);
        list.set(i, list.get(j));
        list.set(j, tmp);                        // legal now: T is a name the compiler can track
    }
}
```

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> templates are invariant too, and there is no wildcard mechanism. Flexibility comes from templating the parameter itself (<code>template&lt;class It&gt; void f(It begin, It end)</code>) or from concepts. Pointers are covariant (<code>Derived*</code> converts to <code>Base*</code>), but <code>vector&lt;Derived&gt;</code> never converts to <code>vector&lt;Base&gt;</code>.</p>
<p><strong>Java:</strong> the same invariance, but with a language-level escape hatch — wildcards let one signature accept a family of instantiations without templating the whole call.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| `vector<Derived>` → `vector<Base>` | Never | Never — but `List<? extends Base>` accepts both |
| Achieving flexibility | Template the parameter; constrain with concepts | Wildcards at the use site |
| Variance declaration | None | Use-site (Java) — contrast Kotlin/C# declaration-site |
| Arrays | Invariant, and `Derived*` ≠ `Base*` for arrays | Covariant and unsound (`ArrayStoreException`) |
| Where the error appears | At instantiation | At the call site, at compile time |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Assuming arrays and generics behave alike.</strong> Java arrays are covariant (runtime-checked), generics are invariant (compile-checked). This inconsistency is a deliberate legacy compromise and a favourite interview question.</p>
<p><strong>Trying to <code>add</code> to a <code>? extends</code> collection</strong> and concluding wildcards are broken. Re-read §2: the restriction is exactly what makes it sound.</p>
<p><strong>Using wildcards in return types</strong> because they seem more general. They infect callers.</p>
</div>

## 8. Edge cases

```java
List<? extends Number> nums = List.of(1, 2, 3);
// nums.add(4);            // ERROR
// nums.add((Number) 4);   // ERROR — still
nums.add(null);            // the only legal add
Number n = nums.get(0);    // fine

List<? super Integer> sink = new ArrayList<Number>();
sink.add(1);               // fine
// Integer i = sink.get(0);  // ERROR
Object o = sink.get(0);    // fine

List<?> any = new ArrayList<String>();
// any.add("x");           // ERROR
System.out.println(any.size());   // methods not involving the type parameter are fine

// Nested wildcards do not nest variance:
List<List<Dog>> a = null;
// List<List<Animal>> b = a;                   // ERROR, as expected
List<? extends List<? extends Animal>> c = a;  // this is the correct form

// Unbounded wildcard vs raw type
void f(List<?> safe)  { /* compiler still checks; cannot add */ }
void g(List raw)      { /* checking disabled; you can add anything */ }
```

`List<?>` and raw `List` are **not** the same: the wildcard keeps type safety and forbids unsafe writes; the raw type discards safety entirely.

## 9. Common mistakes

- Using `? extends` on something you need to write to.
- Using `? super` and then trying to read a typed value.
- Wildcards on return types.
- Writing `List<Object>` where `List<?>` was meant (they accept different arguments).
- Fighting a capture error by casting instead of adding a private generic helper.
- Forgetting `Comparator<? super T>` in your own sort APIs, forcing callers to supply an exact-type comparator.

## 10. Interview questions

**Beginner** — 1. Why is `List<Dog>` not a `List<Animal>`? 2. What does `List<?>` mean? 3. What is PECS?

**Intermediate** — 4. What can you add to a `List<? extends Number>`, and why? 5. What can you read from a `List<? super Integer>`? 6. Why are arrays covariant but generics not? 7. `List<?>` vs raw `List`?

**Advanced** — 8. Explain capture conversion and why `capture#1` appears in errors. 9. Why does `Stream.map` use `Function<? super T, ? extends R>`? 10. Write the capture-helper idiom and explain what it fixes. 11. When should a return type be a wildcard?

**Senior** — 12. Design a `EventBus` API with correct variance for publishers and subscribers. 13. Compare use-site variance (Java) with declaration-site variance (Kotlin/C#) — trade-offs? 14. Why can't Java infer variance automatically?

## 11. Follow-ups

- *After Q4:* "Not even a `Number`? Why not?" → the list may be a `List<Integer>`.
- *After Q6:* "Which design would you choose today, and why did Java ship both?" → arrays predate generics and needed to work with `Object[]`-based APIs.
- *After Q9:* "What does the caller gain, concretely?" → pass a `Function<Object, Integer>` where `Function<String, Number>` is expected.

## 12. Exercise

Write these signatures and justify every wildcard:

1. `static <T> void copyAll(Collection<? super T> dest, Collection<? extends T> src)`
2. `static <T extends Comparable<? super T>> T max(Collection<? extends T> c)`
3. `static <T> void sortDescending(List<T> list, Comparator<? super T> cmp)`
4. `static double sumAll(Collection<? extends Number> nums)`

Then deliberately remove each wildcard and write the caller that stops compiling.

## 13. Output prediction — compiles or not?

```java
List<Integer> ints = new ArrayList<>(List.of(1, 2));
List<? extends Number> a = ints;
List<? super Integer> b = ints;

a.add(3);                       // ?
b.add(3);                       // ?
Number n = a.get(0);            // ?
Integer i = b.get(0);           // ?
Object o = b.get(0);            // ?
b.add(null);                    // ?
List<Object> c = (List<Object>) (List<?>) ints;   // ?
```

## 14. Mastery check

1. Why must generics be invariant? Give the three-line unsoundness proof.
2. State PECS and apply it to `Collections.copy`.
3. What exactly can you write into a `? extends T` collection, and why is that the only option?
4. What can you read out of a `? super T` collection?
5. Explain capture conversion in terms of what the compiler names.
6. Write the capture-helper idiom from memory and say when you need it.
7. `List<?>` vs `List<Object>` vs raw `List` — three differences.
8. Why does `Stream.map` need wildcards on both parameters?
9. Why are arrays covariant, and what runtime cost does that impose on every array store?
10. Contrast use-site and declaration-site variance and say why Java chose the former.
