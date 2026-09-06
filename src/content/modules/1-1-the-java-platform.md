---
title: "The Java Platform: javac, bytecode, class loading, JIT"
phase: 1
order: 1
minutes: 35
summary: "What actually happens between the .java file you save and the machine code your CPU runs — and why 'Java is interpreted' has been wrong for about twenty-five years."
tags: ["jvm", "javac", "bytecode", "jit", "hotspot"]
---

## 1. Concept

"Java" is three separate things that people habitually collapse into one word:

| Term | What it is | What it is not |
| --- | --- | --- |
| **The Java language** | A specification (the JLS) describing syntax and semantics of `.java` source | Not a runtime |
| **The class file format + JVM** | A specification (the JVMS) describing a binary format and an abstract stack machine that executes it | Not tied to Java the language — Kotlin, Scala, Clojure and Groovy all target it |
| **HotSpot / OpenJDK** | *One implementation* of the JVM spec, the one you almost certainly run | Not "the JVM"; J9/OpenJ9, GraalVM, Azul Zing are others |

The **JDK** is the developer kit: compiler (`javac`), tools (`javap`, `jcmd`, `jlink`, `jfr`), and a runtime.
The **JRE** was a runtime-only distribution — **it stopped shipping separately after Java 8**; the modern equivalent is a trimmed runtime image you build yourself with `jlink`. If an interviewer asks "JDK vs JRE vs JVM" they are usually asking a Java-8-era question; say the JRE is historical and explain `jlink`.

The pipeline in one line:

```text
Foo.java ──javac──▶ Foo.class (bytecode) ──class loader──▶ verify ▸ prepare ▸ resolve ▸ initialize
         ──▶ interpreter (+ profiling counters) ──▶ C1 ──▶ C2 ──▶ machine code (and back, on deopt)
```

## 2. Why Java has it

Java was designed for a world where you ship one artifact to machines you do not control. That forces three decisions:

1. **Compile to a portable intermediate form, not to machine code.** The class file is the distribution unit. Portability is not a runtime trick; it is baked into the format.
2. **Make the runtime, not the compiler, do the optimising.** A shipped binary compiled ahead of time must assume the worst about every branch and every virtual call. A runtime that watches the program run for a few seconds knows which branch is taken and which class actually shows up at a call site — and can optimise for *this* run, on *this* CPU, then throw the optimisation away when the assumption breaks.
3. **Make linkage safe and late.** Classes are found and linked by *name*, at runtime, and verified before they execute. That is what lets you drop a JAR onto a classpath and what lets frameworks generate classes at runtime — and it is why Java has no headers, no ODR violations, and no name mangling.

The cost is real and you should be able to name it: **startup and warm-up time**, and a **memory floor** far above a native binary's.

## 3. Mental model

> `javac` is a **transcriber**, not an optimiser. The JVM starts as an **interpreter with a stopwatch**, and promotes hot code to an **optimising compiler that is allowed to be wrong** — because it can undo its work.

Two consequences follow from that one sentence, and most Phase-1 interview questions are downstream of them:

- Reading `javap -c` output tells you what the *language* means (dispatch, string concat, boxing, lambda call sites) — not what your CPU does.
- Measuring the first 10 000 iterations of anything tells you nothing about steady-state performance. (This is the root of every bad Java microbenchmark; see Phase 26.)

## 4. Syntax — the commands, and what each stage consumes

```bash
javac --release 21 -d out src/com/acme/Main.java   # source  → class files
java  -cp out com.acme.Main                        # class files → running program
java  Main.java                                    # single-file source mode (Java 11+): compiles in memory
javap -c -p out/com/acme/Main.class                # disassemble bytecode
java  -XX:+PrintCompilation -cp out com.acme.Main  # watch the JIT promote methods
```

`--release N` is the correct flag: it sets source level, target level **and** the API signatures visible to the compiler. `-source`/`-target` alone let you compile against a newer API and produce a class file that fails at runtime with `NoSuchMethodError` — a classic production incident.

## 5. Minimal example

```java
public class Adder {
    public static int add(int a, int b) {
        return a + b;
    }
}
```

```text
$ javap -c Adder.class
  public static int add(int, int);
    Code:
       0: iload_0        // push local 0 onto the operand stack
       1: iload_1        // push local 1
       2: iadd           // pop two ints, push their sum
       3: ireturn        // pop and return
```

