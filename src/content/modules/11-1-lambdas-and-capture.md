---
title: "Lambdas: target typing, capture, and the invokedynamic machinery underneath"
phase: 11
order: 1
minutes: 50
summary: "Why a lambda is not an anonymous class, what javac actually emits, how LambdaMetafactory spins the implementing class at first execution, and the exact capture rules."
tags: ["lambda", "functional-interface", "invokedynamic", "closure", "effectively-final"]
---

## 1. Concept

A **lambda expression** is an anonymous implementation of a **functional interface** — an interface with exactly one abstract method (a *SAM* type).

```java
Runnable r        = () -> System.out.println("hi");
Comparator<String> c = (a, b) -> Integer.compare(a.length(), b.length());
Function<String, Integer> f = s -> s.length();
BiFunction<Integer, Integer, Integer> add = (x, y) -> x + y;
Supplier<List<String>> s = () -> { var l = new ArrayList<String>(); l.add("a"); return l; };
```

What counts as functional, precisely **[JLS 9.8]**:

- exactly **one abstract method**;
- `default`, `static` and `private` interface methods do not count;
- **public methods of `Object` do not count** — that is why `Comparator` is functional despite declaring `equals(Object)`;
- generic methods are allowed on the interface but the abstract one may not be generic (a lambda cannot introduce its own type parameters);
- `@FunctionalInterface` is optional documentation that makes the compiler enforce all of the above.

```java
@FunctionalInterface
public interface Validator<T> {
    List<String> validate(T value);                            // the SAM
    default Validator<T> and(Validator<T> other) { ... }       // fine
    static <T> Validator<T> alwaysValid() { return v -> List.of(); }   // fine
    boolean equals(Object o);                                  // fine — Object method
}
```

## 2. Why Java has lambdas

Java 8 needed to add bulk operations to `Collection` without breaking every implementation on earth. That drove three features that only make sense together: **default methods** (so `Collection` could gain `stream()`), **streams** (the bulk API), and **lambdas** (so passing behaviour is not five lines of anonymous class).

The design constraint that shaped everything: **no new function type**. Java did not add `int -> int` as a type. A lambda is *always* an instance of an interface you already have, so lambdas interoperate with every pre-Java-8 API that took a callback interface. `new Thread(() -> ...)` works because `Runnable` was already a SAM in 1996.

## 3. Mental model

> A lambda is **an expression with no type of its own**. It gets its type from the context it lands in — the *target type*. The same lambda text means different things in different contexts.

```java
Runnable  r = () -> doWork();      // void-compatible
Callable<?> c = () -> doWork();    // value-compatible, if doWork() returns something
Object o = () -> doWork();         // COMPILE ERROR — Object is not a functional interface
var v = () -> doWork();            // COMPILE ERROR — no target type to infer from
```

**[JLS 15.27]** Lambdas are *poly expressions*: they have no standalone type, so they cannot be assigned to `var`, cast to `Object`, or used where the compiler cannot see a functional target. `(Runnable) () -> doWork()` is legal — the cast supplies the target.

## 4. Capture rules

```java
void demo(int param) {
    int local = 1;
    int mutable = 1;
    mutable++;                                  // now NOT effectively final

    Runnable a = () -> System.out.println(local);     // OK
    Runnable b = () -> System.out.println(param);     // OK — params can be effectively final
    Runnable c = () -> System.out.println(mutable);   // COMPILE ERROR
    Runnable d = () -> System.out.println(this.field);// OK — field, read live, no capture rule
    Runnable e = () -> { int local = 2; };            // COMPILE ERROR — cannot shadow enclosing local
}
```

The rules, exactly:

| What | Rule |
| --- | --- |
| Local variable / parameter | Must be **final or effectively final**; captured **by value** at lambda creation |
| Instance field | Not captured — `this` is captured, and the field is read through it, **live** |
| Static field | Not captured at all; read live |
| `this` | Refers to the **enclosing instance**. A lambda has no `this` of its own |
| Lambda parameter names | May **not** shadow an enclosing local (an anonymous class may) |

*Effectively final* means "you could add `final` and it would still compile" — assigned exactly once, never reassigned.

Why the restriction? Because capture is **by value**, and locals live on a stack frame that will be gone by the time the lambda runs. Allowing mutation would mean either capturing a mutable cell (which C++ does with `[&]`, at the cost of dangling references) or making the semantics depend on which side mutated. Java forbids the question.

The escape hatch people reach for, and why it is a smell:

```java
int[] counter = { 0 };
list.forEach(x -> counter[0]++);       // compiles: the ARRAY reference is effectively final
                                       // but it is not atomic, not visible across threads, and
                                       // hides that you wanted a reduction
long n = list.stream().filter(...).count();   // say what you mean
var counter2 = new AtomicInteger();           // if you genuinely need shared mutable state
```

