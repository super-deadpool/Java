---
title: "Type Erasure, Bridge Methods, and Heap Pollution"
phase: 6
order: 3
minutes: 35
summary: "What the compiler actually deletes, what it inserts to compensate, and the exact list of things you cannot do because of it."
tags: ["erasure", "bridge-methods", "heap-pollution", "reification", "varargs"]
---

## 1. Concept

**Erasure** is the compile-time process that removes generic type information:

- Every type parameter is replaced by its **leftmost bound**, or `Object` if unbounded. `Box<T>` → `Box` with fields of type `Object`; `Box<T extends Number>` → fields of type `Number`.
- Casts are inserted at every point where a generic value is read.
- **Bridge methods** are generated where erasure would otherwise break overriding.

The result: `List<String>` and `List<Integer>` are the same runtime class, and there is no way to ask an object what its type argument was.

```java
List<String> a = new ArrayList<>();
List<Integer> b = new ArrayList<>();
System.out.println(a.getClass() == b.getClass());   // true
```

A type is **reifiable** if its full type information survives to run time: primitives, non-generic types, raw types, unbounded wildcards (`List<?>`), and arrays of reifiable types. Everything else — `List<String>`, `T`, `List<? extends Number>` — is **non-reifiable**, and every restriction below follows from that.

## 2. Why Java did this

