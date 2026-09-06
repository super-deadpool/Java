---
title: "Exceptions: the hierarchy and the checked/unchecked decision"
phase: 7
order: 1
minutes: 30
summary: "Throwable's three branches, what checked exceptions were meant to achieve, when they help, and why they are the most controversial decision in Java's design."
tags: ["exceptions", "checked", "unchecked", "error", "design"]
---

## 1. Concept

Everything thrown in Java is a `Throwable`, and the tree has three meaningful branches:

```text
Throwable
├── Error                    unchecked — the JVM or environment is broken. Do not catch.
│   ├── OutOfMemoryError, StackOverflowError, NoClassDefFoundError, LinkageError
├── Exception                CHECKED — recoverable conditions the caller should handle
│   ├── IOException, SQLException, InterruptedException, ClassNotFoundException
│   └── RuntimeException     unchecked — programming errors
│       ├── NullPointerException, IllegalArgumentException, IllegalStateException,
│           ClassCastException, IndexOutOfBoundsException, ArithmeticException,
│           ConcurrentModificationException, UnsupportedOperationException
```

The **checked** rule: any `Throwable` that is not an `Error` and not a `RuntimeException` must be either caught or declared in the method's `throws` clause. The compiler enforces it — this is the "catch or specify" requirement, and Java is essentially alone among mainstream languages in having it.

## 2. Why Java has checked exceptions

The intent: make failure modes part of the **API signature**. `Files.readString(path)` declares `throws IOException`, so a caller cannot forget that the disk can fail. It is documentation the compiler verifies, and for genuinely recoverable, expected conditions at a module boundary it works well.

The criticism, which you should be able to state fairly:

- **They do not compose.** A lambda cannot throw a checked exception unless the functional interface declares it — which is why nearly all of `java.util.function` is unusable with `IOException`.
- **They leak implementation details.** A `Repository` that declares `throws SQLException` cannot be reimplemented over HTTP without changing every caller.
- **They encourage the worst possible handler:** `catch (Exception e) { }` or `throws Exception` on everything.
- **The caller usually cannot recover anyway.** Most failures propagate to a top-level handler that logs and returns a 500.

Modern practice, and what most interviewers expect to hear: **use unchecked exceptions by default; use checked exceptions only when the caller can realistically do something different because of them** — retry, fall back, prompt the user.

## 3. Mental model

> `Error` = the platform failed. `RuntimeException` = *your code* has a bug. Checked `Exception` = the *world* failed in a way this caller was supposed to plan for.

If the answer to "what would a caller do differently?" is "nothing", the exception should be unchecked.

## 4. Syntax

```java
public byte[] load(Path p) throws IOException {              // declaring
    if (p == null) throw new IllegalArgumentException("p");  // unchecked: caller's bug
    return Files.readAllBytes(p);                            // checked: propagate
}

try {
    var data = load(path);
} catch (NoSuchFileException e) {          // most specific first
    return defaults();
} catch (IOException | SecurityException e) {   // multi-catch (Java 7); e is effectively final
    throw new ConfigLoadException("cannot read " + path, e);   // wrap, preserving the cause
} finally {
    metrics.increment("config.load");      // always runs (see §7 for the exceptions to "always")
}
```

## 5. Custom exceptions

```java
public class InsufficientFundsException extends RuntimeException {   // unchecked: caller can't fix it
    private final long shortfallMinor;

    public InsufficientFundsException(long shortfallMinor, Throwable cause) {
        super("short by " + shortfallMinor, cause);        // always accept and pass a cause
        this.shortfallMinor = shortfallMinor;
    }
    public long shortfallMinor() { return shortfallMinor; }   // data the handler can act on
}
```

Rules that hold up in review: extend `RuntimeException` unless you have a specific recovery story; include the failed values as *fields*, not only in the message; always provide a `(String, Throwable)` constructor; never lose the cause; name it after the condition, not the layer.

## 6. Exception translation

```java
public Order findOrder(long id) {
    try {
        return jdbc.queryForObject(SQL, mapper, id);
    } catch (EmptyResultDataAccessException e) {
        throw new OrderNotFoundException(id, e);     // domain-level abstraction
    } catch (DataAccessException e) {
        throw new RepositoryException("order lookup failed for " + id, e);
    }
}
```

Each layer should throw exceptions at **its own level of abstraction**, with the lower-level exception attached as the cause. Losing the cause (`throw new RepositoryException("failed")`) destroys the stack trace and is one of the most damaging habits in production code.

