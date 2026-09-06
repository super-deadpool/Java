---
title: "Reflection: the Class object, dynamic invocation, strong encapsulation, and MethodHandles"
phase: 18
order: 1
minutes: 50
summary: "What reflection can and cannot see, why setAccessible now fails on JDK internals, what invocation actually costs, and why MethodHandle/VarHandle are the modern path."
tags: ["reflection", "class", "setaccessible", "methodhandle", "varhandle", "proxy"]
---

## 1. Concept

Reflection is **the runtime API for inspecting and manipulating the program's own structure**: classes, fields, methods, constructors, annotations, and generic signatures — plus the ability to invoke and instantiate by name rather than by symbol.

```java
Class<?> c = Class.forName("com.example.Service");
Object instance = c.getDeclaredConstructor().newInstance();
Method m = c.getDeclaredMethod("process", String.class);
m.setAccessible(true);
Object result = m.invoke(instance, "input");
```

That is four things a compiled Java call site cannot do: name a class from a `String`, discover a member you did not declare a dependency on, bypass access control, and call something whose signature you did not know at compile time.

## 2. Why it exists

Every framework you use is built on it. The pattern is always the same: **a library needs to work with types it has never seen.**

| Framework | What reflection does |
| --- | --- |
| Spring / Guice / CDI | Find `@Component` classes, read constructor parameter types, instantiate, inject |
| Hibernate / JPA | Read `@Entity` fields, set them from result-set columns without setters |
| Jackson / Gson | Enumerate fields and getters to serialize; construct and populate to deserialize |
| JUnit | Find `@Test` methods, instantiate, invoke |
| Debuggers, profilers, `jshell` | Inspect arbitrary live objects |

Without reflection, each of these would need generated code per type — which is exactly what the modern alternatives (Dagger, MapStruct, Micronaut) do to avoid it (Module 17.1 §6).

## 3. The `Class` object

Three ways to get one, with different loading behaviour:

```java
Class<String> a = String.class;                        // compile-time, no initialization triggered
Class<?> b = "x".getClass();                           // runtime type of an instance
Class<?> c = Class.forName("java.lang.String");        // by name; RUNS the static initializer
Class<?> d = Class.forName("com.X", false, loader);    // by name, WITHOUT initializing (Phase 22)
```

The four name accessors, which differ in ways that matter for logging and for arrays:

```java
int[][].class.getName();            // "[[I"
int[][].class.getSimpleName();      // "int[][]"
int[][].class.getCanonicalName();   // "int[][]"
int[][].class.getTypeName();        // "int[][]"

Outer.Inner.class.getName();        // "Outer$Inner"
Outer.Inner.class.getCanonicalName();// "Outer.Inner"
anonymousClass.getSimpleName();     // ""      (and getCanonicalName() is null)
```

And the access pattern everyone gets wrong at least once — `getXxx` versus `getDeclaredXxx`:

| | Includes inherited | Includes private | Includes package/protected |
| --- | --- | --- | --- |
| `getFields()` / `getMethods()` | ✅ | ❌ **public only** | ❌ |
| `getDeclaredFields()` / `getDeclaredMethods()` | ❌ **this class only** | ✅ | ✅ |

So neither one gives you "all fields including inherited private ones" — you walk `getSuperclass()` in a loop.

## 4. Fields, methods, constructors

```java
// Fields
Field f = c.getDeclaredField("count");
f.setAccessible(true);                         // suppress the access check (see §5)
int v = f.getInt(instance);                    // typed getters avoid boxing
f.set(instance, 42);
f.getType();                                   // Class<?> — erased
f.getGenericType();                            // Type — ParameterizedType if generic (Module 6.3)
Modifier.isStatic(f.getModifiers());

// Methods
Method m = c.getMethod("run");                 // public, including inherited
m.invoke(instance, args);                      // returns Object; primitives boxed
m.getParameterTypes(); m.getReturnType(); m.getExceptionTypes();
m.getParameters()[0].getName();                // "arg0" unless compiled with -parameters

// Constructors
Constructor<?> ctor = c.getDeclaredConstructor(String.class, int.class);
Object o = ctor.newInstance("a", 1);
// Class.newInstance() is DEPRECATED since Java 9: it threw checked exceptions
// without declaring them, defeating the compiler's exception checking.

// Arrays
Object arr = Array.newInstance(String.class, 10);      // the only way to create a generic array (Module 6.3)
Array.set(arr, 0, "x"); Array.getLength(arr);
```

