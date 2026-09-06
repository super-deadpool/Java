---
title: "Nested classes: the four kinds, the this$0 field, and the leak it causes"
phase: 16
order: 1
minutes: 40
summary: "Static nested versus inner versus local versus anonymous, what each compiles to, how nestmates replaced synthetic accessor methods in Java 11, and the enclosing-instance reference that pins objects in memory."
tags: ["nested-classes", "inner-class", "anonymous-class", "nestmates", "memory-leak"]
---

## 1. The four kinds

```java
class Outer {
    private int x = 1;

    static class StaticNested { }               // 1. static member class — NO enclosing instance
    class Inner { }                             // 2. inner (non-static member) class — HAS one

    void method() {
        class Local { }                         // 3. local class — declared in a block
        Runnable r = new Runnable() {           // 4. anonymous class — declared and instantiated at once
            @Override public void run() { }
        };
    }
}
```

The one distinction that matters more than all the others:

| | Enclosing instance? | Created with |
| --- | --- | --- |
| **Static nested** | ❌ | `new Outer.StaticNested()` |
| **Inner** | ✅ implicit `this$0` | `outer.new Inner()` |
| **Local** | ✅ if declared in an instance context | `new Local()` inside the method |
| **Anonymous** | ✅ if in an instance context | the expression itself |

```java
Outer.StaticNested a = new Outer.StaticNested();       // no Outer needed
Outer o = new Outer();
Outer.Inner b = o.new Inner();                         // the qualified-new syntax nobody remembers
```

## 2. Why Java has them

Three separate motivations, and knowing which applies tells you which kind to use:

- **Namespacing and cohesion.** `Map.Entry` belongs to `Map`; `LinkedList.Node` belongs to `LinkedList`. This wants a **static nested** class.
- **A helper that is logically part of one object's state.** `LinkedList`'s iterator must see the list's fields and `modCount`. This wants an **inner** class.
- **A one-off implementation of an interface.** Pre-Java-8 this was an **anonymous** class; since Java 8 it is a lambda whenever the interface is functional.

## 3. Inner classes and `this$0`

An inner class instance holds a hidden, `final`, synthetic reference to the instance that created it.

```java
class Outer {
    private int x = 42;
    class Inner {
        private int x = 7;
        void print() {
            System.out.println(x);              // 7    — Inner's
            System.out.println(this.x);          // 7
            System.out.println(Outer.this.x);    // 42   — the qualified-this syntax
        }
    }
}
```

```text
$ javap -p Outer\$Inner
class Outer$Inner {
  private int x;
  final Outer this$0;                           // <-- there it is
  Outer$Inner(Outer);                           // the constructor takes the enclosing instance
}
```

Consequences of `this$0`, all of them things people get wrong:

- **An inner class instance keeps its enclosing instance reachable** for as long as it lives (§6).
- **Serializing an inner class serializes the outer instance too** — or fails, if the outer is not `Serializable`.
- **An inner class costs one extra reference field** per instance.
- **`Outer.this`** is how you reach the enclosing instance explicitly.

**[JLS]** Since **Java 16**, inner classes may declare `static` members (fields, methods, and nested types). Before 16 they could only hold `static final` compile-time constants — a restriction that forced awkward workarounds and was lifted as part of the records work.

## 4. Local and anonymous classes

```java
List<Runnable> makeTasks(String prefix, List<String> items) {
    int count = items.size();                            // effectively final

    class Task implements Runnable {                     // LOCAL: named, reusable within the method
        private final String item;                       // can have constructors and state
        Task(String item) { this.item = item; }
        @Override public void run() { log(prefix + " " + item + " of " + count); }
    }

    Runnable summary = new Runnable() {                  // ANONYMOUS: one instance, no name
        @Override public void run() { log(prefix + ": " + count + " tasks"); }
    };

    var out = new ArrayList<Runnable>();
    items.forEach(i -> out.add(new Task(i)));
    out.add(summary);
    return out;
}
```

Both capture **effectively final** locals by value, exactly as lambdas do (Module 11.1 §4) — the mechanism is the same, and predates lambdas by 20 years.

Anonymous class specifics:

- It **extends a class or implements one interface**, never both, never more than one.
- It has **no constructor** — you cannot declare one. Arguments in `new Superclass(args) { ... }` go to the *superclass* constructor. Use an instance initializer block `{ ... }` for setup.
- It is a **subtype with no nameable type**, so `var a = new Object() { int n = 1; };` is the only way to keep access to its members (Module 14.1 §1).
- Its `getClass().getSimpleName()` is `""`.