## 7. What happens internally

**[JVMS]** A method's `Code` attribute has an **exception table**: rows of `(start_pc, end_pc, handler_pc, catch_type)`. `athrow` unwinds frames until a row matches; if none does, the thread's uncaught handler runs. Critically, **an exception table entry costs nothing when no exception is thrown** — `try` blocks are free; only throwing is expensive.

**[JVMS]** The `throws` clause is stored in an `Exceptions` attribute and is **not enforced by the JVM** — it is purely a `javac` rule. Bytecode can throw any checked exception from a method that declares none, which is exactly what Lombok's `@SneakyThrows` and `Unsafe.throwException` exploit. This is a good "do you know what's spec versus compiler?" question.

**[HotSpot]** Cost breakdown: constructing a `Throwable` calls `fillInStackTrace()`, a native walk of the whole stack — that is the expensive part, roughly microseconds for a deep stack. Throwing and catching itself is cheap. Two consequences: never use exceptions for control flow in a hot loop; and for a genuinely hot, expected failure you can override `fillInStackTrace()` to return `this`, or use the `(message, cause, suppression, writableStackTrace)` constructor with `writableStackTrace = false` — the JDK does this for `Stream` internals. **[HotSpot]** also has an optimisation that replaces a repeatedly-thrown implicit exception with a preallocated stackless instance ("the compiler has optimized away this exception, use `-XX:-OmitStackTraceInFastThrow`"), which is a classic cause of "NPE with an empty stack trace" in production logs.

`finally` is implemented by **duplicating** the finally block into every exit path (plus a catch-all handler) — which is why a `return` inside `finally` silently discards a pending exception.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++:</strong> you can throw anything (though <code>std::exception</code> is convention), there are no checked exceptions, <code>noexcept</code> is the only declaration and violating it calls <code>std::terminate</code>. Cleanup is automatic via destructors (RAII) — <code>finally</code> is unnecessary. Exceptions may be disabled entirely (<code>-fno-exceptions</code>).</p>
<p><strong>Java:</strong> only <code>Throwable</code> subclasses can be thrown; checked exceptions are compiler-enforced; there are no destructors, so cleanup needs <code>finally</code> or try-with-resources; exceptions are always available and are the normal error mechanism throughout the JDK.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| What can be thrown | Any type | `Throwable` subclasses only |
| Compile-time obligation | None (`noexcept` is a promise, not a requirement) | Checked exceptions must be caught or declared |
| Cleanup | RAII destructors, automatic | `finally` / try-with-resources, manual |
| Stack trace | Not standard; must be captured manually | Built in, captured at construction |
| Cost when not thrown | Zero-cost tables | Zero — `try` is free |
| Cost when thrown | Expensive (unwinding) | Expensive, dominated by `fillInStackTrace` |
| Catch by value/ref | `catch (const E&)` | Always a reference; no slicing |
| Rethrow | `throw;` preserves the original | `throw e;` — same object, trace preserved |
| Failure in cleanup | Destructor throwing during unwind → `terminate` | `finally` throwing **replaces** the original exception (silently!) |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Looking for RAII.</strong> There is none. Every resource needs try-with-resources (Module 7.2) — a file handle is not closed by garbage collection.</p>
<p><strong>Catching broadly because C++ has no checked exceptions.</strong> <code>catch (Exception e)</code> also catches every <code>RuntimeException</code> — including bugs you wanted to see.</p>
<p><strong>Assuming <code>throws</code> is enforced by the runtime.</strong> It is a compiler rule only.</p>
<p><strong>Throwing in a <code>finally</code> block.</strong> In C++ that terminates; in Java it silently swallows the original exception, which is worse because it hides the real failure.</p>
</div>

## 9. Edge cases

```java
// 1. finally beats return
static int f() { try { return 1; } finally { return 2; } }        // returns 2, and any exception is LOST

// 2. finally can swallow
static int g() { try { throw new RuntimeException("real"); } finally { return 0; } }   // returns 0

// 3. return value is computed BEFORE finally runs
static int h() { int x = 1; try { return x; } finally { x = 99; } }   // returns 1

// 4. multi-catch variables are implicitly final
try { ... } catch (IOException | SQLException e) { /* e = null;  ERROR */ }

// 5. an override may throw FEWER checked exceptions, never more
class A { void m() throws IOException {} }
class B extends A { @Override void m() {} }                    // legal
class C extends A { @Override void m() throws Exception {} }   // ERROR

// 6. catching an exception the try block cannot throw is a compile error (for checked types)
try { System.out.println(); } catch (IOException e) {}         // ERROR: never thrown in body
try { System.out.println(); } catch (Exception e) {}           // legal — Exception covers unchecked

// 7. InterruptedException must never be swallowed
try { Thread.sleep(100); }
catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IllegalStateException(e); }
```