**Exception wrapping is the detail that trips people up.** `Method.invoke` wraps anything the target throws in `InvocationTargetException`:

```java
try { m.invoke(obj); }
catch (InvocationTargetException e) {
    Throwable real = e.getCause();             // the exception your method actually threw
}
catch (IllegalAccessException e) { /* the access check failed */ }
```

Never log the `InvocationTargetException` without its cause — the stack trace above the cause is all framework frames.

## 5. `setAccessible` and strong encapsulation

`setAccessible(true)` suppresses the language-level access check. Since Java 9 that is no longer unconditional.

**[JDK]** The timeline, which you should be able to state:

| Release | Behaviour for reflecting into JDK internals |
| --- | --- |
| ≤ 8 | Anything goes. `sun.misc.Unsafe`, private `String.value`, everything |
| 9–15 | **Illegal reflective access** permitted but **warned** (`--illegal-access=permit` default) |
| 16 | Default flipped to `deny` |
| 17+ | **`--illegal-access` removed entirely.** Denied, no override |

```java
Field f = String.class.getDeclaredField("value");
f.setAccessible(true);
// java.lang.reflect.InaccessibleObjectException: Unable to make field private final byte[]
// java.lang.String.value accessible: module java.base does not "opens java.lang" to unnamed module
```

The escape hatch is explicit and per-package, at JVM launch:

```bash
--add-opens java.base/java.lang=ALL-UNNAMED       # deep reflection into that package
--add-exports java.base/sun.nio.ch=ALL-UNNAMED    # compile/link against non-exported API
```

Your own code is governed by the same rules under JPMS:

```java
module app { opens com.example.model to com.fasterxml.jackson.databind; }   // targeted
module app { opens com.example.model; }                                     // to everyone
module app { exports com.example.api; }                                     // compile-time access only, no deep reflection
```

`exports` means "you may use the public API"; `opens` means "you may reflect into it, including private members". A framework that populates your entities needs `opens`, not `exports`. On the classpath (unnamed module) everything is open by default, which is why most applications never notice.

## 6. What it costs

Reflection is not catastrophically slow, but it is slower in ways that compound:

| Operation | Relative cost | Why |
| --- | --- | --- |
| `Class.forName` | Very expensive | Loading, linking, possibly initialization |
| `getDeclaredMethods()` | Expensive | Allocates a fresh **copy** of the array and of every `Method` object on each call |
| `Method.invoke` (cached `Method`) | ~1–5× a direct call once JIT-warmed | Access check, `Object[]` argument boxing, no inlining across the reflective boundary |
| `Field.get` on a primitive | Boxes | Use `getInt`/`getLong`/etc. |
| `MethodHandle.invokeExact` on a `static final` handle | ≈ a direct call | The JIT constant-folds the handle and inlines through it |

Two rules follow:

1. **Cache the `Method`/`Field`/`Constructor` objects.** `getDeclaredMethods()` returns defensive copies every call — doing lookups in a loop is where the real cost is, not the invocation.
2. **`setAccessible(true)` once, at lookup time.** It disables the per-invocation access check.

**[JDK]** Since Java 18 (JEP 416), core reflection's `Method.invoke` is itself **implemented on top of `MethodHandle`s**, replacing the old bytecode-spinning `MagicAccessorImpl` machinery. Reflection got faster and simpler as a result, and the old "reflection is 50× slower" folklore is well out of date — but the boxing and inlining barriers remain.

## 7. `MethodHandle` and `VarHandle` — the modern path

**[JDK]** `java.lang.invoke` is the reflection API designed for the JIT rather than for introspection.

