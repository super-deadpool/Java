---
title: "The Object Class: toString, getClass, clone, finalize"
phase: 3
order: 1
minutes: 25
summary: "Every Java class inherits eleven methods whether you want them or not. What each is for, which ones you must override, and which ones are historical mistakes."
tags: ["object", "tostring", "getclass", "clone", "finalize"]
---

## 1. Concept

Every class implicitly extends `java.lang.Object`. Even `interface` types are assignable to `Object`, and arrays are objects too. `Object` declares eleven methods, and they fall into four groups:

| Group | Methods | Your job |
| --- | --- | --- |
| Value semantics | `equals`, `hashCode`, `toString` | Override together, consistently (Module 3.2) |
| Reflection | `getClass` | `final` — you cannot override it |
| Copying | `clone` | Avoid; use a copy constructor or a record |
| Concurrency | `wait`, `notify`, `notifyAll` | `final`; use `java.util.concurrent` instead (Phase 24) |
| Lifecycle | `finalize` | Deprecated for removal. Never use |

The default implementations are identity-based: `equals` is `==`, `hashCode` is derived from object identity, `toString` is `getClass().getName() + "@" + Integer.toHexString(hashCode())`.

## 2. Why Java has it

A single root class gives the language a universal type for containers and APIs written before generics, a place to hang the object protocol the runtime needs (identity hash, monitor, class access), and a guaranteed baseline: any object can be printed, compared, hashed and locked. The cost is that every class carries methods it may have no business having — `wait`/`notify` on a `String` is meaningless but legal.

## 3. Mental model

> `Object` is the **runtime's interface to your object**: identity, class, hash, monitor. Three of its methods (`equals`/`hashCode`/`toString`) are contracts *you* are expected to implement; the rest are plumbing you should mostly leave alone.

## 4. `toString()`

```java
// Default: com.acme.Order@1b6d3586  — useless in a log
public record Order(long id, String customer, long amountMinor) { }
// records generate: Order[id=1, customer=alice, amountMinor=500]
```

For non-records, write one by hand and include the fields that identify the object — but **never include secrets, credentials or full personal data**, because `toString` output ends up in logs. A good `toString` is a debugging tool; it is not a serialisation format, and code should never parse it.

## 5. `getClass()` and the Class object

```java
Object o = "hi";
Class<?> c = o.getClass();            // class java.lang.String — the RUNTIME class
System.out.println(c.getName());      // java.lang.String
System.out.println(String.class == c);// true — one Class object per (class, loader)
System.out.println(int.class);        // int — primitives have Class objects too
System.out.println(new int[0].getClass().getName());  // [I
```

`getClass()` is `final` and `native`: **[HotSpot]** it reads the class word from the object header. It is the basis of reflection (Phase 18) and the correct tool inside `equals` when you want strict class equality (Module 3.2 §9).

## 6. `clone()` — and why to avoid it

```java
public class Point implements Cloneable {          // marker interface; without it: CloneNotSupportedException
    int x, y;
    @Override public Point clone() {
        try { return (Point) super.clone(); }      // Object.clone: field-by-field shallow copy
        catch (CloneNotSupportedException e) { throw new AssertionError(e); }
    }
}
```

The problems, which are the interview answer:

1. **`Cloneable` declares no `clone()` method.** It is a marker that changes the behaviour of a `protected` method on `Object` — an interface that modifies a superclass method's behaviour, which is not how interfaces work anywhere else.
2. **The copy is shallow.** Mutable fields are shared between original and copy unless you deep-copy them yourself.
3. **`clone()` does not run constructors.** `final` fields cannot be reassigned in `clone`, so classes with final mutable fields cannot implement it correctly.
4. **The contract is vague** — `x.clone() != x` and `x.clone().getClass() == x.getClass()` are "typically true", not required.

**Use instead:** a copy constructor `Point(Point other)`, a static factory `Point.copyOf(p)`, a record with `with`-style factories, or simply immutability, which makes copying unnecessary.

## 7. `finalize()` — history

Intended as a destructor-like hook. It was unreliable (no guarantee it ever runs, or when), a security hazard (finalizer attacks can resurrect a partially constructed object), and a performance problem (finalizable objects survive at least two GC cycles). Deprecated in Java 9, disabled by default in Java 18, and slated for removal.

