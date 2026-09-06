---
title: "Class loading: delegation, linking, initialization order, and class identity"
phase: 22
order: 1
minutes: 50
summary: "Loading → verification → preparation → resolution → initialization, the parent-delegation model, why a class's identity includes its loader, and exactly what triggers <clinit>."
tags: ["classloader", "linking", "clinit", "delegation", "metaspace", "jpms"]
---

## 1. Concept

**[JVMS 5.3–5.5]** A class goes through three phases before its first use, and the JVM performs them **lazily**.

```text
LOADING          find the bytes, parse them, create the Class object in the heap
LINKING
  Verification   prove the bytecode is type-safe and cannot corrupt the JVM
  Preparation    allocate static fields and set them to DEFAULT values (0/null/false)
  Resolution     turn symbolic references into direct ones — lazy in HotSpot
INITIALIZATION   run <clinit>: static initializers and static field initializers, in source order
```

Everything about class loading that surprises people comes from the fact that **preparation and initialization are separate steps**, and that initialization happens at a precisely specified moment which is usually later than you expect.

## 2. The class loader hierarchy

**[JDK]** Since Java 9 there are three built-in loaders:

| Loader | Loads | `getClassLoader()` returns |
| --- | --- | --- |
| **Bootstrap** | `java.base` and the other core platform modules | `null` |
| **Platform** (was "extension") | The rest of the JDK's platform modules | a `ClassLoader` |
| **Application** ("system") | Your classpath and module path | a `ClassLoader` |

```java
String.class.getClassLoader();                    // null   — bootstrap
javax.sql.DataSource.class.getClassLoader();      // platform
Main.class.getClassLoader();                      // app: jdk.internal.loader.ClassLoaders$AppClassLoader
ClassLoader.getSystemClassLoader();               // the app loader
ClassLoader.getPlatformClassLoader();             // Java 9+
```

**Parent delegation** is the loading algorithm, and you should be able to write it:

```java
protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {
        Class<?> c = findLoadedClass(name);                  // 1. already loaded by ME?
        if (c == null) {
            try {
                if (parent != null) c = parent.loadClass(name, false);   // 2. ask the PARENT first
                else                c = findBootstrapClassOrNull(name);
            } catch (ClassNotFoundException ignored) { }
            if (c == null) c = findClass(name);              // 3. only now, look myself
        }
        if (resolve) resolveClass(c);
        return c;
    }
}
```

Delegation exists for two reasons, both security-critical:

- **Core classes cannot be replaced.** A `java.lang.String` on your classpath is never loaded, because the bootstrap loader answers first. (Package sealing and the `java.*` prefix restriction back this up: defining a class in a `java.*` package throws `SecurityException`.)
- **Uniqueness.** Every loader in the chain sees the same `java.lang.Object`, so types are compatible across the whole application.

Custom loaders exist to *break* delegation deliberately — a servlet container loads each web application's classes child-first so two apps can use different versions of the same library.

```java
public class PluginLoader extends ClassLoader {
    private final Path dir;
    public PluginLoader(Path dir, ClassLoader parent) { super(parent); this.dir = dir; }

    @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
        try {
            byte[] b = Files.readAllBytes(dir.resolve(name.replace('.', '/') + ".class"));
            return defineClass(name, b, 0, b.length);        // the JVM verifies and links here
        } catch (IOException e) { throw new ClassNotFoundException(name, e); }
    }
}
```

## 3. Class identity includes the loader

**[JVMS 5.3]** A **runtime class is identified by the pair (binary name, defining class loader)**. Two loaders loading the same bytes produce two different, incompatible types.

```java
var l1 = new PluginLoader(dir, null);
var l2 = new PluginLoader(dir, null);
Class<?> a = l1.loadClass("com.example.Plugin");
Class<?> b = l2.loadClass("com.example.Plugin");

a == b;                        // false
a.getName().equals(b.getName());  // true — same name!
b.cast(a.getConstructor().newInstance());   // ClassCastException: com.example.Plugin
                                            // cannot be cast to com.example.Plugin
```