```java
MethodHandles.Lookup lookup = MethodHandles.lookup();
MethodType type = MethodType.methodType(int.class, String.class);      // (String)int
MethodHandle mh = lookup.findVirtual(Service.class, "process", type);

int r = (int) mh.invokeExact(service, "input");   // exact: no conversion, signature must match EXACTLY
int s = (int) mh.invoke(service, "input");        // asType conversions allowed, slower
```

Differences from core reflection that matter:

- **Access is checked once, at lookup time**, against the `Lookup` object's permissions — not on every call. A `Lookup` is a capability you can pass around.
- **`invokeExact` is *signature-polymorphic*** **[JVMS]**: the call site's descriptor is the compile-time signature and must match the handle's type exactly, including the return cast. A mismatch throws `WrongMethodTypeException`. This is what allows no boxing and no `Object[]`.
- **A `static final MethodHandle` is constant-folded** by the JIT, so the call inlines to roughly a direct invocation.
- **Handles compose**: `filterArguments`, `insertArguments`, `dropArguments`, `guardWithTest`, `foldArguments` build adapters without generating classes.
- `MethodHandles.privateLookupIn(Target.class, lookup)` grants deep access when the module opens the package — the sanctioned modern replacement for `setAccessible`.

`VarHandle` (Java 9) is the field/array counterpart, and additionally exposes **memory ordering modes** — which is why it replaced `sun.misc.Unsafe` for lock-free code (Phase 25):

```java
private static final VarHandle COUNT =
        MethodHandles.lookup().findVarHandle(Node.class, "count", int.class);

COUNT.get(node);                 // plain read
COUNT.getVolatile(node);         // volatile semantics
COUNT.getAcquire(node);          // acquire
COUNT.compareAndSet(node, 0, 1); // CAS
COUNT.getAndAdd(node, 1);
```

## 8. Dynamic proxies

**[JDK]** `java.lang.reflect.Proxy` generates a class at runtime implementing a set of **interfaces**, routing every call to an `InvocationHandler`.

```java
@SuppressWarnings("unchecked")
static <T> T timed(Class<T> iface, T target) {
    return (T) Proxy.newProxyInstance(iface.getClassLoader(), new Class<?>[]{ iface },
        (proxy, method, args) -> {
            long t0 = System.nanoTime();
            try { return method.invoke(target, args); }
            catch (InvocationTargetException e) { throw e.getCause(); }
            finally { record(method.getName(), System.nanoTime() - t0); }
        });
}
```

This is how JDK annotation instances work (Module 17.1 §6), how Spring's interface-based AOP works, how JPA repositories with no implementation class work, and how RMI/RPC stubs work. Its one hard limit: **interfaces only**. Proxying a class requires bytecode generation — CGLIB or ByteBuddy — which is why Spring falls back to subclass proxies and why `final` methods are then un-advisable.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ has almost nothing here.</strong> RTTI gives you <code>typeid</code> (a name and an identity, and the name is implementation-mangled) and <code>dynamic_cast</code> (a downcast check). That is the complete list: you cannot enumerate members, read a field by name, call a method by name, or construct a type from a string. Everything a Java framework does reflectively, a C++ library does with macros, template metaprogramming, an external code generator, or intrusive registration boilerplate.</p>
<p>C++26's static reflection changes this at <strong>compile time</strong> — which is the right comparison for Java <em>annotation processing</em>, not for <code>Method.invoke</code>. There is still no plan for runtime member enumeration, because C++ does not carry the metadata into the binary.</p>
</div>

