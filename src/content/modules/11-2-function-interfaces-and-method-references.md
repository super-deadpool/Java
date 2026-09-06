---
title: "The java.util.function zoo and method references"
phase: 11
order: 2
minutes: 40
summary: "How to decode 43 interface names from their naming scheme, the four kinds of method reference and when each is ambiguous, and where boxing quietly costs you."
tags: ["function", "predicate", "consumer", "supplier", "method-reference", "boxing"]
---

## 1. Concept

`java.util.function` contains **43 interfaces**. You do not memorise 43 names; you learn the naming scheme and derive them.

The four shapes everything is built from:

| Interface | Method | Shape | Reads as |
| --- | --- | --- | --- |
| `Function<T, R>` | `R apply(T)` | in → out | "transform" |
| `Predicate<T>` | `boolean test(T)` | in → boolean | "test" |
| `Consumer<T>` | `void accept(T)` | in → nothing | "do something with" |
| `Supplier<T>` | `T get()` | nothing → out | "produce" |

Then four systematic modifiers:

```text
Bi-       two arguments        BiFunction<T,U,R>  BiPredicate<T,U>  BiConsumer<T,U>
          (no BiSupplier — a supplier has no arguments to double)

...Operator   input and output are the SAME type
              UnaryOperator<T> extends Function<T,T>
              BinaryOperator<T> extends BiFunction<T,T,T>

<Prim>...     the ARGUMENT is a primitive:  IntPredicate, IntConsumer, IntUnaryOperator,
              IntFunction<R>, IntSupplier, LongFunction<R>, DoubleConsumer, ...

To<Prim>...   the RESULT is a primitive:    ToIntFunction<T>, ToLongFunction<T>,
              ToDoubleBiFunction<T,U>, ...
```

Read `ToIntBiFunction<T, U>` as: two reference arguments in, an `int` out. Read `ObjIntConsumer<T>` as: a `T` and an `int` in, nothing out. Only `int`, `long` and `double` get specializations — the rest box.

## 2. Why the zoo exists

Two forces, both worth being able to state:

**No generic function type.** Java refused to add structural function types, so every arity/shape combination needs its own named interface. `Function<T, R>` cannot express three arguments, so real code either nests or defines its own interface.

**Generics cannot abstract over primitives.** `Function<int, int>` is illegal — type arguments must be reference types (Phase 6). Without `IntUnaryOperator`, `IntStream.map` would box every element. That single limitation is why a third of the package exists, and it is what Project Valhalla is meant to eventually remove.

## 3. The default methods

These are the reason to use the JDK interfaces rather than rolling your own.

```java
Function<T,R>     f.andThen(g)   // g(f(x))         f.compose(g)  // f(g(x))
                  Function.identity()               // x -> x
Predicate<T>      p.and(q)  p.or(q)  p.negate()
                  Predicate.not(p)                  // Java 11 — works on method refs
                  Predicate.isEqual(target)         // Objects::equals against target
Consumer<T>       c.andThen(d)                      // run both, in order
UnaryOperator<T>  UnaryOperator.identity()
BinaryOperator<T> BinaryOperator.minBy(cmp) / maxBy(cmp)
```

`Predicate.not` exists because `.negate()` cannot be called on a method reference (`String::isBlank.negate()` is not valid syntax):

```java
lines.stream().filter(Predicate.not(String::isBlank))    // idiomatic
lines.stream().filter(s -> !s.isBlank())                 // equivalent
```

`andThen` versus `compose` catches people every time: **`f.andThen(g)` runs `f` first**; `f.compose(g)` runs `g` first. `andThen` reads left-to-right, `compose` reads like mathematics.

## 4. Method references — the four kinds

```java
Type::staticMethod          // 1. static
instance::instanceMethod    // 2. bound     — receiver fixed NOW
Type::instanceMethod        // 3. unbound   — receiver is the FIRST argument
Type::new                   // 4. constructor      (also int[]::new for arrays)
```