That error message — the same fully-qualified name on both sides of "cannot be cast to" — is the **signature of a class-loader problem**, and recognising it instantly is worth real points in an interview. It is the everyday reality of application servers, OSGi, plugin systems, and hot redeploy.

The related failure is `LinkageError: loader constraint violation`, raised when two loaders would give the same method signature incompatible meanings.

## 4. What triggers initialization

**[JLS 12.4.1]** `<clinit>` runs on the **first** of these, and on nothing else:

| Triggers initialization | Does **not** trigger it |
| --- | --- |
| `new Foo()` | Declaring a variable of type `Foo` |
| Reading/writing a **non-constant** `static` field | Reading a `static final` **compile-time constant** (inlined by javac) |
| Invoking a `static` method | Creating an array `new Foo[10]` |
| `Class.forName("Foo")` | `Class.forName("Foo", false, loader)` |
| Initializing a **subclass** | Initializing an **implementing class** (interfaces init only if they have default methods) |
| Being the `main` class | Accessing an inherited static field **through** the subclass name |
| A `MethodHandle` resolving to one of the above | `Foo.class` |

The two that catch everyone:

```java
class A { static final String X = "constant"; static { System.out.println("A init"); } }
class B { static final String Y = compute(); static { System.out.println("B init"); } }

System.out.println(A.X);     // prints only "constant" — X was INLINED into the caller's constant pool
System.out.println(B.Y);     // prints "B init" first — Y is not a compile-time constant

class P { static int v = 1; static { System.out.println("P"); } }
class C extends P { static { System.out.println("C"); } }
System.out.println(C.v);     // prints "P" only — v is declared in P, so only P initializes
```

The constant-inlining rule is also a **binary-compatibility hazard**: change `public static final int VERSION = 1;` to `2` in a library and recompile only the library — every caller still holds the inlined `1` until *they* are recompiled.

**`<clinit>` is thread-safe and runs exactly once.** **[JLS 12.4.2]** The JVM takes a per-class initialization lock; other threads block until it completes, and there is a happens-before edge from the initialization to every subsequent use (Phase 25). That is what makes the holder idiom a correct lazy singleton with no synchronization:

```java
public class Heavy {
    private Heavy() { }
    private static class Holder { static final Heavy INSTANCE = new Heavy(); }   // initialized on first
    public static Heavy get() { return Holder.INSTANCE; }                        // access to Holder
}
```

It also means **circular initialization across threads can deadlock**: thread 1 initializing `A` (which touches `B`) while thread 2 initializes `B` (which touches `A`) is a genuine, hard-to-reproduce deadlock with no lock you can see in the code.

**If `<clinit>` throws**, the class is marked **erroneous** permanently:

```java
class Bad { static int x = 1 / 0; }
try { new Bad(); } catch (Throwable t) { System.out.println(t); }  // ExceptionInInitializerError
try { new Bad(); } catch (Throwable t) { System.out.println(t); }  // NoClassDefFoundError:
                                                                    // Could not initialize class Bad
```

Seeing `NoClassDefFoundError: Could not initialize class X` in a log means **the real error happened earlier** — find the first `ExceptionInInitializerError` in the log, because that one has the actual cause.

## 5. `ClassNotFoundException` versus `NoClassDefFoundError`

A guaranteed interview question, and the answer is about *who asked*:

| | `ClassNotFoundException` | `NoClassDefFoundError` |
| --- | --- | --- |
| Type | Checked `Exception` | `Error` (a `LinkageError`) |
| Raised by | An explicit **dynamic** lookup: `Class.forName`, `loadClass`, `loadClass` in a custom loader | The **JVM**, resolving a symbolic reference it needs |
| Meaning | "You asked me for a class by name and I could not find it" | "This class was present at compile time and is missing or failed to initialize now" |
| Typical cause | Missing JDBC driver, bad reflective name, typo in config | Classpath mismatch between compile and run, **or a failed `<clinit>`** |