Note what the bytecode shows: an **operand stack**, not registers; `int`-specific opcodes (`iadd`, not a polymorphic `add`); and local variables addressed by *slot number*, not name — names survive only in the optional `LocalVariableTable` (`javac -g`).

## 6. Realistic example — the pipeline as it appears in a real build

```java
package com.acme.pricing;

public final class PriceEngine {
    private static final int MAX_DISCOUNT_PERCENT = 40;   // compile-time constant

    private final DiscountPolicy policy;                  // resolved at runtime, by name

    public PriceEngine(DiscountPolicy policy) {
        this.policy = policy;
    }

    public long priceOf(Order order) {
        int discount = Math.min(policy.discountPercentFor(order), MAX_DISCOUNT_PERCENT);
        return order.subtotalMinor() * (100 - discount) / 100;
    }
}
```

Three different linkage stories live in that one method:

- `MAX_DISCOUNT_PERCENT` is a **compile-time constant** (`static final` with a constant initialiser). `javac` does not emit a field read — it **copies the literal `40` into `PriceEngine.class`**. Change it to `50`, recompile only `PriceEngine`, and any *other* class that read the constant still holds `40` until it too is recompiled. This is the single most surprising `javac` behaviour for a C++ reader, and it is specified, not an implementation quirk (JLS §13.1).
- `policy.discountPercentFor(order)` compiles to `invokeinterface` naming the interface and the method **as text**. Nothing is bound until that call site executes for the first time.
- `Math.min` compiles to `invokestatic`, and is one of a small set of methods HotSpot replaces with an **intrinsic** — a hand-written machine-code sequence — rather than compiling the Java source of `Math.min` at all.

## 7. What happens internally

I will mark each claim: **[JLS/JVMS]** = specified behaviour you can rely on; **[HotSpot]** = how the common implementation happens to do it.

### Compilation — `javac`

**[JLS]** `javac` type-checks, desugars, and emits class files. Its optimisation budget is close to zero: it folds compile-time constant expressions, inlines compile-time constants, and that is essentially all. There is no `-O`. Things you may assume are "compiler magic" are actually desugarings you can see in `javap`:

| Source construct | What javac emits |
| --- | --- |
| `for (T x : list)` | `Iterator` calls (arrays: an index loop) |
| `"a" + x + "b"` | **[Java 9+]** a single `invokedynamic` to `StringConcatFactory` |
| a lambda | an `invokedynamic` call site + a private synthetic method |
| generics | erased types + synthetic bridge methods + casts |
| `switch` on a pattern | `invokedynamic` to a bootstrap that does the type tests |
| an inner class | a separate class file with a synthetic `this$0` field |

### The class file

**[JVMS]** A class file carries a **constant pool** (all names, signatures, literals, symbolic references), field and method tables, bytecode, and attributes. It records a **major version**: 52 = Java 8, 55 = 11, 61 = 17, 65 = 21, 69 = 25. A JVM refuses any class file newer than itself with `UnsupportedClassVersionError` — the JVM is backward compatible, never forward compatible.

### Loading, linking, initialisation

**[JVMS]** Five steps, and the ordering guarantees matter:

1. **Loading** — a `ClassLoader` finds the bytes and defines a `Class` object. Identity of a class is the pair *(fully qualified name, defining loader)*: the same `com.acme.Foo` loaded by two loaders produces two incompatible types. This is exactly why an app server can throw `ClassCastException: com.acme.Foo cannot be cast to com.acme.Foo`.
2. **Verification** — the bytecode is proven type-safe before it runs: no operand-stack underflow, no jumping into the middle of an instruction, no treating an `int` as a reference. This is *why* Java has no undefined behaviour of the C++ kind — an invalid class file is rejected, not executed.
3. **Preparation** — static fields get their **default** values (`0`, `0.0`, `false`, `null`). Not their initialisers. Just the zeroes.
4. **Resolution** — symbolic references (`"java/util/List.add:(Ljava/lang/Object;)Z"`) become direct references. **[JVMS]** permits this to be eager or lazy; **[HotSpot]** does it lazily, on first execution of the instruction. That laziness is why a missing class can surface as `NoClassDefFoundError` minutes into a run.
5. **Initialisation** — `<clinit>` runs: static initialisers and static field initialisers, in source order, **exactly once**, guarded by the JVM. Triggered lazily by first *active use* (`new`, static method call, non-constant static field access), never by merely naming the type.