```java
Function<String, Integer>  a = Integer::parseInt;      // 1 static
Supplier<Integer>          b = "hello"::length;        // 2 bound: receiver is "hello"
Function<String, Integer>  c = String::length;         // 3 unbound: receiver becomes the argument
BiFunction<String,String,Boolean> d = String::startsWith;  // 3: (recv, arg)
Supplier<ArrayList<String>> e = ArrayList::new;        // 4
Function<Integer, int[]>    f = int[]::new;            // 4 array constructor
IntFunction<String[]>       g = String[]::new;         // 4 — the toArray idiom
```

The unbound form is the one that is genuinely new to a C++ reader: `String::length` produces a `Function<String, Integer>` where the "argument" is what you would have called the receiver. An instance method of arity *n* becomes a function of arity *n+1*.

**Bound references evaluate the receiver eagerly**, at the point the reference is created:

```java
List<String> list = new ArrayList<>(List.of("a"));
Supplier<Integer> s = list::size;    // captures the CURRENT value of `list`, right now
list.add("b");
s.get();                             // 2 — the same list object, mutated
list = new ArrayList<>();            // (if list weren't effectively final) — s is unaffected

String name = null;
Supplier<Integer> t = name::length;  // NullPointerException HERE, not at t.get()
```

That last line is a real production bug shape: a null check deferred by a lambda (`() -> name.length()`) fires at call time; the same thing written as a method reference fires at creation time.

## 5. Realistic example

```java
record User(String email, String name, int age, boolean active) {}

// Predicates compose into a readable filter policy
Predicate<User> isActive   = User::active;
Predicate<User> isAdult    = u -> u.age() >= 18;
Predicate<User> hasEmail   = Predicate.not(u -> u.email() == null || u.email().isBlank());
Predicate<User> eligible   = isActive.and(isAdult).and(hasEmail);

// Functions compose into a pipeline
Function<User, String> normalize = ((Function<User, String>) User::email)
        .andThen(String::strip)
        .andThen(String::toLowerCase);

// Suppliers defer work — the message is built only if the branch is taken
void require(boolean ok, Supplier<String> message) {
    if (!ok) throw new IllegalStateException(message.get());
}
require(eligible.test(u), () -> "ineligible: " + expensiveDiagnostics(u));

// Consumers chain
Consumer<User> audit = u -> log.info("processing {}", u.email());
Consumer<User> send  = mailer::send;
users.forEach(audit.andThen(send));

// The primitive specializations matter here
double avg = users.stream().mapToInt(User::age).average().orElse(0);   // ToIntFunction: no boxing
```

`Supplier` as a laziness marker is the highest-value idiom in this list. Every logging framework, `Objects.requireNonNull(x, Supplier<String>)`, `Optional.orElseGet`, and `Map.computeIfAbsent` exist to avoid computing something that is usually not needed.

## 6. What happens internally

**Method references compile to the same `invokedynamic` machinery as lambdas** (Module 11.1). The difference is that the bootstrap's implementation method handle points directly at the *existing* method rather than at a synthetic `lambda$` method — so a method reference emits **no synthetic method at all** and is very slightly cheaper to link.

The bound form is a **capturing** call site: the receiver is pushed as an argument to the `invokedynamic` and stored in the spun class's field. The unbound and static forms are **non-capturing**, so they typically yield a single shared instance.

**Boxing is the cost you can actually measure.** `Function<Integer, Integer>` erases to `Object apply(Object)`, so every call boxes the argument and the result:

```java
// 1_000_000 elements
IntUnaryOperator      fast = x -> x * 2;      // int -> int, no allocation
Function<Integer,Integer> slow = x -> x * 2;  // 2 boxes per call, plus an unbox for the arithmetic
```

For values in `[-128, 127]` `Integer.valueOf` hits the cache (Module 1.2) and allocates nothing, which is exactly why microbenchmarks over small ints hide the problem and production over real ids does not.

**Overload resolution with method references** is a genuine source of compile errors. `Type::method` is ambiguous when the type has both a static and an instance method of the same name that both fit the target shape:

```java
class Foo {
    static  int size(Foo f) { return 1; }
    int size()              { return 2; }
}
Function<Foo, Integer> f = Foo::size;    // ERROR: ambiguous — static form and unbound form both apply
```