Modern replacements, in order of preference: **`AutoCloseable` + try-with-resources** (deterministic, Phase 7); **`java.lang.ref.Cleaner`** (a safety net registered against a phantom reference, for native memory); nothing else.

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> there is no common base class; you get value semantics, copy constructors, <code>operator==</code> and destructors, all under your control and all deterministic. RTTI is opt-in.</p>
<p><strong>Java:</strong> one mandatory root supplying identity, hash, monitor and runtime class. No destructor exists at all — <code>finalize()</code> was never one, and treating it as one is the single most damaging assumption a C++ programmer brings to Java resource handling.</p>
<p><strong>Mapping:</strong> destructor → <code>close()</code> + try-with-resources; copy constructor → copy constructor (Java's is just a normal constructor, nothing implicit); <code>operator==</code> → <code>equals</code>; <code>std::hash</code> → <code>hashCode</code>; <code>operator&lt;&lt;</code> → <code>toString</code>; <code>typeid</code> → <code>getClass()</code>.</p>
</div>

## 8. Edge cases

```java
System.out.println(new int[]{1,2}.toString());       // [I@1b6d3586 — arrays don't override toString
System.out.println(Arrays.toString(new int[]{1,2})); // [1, 2]

Object o = new Object();
synchronized (o) { o.wait(100); }    // legal on any object — the monitor lives in the header

System.out.println("x".getClass());                  // class java.lang.String
System.out.println(new ArrayList<String>().getClass().getName()); // java.util.ArrayList (erased)

record R(int a) {}
System.out.println(new R(1).equals(new R(1)));       // true — records generate equals/hashCode/toString
```

`System.identityHashCode(o)` gives the identity hash even when `hashCode()` is overridden — useful in debugging when you need to know whether two references are the same object.

## 9. Common mistakes

- Overriding `equals` but not `hashCode` (Module 3.2 — the single most common Java bug).
- Logging an object whose `toString` leaks tokens, passwords or PII.
- Implementing `Cloneable` instead of writing a copy constructor.
- Using `finalize` for cleanup, or assuming GC will close your files and sockets.
- Calling `wait`/`notify` directly instead of using `BlockingQueue`, `CountDownLatch` or a `Condition`.
- Parsing `toString()` output in production code.

## 10. Interview questions

**Beginner** — 1. Which methods does every object inherit? 2. What does the default `toString` print? 3. Why override `toString`?

**Intermediate** — 4. Why is `getClass()` final? 5. What does `Cloneable` actually declare? 6. What is the difference between a shallow and a deep copy in Java? 7. Why is `finalize` deprecated?

**Advanced** — 8. Where do `hashCode`'s identity value and the object's monitor physically live? 9. What is a finalizer attack? 10. Compare `Cleaner`, `finalize` and try-with-resources. 11. Why can `clone()` not initialise `final` fields?

**Senior** — 12. Design a class holding a native pointer that must be released. What do you use and what do you guarantee? 13. Why did Java put `wait`/`notify` on `Object` rather than on a `Monitor` type, and what is the modern alternative? 14. What does it cost the JVM to give every object an identity hash and a monitor?

## 11. Follow-ups to expect

- *After Q4:* "So how do you fake a `getClass` override?" → you don't; that is the point — `equals` can rely on it.
- *After Q8:* "What happens to the header when you call `hashCode()` on an object HotSpot has biased or locked?" → the identity hash is stored in the mark word, which forces the lock state to change.
- *After Q12:* "What is the failure mode if the caller forgets to close?" → `Cleaner` as a backstop, plus leak detection in logs.

## 12. Exercise

Take a mutable `Person { String name; List<String> emails; }`. Implement (a) `Cloneable`, (b) a copy constructor, (c) an immutable record version. Write a test that mutates the original's `emails` list and asserts what each copy sees. Then explain which one you would ship and why.

## 13. Output prediction

```java
class A { }
class B { @Override public String toString() { return "B!"; } }
public class Main {
    public static void main(String[] args) {
        System.out.println(new A());
        System.out.println(new B());
        System.out.println(new B[]{new B()});
        System.out.println(Arrays.toString(new B[]{new B()}));
        System.out.println(new A().equals(new A()));
        Object x = new A();
        System.out.println(x.equals(x));
    }
}
```

```java
class Res implements AutoCloseable {
    private final String n;
    Res(String n) { this.n = n; System.out.println("open " + n); }
    @Override public void close() { System.out.println("close " + n); }
}
public class Main {
    public static void main(String[] args) {
        try (Res a = new Res("a"); Res b = new Res("b")) {
            System.out.println("body");
        }
    }
}
```

## 14. Mastery check

1. List `Object`'s methods and mark which are `final` and why.
2. What exactly does the default `hashCode` return, and where is it stored?
3. Give four concrete reasons `clone()` is discouraged.
4. What replaced `finalize()`, and what guarantee does each replacement give?
5. Why can any object be used as a lock, and what does that cost?
6. When is `getClass()` the right tool inside `equals`, and when is `instanceof` better?
7. What should never appear in a `toString()`?
8. Why do arrays print as `[I@...` and what do you use instead?
9. What is `System.identityHashCode` for?
10. Name the C++ construct each of `equals`, `hashCode`, `toString`, `getClass` and `close` corresponds to.
