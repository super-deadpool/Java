---
title: "Objects and Construction: what new Child() actually does"
phase: 2
order: 1
minutes: 30
summary: "Object identity, reference semantics, constructor chaining with this() and super(), and the exact sequence of events from the new instruction to a usable object."
tags: ["objects", "constructors", "new", "this", "super"]
---

## 1. Concept

An object in Java is a heap-allocated block with a **header** and its fields. A variable never *is* an object; it holds a reference. Three things are worth separating cleanly:

- **Identity** — which object this is. Tested with `==`, exposed (imperfectly) by `System.identityHashCode`. Never changes; not derived from state.
- **State** — the field values.
- **Behaviour** — the methods, which live once per class, not per object.

A **constructor** is not a method. It has no return type, is not inherited, cannot be overridden, cannot be `final`/`static`/`abstract`, and is invoked only by `new`, by `this(...)`/`super(...)`, or reflectively. Its job is to take a zeroed object and establish the class invariants.

## 2. Why Java has it

Java wanted object creation that cannot produce a half-typed or uninitialised object: the memory is zeroed before any code runs, the constructor chain is forced to run top-down from `Object`, and the compiler proves every `final` field is assigned exactly once. That combination is what makes "no uninitialised reads" a language-level guarantee rather than a coding convention.

## 3. Mental model

> `new` is three steps: **allocate + zero → run the constructor chain from `Object` downward → hand back a reference**. The object has its final type from step one, but its fields are only trustworthy after the *outermost* constructor returns.

## 4. Syntax

```java
public class Money {
    private final String currency;
    private final long minorUnits;

    public Money(String currency, long minorUnits) {     // primary constructor
        this.currency = Objects.requireNonNull(currency);
        this.minorUnits = minorUnits;
    }

    public Money(long minorUnits) {
        this("USD", minorUnits);                          // must be the FIRST statement
    }

    public static Money ofMajor(String ccy, long major) { // static factory — often better
        return new Money(ccy, major * 100);
    }
}
```

## 5. Minimal example

```java
class A {
    A() { System.out.println("A()"); }
    A(int x) { this(); System.out.println("A(int)"); }
}
class B extends A {
    B() { super(1); System.out.println("B()"); }
}
new B();      // A()  A(int)  B()
```

Every constructor's first act is another constructor call. `this(...)` delegates sideways within the class; `super(...)` goes up. If you write neither, `javac` inserts `super()` — and fails to compile if the superclass has no no-arg constructor.

## 6. Realistic example

```java
public final class HttpClientConfig {
    private final URI baseUri;
    private final Duration timeout;
    private final Map<String, String> defaultHeaders;

    private HttpClientConfig(Builder b) {
        this.baseUri = Objects.requireNonNull(b.baseUri, "baseUri");
        this.timeout = b.timeout != null ? b.timeout : Duration.ofSeconds(10);
        this.defaultHeaders = Map.copyOf(b.headers);   // defensive, immutable copy
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private URI baseUri;
        private Duration timeout;
        private final Map<String, String> headers = new LinkedHashMap<>();

        public Builder baseUri(URI v)   { this.baseUri = v; return this; }
        public Builder timeout(Duration v) { this.timeout = v; return this; }
        public Builder header(String k, String v) { headers.put(k, v); return this; }
        public HttpClientConfig build() { return new HttpClientConfig(this); }
    }
}
```

Three habits worth copying: validate in the constructor so an invalid object can never exist; copy mutable inputs (`Map.copyOf`) so the caller cannot mutate your state afterwards; prefer static factories/builders over telescoping constructors, because factories have names, can return cached instances, and can return a subtype.

## 7. What happens internally

**[JVMS]** `new Foo(args)` compiles to *four* instructions, not one:

```text
new #2          // allocate + zero fields, push an uninitialised reference
dup             // the constructor consumes one copy
<push args>
invokespecial #3 // Foo.<init>  — runs the constructor chain
```

