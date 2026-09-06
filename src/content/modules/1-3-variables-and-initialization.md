---
title: "Variables, Initialization Order, and final"
phase: 1
order: 3
minutes: 30
summary: "Default values, definite assignment, the exact order the JVM runs static blocks, instance initializers and constructors — and why Java's final is nothing like C++'s const."
tags: ["variables", "final", "initialization", "static", "scope"]
---

## 1. Concept

Java has four places a variable can live, and they differ in *who zeroes them*, *when they are created*, and *how long they live*:

| Kind | Declared | Default value | Lives in | Lifetime |
| --- | --- | --- | --- | --- |
| **Local variable** | inside a method/block | **none** — must be definitely assigned before use | the stack frame (a slot) | the frame |
| **Parameter** | method signature | assigned by the caller | the stack frame | the frame |
| **Instance field** | class body, non-static | zeroed (`0`/`false`/`null`) | inside the object, on the heap | as long as the object is reachable |
| **Static field** | class body, `static` | zeroed at *preparation* | with the `Class` object (metaspace-adjacent) | as long as the class (and its loader) is alive |

The asymmetry is deliberate: fields are zeroed because an object's memory is wiped on allocation, and reading a partially built object must not expose garbage. Locals are *not* zeroed; instead `javac` enforces **definite assignment** (JLS §16) and refuses to compile a read of a possibly-unassigned local. Java swaps a runtime hazard for a compile-time proof.

## 2. Why Java has it

Zeroed memory plus a verifier means **no uninitialised reads, ever** — the single most common source of nondeterministic C++ bugs simply does not exist. Definite-assignment analysis extends the guarantee to locals without paying for zeroing every stack slot.

`final` exists for a different reason: it is about **assignment**, not about the object, and it exists mostly so that (a) intent is checked, (b) lambdas and inner classes can capture safely, and (c) the JMM can give you the **final-field freeze guarantee** — a correctly constructed object with final fields is safely visible to other threads without synchronisation (Phase 25).

## 3. Mental model

> Fields are born zeroed; locals are born *forbidden*. `final` freezes the **variable**, never the **object**. And an object is fully built only after the constructor of its *most derived* class returns — everything before that is a partially constructed object that Java will nevertheless happily let you leak.

## 4. Syntax

```java
public class Account {
    static final int MAX = 10;              // compile-time constant, inlined at use sites
    static int openCount;                   // 0 at class preparation
    static { openCount = load(); }          // static initializer, runs once at class init

    private final String id;                // blank final: must be assigned exactly once per constructor
    private long balanceMinor;              // 0L before any constructor body runs
    private final List<Txn> txns = new ArrayList<>();   // instance initializer, runs per object

    { balanceMinor = 0; }                   // instance initializer block (rare; prefer constructors)

    Account(String id) {
        this.id = id;                       // 'this.id' distinguishes field from parameter
    }
}
```

## 5. Minimal example — the order, printed

```java
class Parent {
    static { System.out.println("1 parent static"); }
    { System.out.println("3 parent instance init"); }
    Parent() { System.out.println("4 parent ctor"); }
}

class Child extends Parent {
    static { System.out.println("2 child static"); }
    { System.out.println("5 child instance init"); }
    Child() { System.out.println("6 child ctor"); }
}

new Child();
```

Output is exactly `1 2 3 4 5 6`. Memorise the rule that generates it, not the sequence:

1. **All static initialisation, superclass first**, once per class, at first active use.
2. Then per object: allocate + zero all fields → `super(...)` runs to completion → **this class's** instance initialisers and field initialisers in source order → this class's constructor body.

## 6. Realistic example — the trap the order creates

```java
public class Base {
    Base() {
        init();                       // calling an overridable method from a constructor
    }
    protected void init() { }
}

public class Derived extends Base {
    private final List<String> items = new ArrayList<>();
    private int limit = 10;

    @Override protected void init() {
        items.add("first");           // NullPointerException
        System.out.println(limit);    // would print 0, not 10
    }
}
```

`Base`'s constructor runs *before* `Derived`'s field initialisers, so `items` is still `null` and `limit` is still `0`. This is the Java form of the C++ rule that virtual dispatch during base construction resolves to the base — except **Java does the opposite and dispatches to the derived override**, which is strictly more dangerous.

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> during a base-class constructor, the object's dynamic type <em>is</em> the base. A virtual call resolves to the base implementation; the derived override cannot see uninitialised derived members.</p>
<p><strong>Java:</strong> the object has its final type from allocation. A virtual call from a base constructor dispatches to the <strong>derived override</strong>, which then reads its own not-yet-initialised fields — <code>null</code> and <code>0</code>. Even <code>final</code> fields read as their defaults here.</p>
<p><strong>Rule:</strong> never call an overridable method from a constructor. Make it <code>final</code>, <code>private</code>, or <code>static</code>, or move the work to a factory method that constructs then initialises.</p>
</div>

The related sin is **leaking `this` from a constructor**:

```java
public class Listener {
    public Listener(EventBus bus) {
        bus.register(this);      // another thread may now see a half-built Listener
    }
}
```

Publish in a static factory after construction completes instead.