## 5. Lambda vs anonymous class

They are not the same feature with different syntax.

```java
class Widget {
    private String name = "widget";

    void anonymous() {
        Runnable r = new Runnable() {
            private int calls = 0;                    // has its own state
            @Override public void run() {
                calls++;
                System.out.println(this.getClass());  // Widget$1
                System.out.println(Widget.this.name); // must qualify to reach the outer instance
            }
        };
    }

    void lambda() {
        Runnable r = () -> {
            System.out.println(this.getClass());      // Widget  <-- not the lambda
            System.out.println(name);                 // no qualification needed
        };
    }
}
```

| | Anonymous class | Lambda |
| --- | --- | --- |
| `this` | The anonymous instance | The **enclosing** instance |
| Own fields / state | ✅ | ❌ |
| Shadowing enclosing locals | ✅ allowed | ❌ compile error |
| Multi-method interfaces | ✅ | ❌ SAM only |
| Abstract *class* target | ✅ | ❌ interfaces only |
| Compiled to | A real `Outer$1.class` at compile time | A synthetic method + `invokedynamic`; class spun at runtime |
| Instance per evaluation | Always a new one | Non-capturing: usually one shared instance |
| Recursive self-reference | ✅ via `this` | ❌ directly |
| `Serializable` | If the interface is | Only if the target type is, via a special path |

Recursion, since a lambda cannot name itself:

```java
// Does not compile: 'fact' may not have been initialized
Function<Integer, Integer> fact = n -> n <= 1 ? 1 : n * fact.apply(n - 1);

// Works: a field, or a one-element holder, is initialized before the body ever runs
static Function<Integer, Integer> FACT = n -> n <= 1 ? 1 : n * FACT.apply(n - 1);
```

## 6. What happens internally

This is the part that separates a rehearsed answer from an understood one.

**javac does not generate a class for a lambda.** It generates two things:

1. A **synthetic method** holding the body — `private static` for a non-capturing lambda, `private` (instance) if it uses `this`. Named `lambda$methodName$N`.
2. An **`invokedynamic`** instruction at the point of the lambda expression.

```java
public class Demo {
    public static void main(String[] args) {
        int n = 41;
        Supplier<Integer> s = () -> n + 1;
        System.out.println(s.get());
    }
}
```

```text
$ javap -p -c Demo
  private static java.lang.Integer lambda$main$0(int);        // <-- the body
      ...

  public static void main(java.lang.String[]);
       0: bipush        41
       2: istore_1
       3: iload_1                                             // push the captured value
       4: invokedynamic #7,  0   // InvokeDynamic #0:get:(I)Ljava/util/function/Supplier;
       9: astore_2
       ...

BootstrapMethods:
  0: #30 REF_invokeStatic java/lang/invoke/LambdaMetafactory.metafactory:(...)
    Method arguments:
      #38 ()Ljava/lang/Object;                 // erased SAM signature
      #39 REF_invokeStatic Demo.lambda$main$0:(I)Ljava/lang/Integer;   // the implementation
      #42 ()Ljava/lang/Integer;                // instantiated signature (for the bridge)
```

**[JVMS]** At the **first execution** of that instruction, the JVM calls the *bootstrap method* — `LambdaMetafactory.metafactory` — passing the SAM signature, a method handle to the implementation, and the instantiated signature. The metafactory (**[HotSpot]**, via `InnerClassLambdaMetafactory`) **spins a class at runtime** implementing `Supplier`, whose `get()` calls the synthetic method. It returns a `CallSite`, which the JVM **links into the instruction permanently**. Every subsequent execution is a plain indirect call with no bootstrap cost.

The capturing/non-capturing split is the practically visible consequence:

```java
Runnable a = () -> System.out.println("hi");
Runnable b = () -> System.out.println("hi");
System.out.println(a == b);        // typically true  — non-capturing: one instance, ConstantCallSite

int x = 1;
Runnable c = () -> System.out.println(x);
Runnable d = () -> System.out.println(x);
System.out.println(c == d);        // false — capturing: a new instance per evaluation
```

**[JLS 15.27.4]** is explicit that lambda **identity is unspecified**: an implementation may or may not reuse instances, and `==`, `hashCode`, and `System.identityHashCode` on lambdas guarantee nothing. Never key a map on a lambda, and never expect `removeListener(x -> ...)` to remove a listener added as `x -> ...`.

**Why this design instead of just generating classes?**

- **No class-file explosion.** Java 7's anonymous-class approach put one `.class` in the jar per callback; large codebases paid for it in jar size, class-loading time, and metaspace.
- **Late binding of strategy.** The translation lives in the JDK, not in bytecode. A future JVM could return a cached instance, use a `MethodHandle` proxy, or (with Valhalla) a value object, with no recompilation.
- **Non-capturing lambdas cost one allocation ever.**