**When an anonymous class is still right in a lambda world:** the target is not a functional interface (two abstract methods), you need state, you need to override multiple methods, you need `this` to mean the instance, or you are subclassing an abstract class.

```java
// Not a lambda candidate: two methods
var listener = new MouseAdapter() {
    private int clicks = 0;                              // and it has state
    @Override public void mousePressed(MouseEvent e)  { clicks++; }
    @Override public void mouseReleased(MouseEvent e) { report(clicks); }
};
```

## 5. Realistic example — the iterator that needs to be inner

```java
public class RingBuffer<E> implements Iterable<E> {
    private final Object[] items;
    private int head, size, modCount;

    /** INNER: must read head/size/modCount live, and there is one per RingBuffer instance. */
    private class Cursor implements Iterator<E> {
        private int visited = 0;
        private final int expected = modCount;           // reads the enclosing field directly
        public boolean hasNext() { return visited < size; }
        @SuppressWarnings("unchecked")
        public E next() {
            if (modCount != expected) throw new ConcurrentModificationException();
            return (E) items[(head + visited++) % items.length];
        }
    }
    @Override public Iterator<E> iterator() { return new Cursor(); }

    /** STATIC NESTED: a builder needs no RingBuffer to exist yet. */
    public static final class Builder<E> {
        private int capacity = 16;
        public Builder<E> capacity(int c) { this.capacity = c; return this; }
        public RingBuffer<E> build() { return new RingBuffer<>(capacity); }
    }
}
```

The rule this illustrates: **make it `static` unless it genuinely needs the enclosing instance.** A nested class that never says `Outer.this` and never reads an enclosing instance field should be `static`; IDEs and static analysers flag exactly this.

## 6. The leak

An inner class instance is a strong reference to its outer instance. Whenever the inner instance outlives the outer's intended lifetime, the outer is pinned.

```java
class ReportPage {
    private final byte[] renderedImage = new byte[50 * 1024 * 1024];   // 50 MB

    void schedule() {
        // Inner (anonymous) class -> holds this$0 -> holds renderedImage
        timer.schedule(new TimerTask() {
            @Override public void run() { ping(); }
        }, 0, 60_000);
    }
    void ping() { }
}
```

The `TimerTask` lives on the `Timer`'s queue forever. Its `this$0` keeps the `ReportPage` — and its 50 MB array — alive forever. Nothing in the code references `ReportPage` after `schedule()` returns; the heap dump shows it retained by `Timer → TaskQueue → ReportPage$1 → this$0`.

The same shape, with the same fix, appears as:

- a non-static inner `Runnable`/`Handler`/`Callback` registered with a long-lived service;
- a non-static `Comparator` or `ThreadLocal` stored in a `static` field;
- a lambda that captures `this` implicitly by reading an instance field (Module 11.1 §8) — identical mechanism;
- a non-static inner class placed in a cache.

The fixes, in order of preference:

```java
// 1. Make it static and pass only what it needs
private static final class Pinger extends TimerTask {
    private final Runnable action;
    Pinger(Runnable action) { this.action = action; }
    @Override public void run() { action.run(); }
}

// 2. Keep it inner but hold the outer weakly
private static final class WeakPinger extends TimerTask {
    private final WeakReference<ReportPage> ref;
    @Override public void run() { var p = ref.get(); if (p != null) p.ping(); else cancel(); }
}

// 3. Unregister deterministically — a lifecycle contract, not a hope
```

<div class="note">
<span class="label">Note</span>
<p>This is the single most common Java memory-leak shape after unbounded caches and un-removed listeners, and it is invisible in code review unless you are specifically looking for a missing <code>static</code>.</p>
</div>

## 7. What happens internally

**Every nested class is a separate top-level class file.** There is no nesting in the JVM.

```text
Outer.class
Outer$StaticNested.class
Outer$Inner.class
Outer$1.class              // first anonymous class in Outer
Outer$2.class              // second
Outer$1Local.class         // local class named Local in the first method that declares one
```

`InnerClasses` and `EnclosingMethod` class-file attributes record the source relationship, which is what `getSimpleName()`, `getEnclosingClass()` and `isAnonymousClass()` read.

**Private access across the nest — the Java 11 change.** The JVM has always enforced `private` at class granularity, but `Outer` and `Outer$Inner` are different classes. Before Java 11, javac bridged the gap by generating **synthetic package-private accessor methods**:

```text
// javac 8, for Inner reading Outer's private int x
static int access$000(Outer);              // synthetic, package-private, in Outer
```

That was ugly (extra methods, extra call frames) and, worse, **a real encapsulation hole**: any class in the same package could call `access$000` and read a private field.