Migration compatibility, in 2004. Millions of lines of pre-generics code and a vast body of compiled class files had to keep working, and a generified `Collection` had to be the *same type* as the old one so that old code could pass a `List` to new code and vice versa. Reified generics (C# went that way in 2005) would have required either a parallel set of collection types or a breaking change to the JVM.

The trade was explicit: **source and binary compatibility now, in exchange for permanent limitations.** Whether it was the right call is a legitimate interview discussion; that it was a deliberate engineering decision, not an oversight, is the point to make.

## 3. Mental model

> The compiler enforces generics and then **throws the evidence away**. The JVM sees the same code Java 1.4 would have written, casts and all. Anything that needs the type argument at run time cannot work.

## 4. The complete list of consequences

```java
class Box<T> {
    // 1. Cannot instantiate a type parameter
    // T make() { return new T(); }

    // 2. Cannot create an array of a type parameter or a parameterised type
    // T[] arr = new T[10];
    // List<String>[] lists = new List<String>[10];

    // 3. Cannot use instanceof with a parameterised type
    // boolean f(Object o) { return o instanceof List<String>; }
    boolean g(Object o) { return o instanceof List<?>; }        // OK: unbounded wildcard is reifiable

    // 4. Cannot get a class literal
    // Class<?> c = List<String>.class;
    Class<?> ok = List.class;

    // 5. Cannot use a type parameter in a static context
    // static T shared;

    // 6. Cannot overload on erased signatures
    // void f(List<String> l) {}
    // void f(List<Integer> l) {}

    // 7. Cannot catch or throw a generic exception type
    // <E extends Exception> void h() throws E {}   // declaring is fine
    // catch (E e) {}                               // catching is not
}
```

### Workarounds

```java
// 1 & 4: pass the type as a value — a Class token or a factory
class Box<T> {
    private final Class<T> type;
    Box(Class<T> type) { this.type = type; }
    T make() throws Exception { return type.getDeclaredConstructor().newInstance(); }
    T cast(Object o) { return type.cast(o); }           // checked cast at run time
}
class Box2<T> {
    private final Supplier<T> factory;                  // usually better than reflection
    Box2(Supplier<T> factory) { this.factory = factory; }
}

// 2: use a List, or an Object[] plus an unchecked cast confined to one place
@SuppressWarnings("unchecked")
T[] toArray(int n) { return (T[]) new Object[n]; }      // works only if T[] never escapes as T[]

// The safe version, and what the JDK does:
T[] toArray(T[] a) { ... }                              // caller supplies the array with the real type
```

**[JDK]** `ArrayList` stores `Object[] elementData` internally and casts on read; `Arrays.copyOf(array, n, arrayType)` uses reflection on the array's runtime class to create the right type. Both are the professional versions of the workaround.

## 5. Bridge methods

Erasure would break overriding whenever a subclass narrows a generic signature, so `javac` inserts a synthetic **bridge method** with the erased signature that delegates to yours:

```java
class Node<T> {
    public void set(T value) { }
}
class StringNode extends Node<String> {
    @Override public void set(String value) { }
}
// After erasure, Node.set has signature set(Object). StringNode.set(String) does NOT override it.
// javac emits into StringNode:
//     public synthetic bridge void set(Object o) { set((String) o); }
```

That bridge is why this compiles and throws at run time:

```java
Node raw = new StringNode();
raw.set(42);      // calls the bridge → (String) 42 → ClassCastException inside the bridge
```

Covariant return types generate bridges too (Module 2.2 §7). Bridges are marked `ACC_BRIDGE | ACC_SYNTHETIC`, are visible to reflection (which is why `getMethods()` sometimes returns two `set` methods), and are the mechanism behind `Comparable<T>`, `Comparator<T>` and every functional interface.

## 6. Heap pollution and unchecked warnings

**Heap pollution** is a variable of parameterised type referring to an object that is not of that type. It happens whenever an unchecked operation is allowed:

```java
List<String> strings = new ArrayList<>();
List raw = strings;                  // unchecked
raw.add(42);                         // heap pollution: a List<String> now contains an Integer
String s = strings.get(0);           // ClassCastException — thrown at a line that looks innocent
```

The failure surfaces **far from its cause**, which is exactly why "unchecked" warnings must be understood, not suppressed by reflex.

### Generic varargs

```java
@SafeVarargs                                    // asserts: I do not store into or expose the array
static <T> List<T> listOf(T... items) {         // creates a T[] — a non-reifiable array!
    return Arrays.asList(items);
}

static <T> T[] unsafe(T... items) { return items; }         // leaks the array — genuinely unsafe
String[] arr = unsafe("a", "b");    // ClassCastException: [Ljava.lang.Object; cannot be cast to [Ljava.lang.String;
```

A varargs method with a non-reifiable parameter type always creates an `Object[]` at the call site. `@SafeVarargs` (only legal on `static`, `final`, or `private` methods, since the promise cannot bind subclasses) silences the warning and asserts two things: the method never stores anything into the varargs array, and never lets the array escape.

## 7. What survives erasure

Erasure removes type arguments from *values*, not from *declarations*. Generic signatures of classes, fields and methods are preserved in the class file's `Signature` attribute — which is how:

- `javac` type-checks against a compiled library it has no source for;
- reflection can report `List<String>` via `Method.getGenericReturnType()`;
- frameworks like Jackson and Spring resolve `List<Order>` for a field or method (they read the declaration, not the object).

```java
class Holder { List<String> names; }
var f = Holder.class.getDeclaredField("names");
System.out.println(f.getType());          // interface java.util.List        (erased)
System.out.println(f.getGenericType());   // java.util.List<java.lang.String> (Signature attribute)
```

This distinction is the crisp answer to "is generic information really gone?": **gone from objects, retained on declarations.** The `TypeToken`/`ParameterizedTypeReference` trick used by Guava and Spring exploits it — an anonymous subclass captures the type argument in its superclass declaration:

```java
var type = new TypeToken<List<String>>() {}.getType();   // an anonymous class whose SUPERCLASS
                                                         // signature records List<String>
```

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> each template instantiation is a distinct, complete type with its own machine code, layout and RTTI. <code>typeid(vector&lt;int&gt;) != typeid(vector&lt;double&gt;)</code>, and the optimiser sees concrete types.</p>
<p><strong>Java:</strong> one class, one method body, no per-instantiation code. <code>List&lt;String&gt;.class</code> does not exist. This costs you specialisation and primitive support; it buys you constant code size, fast compilation, and 2004-era backward compatibility.</p>
</div>

| Question | C++ | Java |
| --- | --- | --- |
| Does `T` exist at run time? | Yes | No (only in declarations) |
| `new T()` | Yes | Needs a `Class<T>` or `Supplier<T>` |
| `T[]` creation | Yes | No — the array workaround above |
| Same class for all instantiations? | No | Yes |
| Code bloat | Real concern | None |
| Primitive specialisation | Free | Impossible (boxing, or `IntStream`-style duplicate APIs) |
| Error timing | At instantiation | At declaration |

## 9. Common mistakes

- `@SuppressWarnings("unchecked")` on a whole method instead of the narrowest possible declaration.
- Returning `(T[]) new Object[n]` from a public method — it throws in the *caller*.
- `@SafeVarargs` on a method that does store into the array.
- Expecting `instanceof List<String>` to work.
- Assuming reflection cannot see generics at all (it can — on declarations).
- Overloading on generic parameters and hitting "same erasure" errors without understanding why.

## 10. Interview questions

**Beginner** — 1. What is type erasure? 2. What does `List<String>.getClass()` return? 3. Why can't you do `new T()`?

**Intermediate** — 4. List five things erasure makes impossible. 5. What is a bridge method? 6. Why can't you overload on `List<String>` and `List<Integer>`? 7. What is a reifiable type?

**Advanced** — 8. What is heap pollution? Produce it in four lines. 9. What does `@SafeVarargs` assert, and where may it be applied? 10. How can Jackson deserialize into `List<Order>` if generics are erased? 11. What exactly does the `Signature` attribute store?

**Senior** — 12. Why did Java choose erasure? What did reification cost C#? 13. Explain the `TypeToken` idiom mechanically. 14. What would Valhalla + specialised generics change? 15. Debug: a `ClassCastException` in a line with no visible cast.

## 11. Follow-ups

- *After Q5:* "Show me the `javap` output." Then: "how does that produce a `ClassCastException` from raw-typed code?"
- *After Q10:* "So what does `new TypeReference<List<Order>>() {}` actually do?"
- *After Q12:* "What is the cost of C#'s approach?" → runtime support, JIT specialisation per value type, no free interop with pre-generic assemblies.

## 12. Exercise

1. Write `class Pair<A, B>` and disassemble it with `javap -c -p`. Identify the erased field types.
2. Write `class StringPair extends Pair<String, String>` overriding a setter; find the bridge method in `javap -c`.
3. Produce a `ClassCastException` from `StringPair` using only raw types — no explicit cast anywhere in your source.
4. Write a generic `toArray` that works correctly, using the caller-supplied-array technique, and explain why the naive version fails.

## 13. Output prediction

```java
public class Main {
    static <T> T[] toArray(T... items) { return items; }
    public static void main(String[] args) {
        System.out.println(new ArrayList<String>().getClass() == new ArrayList<Integer>().getClass());
        List<String> l = new ArrayList<>();
        List raw = l;
        raw.add(42);
        System.out.println(l.size());
        try { String s = l.get(0); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        try { String[] a = toArray("x", "y"); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 14. Mastery check

1. Define erasure precisely: what is replaced, with what, and what is inserted.
2. Define reifiable and give four reifiable and four non-reifiable types.
3. List seven things erasure forbids, with a workaround for each where one exists.
4. What is a bridge method, what flags does it carry, and what two features generate them?
5. Produce heap pollution and explain why the exception appears where it does.
6. What two promises does `@SafeVarargs` make, and why is it restricted to static/final/private methods?
7. What survives erasure, and how do frameworks exploit it?
8. Explain the `TypeToken` idiom mechanically, not by analogy.
9. Why did Java choose erasure in 2004, and what was the alternative's cost?
10. Given a `ClassCastException` in a line containing no cast, how do you find the real cause?