The tradeoff is **startup**: the first execution of each lambda call site does bootstrap work (method-handle resolution + class spinning), measurable in milliseconds across a large application. Class-Data Sharing and AOT caches (`-XX:+AutoCreateSharedArchive`) exist partly to reclaim it.

**Serialization** is a wart. Lambdas are not `Serializable` unless the target type is (`interface Foo extends Runnable, Serializable`). When it is, javac emits a `$deserializeLambda$` method and the runtime uses `SerializedLambda`, which encodes the *implementation method name* — so renaming `lambda$main$0` by adding a lambda earlier in the file breaks previously serialized instances. Do not serialize lambdas.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++</strong> lambdas create an <strong>unnamed class type</strong> at compile time with an <code>operator()</code>. Each lambda has a distinct type, so <code>auto f = [](int x){...}</code> stores it with no indirection and inlines perfectly. Capture is explicit and per-variable: <code>[x]</code> by value, <code>[&amp;x]</code> by reference, <code>[=]</code>/<code>[&amp;]</code> wholesale, <code>[x = expr]</code> init-capture, <code>[this]</code> or <code>[*this]</code>. <code>mutable</code> makes by-value captures assignable.</p>
<p><strong>Java</strong> lambdas are instances of an interface you name. Capture is implicit, always by value, always requires effectively-final, and cannot be by reference — so Java's lambdas can outlive their enclosing frame safely, which is the whole point. There is no <code>mutable</code>, no <code>auto</code> storage, and no generic lambda.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Type of a lambda | Unique unnamed class, `auto` to store | The target functional interface |
| Zero-overhead storage | ✅ `auto` / template parameter | ❌ always an object reference |
| Type-erased storage | `std::function` — may heap-allocate | The interface itself; always a reference |
| Capture by reference | `[&x]` — **dangling if it outlives the frame** | Impossible |
| Capture by value | `[x]`, copies (so a full object copy) | Always; copies the *reference*, not the object |
| Mutate a capture | `mutable` | Never |
| Capture `this` | `[this]` (pointer) or `[*this]` (copy, C++17) | Implicit `this`; only the enclosing one |
| Generic parameters | `[](auto x){}` (C++14) | Not possible |
| Inlining | Guaranteed in practice | JIT-dependent; monomorphic call sites inline (Phase 22) |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>"Capture by value copies the object." In Java, capturing a <code>List</code> captures the <strong>reference</strong>. The list stays fully mutable through it, and mutating it from another thread is a data race. Java's effectively-final rule constrains the <em>variable</em>, never the object it points at.</p>
<p>"<code>this</code> inside a lambda is the lambda." Coming from C++ that reads naturally, and it is wrong in the useful direction: Java's lambda <code>this</code> is the enclosing instance, which is exactly what an anonymous class made awkward.</p>
</div>

## 8. Edge cases

- **`var` cannot hold a lambda.** No target type. `Supplier<String> s = () -> "x";` or a cast.
- **Explicit parameter types are all-or-nothing:** `(String a, b) ->` is illegal; so is mixing `var` with a type. `(var a, var b) ->` is legal (Java 11+) and exists so you can annotate parameters.
- **A lambda body's `return` returns from the lambda**, never from the enclosing method. `break`/`continue` targeting an enclosing loop are illegal.
- **Ambiguous overloads.** If a method is overloaded on two functional interfaces with the same shape, an implicit lambda is ambiguous; cast to disambiguate. `ExecutorService.submit` taking both `Runnable` and `Callable<T>` is the classic case — `submit(() -> doThing())` picks `Callable` if `doThing()` returns a value, and that silently swallows exceptions into the `Future`.
- **Checked exceptions do not pass through.** `Function.apply` declares none, so `path -> Files.readString(path)` does not compile. Wrap, or define your own throwing interface.
- **`null` as a functional value** is legal to assign, and `NullPointerException` arrives at the call, not at the assignment.
- **Lambdas in fields with initialization order** — a lambda field capturing another field that is initialized later captures `null`/0 only if it *reads it at construction*; since bodies run later, it usually reads live and is fine. Static lambda fields referring to each other are not.
- **Instance-method-capturing lambdas keep the enclosing object alive.** A lambda registered as a long-lived listener pins its whole enclosing instance — the same leak shape as a non-static inner class (Phase 16).

## 9. Common mistakes