**[JVMS]** Java 11 (JEP 181) introduced **nestmates**. The compiler emits two attributes — `NestHost` on each nested class pointing at the top-level class, and `NestMembers` on the host listing them all — and the JVM's access check permits private access between members of the same nest. No synthetic accessors are generated.

```java
Outer.Inner.class.getNestHost();       // class Outer
Outer.class.getNestMembers();          // [Outer, Outer$Inner, Outer$StaticNested, Outer$1, ...]
Outer.Inner.class.isNestmateOf(Outer.class);   // true
```

The same mechanism later carried `PermittedSubclasses` for sealed types (Module 14.2) and is what lets `MethodHandles.privateLookupIn` work.

**Constructor signatures change.** An inner class's constructor takes the enclosing instance as a hidden first parameter, which is visible through reflection and matters when you instantiate one reflectively:

```java
Constructor<Outer.Inner> c = Outer.Inner.class.getDeclaredConstructor(Outer.class);
Outer.Inner i = c.newInstance(new Outer());
```

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>A C++ nested class is exactly Java's <em>static</em> nested class.</strong> It is a scoping device: no hidden pointer, no enclosing instance, no way to reach outer state without being handed a pointer explicitly. Since C++11 a nested class does have access to the enclosing class's private members (a name-lookup permission, not a data connection).</p>
<p><strong>Java's inner class has no C++ equivalent.</strong> The nearest thing is a nested class you always construct with <code>Outer*</code> and store as a member — which is precisely what <code>this$0</code> is, generated for you. Every consequence follows: the lifetime coupling, the leak, and the fact that you cannot create one without an outer object.</p>
<p><strong>C++ local classes</strong> exist, but a local class <em>cannot</em> access the enclosing function's automatic variables at all — no capture. That gap is exactly why lambdas were added in C++11, and why Java's local/anonymous classes (which have captured since 1.1) felt more capable for a long time.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Nested class | Scoping only | `static` nested = the same thing |
| Implicit outer pointer | ✗ | `this$0` on inner classes |
| Access to outer's privates | ✅ since C++11 (lookup) | ✅ via nestmates since Java 11 |
| Local class captures locals | ✗ | ✅ effectively final, by value |
| Anonymous one-off | Lambda | Anonymous class, or a lambda |
| Own class file / symbol | Mangled symbol in the same TU | A separate `.class` file |
| Lifetime coupling | You choose | Automatic and easy to miss |
| Friend-style access | `friend` | Nest membership |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Writing <code>class Inner</code> where you meant <code>static class Inner</code>, because in C++ the nested form has no lifetime implications. In Java that one missing keyword is the difference between a helper and a memory leak.</p>
<p>Expecting <code>new Outer.Inner()</code> to work. It does not — an inner class needs an instance: <code>outer.new Inner()</code>.</p>
</div>

## 9. Edge cases

- **An inner class of a generic class** inherits the type parameters: `Outer<T>.Inner` is the full type name, and `new Outer<String>().new Inner()` is the syntax.
- **A static nested class of a generic class** does **not** see `T` — it needs its own parameter.
- **Anonymous classes can capture but cannot be reused**; every evaluation of the expression allocates.
- **Instance initializer blocks in anonymous classes** produce the "double-brace initialization" idiom, `new ArrayList<>() {{ add("a"); }}` — it creates a subclass, holds `this$0`, breaks `equals` against other lists, and defeats serialization. Never use it.
- **A local class in a static method** has no enclosing instance and so cannot use `Outer.this`.
- **Anonymous classes and generics:** `new TypeReference<Map<String,Integer>>() {}` works precisely *because* the anonymous subclass records its supertype in the class file, defeating erasure (Module 6.3).
- **`getSimpleName()`** is `""` for anonymous, the local name for local, and the simple name for member classes; `getName()` shows the `$` form.
- **You cannot have a `static` method on an inner class before Java 16.**
- **Nested enums, records, and interfaces are implicitly `static`.**
- **Anonymous classes are not `Serializable` in practice** — even when the interface is, the generated name (`Outer$1`) is compilation-order-dependent, so a recompile can break deserialization. Same hazard as serialized lambdas.

## 10. Common mistakes

- Omitting `static` on a nested class that does not need the outer instance.
- Registering a non-static inner listener with a long-lived object and leaking the outer.
- Double-brace initialization.
- Expecting `new Outer.Inner()` to compile.
- Serializing an inner class and getting a `NotSerializableException` naming the *outer* class.
- Using an anonymous class where a lambda is clearer, or a lambda where you needed `this` or state.
- Assuming `this` inside an anonymous class is the outer instance (it is not — that is the lambda rule).
- Capturing a mutable local and being surprised it will not compile.
- Relying on `Outer$1` names in reflection, logs, or serialized data.
- Putting a static nested class's fields in the outer class "because it is all one file".