**[JVMS]** Loaders form a delegation chain — bootstrap → platform → application — and each **delegates to its parent first**. That is the security property that stops your `java.lang.String` from replacing the real one.

### Execution — interpreter, then JIT

**[HotSpot]** Every method starts in the **template interpreter**, which also increments per-method invocation counters and per-branch backedge counters. When counters cross a threshold (order of hundreds for C1, thousands for C2; tunable, not specified), **tiered compilation** promotes the method:

- **C1** — fast to compile, lightly optimised, and instrumented to keep collecting profile data.
- **C2** — slow to compile, aggressively optimised, using the profile C1 collected.

What C2 does with a profile is the part worth internalising, because it explains why Java's "everything is virtual" is not the disaster a C++ programmer expects:

- **Inlining** across method boundaries — the enabling optimisation; almost everything else depends on it.
- **Devirtualisation.** The profile says a call site has only ever seen `HashMap`. C2 inlines `HashMap`'s method behind a **cheap type guard**. Monomorphic call sites become direct calls; a bimorphic site becomes two guarded branches; a megamorphic one falls back to a real dynamic dispatch.
- **Escape analysis** → **scalar replacement**: an object proven not to escape its compilation scope need not be heap-allocated at all; its fields become registers. (Note the precise claim: HotSpot does not "allocate objects on the stack" so much as *delete the object* and keep its fields.)
- **Lock elision**, loop unrolling, vectorisation, range-check elimination, intrinsics for `Math`, `System.arraycopy`, `String` methods, `Atomic*`.
- **Deoptimisation.** Every speculative assumption is guarded. Load a class that makes a previously-monomorphic site polymorphic, and the compiled code is thrown away and execution resumes *in the interpreter, mid-method*, at a recorded safepoint. This is the mechanism that makes speculation safe — and it is why a long-running service can transiently get slower after a new code path first executes.

**[HotSpot]** Note what this buys you that an AOT compiler cannot have: profile-guided optimisation of the actual production workload, and the ability to inline through virtual calls that a static compiler must leave as indirect jumps.

<div class="note">
<span class="label">Naming</span>
<p>"Java is interpreted" and "Java is compiled" are both wrong as stated. Java is compiled twice: <strong>statically to bytecode</strong>, then <strong>dynamically to machine code</strong>, with an interpreter covering the cold start. The precise phrase in an interview is "bytecode-compiled, then JIT-compiled at runtime with tiered compilation and deoptimisation."</p>
</div>

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> preprocessor → per-TU object files → linker resolves symbols → one binary; templates instantiated at compile time; inlining decided by the compiler with no runtime knowledge; ODR and mangled names.</p>
<p><strong>Java:</strong> no preprocessor, no headers, no linker. A class file is self-describing and references everything else <em>by name</em>. Linking happens inside the JVM, lazily, and the optimiser runs while your program is running.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Unit of compilation | Translation unit → `.o` | One class → one `.class` (nested/anonymous classes get their own files) |
| Declaration sharing | Headers, textual inclusion, ODR | None. The class file *is* the interface; `javac` reads other `.class` files |
| Link time | Before shipping | At runtime, per symbol, lazily |
| Symbol names | Mangled | Plain UTF-8 names + descriptors in the constant pool |
| Optimisation | Ahead of time, no profile (unless you set up PGO) | At runtime, with a live profile, revocable |
| Invalid binary | Undefined behaviour | Rejected by the verifier |
| Integer overflow | UB for signed | **Defined**: two's-complement wraparound |
| Evaluation order of arguments | Unspecified (pre-C++17 in general) | **Specified**: strictly left to right |
| Startup cost | Microseconds | Tens to hundreds of milliseconds, plus warm-up |
| "Portable" | Recompile per platform/ABI | Same class file everywhere; the *JVM* is per-platform |