Case 7 is a genuine production issue: catching `InterruptedException` and ignoring it destroys the interrupt signal and makes threads unstoppable (Phase 24).

## 10. Common mistakes

- `catch (Exception e) { e.printStackTrace(); }` — catches bugs, logs to stdout, continues in a broken state.
- Swallowing exceptions with an empty catch block.
- `throw new MyException("failed")` without the cause.
- `return` or `throw` inside `finally`.
- Catching `Throwable` or `Error` (you cannot meaningfully recover from `OutOfMemoryError`).
- Using exceptions for control flow (e.g. `NumberFormatException` to test if a string is numeric, inside a loop).
- Declaring `throws Exception` on everything.
- Swallowing `InterruptedException`.
- Logging *and* rethrowing — the same failure then appears three times in the log.

## 11. Interview questions

**Beginner** — 1. Checked vs unchecked? 2. Give five common runtime exceptions. 3. What does `finally` guarantee?

**Intermediate** — 4. Why not catch `Error`? 5. Can a `finally` block change the return value? Show it. 6. What are the rules for `throws` in an override, and why? 7. Why is multi-catch's variable final?

**Advanced** — 8. What is exception translation and why does it matter? 9. Where is the real cost of an exception, and how do you avoid it? 10. Is `throws` enforced by the JVM? Prove it. 11. Why do checked exceptions break lambdas?

**Senior** — 12. Design an error strategy for a layered service: which layer throws what, and what does the top-level handler do? 13. Argue both sides of checked exceptions. 14. An NPE arrives with an empty stack trace. Explain and fix. 15. How do you handle `InterruptedException` correctly, and why does it matter?

## 12. Follow-ups

- *After Q5:* "So what is the rule for `finally` and control flow?" → never return or throw from it.
- *After Q9:* "How would you make an exception cheap?" → `writableStackTrace=false`, or don't use exceptions there.
- *After Q11:* "So how do you call a throwing method inside a stream?" → wrap in an unchecked exception, or use a custom throwing-functional-interface adapter.

## 13. Exercise

Write a `ConfigLoader` that reads a file, parses JSON, and validates it. Then:
1. Define the exception strategy: which failures are checked, which unchecked, and why.
2. Ensure every thrown exception carries the file path and the cause.
3. Write a test asserting that a corrupted file produces your domain exception with the parse exception as `getCause()`.
4. Add a `finally` that closes a metric timer, and prove with a test that an exception still propagates.
5. Now deliberately `return` from that `finally` and watch the test fail. Explain exactly what happened.

## 14. Output prediction

```java
public class Main {
    static int f() { try { return 1; } finally { System.out.println("finally f"); } }
    static int g() { try { return 1; } finally { return 2; } }
    static int h() { int x = 1; try { return x; } finally { x = 99; } }
    static int i() { try { throw new RuntimeException("boom"); } finally { return 3; } }
    public static void main(String[] args) {
        System.out.println(f());
        System.out.println(g());
        System.out.println(h());
        System.out.println(i());
    }
}
```

```java
public class Main {
    public static void main(String[] args) {
        try {
            try {
                throw new IllegalStateException("inner");
            } finally {
                System.out.println("inner finally");
            }
        } catch (Exception e) {
            System.out.println("caught " + e.getMessage());
        }
        System.out.println(divide());
    }
    static String divide() {
        try { int x = 1 / 0; return "no"; }
        catch (ArithmeticException e) { return "arith"; }
        finally { System.out.println("div finally"); }
    }
}
```

## 15. Mastery check

1. Draw the `Throwable` hierarchy and say which branches are checked.
2. State the catch-or-specify rule and the three exemptions.
3. Give the design test for choosing checked vs unchecked.
4. List four arguments against checked exceptions and one strong argument for them.
5. Why may an override not widen its `throws` clause?
6. Where does an exception's cost actually go, and how do you make one cheap?
7. Is `throws` enforced at run time? What exploits the answer?
8. What does a `return` inside `finally` do to a pending exception?
9. Why must `InterruptedException` never be swallowed, and what is the correct handling?
10. Map C++'s RAII, `noexcept` and `catch(...)` onto their Java counterparts, noting what has no counterpart.