The verifier tracks the "uninitialised" state of that reference and forbids almost every use of it before `<init>` completes. `invokespecial` (not `invokevirtual`) is used for constructors, `super.m()` calls and private methods — precisely the cases that must **not** be virtually dispatched.

**[JLS]** `javac` copies instance-field initialisers and instance blocks into each constructor immediately after its `super(...)` call — and *not* into a constructor that starts with `this(...)`, which is why field initialisers still run exactly once per object. (Module 1.3 §7 has the disassembly.)

**[HotSpot]** Allocation is normally a pointer bump in the thread's TLAB; the object header is one mark word plus a compressed class word (typically 12 bytes total with compressed oops, 8 with the compact headers of recent JDKs), then fields laid out with alignment gaps. When escape analysis proves an object never escapes, the allocation can disappear entirely and its fields become registers — so "every object is on the heap" is a language-level statement, not a machine-level one.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> <code>Foo f(1);</code> constructs in place; <code>new Foo(1)</code> returns a pointer you must delete; member-init-lists initialise in <em>declaration</em> order; copy/move constructors and assignment operators exist; destructors run deterministically.</p>
<p><strong>Java:</strong> only one form — <code>new</code> — always heap-conceptual, always returning a reference, never copying. No copy constructor is generated, no assignment operator exists (<code>=</code> rebinds a reference), no destructor runs.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Delegating construction | `Foo() : Foo(0) {}` (C++11) | `this(0);` — must be the first statement |
| Base construction | Implicit, in the member-init-list | Implicit `super()`, or explicit as first statement |
| Init order | Declaration order of members | Source order of initialisers, after `super()` |
| Copying an object | Copy ctor / `operator=`, often implicit | Nothing implicit; `clone()` is discouraged, use a copy constructor or record |
| Cleanup | Destructor, RAII, deterministic | GC for memory; `try`-with-resources for everything else |
| Failing construction | Throw; the object never existed, members already built are destroyed | Throw; the object is unreachable garbage. Fields already assigned are simply dropped |
| Factory returning a subtype | Fine, but slicing is a hazard on value returns | Fine and idiomatic; there is no slicing, ever |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Expecting slicing.</strong> <code>Parent p = child;</code> copies a reference. The object stays a <code>Child</code> with all its state and all its overrides. Slicing does not exist in Java.</p>
<p><strong>Looking for a destructor.</strong> <code>finalize()</code> is deprecated for removal and was never a destructor. Use <code>AutoCloseable</code> + try-with-resources (Phase 7); <code>Cleaner</code> only as a safety net.</p>
<p><strong>Assuming <code>=</code> copies.</strong> <code>a = b</code> makes two names for one object. Mutating through <code>a</code> is visible through <code>b</code>.</p>
<p><strong>Writing telescoping constructors.</strong> Java has no default arguments and no named parameters — that is exactly why builders and static factories are idiomatic here and less common in C++.</p>
</div>

## 9. Edge cases

```java
class A { A() { this(1); } A(int x) { this(); } }   // compile error: recursive constructor invocation

class B {
    B() { super(); this.x = 1; }   // compile error: cannot have BOTH super() and this()
    int x;
}

class C {
    private C() {}                 // no public constructor → not instantiable from outside
    static C create() { return new C(); }
}

class D { }                        // javac supplies: public D() { super(); }  (matching class access)
class E { E(int x) {} }
class F extends E { F() { } }      // compile error: no default super constructor available
```

- A constructor **can** throw; the reference is simply never published.
- A constructor that calls an overridable method sees the subclass's uninitialised fields (Module 1.3 §6).
- Passing `this` to anything before the constructor returns publishes a half-built object.
- An anonymous class has no constructor of its own; it uses an instance initialiser block plus the superclass constructor's arguments.

## 10. Common mistakes

- Doing real work (I/O, thread starts, listener registration) in a constructor.
- Not validating arguments, so invalid objects exist and fail far from the cause.
- Storing a caller's mutable collection or array directly instead of copying it.
- Long telescoping constructor chains where argument order is guessable — use a builder.
- Assuming `new` guarantees a fresh object: static factories (`Integer.valueOf`, `List.of`, `Optional.empty`) may return shared instances, which is a feature.