<div class="trap">
<span class="label">Misconceptions a C++ programmer arrives with</span>
<p><strong>“Bytecode is like assembly, so I can read performance off it.”</strong> No. Bytecode is a stack machine encoding of language semantics. C2 discards the stack model entirely, converts to SSA, and inlines aggressively. A method that looks expensive in <code>javap</code> may compile to nothing.</p>
<p><strong>“Virtual calls everywhere must be slow.”</strong> In C++ a virtual call is an indirect jump the optimiser cannot see through. In Java the profile usually proves the site monomorphic, so it becomes an inlined direct call behind a guard. Java's dispatch overhead is frequently <em>lower</em> than an equivalent C++ virtual call — and higher when the site is genuinely megamorphic.</p>
<p><strong>“<code>final</code> is <code>const</code>, so it helps the optimiser.”</strong> Mostly not: C2 already knows what is overridden, via class-hierarchy analysis, and deoptimises if a new subclass appears. <code>final</code> is a design and safety tool in Java (plus real JMM semantics for fields — Phase 25), not a performance hint.</p>
<p><strong>“There must be a <code>javac -O</code>.”</strong> There isn't, and asking for one in an interview signals the wrong mental model. Optimisation lives in the JVM.</p>
</div>

## 9. Edge cases

1. **Constant inlining across compilation units.** As in §6 — `static final int X = 40;` is copied into every reader's class file. `static final Integer X = 40;` is *not* (not a compile-time constant type), nor is `static final int X = compute();`.
2. **`UnsupportedClassVersionError` reads backwards.** "class file version 65.0, this JVM supports up to 61.0" means the *artifact* is newer than the *runtime* — you built with 21 and are running on 17.
3. **`NoClassDefFoundError` ≠ `ClassNotFoundException`.** The latter is a checked exception from a reflective lookup (`Class.forName`). The former is an `Error` thrown at a use site — and it is also what you get when a class's `<clinit>` threw earlier: the class is marked erroneous, and the *second* access reports `NoClassDefFoundError` with no useful stack trace. Always hunt for the first `ExceptionInInitializerError` in the log.
4. **Two class loaders, same name.** `ClassCastException` naming the same type twice. Loader identity is part of type identity.
5. **`System.exit()` inside a static initialiser** and deadlocks between two classes' `<clinit>` are both real: class initialisation takes a per-class lock, and two threads initialising two mutually-referencing classes can deadlock.
6. **Java 25 has AOT caching** (Project Leyden, `-XX:AOTCache`): loading and linking work from a training run is recorded and replayed to cut startup. It does **not** turn Java into an AOT-compiled language — GraalVM Native Image does that, and pays for it with no JIT, no profile, and restricted reflection.

## 10. Common mistakes

- Using `-source`/`-target` instead of `--release`, then getting `NoSuchMethodError` in production.
- Benchmarking without warm-up, and concluding something about the JVM. (You measured the interpreter and C1.)
- Assuming a `.class` file is tied to the Java version of its source language features — it is tied to the *class file version*, and `--release 17` on a JDK 25 compiler produces perfectly good 17 bytecode.
- Believing `javap` output predicts machine code.
- Shipping a fat JAR built on JDK 25 to a JDK 17 runtime and being surprised.
- Saying "the JRE" in 2026 as if it were a thing you download.

## 11. Interview questions

**Beginner**
1. What is the difference between the JDK, the JRE, and the JVM?
2. What does `javac` produce, and what runs it?
3. Why is Java called platform independent when the JVM is platform specific?

**Intermediate**
4. Is Java compiled or interpreted? Defend your answer precisely.
5. Walk me through what happens when I run `java com.acme.Main`.
6. What is the difference between `NoClassDefFoundError` and `ClassNotFoundException`?
7. What does the bytecode verifier do, and what would break without it?

**Advanced**
8. What is tiered compilation? Why have both C1 and C2?
9. What is deoptimisation and why is it necessary for aggressive optimisation?
10. How can the JIT inline a virtual call that a static compiler could not?
11. What is escape analysis, and what does HotSpot actually do with the result?

**Senior / deep dive**
12. Class initialisation is lazy — define precisely what triggers it, and give a case where it is *not* triggered by referencing the class.
13. Two classes with identical bytes are loaded by different loaders. Are they the same type? What breaks?
14. Why does changing a `public static final int` in one library force recompilation of its consumers?
15. When would you choose GraalVM Native Image over HotSpot, and what do you give up?

## 12. Follow-up questions to expect