## 7. What happens internally

**[JVMS]** Static and instance initialisation are not language-only concepts; they become two synthetic methods:

- `<clinit>` — one per class, containing all static initialiser blocks and static field initialisers in source order. Invoked by the JVM (never by bytecode you write) at class initialisation, under a per-class lock, exactly once.
- `<init>` — one per constructor. Every `<init>` must begin with a call to another `<init>`: `this(...)` or `super(...)`, explicit or compiler-inserted. Field initialisers and instance blocks are **copied by `javac` into each constructor**, right after the `super(...)` call and before the constructor body. That copying *is* the initialisation order rule.

You can see it:

```text
$ javap -c Child.class
  Child();
    Code:
       0: aload_0
       1: invokespecial #1   // Method Parent."<init>":()V
       4: aload_0
       5: ...                // instance initializer + field initializers, inlined here
      12: ...                // constructor body
```

**[JVMS]** Object allocation (`new`) zeroes the whole instance before `<init>` runs — hence "fields are born zeroed". **[HotSpot]** allocation is a pointer bump in a thread-local allocation buffer (TLAB), and the zeroing is often folded into the write of the fields that immediately follow.

**Locals [JVMS]:** a stack frame has an array of slots; `long` and `double` occupy two. Nothing is zeroed; the verifier rejects any read of a slot not provably written. The `LocalVariableTable` carrying names is optional debug info.

**Constant fields [JLS §13.1]:** as in Module 1.1, `static final` of primitive or `String` type with a constant initialiser is inlined into readers and does **not** trigger class initialisation.

## 8. C++ comparison

| Concern | C++ | Java |
| --- | --- | --- |
| Uninitialised read | UB, silent | Impossible: fields zeroed, locals proven assigned |
| Member init order | **Declaration order**, member-init-list order is ignored (with a warning) | Source order of initialisers, after `super()` |
| Base construction | Base ctor runs first; virtual calls resolve to base | Super ctor runs first; virtual calls resolve to **override** |
| `const` member | Deep-ish immutability, `const` methods, `const` propagation | `final` field only forbids reassignment. `final List` is fully mutable |
| `constexpr` | Real compile-time evaluation | Only "compile-time constant expressions" (primitives + `String`) |
| Static locals | `static` inside a function, initialised on first use, thread-safe since C++11 | No such thing. Use a private static field or a holder class |
| Static init order across TUs | The **static initialisation order fiasco** | Solved: lazy, per-class, on first active use |
| Destruction | Deterministic, RAII | None. GC + `try-with-resources` for resources (Phase 7) |
| Shadowing a member with a local | Allowed | Allowed — hence `this.x = x` in constructors |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Reading <code>final</code> as <code>const</code>.</strong> <code>final Map&lt;String,String&gt; m</code> means you cannot reassign <code>m</code>; you can still <code>m.clear()</code>. Java has no <code>const</code> method, no <code>const&amp;</code> parameter, no transitive immutability. Immutability is a design job (Phase 5), not a keyword.</p>
<p><strong>Expecting deterministic cleanup at scope exit.</strong> There is none. Anything with a resource must be closed explicitly.</p>
<p><strong>Expecting the member-initialiser-list rule.</strong> In Java there is no init list; order is source order of the field declarations and initialiser blocks.</p>
<p><strong>Assuming a virtual call in a constructor is safe because C++ makes it safe.</strong> It is the opposite in Java.</p>
</div>

## 9. Edge cases

```java
class A {
    static int x = getX();       // runs during <clinit>
    static int y = 5;
    static int getX() { return y + 1; }   // y is still 0 here → x == 1
}
```

Static initialisers run **in source order**, so a static method called from an earlier initialiser sees later fields at their default. Reordering two lines changes the answer.

```java
class B {
    static final int C1 = 10;            // compile-time constant
    static final int C2;                 // blank static final
    static { C2 = compute(); }           // must be assigned exactly once in <clinit>
}
```

```java
public class Loop {
    public static void main(String[] args) {
        for (int i = 0; i < 3; i++) {
            int local;                   // a *new* variable each iteration
            local = i;
        }
        // int z; System.out.println(z);  // does not compile: not definitely assigned
    }
}
```

```java
int x;
if (args.length > 0) x = 1;
System.out.println(x);   // does not compile — the compiler proves nothing about the else path

final int y;
if (args.length > 0) y = 1; else y = 2;   // fine: definitely assigned exactly once on every path
```

Two more worth knowing:

- **Class initialisation deadlock:** two classes whose `<clinit>` reference each other, initialised concurrently by two threads, can deadlock permanently — each holds one class's init lock.
- **A failed `<clinit>` poisons the class forever.** The first failure throws `ExceptionInInitializerError`; every later use throws `NoClassDefFoundError` with no cause. Log-hunting rule: find the *first* one.

## 10. Common mistakes

- Calling an overridable method from a constructor (§6).
- Publishing `this` before the constructor completes.
- Treating `final` as immutability.
- Mutable `public static` state — a lazily-initialised global with no synchronisation is the classic race; use a holder class or an `enum` singleton (Phase 15).
- Depending on static initialisation order across classes.
- Shadowing a field with a local and forgetting `this.`, so the assignment silently goes nowhere: `void setId(String id) { id = id; }`.
- Non-`static` inner class holding an implicit reference to the outer instance and keeping it alive (Phase 16, and a real leak shape in Phase 23).