## 11. Interview questions

**Beginner**
1. What does `new Foo()` do, step by step?
2. Why can a constructor not be `static` or `final`?
3. What is the difference between `this(...)` and `super(...)`?

**Intermediate**
4. Are constructors inherited? What actually happens when a subclass has no constructor?
5. What is the compile error when the superclass has only a parameterised constructor, and why?
6. Why must `this(...)` / `super(...)` be the first statement?
7. Give three reasons to prefer a static factory over a public constructor.

**Advanced**
8. Which JVM instruction invokes a constructor, and why is it `invokespecial` rather than `invokevirtual`?
9. What is the "uninitialised this" state in the verifier, and what does it prevent?
10. Explain what happens to an object whose constructor throws.
11. Why is publishing `this` from a constructor unsafe even in single-threaded code?

**Senior / deep dive**
12. Design an immutable class with 12 optional fields. Justify the construction strategy.
13. How does object allocation actually work in HotSpot, and when does it not happen at all?
14. Records give you a canonical constructor — what validation hook do they provide and where does it run?
15. Why does Java have no copy constructor convention, and what replaced it?

## 12. Follow-up questions to expect

- *After Q4:* "So what does the implicit constructor look like, and what access modifier does it get?" (Same as the class.)
- *After Q6:* "What guarantee would break if it were allowed anywhere?" → the superclass part of the object could be observed before initialisation.
- *After Q7:* "Name three JDK static factories and what each buys." → `List.of` (immutable + size-specialised), `Integer.valueOf` (caching), `Optional.empty` (singleton).
- *After Q12:* "Builder vs record with `withX` methods vs constructor overloads — trade-offs?"

## 13. Coding exercise

Implement an immutable `Interval` (`start`, `end`, both `Instant`) with:
1. a validating canonical constructor that rejects `end` before `start`;
2. static factories `of(start, end)` and `ofDuration(start, Duration)`;
3. a `withEnd(Instant)` returning a new instance;
4. a `Builder`.

Then write a test proving that mutating anything the caller passed in cannot change an existing `Interval`. Finally, rewrite it as a `record` and list exactly what you lost and what you gained.

## 14. Output prediction

**A**
```java
class P { P() { System.out.print("P"); } }
class Q extends P { Q() { System.out.print("Q"); } }
class R extends Q { R() { this(1); System.out.print("R"); } R(int x) { System.out.print("R" + x); } }
public class Main { public static void main(String[] a) { new R(); } }
```

**B**
```java
class Node {
    static int count;
    final int id;
    Node() { id = ++count; }
    public static void main(String[] args) {
        Node a = new Node(), b = a, c = new Node();
        System.out.println(a == b);
        System.out.println(a == c);
        System.out.println(a.id + " " + b.id + " " + c.id + " " + count);
    }
}
```

**C**
```java
class Box {
    private final List<String> items;
    Box(List<String> items) { this.items = items; }
    List<String> items() { return items; }
    public static void main(String[] args) {
        List<String> src = new ArrayList<>(List.of("a"));
        Box box = new Box(src);
        src.add("b");
        box.items().add("c");
        System.out.println(src);
    }
}
```

## 15. Mastery check

1. List the four bytecode instructions behind `new Foo(1)` and say what each does.
2. Why is a constructor not a method? Give four properties methods have that constructors do not.
3. What exactly does `javac` insert when a constructor has neither `this(...)` nor `super(...)`?
4. Where do instance field initialisers run in a constructor that begins with `this(...)`?
5. Why can't a class be instantiated if its superclass has only a private constructor?
6. Explain, in JVM terms, why `super.m()` cannot be virtually dispatched.
7. Give three concrete advantages of a static factory over a constructor, with a JDK example of each.
8. What is slicing, and why can it not happen in Java?
9. An object's constructor throws on line 3 of 5. What state is the object in, and what happens to it?
10. Why is defensive copying in a constructor part of construction rather than an optimisation detail?