- *After Q4:* "Then why does my Java service take 30 seconds to reach full speed?" → warm-up, tier promotion, profile accumulation, class loading, and the first-GC effect.
- *After Q5:* "Where does the classpath get searched, and in what order?" → parent delegation; then "how would you break delegation and why would anyone?" → app servers, plugin isolation, OSGi.
- *After Q8:* "What happens if the code cache fills up?" → compilation stops, everything degrades toward the interpreter; `-XX:ReservedCodeCacheSize`.
- *After Q9:* "How does the JVM resume mid-method after throwing away compiled code?" → safepoints and the deoptimisation state map.
- *After Q12:* "Does accessing a `static final` constant initialise the class?" → no, if it is a compile-time constant. Does `Foo[] a = new Foo[10]`? → no.
- *After Q14:* "How would you avoid that coupling in a published API?" → don't expose mutable-in-practice constants as `static final` primitives; use a static accessor method.

## 13. Coding exercise

Create two classes in separate files:

```java
public class Config {
    public static final int TIMEOUT_MS = 3000;
    public static final String NAME = "svc";
    public static final Integer BOXED_TIMEOUT = 3000;
    static { System.out.println("Config initialised"); }
}

public class Client {
    public static void main(String[] args) {
        System.out.println(Config.TIMEOUT_MS);
        System.out.println(Config.NAME);
    }
}
```

1. Compile both, run `Client`. Does "Config initialised" print? Explain, using §7 step 5.
2. Change `TIMEOUT_MS` to `5000`, recompile **only** `Config.java`, run `Client` again. What prints? Now recompile `Client` too.
3. Replace the read of `TIMEOUT_MS` with `BOXED_TIMEOUT` and repeat step 2. What is different, and why?
4. Run `javap -c Client.class` for each version and point at the exact instruction that explains the behaviour.

Write down your prediction *before* running each step.

## 14. Output prediction

Predict output, compile error, or runtime exception — and say whether the behaviour is decided at compile time or run time.

**A**
```java
class A {
    static { System.out.println("A init"); }
    static final int N = 42;
    static int m = 7;
}
public class Main {
    public static void main(String[] args) {
        System.out.println(A.N);
        System.out.println("---");
        System.out.println(A.m);
    }
}
```

**B**
```java
class Boom {
    static final int[] TABLE = new int[]{1, 2, 3};
    static { if (TABLE.length == 3) throw new IllegalStateException("bad table"); }
}
public class Main {
    public static void main(String[] args) {
        for (int i = 0; i < 2; i++) {
            try { System.out.println(Boom.TABLE[0]); }
            catch (Throwable t) { System.out.println(t.getClass().getSimpleName()); }
        }
    }
}
```

**C**
```java
public class Main {
    public static void main(String[] args) {
        int x = Integer.MAX_VALUE;
        System.out.println(x + 1);
        System.out.println(2_000_000_000 + 2_000_000_000);
    }
}
```

**D**
```java
public class Main {
    static int i = 0;
    public static void main(String[] args) {
        System.out.println(f() + g() + f());
    }
    static int f() { i += 1; return i; }
    static int g() { i *= 10; return i; }
}
```

Do not read on for answers — there aren't any here. Work them out, then ask for the walkthrough.

## 15. Mastery check

1. Give the precise five stages between "the JVM has the bytes of a class" and "static initialisers have run", and say which one assigns `0` to a static `int`.
2. Why can `NoClassDefFoundError` appear with a stack trace that does not mention the real failure?
3. Explain, without using the word "faster", why a JIT can produce better code than an ahead-of-time compiler — and one case where it reliably cannot.
4. What exactly is guarded when C2 inlines a virtual call, and what happens when the guard fails?
5. Your service's p99 latency spikes 40 minutes after a deploy, with no traffic change. Give two JIT-related explanations.
6. Why is a class's identity the pair (name, defining loader) rather than just the name? Give a concrete failure this prevents and a confusing error it causes.
7. Which of these trigger class initialisation of `Foo`: `new Foo()`, `Foo.CONSTANT` (a `static final int` literal), `Foo.staticMethod()`, `Foo[] a = new Foo[3]`, `Class.forName("Foo")`, a subclass's `<clinit>`?
8. What does the verifier make impossible that a C++ program can do freely? Name two.
9. Why does `--release 17` on JDK 25 differ from `-source 17 -target 17`?
10. Explain the difference between the JVM specification, the HotSpot implementation, and the Java language specification, using one example of a behaviour from each.