## 11. Interview questions

**Beginner** — 1. Name the four kinds of nested class. 2. What is the difference between static nested and inner? 3. How do you instantiate an inner class?

**Intermediate** — 4. What is `this$0`? 5. Why does an anonymous class have no constructor? 6. When would you still use an anonymous class over a lambda? 7. What does `Outer.this` mean?

**Advanced** — 8. Explain the inner-class memory leak with a concrete scenario and a heap-dump path. 9. What class files does a file with an inner, a static nested, and two anonymous classes produce? 10. What were `access$000` methods and what replaced them? 11. Why can `new TypeReference<List<String>>() {}` recover the type argument when erasure normally destroys it?

**Senior** — 12. A service leaks ~200 MB/hour; the dominator tree is rooted at a `ScheduledExecutorService`. Walk through diagnosis and the three possible fixes ranked. 13. Explain nestmates: the class-file attributes, the JVM check, and the encapsulation problem they solved. 14. Design the nesting for a `Cache` with a builder, a per-entry node, an eviction policy, and a stats view. Justify static versus inner for each.

## 12. Follow-ups

- *After Q2:* "Which should be the default and why?" → static.
- *After Q4:* "What is its access modifier and is it final?" → package-private synthetic, final.
- *After Q8:* "How do you find it in a heap dump?" → path to GC root through `this$0`.
- *After Q10:* "Why was that an encapsulation hole?" → package-private synthetic accessors.
- *After Q13:* "What else uses nest membership?" → sealed classes, `privateLookupIn`.

## 13. Exercise

1. Write a class with all four nested kinds. Compile it, list the class files, and run `javap -p` on each to find `this$0` and the constructor signatures.
2. Run `javap -v` on Java 8 and Java 17 builds of a class whose inner class reads a private outer field. Find `access$000` in one and `NestHost`/`NestMembers` in the other.
3. Reproduce the §6 leak with a `ScheduledExecutorService` and a 50 MB array. Take a heap dump, find the retention path, then fix it three ways and re-dump each time.
4. Implement `RingBuffer` from §5 with the iterator as a **static** nested class instead, passing what it needs explicitly. Compare the two for correctness under concurrent modification and for readability.
5. Write `new TypeReference<Map<String, List<Integer>>>() {}` and extract the full generic type via `getGenericSuperclass()`. Explain why the anonymous subclass is essential.

## 14. Output prediction

```java
import java.util.*;

public class Main {
    private int x = 1;
    static int s = 10;

    static class Nested { int get() { return s; } }
    class Inner { int x = 2; int outerX() { return Main.this.x; } int innerX() { return x; } }

    void run() {
        int local = 5;
        class Local { int get() { return local + x; } }
        Runnable anon = new Runnable() {
            int x = 3;
            public void run() {
                System.out.println(x + " " + Main.this.x + " " + this.getClass().getSimpleName() + "|");
            }
        };
        System.out.println(new Local().get());
        anon.run();
        System.out.println(anon.getClass().getName());
    }

    public static void main(String[] args) {
        Main m = new Main();
        System.out.println(new Nested().get());

        Main.Inner i = m.new Inner();
        System.out.println(i.innerX() + " " + i.outerX());

        m.run();

        System.out.println(Main.Inner.class.getNestHost().getSimpleName());
        System.out.println(Arrays.toString(Main.Inner.class.getDeclaredFields()));

        var withField = new Object() { int n = 99; };
        System.out.println(withField.n);

        List<String> dbl = new ArrayList<>() {{ add("a"); }};
        System.out.println(dbl + " " + dbl.getClass().getSimpleName() + "|" +
                           dbl.equals(List.of("a")) + " " + List.of("a").equals(dbl));
    }
}
```

## 15. Mastery check

1. Name the four kinds and the enclosing-instance rule for each.
2. What is `this$0` — its type, modifiers, and who sets it?
3. Give the syntax to create an inner class instance and to reach the enclosing instance from inside one.
4. Explain the inner-class leak end to end, including the heap-dump path.
5. Which class files does a compilation unit with two anonymous and one local class produce?
6. What were synthetic accessor methods, what did they cost, and what replaced them?
7. Describe `NestHost`/`NestMembers` and the JVM check that uses them.
8. When is an anonymous class still the right answer over a lambda? Give four cases.
9. Why does `new TypeReference<T>() {}` defeat erasure?
10. Explain double-brace initialization and give three reasons not to use it.