| Capability | C++ | Java |
| --- | --- | --- |
| Runtime type identity | `typeid` | `getClass()`, `Class` |
| Checked downcast | `dynamic_cast` | `instanceof` + cast, patterns |
| Enumerate fields/methods | ✗ | ✅ |
| Call by name | ✗ | `Method.invoke` |
| Construct by name | ✗ | `Class.forName().newInstance()` |
| Read/write a private member | Cast tricks / UB | `setAccessible`, if opened |
| Runtime proxy generation | ✗ | `Proxy`, ByteBuddy |
| Metadata in the binary | ✗ (only vtables/RTTI) | Full class-file metadata |
| Cost | N/A | Real, but cacheable |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Underestimating how much Java's design assumes reflection exists. Class files keep field names, method names, signatures, and (with <code>-parameters</code>) parameter names — that is why the ecosystem looks the way it does, and why Java startup is slow in a way C++ startup is not.</p>
<p>Treating <code>setAccessible(true)</code> as the C++ "cast away const" trick. Since 17 it is a hard failure across module boundaries, and reaching for <code>--add-opens</code> to make a library work is a signal that the library is out of date.</p>
</div>

## 10. Edge cases

- **`getMethods()` on an interface with default methods** includes them; on a class it includes inherited public ones plus bridge methods (Module 6.3).
- **Bridge and synthetic members show up.** Filter with `isBridge()` / `isSynthetic()` or you will call the wrong overload.
- **Parameter names are `arg0`, `arg1`, …** unless compiled with `-parameters`. Frameworks that need real names (Spring's `@PathVariable`) require that flag or a debug-info fallback.
- **`getGenericType()` recovers the type argument from the *declaration*, not the instance.** `List<String> f` has it; `List<String> local = ...` does not (Module 6.3).
- **Setting a `final` field** works for instance fields via `setAccessible` on some paths, but is **undefined behaviour with respect to the JMM**: the JIT may have constant-folded the read (Phase 25 final-field semantics). Since Java 17, `Field.set` on a `static final` field throws `IllegalAccessException`. Do not do this.
- **`Class.forName` runs static initializers.** For a plugin scanner that is a security and performance problem — use the three-argument form with `initialize = false`.
- **Records:** `getRecordComponents()` gives components in declaration order; the canonical constructor is `getDeclaredConstructor(componentTypes)`.
- **Enums:** `Constructor.newInstance` on an enum throws `IllegalArgumentException` — deliberately (Module 15.1 §6).
- **`hashCode`/`equals` on `Method` objects** compare declaring class + name + parameter types, so two lookups yield equal-but-not-identical objects.
- **Annotations on a proxy's methods** are not present on the proxy class — read them from the interface.

## 11. Common mistakes

- Doing `getDeclaredMethod` inside a loop instead of caching it.
- Logging `InvocationTargetException` without `getCause()`.
- `getFields()` when you meant `getDeclaredFields()`, or vice versa.
- Using `Class.newInstance()` (deprecated) instead of `getDeclaredConstructor().newInstance()`.
- Forgetting that arguments and return values are boxed.
- Reaching for `--add-opens` instead of upgrading the library.
- Writing a `final` field reflectively and getting stale reads under JIT.
- Reflection where an interface, a factory, or a `ServiceLoader` would do.
- Building a framework on reflection when a compile-time processor would catch the errors earlier.
- Ignoring bridge/synthetic methods and invoking the erased overload.

## 12. Interview questions

**Beginner** — 1. What is reflection and name three things that use it? 2. Three ways to get a `Class` object? 3. What does `setAccessible(true)` do?

**Intermediate** — 4. `getMethods()` versus `getDeclaredMethods()`. 5. What does `Method.invoke` throw when the target throws? 6. Why was `Class.newInstance()` deprecated? 7. How do you create an array of a generic type?

**Advanced** — 8. What changed for reflection in Java 9, 16, and 17? 9. Explain `exports` versus `opens`. 10. Why is `Method.invoke` slower than a direct call — name three specific reasons. 11. What is signature polymorphism and why does `invokeExact` need it?

**Senior** — 12. Compare `Method`, `MethodHandle`, and `VarHandle` on access checking, performance, and composability. 13. A Spring app fails on JDK 17 with `InaccessibleObjectException`. Give the diagnosis, the tactical fix, and the correct fix. 14. Design a plugin system loading implementations by name from user config: safety, class loading, initialization timing, and error handling.

## 13. Follow-ups

- *After Q3:* "When does it now fail?" → across a module boundary that is not opened.
- *After Q5:* "What do you do with it?" → unwrap `getCause()`.
- *After Q9:* "Which does Jackson need for private fields?" → `opens`.
- *After Q10:* "Which of those did JEP 416 fix?" → the dispatch machinery, not boxing or inlining.
- *After Q12:* "When is a `MethodHandle` as fast as a direct call?" → `static final`, constant-folded.

## 14. Exercise

1. Write a mini-Jackson: serialize any object to JSON by walking `getDeclaredFields()` up the superclass chain, handling primitives, `String`, arrays, and `List`. Then deserialize it back. Note every place erasure blocks you.
2. Benchmark, with JMH: a direct call, a cached `Method.invoke`, an uncached `getDeclaredMethod` + `invoke`, and a `static final MethodHandle.invokeExact`, 10 M iterations each. Explain all four numbers.
3. On JDK 17+, attempt `setAccessible(true)` on a private `java.lang.String` field. Record the exception, then make it work with `--add-opens` and write down why you should not ship that.
4. Build a `Proxy`-based logging decorator for an interface, then a ByteBuddy subclass proxy for a class, and list what each cannot do.
5. Write a `ServiceLoader`-based plugin system for the same problem as (4) and argue when to prefer it over reflection by name.

## 15. Output prediction

```java
import java.lang.reflect.*;
import java.util.*;

class Base { public int pub = 1; private int priv = 2; public void hello() {} private void secret() {} }
class Derived extends Base { public String name = "d"; public void extra() {} }
record Point(int x, int y) {}

public class Main {
    public static void main(String[] args) throws Exception {
        System.out.println(Derived.class.getFields().length);
        System.out.println(Derived.class.getDeclaredFields().length);

        System.out.println(int[][].class.getName() + " " + int[][].class.getSimpleName());
        System.out.println(Map.Entry.class.getName() + " " + Map.Entry.class.getCanonicalName());

        Field f = Base.class.getDeclaredField("priv");
        Base b = new Base();
        try { f.get(b); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        f.setAccessible(true);
        System.out.println(f.get(b) + " " + f.getInt(b));

        Method m = Base.class.getDeclaredMethod("secret");
        System.out.println(m.getDeclaringClass().getSimpleName() + " " + Modifier.isPrivate(m.getModifiers()));

        Method thrower = Main.class.getDeclaredMethod("boom");
        try { thrower.invoke(null); }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName() + " -> " +
                                                 e.getCause().getClass().getSimpleName()); }

        System.out.println(Point.class.getRecordComponents().length);
        Constructor<Point> c = Point.class.getDeclaredConstructor(int.class, int.class);
        System.out.println(c.newInstance(1, 2));

        Object arr = Array.newInstance(String.class, 3);
        Array.set(arr, 0, "z");
        System.out.println(arr.getClass().getSimpleName() + " " + Array.getLength(arr) + " " + Array.get(arr, 0));

        Method h1 = Base.class.getMethod("hello"), h2 = Base.class.getMethod("hello");
        System.out.println((h1 == h2) + " " + h1.equals(h2));
    }
    static void boom() { throw new IllegalStateException("x"); }
}
```

## 16. Mastery check

1. Give three ways to obtain a `Class` and say which triggers initialization.
2. Fill in the `getXxx` versus `getDeclaredXxx` table from memory, then say how you get every field including inherited private ones.
3. What does `Method.invoke` throw when the target method throws, and how do you handle it?
4. Explain the Java 9 → 16 → 17 progression for illegal reflective access.
5. Explain `exports` versus `opens` and which a JSON mapper needs.
6. Name three distinct reasons `Method.invoke` costs more than a direct call.
7. What did JEP 416 change, and what did it *not* fix?
8. Define signature polymorphism and contrast `invoke` with `invokeExact`.
9. When is a `MethodHandle` call as fast as a direct call, and what is required for that?
10. What can `java.lang.reflect.Proxy` proxy, what can it not, and what fills the gap?