**[JLS 15.13]** In practice you hit this with `Integer::compare` versus `Integer::compareTo`, and with overloaded methods where only one overload fits — the compiler picks by target type, which means changing a variable's declared type can silently change *which method* a reference points at.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++</strong> has one general callable concept and many representations: function pointers, function objects (functors), lambdas, and <code>std::function</code> for type erasure. A pointer-to-member <code>&amp;String::length</code> is a distinct type invoked with <code>.*</code>/<code>-&gt;*</code> or wrapped by <code>std::mem_fn</code>/<code>std::invoke</code>. Templates let one algorithm accept any callable with no interface declaration at all — structural typing.</p>
<p><strong>Java</strong> is nominal: a callable must be an instance of a named interface, so the JDK ships a fixed catalogue of shapes. Java's unbound method reference <code>String::length</code> is closest to <code>std::mem_fn(&amp;std::string::length)</code>, which likewise turns the receiver into the first argument.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Callable concept | Structural — anything with `operator()` | Nominal — a specific interface |
| Generic over arity | Variadic templates | One interface per arity; stops at 2 |
| Primitives | Templates instantiate on `int` natively | Separate `Int*` interfaces or boxing |
| Type erasure | `std::function` (may allocate) | The interface reference itself |
| Member fn as callable | `std::mem_fn(&T::f)`, `std::invoke` | `T::f` unbound reference |
| Bind receiver | `std::bind`, or a lambda | `instance::f` |
| Composition | Manual, or ranges/views | `andThen`, `compose`, `and`, `or`, `negate` |
| Cost | Usually inlined, zero overhead | Virtual call; JIT inlines monomorphic sites |

## 8. Edge cases

- **`Function.identity()` is not `x -> x`** for `==` purposes: `identity()` returns a shared singleton, so it is preferable in hot paths and in `Collectors.toMap(k -> k, ...)` → `Collectors.toMap(Function.identity(), ...)`.
- **`Consumer.andThen` runs both even if the first mutates**; if the first throws, the second never runs and the exception propagates.
- **`Predicate.and`/`or` short-circuit**, exactly like `&&`/`||`.
- **`BinaryOperator<T>` is not `BiFunction<T,T,R>`** — the result type is pinned to `T`. `reduce` needs the former.
- **A method reference to a varargs method** works and adapts: `Arrays::asList` as a `Function<String[], List<String>>`.
- **`super::method`** is legal inside a class and binds to the superclass implementation.
- **Generic method references** infer from the target: `Collections::<String>emptyList` is explicit-witness syntax when inference fails.
- **`this::method` in a constructor** captures a partially constructed `this` — the same hazard as calling an overridable method from a constructor (Module 2.1).
- **`toArray(String[]::new)`** is the correct modern form; `toArray(new String[0])` is equivalent and marginally faster than `new String[list.size()]` on HotSpot (the zero-length array skips a zeroing pass).
- **No checked exceptions anywhere.** Every interface in the package declares none, so any I/O in a lambda body needs wrapping.

## 9. Common mistakes

- Confusing `andThen` and `compose`.
- Using `Function<Integer, Integer>` in a numeric hot loop instead of `IntUnaryOperator`.
- `map.computeIfAbsent(k, v -> new ArrayList<>())` — correct — versus `getOrDefault(k, new ArrayList<>())`, which allocates every call and discards the result.
- `orElse(expensive())` instead of `orElseGet(this::expensive)` — `orElse` evaluates its argument always (Phase 13).
- `logger.debug("x=" + expensive())` instead of the `Supplier` overload.
- Writing a custom `interface StringMapper { String map(String s); }` when `UnaryOperator<String>` exists — it does not compose with anything.
- Expecting `instance::method` to re-evaluate `instance` later.
- Being surprised by an NPE at the point a bound method reference is created.
- Passing a method reference where an overload set makes it ambiguous, then adding a cast instead of understanding why.
- Treating `Supplier<T>` as a cache — it recomputes on every `get()`.

## 10. Interview questions

**Beginner** — 1. Name the four core functional interfaces and their methods. 2. What is a method reference? 3. What does `Supplier` buy you over passing a value?

**Intermediate** — 4. Decode `ToIntBiFunction<T, U>` and `ObjLongConsumer<T>` from the name. 5. Difference between `andThen` and `compose`. 6. What are the four kinds of method reference? 7. Why does `IntPredicate` exist when `Predicate<Integer>` compiles?