- Trying to mutate a captured local, then reaching for `int[] holder`.
- Assuming a lambda gets a fresh instance every time, or that two identical lambdas are `==`.
- Registering `obj::handle` as a listener and later trying to unregister with another `obj::handle`.
- Expecting `this` to mean the lambda.
- Multi-statement lambda bodies with braces but a missing `return`.
- Using lambdas for anything needing state — that is what a class is for.
- Passing `() -> compute()` to an overload set containing both `Runnable` and `Callable` and losing the exception.
- Serializing lambdas.
- Believing lambdas are slower than anonymous classes at steady state — after JIT they are equivalent; the difference is at startup.
- Writing a 30-line lambda. Extract a method and use a method reference.

## 10. Interview questions

**Beginner** — 1. What is a functional interface? 2. Which interfaces can a lambda implement? 3. What does `@FunctionalInterface` do?

**Intermediate** — 4. What is "effectively final" and why is it required? 5. What does `this` mean inside a lambda? 6. Name four differences between a lambda and an anonymous class. 7. Why can't you assign a lambda to `var`?

**Advanced** — 8. What bytecode does javac emit for a lambda? 9. What does `LambdaMetafactory.metafactory` do, and when does it run? 10. Why is capture by value rather than by reference? 11. When are two lambdas the same object, and what does the spec promise?

**Senior** — 12. Why did Java choose `invokedynamic` over generating anonymous classes, and what did it cost? 13. A service's p99 startup regressed after a refactor that introduced heavy lambda use in initialization paths. Explain the mechanism and three mitigations. 14. Design an API for a callback that must be removable and must not leak its registrant. What do lambdas make hard here?

## 11. Follow-ups

- *After Q4:* "Then how do I accumulate in a loop?" → reduce/collect, or `AtomicInteger` if truly shared.
- *After Q5:* "Then how do you leak an object with a lambda?" → capturing `this` in a long-lived listener.
- *After Q8:* "Is there a class file per lambda?" → no; a synthetic method plus a bootstrap entry.
- *After Q9:* "What happens on the second execution of the same call site?" → nothing; it is already linked.
- *After Q11:* "So can I use a lambda as a map key?" → never.

## 12. Exercise

1. Write a class with a capturing and a non-capturing lambda. Run `javap -p -c -v` on it and identify: the synthetic methods, the `invokedynamic` instructions, the `BootstrapMethods` table, and the difference in the call-site descriptors.
2. Write the `a == b` identity test from §6 for both kinds and explain the result in terms of `ConstantCallSite`.
3. Implement `@FunctionalInterface interface ThrowingFunction<T, R, E extends Exception> { R apply(T t) throws E; }` and an adapter `Function<T, R> unchecked(ThrowingFunction<T, R, ?> f)` that wraps checked exceptions. Use it to write `paths.stream().map(unchecked(Files::readString))`.
4. Build a class that registers a lambda listener on a static registry, then drop all your references to the instance and prove with a heap dump that it is still reachable. Fix it with a `WeakReference` or an explicit unregister handle.
5. Measure first-call versus steady-state cost of a lambda call site with JMH, using `@Fork` and single-shot mode for the bootstrap measurement.

## 13. Output prediction

```java
import java.util.*;
import java.util.function.*;

public class Main {
    static int calls = 0;
    static Supplier<String> make() { return () -> "s"; }

    public static void main(String[] args) {
        Runnable a = () -> {}, b = () -> {};
        System.out.println(a == b);
        System.out.println(make() == make());

        int k = 5;
        Supplier<Integer> c = () -> k, d = () -> k;
        System.out.println(c == d);

        List<Runnable> rs = new ArrayList<>();
        for (int i = 0; i < 3; i++) { int j = i; rs.add(() -> System.out.print(j)); }
        rs.forEach(Runnable::run);
        System.out.println();

        List<String> data = new ArrayList<>(List.of("a"));
        Supplier<Integer> size = () -> data.size();
        data.add("b");
        System.out.println(size.get());

        int[] box = { 0 };
        List.of(1, 2, 3).forEach(x -> box[0] += x);
        System.out.println(box[0]);

        Function<Integer, Integer> f = x -> x + 1;
        Function<Integer, Integer> g = x -> x * 2;
        System.out.println(f.andThen(g).apply(3) + " " + f.compose(g).apply(3));
    }
}
```

## 14. Mastery check

1. Give the precise definition of a functional interface, including the `Object`-methods rule.
2. What is a poly expression, and name two places a lambda cannot appear because of it.
3. State all five capture rules from §4.
4. Explain why effectively-final is required, in terms of stack frames.
5. Describe exactly what javac emits for a lambda — every artifact.
6. Walk through what happens at the first and the second execution of a lambda's `invokedynamic`.
7. When does a lambda evaluation allocate, and when does it not?
8. What does the JLS guarantee about lambda identity?
9. Give four behavioural differences between a lambda and an anonymous class.
10. How does a lambda leak an enclosing object, and how do you prevent it?