## 11. Interview questions

**Beginner**
1. What are the default values of fields, and why do locals not have them?
2. What does `final` mean on a field, on a local, on a parameter?
3. When does a static initialiser run?

**Intermediate**
4. Give the exact initialisation order for `new Child()` where `Child extends Parent`, including static blocks.
5. Why does the compiler reject reading a local that "obviously" gets assigned?
6. What is a blank final and where must it be assigned?
7. What is wrong with calling an overridable method from a constructor?

**Advanced**
8. Where do field initialisers physically live in bytecode, and what does that imply if a class has three constructors?
9. Explain a class-initialisation deadlock and how you would diagnose one from a thread dump.
10. `static final int` versus `static final Integer` versus `static final int` assigned in a static block — which are inlined into callers, and which trigger class initialisation?
11. What does the JMM guarantee about `final` fields, and what breaks that guarantee?

**Senior / deep dive**
12. Design a thread-safe lazily-initialised singleton without `synchronized` on every access. Justify it in terms of class initialisation semantics.
13. A field is `final` and set in the constructor, but another thread sometimes sees `null`. How is that possible?
14. Why is Java's constructor-dispatch rule (dispatch to the override) arguably worse than C++'s, and what design guidance follows?
15. How does static state interact with class loaders in an application server, and what leak does that cause on redeploy?

## 12. Follow-up questions to expect

- *After Q4:* "Now add a `this(...)` delegating constructor — where do the field initialisers run?" (Answer involves: only once, in the constructor that calls `super()`.)
- *After Q7:* "How would you redesign an API that needs post-construction setup?" → static factory, builder, two-phase init behind a factory.
- *After Q11:* "Does that guarantee cover the *contents* of a final `List` field?" → only what was reachable and written before the constructor completed; the list's later mutations are unprotected.
- *After Q12:* "Compare the holder-class idiom, `enum` singleton, and double-checked locking with `volatile`." → all three, plus why DCL needs `volatile` (Phase 25).
- *After Q13:* "What is unsafe publication, and what fixes it?" → escaping `this`, non-final field, publication via a data race.

## 13. Coding exercise

```java
public class Ledger {
    public static final Ledger INSTANCE = new Ledger();
    private static final long OPENING_BALANCE = 1_000L;
    private final long balance;

    private Ledger() { this.balance = OPENING_BALANCE; }
    public long balance() { return balance; }
}
```

1. Predict `Ledger.INSTANCE.balance()`. Now swap the order of the first two fields and predict again. Run both.
2. Explain the result strictly in terms of `<clinit>` source order and §9's first example. Which value is a compile-time constant and does that change the answer?
3. Rewrite `Ledger` so the order of declarations cannot affect correctness. Give two ways.
4. Now make `INSTANCE` lazily initialised without `synchronized`, and explain why your version is thread-safe using class-initialisation semantics.

## 14. Output prediction

**A**
```java
class P {
    P() { print(); }
    void print() { System.out.println("P"); }
}
class C extends P {
    private final String name = "C";
    @Override void print() { System.out.println(name + "/" + name.length()); }
}
public class Main { public static void main(String[] a) { new C(); } }
```

**B**
```java
public class Main {
    static int a = f("a", 1);
    static { System.out.println("block, b=" + b); }
    static int b = f("b", 2);
    static int f(String n, int v) { System.out.println("init " + n); return v; }
    public static void main(String[] args) { System.out.println(a + " " + b); }
}
```

**C**
```java
public class Main {
    private int x = 1;
    { x = 2; }
    Main() { x = 3; }
    Main(int ignored) { this(); x = 4; }
    public static void main(String[] args) {
        System.out.println(new Main().x + " " + new Main(0).x);
    }
}
```

**D**
```java
class Holder {
    static final Holder SELF = new Holder();
    static int counter = 10;
    final int snapshot;
    Holder() { snapshot = counter; }
}
public class Main {
    public static void main(String[] args) { System.out.println(Holder.SELF.snapshot); }
}
```

## 15. Mastery check

1. Why are instance fields zeroed but locals not? What replaces zeroing for locals?
2. Write the complete initialisation order for `new Child()` including both classes' static blocks, and say which parts run once versus per instance.
3. Where does `javac` place instance field initialisers, and what does that mean for a class with a `this(...)` delegating constructor?
4. Give a concrete case where a `final` field is observed as `0` or `null`.
5. State three differences between Java `final` and C++ `const` that change how you design an API.
6. What is the "static initialisation order fiasco" in C++, and precisely which Java mechanism makes it impossible?
7. Explain why `ExceptionInInitializerError` appears once and `NoClassDefFoundError` afterwards.
8. Why is calling an overridable method from a constructor safe-ish in C++ and dangerous in Java?
9. What is the lifetime of a static field, and what keeps it alive? Name the leak this causes in a redeployable application server.
10. Describe the final-field freeze guarantee and one way to defeat it.