**Advanced** — 8. Explain the difference between `list::size` and `() -> list.size()` including when a null receiver blows up. 9. Why is there no `BiSupplier` and no three-argument `Function`? 10. When is `Type::method` ambiguous, and what does the compiler complain about? 11. What does a method reference emit that a lambda does not, and vice versa?

**Senior** — 12. A data pipeline over 50 M records is allocating 4 GB/s. The code is all `Function`/`Predicate`. Diagnose and fix. 13. Design a functional interface for an operation that can throw a checked exception and still compose. What do you lose? 14. Why can't Java generics abstract over primitives, and what would Valhalla change about this package?

## 11. Follow-ups

- *After Q4:* "Which primitives get specializations, and why only those?"
- *After Q6:* "Show the same method as both a bound and an unbound reference."
- *After Q7:* "Show the allocation with a profiler, not an argument."
- *After Q8:* "Which of the two would you use for a lazily-supplied error message?"
- *After Q12:* → `mapToInt`/`IntStream`, primitive specializations, avoid `boxed()`, check the `Integer` cache assumption.

## 12. Exercise

1. Without looking anything up, write the signatures of: `ToDoubleFunction<T>`, `ObjIntConsumer<T>`, `LongBinaryOperator`, `DoublePredicate`, `IntFunction<R>`. Then check.
2. Express each of `Integer::parseInt`, `"x"::equals`, `String::isEmpty`, `HashMap::new`, `String[]::new` as an explicit lambda, and state which functional interface each targets.
3. Build a `Predicate<User>` policy from five composable predicates and prove short-circuiting with a predicate that logs.
4. JMH: `IntUnaryOperator` versus `Function<Integer,Integer>` applied 10 M times, once with values under 128 and once with values over 100 000. Explain the three different numbers.
5. Write `ThrowingFunction` + a `sneaky`/`wrapped` adapter, then a `compose` for it. Write up what you gave up compared with `Function`.

## 13. Output prediction

```java
import java.util.*;
import java.util.function.*;

public class Main {
    static String s = "hello";
    public static void main(String[] args) {
        Function<Integer, Integer> f = x -> x + 1;
        Function<Integer, Integer> g = x -> x * 10;
        System.out.println(f.andThen(g).apply(1) + " " + f.compose(g).apply(1));

        List<String> l = new ArrayList<>(List.of("a"));
        Supplier<Integer> bound = l::size;
        l.add("b"); l.add("c");
        System.out.println(bound.get());

        Predicate<String> empty = String::isEmpty;
        System.out.println(empty.negate().test("x") + " " + Predicate.not(empty).test(""));

        BiFunction<String, String, Boolean> sw = String::startsWith;
        System.out.println(sw.apply("banana", "ban"));

        Function<String, Integer> len = String::length;
        Supplier<Integer> lenOf = s::length;
        s = "hi";
        System.out.println(len.apply("abcd") + " " + lenOf.get());

        Consumer<String> c1 = x -> System.out.print(x.toUpperCase());
        Consumer<String> c2 = x -> System.out.print(x.length());
        c1.andThen(c2).accept("ab");
        System.out.println();

        UnaryOperator<String> id = UnaryOperator.identity();
        System.out.println(id.apply("z") + " " + (Function.identity() == Function.identity()));

        String name = null;
        try { Supplier<Integer> bad = name::length; System.out.println("created"); }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 14. Mastery check

1. Derive the signatures of all four modifier families (`Bi`, `Operator`, `<Prim>`, `To<Prim>`) from the naming scheme.
2. Why is there no `BiSupplier`? Why no `TriFunction`?
3. Give the four kinds of method reference with an example of each.
4. Explain precisely when the receiver of a bound method reference is evaluated, with the NPE consequence.
5. What is the unbound form's arity relationship to the underlying method?
6. `f.andThen(g)` versus `f.compose(g)` — write out the equivalent lambda for each.
7. Why does `IntPredicate` exist, and what exactly does using `Predicate<Integer>` cost?
8. When is `Type::method` ambiguous?
9. Why does `Predicate.not` exist when `negate()` already does?
10. Name three JDK APIs that take a `Supplier` purely for laziness, and say what each avoids.