## 6. Verification, preparation, resolution

**Verification** **[JVMS 4.10]** proves the bytecode cannot violate the JVM's invariants: the operand stack never underflows or overflows, types match at every instruction, locals are initialized before use, `final` classes are not extended, every branch target is valid. Since Java 6 classes carry a **`StackMapTable`** attribute recording the types at each branch target, so verification is a single linear pass rather than an iterative dataflow fixpoint — much faster. **[HotSpot]** `-Xverify:none` was deprecated in Java 13 and removed; verification is not optional any more.

**Preparation** allocates `static` fields and sets them to **default** values. This is why a static field is `0`/`null` during a phase where `<clinit>` has not yet reached it:

```java
class Order {
    static int counter = 5;
    static { System.out.println(counter); }    // prints 5 — the initializer above ran first
    static int later = compute();
    static int compute() { return counter2; }  // reads counter2 BEFORE its initializer -> 0
    static int counter2 = 7;                   // textual order is the execution order
}
```

**Resolution** replaces constant-pool symbolic references (`java/util/List.add:(Ljava/lang/Object;)Z`) with direct references. **[HotSpot]** It is **lazy**: a reference is resolved the first time the instruction executes, which is why a missing class on a rarely-taken branch surfaces months into production rather than at startup.

## 7. What happens internally

**Where the class lives.** **[HotSpot]** The `Class` object and its mirror live in the heap; the class *metadata* (methods, field descriptors, constant pool, bytecode) lives in **Metaspace**, which is native memory outside the heap. Metaspace replaced PermGen in Java 8 and grows on demand — bounded by `-XX:MaxMetaspaceSize` if you set it, otherwise by available native memory.

**Class unloading** happens only when the class's **defining loader becomes unreachable** — a class, its loader, and all its instances form one unloadable unit. This is the mechanism behind the classic application-server leak: redeploy an app, something (a `ThreadLocal`, a JDBC driver registered in a static registry, a running thread, a logging framework's cached logger) holds a reference to one class of the old application, which pins the old loader, which pins every class it loaded, and Metaspace grows by tens of megabytes per redeploy until `OutOfMemoryError: Metaspace`.

**Hidden classes** (Java 15, JEP 371) are the modern facility for runtime-generated classes: they are not discoverable by name, cannot be referenced by other classes, and can be unloaded independently of their loader. **[JDK]** `LambdaMetafactory` uses them for spun lambda classes (Module 11.1), which is why heavy lambda use no longer leaks class metadata.

**Startup cost.** Loading, verifying and initializing thousands of classes dominates JVM startup. The mitigations, in order of adoption:

- **Class-Data Sharing (CDS)** memory-maps a pre-parsed archive of class metadata shared between JVMs. `-XX:+AutoCreateSharedArchive -XX:SharedArchiveFile=app.jsa` (Java 19+) makes it one flag.
- **AppCDS** extends it to application classes.
- **[JDK]** **JEP 483 (Java 24) — Ahead-of-Time Class Loading & Linking** caches classes already loaded *and linked*, cutting startup substantially. This is the first shipped piece of Project Leyden.
- **GraalVM native image** goes further: it runs class initialization at build time and produces a binary with no class loading at all — at the cost of requiring every reflective use to be declared.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ has no runtime class loading.</strong> The linker resolves every symbol at build time (static) or at process start (dynamic, via the loader's relocation), and after that there is no notion of "loading a type". <code>dlopen</code>/<code>LoadLibrary</code> is the closest analogue to a custom class loader, and it has the same version-conflict problems — but it works on <em>symbols</em>, not on named types with identity.</p>
<p><strong>Static initialization</strong> is where the comparison bites. C++ has the <em>static initialization order fiasco</em>: the order of dynamic initialization of non-local statics <strong>across translation units is unspecified</strong>, so one global depending on another is undefined behaviour, and the standard workaround is the function-local static (Meyers singleton), which C++11 made thread-safe. Java specifies the order completely — textual order within a class, and lazily on first active use across classes — and guarantees <code>&lt;clinit&gt;</code> runs exactly once under a lock. Java's holder idiom is the direct counterpart of the Meyers singleton, and it works for the same reason.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| When types become available | Link time / `dlopen` | Lazily, on first active use |
| Type identity | The ODR: one definition, or UB | (name, defining loader) |
| Same type twice | ODR violation — silent UB | Two distinct classes; `ClassCastException` |
| Bytecode/binary verification | None (the loader trusts the binary) | Mandatory verifier |
| Static init order | **Unspecified across TUs** | Specified; lazy per class |
| Thread-safe lazy init | Function-local static (C++11) | `<clinit>` lock; the holder idiom |
| Missing symbol | Link error, or `dlsym` returning null | `NoClassDefFoundError` / `ClassNotFoundException` |
| Unloading | `dlclose` | Only when the loader is unreachable |
| Startup cost | Relocation only | Load + verify + link + init thousands of classes |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Assuming static state is initialized "at program start". In Java a class's statics do not exist until something actively uses that class — so a registry that expects implementations to self-register in their static blocks registers <em>nothing</em> until someone touches each class. That is why service discovery uses <code>ServiceLoader</code> or annotation scanning, not static blocks.</p>
</div>

## 9. Edge cases

- **Interfaces initialize lazily and independently.** An interface is initialized only when a *non-constant* field of it is used, or (Java 8+) when a class implementing it that has default methods is initialized.
- **`Class.forName(String)` uses the caller's class loader** and initializes; the three-argument form lets you choose both.
- **`Thread.currentThread().getContextClassLoader()`** exists because delegation breaks for frameworks: JDBC's `DriverManager` in `java.base` cannot see your driver on the classpath. It is a deliberate hole in the model and a common source of "works in tests, fails in the container".
- **`defineClass` with a `java.*` name** throws `SecurityException`.
- **Two classes in the same runtime package** must have the same loader *and* the same package name, or package-private access silently fails with `IllegalAccessError`.
- **`static final` primitives and `String`s are inlined; other `static final`s are not.** `static final Integer X = 1;` is not a compile-time constant.
- **An enum's constants are created in `<clinit>`** (Module 15.1 §7) — which is why an enum constructor cannot read a static field of its own class.
- **`-verbose:class`** prints every load with its source; the fastest way to answer "which jar did this come from".
- **A class can be initialized while another thread is inside its `<clinit>`** — the recursive case: the *same* thread re-entering `<clinit>` sees partially initialized state and does **not** block.
- **JPMS**: `--add-opens`/`--add-exports` (Module 18.1) affect access, not loading; a module's classes are still loaded by one of the three built-in loaders unless you build a `ModuleLayer`.

## 10. Common mistakes

- Reading `NoClassDefFoundError: Could not initialize class X` as "class missing" instead of "its `<clinit>` threw earlier".
- Expecting static registration blocks to run without something touching the class.
- Assuming `Foo.class` or `new Foo[10]` initializes `Foo`.
- Changing a `public static final int` in a library and not recompiling callers.
- Circular static initialization between two classes touched from two threads.
- Holding a reference to a redeployed application's class and leaking its whole loader.
- Using the context class loader without understanding why it exists.
- Writing a custom loader that does not delegate, then being surprised by `ClassCastException` on shared types.
- Relying on resolution eagerness — a `NoSuchMethodError` on a cold branch in production.
- Setting `-Xverify:none` (it no longer exists).

## 11. Interview questions

**Beginner** — 1. Name the phases from bytes to a usable class. 2. What are the three built-in class loaders? 3. What is parent delegation?

**Intermediate** — 4. Why does delegation go to the parent first? 5. `ClassNotFoundException` versus `NoClassDefFoundError`. 6. What happens during preparation? 7. Name four things that trigger `<clinit>` and two that do not.

**Advanced** — 8. What identifies a runtime class, and what error tells you two loaders are involved? 9. Why does `System.out.println(A.X)` not initialize `A` when `X` is `static final String`? 10. Explain why the holder idiom is a correct lazy singleton with no synchronization. 11. What happens on the second use of a class whose `<clinit>` threw?

**Senior** — 12. An application server's Metaspace grows 40 MB per redeploy. Explain the mechanism and how you would find the culprit in a heap dump. 13. Explain the context class loader: what problem it solves and why it is a design smell. 14. Two threads deadlock with no monitors in the stack traces, both in class initialization. Explain and fix.

## 12. Follow-ups

- *After Q3:* "Write `loadClass` from memory."
- *After Q5:* "Which one is an `Error` and why does that matter?"
- *After Q9:* "What binary-compatibility hazard does inlining create?"
- *After Q11:* "Which exception has the real cause?"
- *After Q12:* → `ThreadLocal`s, JDBC drivers, live threads, cached loggers, JMX registrations.

## 13. Exercise

1. Write two `PluginLoader` instances loading identical bytes and reproduce the `ClassCastException` whose two type names are identical. Print both `Class` objects' identity hashes.
2. Build the initialization-trigger table experimentally: eight small classes each printing from `<clinit>`, exercised by `new`, array creation, `.class`, constant read, non-constant read, static method, subclass init, and `Class.forName` both ways.
3. Reproduce `ExceptionInInitializerError` followed by `NoClassDefFoundError` on the second access. Then write the log line you would want your service to emit so an on-call engineer finds the real cause.
4. Write two classes with circular static initialization and drive them from two threads in a loop until they deadlock. Capture a thread dump and identify the state.
5. Measure startup for an application with 5 000 classes, then with AppCDS enabled. Report the class-loading time from `-Xlog:class+load` and the wall-clock delta.

## 14. Output prediction

```java
class A { static final String X = "const"; static final Integer Y = 7;
          static { System.out.println("A init"); } }
class B { static int v = 1; static { System.out.println("B init"); } }
class C extends B { static { System.out.println("C init"); } }
class D { static int a = f(); static int b = 2; static int f() { return b + 10; }
          static { System.out.println("D: a=" + a + " b=" + b); } }
class E { static { if (true) throw new RuntimeException("boom"); } }

public class Main {
    public static void main(String[] args) throws Exception {
        System.out.println("--1");
        System.out.println(A.X);
        System.out.println("--2");
        System.out.println(A.Y);

        System.out.println("--3");
        B[] arr = new B[3];
        Class<?> k = B.class;
        System.out.println("--4");
        System.out.println(C.v);

        System.out.println("--5");
        new D();

        System.out.println("--6");
        try { new E(); } catch (Throwable t) { System.out.println(t.getClass().getSimpleName()); }
        try { new E(); } catch (Throwable t) { System.out.println(t.getClass().getSimpleName()); }

        System.out.println("--7");
        System.out.println(String.class.getClassLoader());
        System.out.println(Main.class.getClassLoader().getClass().getSimpleName());
        System.out.println(Main.class.getClassLoader().getParent().getClass().getSimpleName());

        System.out.println("--8");
        Class.forName("Loud", false, Main.class.getClassLoader());
        System.out.println("between");
        Class.forName("Loud");
    }
}
class Loud { static { System.out.println("Loud init"); } }
```

## 15. Mastery check

1. Name the five sub-phases from bytes to initialized class and what each does.
2. Write `loadClass`'s delegation algorithm.
3. Give both reasons parent delegation exists.
4. What identifies a runtime class, and what is the tell-tale error when two loaders collide?
5. List four initialization triggers and four non-triggers.
6. Explain constant inlining and the binary-compatibility hazard it creates.
7. Why is the holder idiom thread-safe with no `synchronized`?
8. What happens on the first and on every subsequent use of a class whose `<clinit>` threw?
9. Distinguish `ClassNotFoundException` from `NoClassDefFoundError` by who raises each.
10. Explain the redeploy Metaspace leak: what pins what, and what makes a class unloadable.
