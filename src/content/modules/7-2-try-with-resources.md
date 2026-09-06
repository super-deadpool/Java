---
title: "try-with-resources, AutoCloseable, and Suppressed Exceptions"
phase: 7
order: 2
minutes: 25
summary: "Java's answer to RAII: what the compiler generates, why suppressed exceptions exist, and the resource-leak bugs the old try/finally idiom caused."
tags: ["try-with-resources", "autocloseable", "suppressed", "resources", "raii"]
---

## 1. Concept

`try`-with-resources (Java 7) declares resources in the `try` header and closes them automatically, in reverse order of declaration, whether the block completes normally or abruptly:

```java
try (var in = Files.newInputStream(src);
     var out = Files.newOutputStream(dst)) {
    in.transferTo(out);
}   // out.close() then in.close(), always
```

A resource must implement **`AutoCloseable`** (`void close() throws Exception`) or its subinterface **`Closeable`** (`void close() throws IOException`, and idempotent by contract).

## 2. Why

The pre-Java-7 idiom was wrong in a way almost nobody got right:

```java
InputStream in = null;
try {
    in = Files.newInputStream(src);
    // ... use in ...
} finally {
    if (in != null) in.close();    // if the body threw AND close() throws, the BODY's exception is lost
}
```

With two resources the correct version needs nested try/finally and is about fifteen lines. Worse, the exception thrown by `close()` **replaces** the exception from the body — so you get "connection reset" instead of the actual bug. `try`-with-resources fixes both: it is shorter, and it keeps the primary exception.

## 3. Mental model

> It is a scope-bound `close()` with a rule about which exception wins: **the body's exception is primary; anything thrown while closing is attached to it as *suppressed***.

## 4. Syntax, all forms

```java
// classic
try (BufferedReader r = Files.newBufferedReader(path)) { ... }

// multiple resources: closed in REVERSE order
try (Connection c = ds.getConnection();
     PreparedStatement s = c.prepareStatement(SQL);
     ResultSet rs = s.executeQuery()) { ... }

// Java 9+: an effectively final variable declared outside can be used directly
var lock = acquireLock();
try (lock) { ... }

// combined with catch and finally (both run AFTER the resources are closed)
try (var in = open()) { ... }
catch (IOException e) { ... }
finally { ... }
```

## 5. What the compiler generates

```java
// Source
try (Resource r = open()) {
    r.use();
}
```

```java
// Roughly what javac emits
Resource r = open();
Throwable primary = null;
try {
    r.use();
} catch (Throwable t) {
    primary = t;
    throw t;
} finally {
    if (r != null) {
        if (primary != null) {
            try { r.close(); }
            catch (Throwable suppressed) { primary.addSuppressed(suppressed); }   // NOT rethrown
        } else {
            r.close();                                                            // may throw normally
        }
    }
}
```

**[JLS §14.20.3]** That is the whole semantics: if the body threw, a `close()` failure is *suppressed* onto the primary exception (`Throwable.addSuppressed`, retrievable with `getSuppressed()`, and printed by the default stack-trace printer as `Suppressed: ...`). If the body succeeded, a `close()` failure propagates normally.

## 6. Realistic example

```java
public final class ReportJob implements AutoCloseable {
    private final Connection connection;
    private final Path tempDir;

    public ReportJob(DataSource ds) throws SQLException, IOException {
        this.connection = ds.getConnection();
        try {
            this.tempDir = Files.createTempDirectory("report");    // if THIS throws, close what we have
        } catch (IOException e) {
            try { connection.close(); } catch (SQLException s) { e.addSuppressed(s); }
            throw e;
        }
    }

    @Override public void close() throws IOException {
        try (connection) {                        // Java 9 form: closes the connection too
            deleteRecursively(tempDir);
        } catch (SQLException e) {
            throw new IOException(e);
        }
    }
}
```

Two lessons: a constructor that acquires more than one resource must clean up on partial failure (try-with-resources cannot help before the object exists), and `close()` implementations should be **idempotent** and should not throw for reasons the caller cannot act on.

## 7. Edge cases

```java
// 1. The resource variable is implicitly final
try (var r = open()) { /* r = other;  ERROR */ }

// 2. A null resource is fine — close() is only called if non-null
try (Resource r = null) { }        // no NPE

// 3. Resources close BEFORE catch and finally run
try (var r = open()) { throw new RuntimeException("body"); }
catch (Exception e) { /* r is already closed here */ }

// 4. Reverse order matters when resources are layered
try (var fis = new FileInputStream(f);
     var bis = new BufferedInputStream(fis)) { }   // bis closed first — correct

// 5. Closing a wrapper closes what it wraps — declaring both is harmless but redundant
try (var reader = new BufferedReader(new FileReader(f))) { }   // FileReader closed by BufferedReader
                                                               // but if `new BufferedReader` throws,
                                                               // the FileReader LEAKS. Declare both.

// 6. Streams over files are resources too
try (Stream<String> lines = Files.lines(path)) { lines.forEach(System.out::println); }
// Files.lines holds an open file handle — a very common leak when people forget this.
```

Case 5 is subtle and worth remembering: `new BufferedReader(new FileReader(f))` leaks the `FileReader` if the `BufferedReader` constructor fails. Declaring each resource separately in the header is the safe idiom.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ RAII:</strong> the destructor runs at scope exit, guaranteed, for every object, with no syntax at the use site. Ownership is expressed in the type (<code>unique_ptr</code>, <code>lock_guard</code>), so leaks are structurally impossible.</p>
<p><strong>Java:</strong> nothing is automatic. try-with-resources is <em>opt-in per use site</em> — every caller must remember. GC frees memory but never releases file handles, sockets, locks or native memory.</p>
</div>

| Concern | C++ RAII | Java try-with-resources |
| --- | --- | --- |
| Who remembers | The type's author (once) | Every caller (every time) |
| Scope | Any object, any scope | Only `AutoCloseable`, only in a `try` header |
| Failure during cleanup | Destructor throwing during unwind → `std::terminate` | Suppressed onto the primary exception |
| Ownership transfer | `std::move`, `unique_ptr` | Convention and documentation only |
| Locks | `std::lock_guard` | `synchronized` block, or `ReentrantLock` + `try/finally` |
| Deterministic | Yes | Yes, within the `try` — but only if someone wrote it |
| Missed cleanup | Nearly impossible with RAII types | Common; needs static analysis or leak detection |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p><strong>Assuming GC closes things.</strong> It does not, ever, deterministically. An unclosed <code>FileInputStream</code> holds an OS handle until the process exits or a finalizer/Cleaner happens to run.</p>
<p><strong>Expecting a destructor equivalent on your own classes.</strong> Implement <code>AutoCloseable</code> and rely on callers.</p>
<p><strong>Forgetting that streams from <code>Files.lines</code>, <code>Files.walk</code> and <code>DirectoryStream</code> are resources.</strong></p>
<p><strong>Using <code>synchronized</code> and expecting a <code>lock_guard</code>-style object.</strong> <code>ReentrantLock</code> requires an explicit <code>try { } finally { lock.unlock(); }</code> — it is not <code>AutoCloseable</code> by default.</p>
</div>

## 9. Common mistakes

- Using the old `try/finally` idiom and losing the primary exception.
- Not closing `Stream`s returned by `Files.lines`/`Files.walk`.
- `close()` implementations that throw for trivial reasons, or that are not idempotent.
- Acquiring two resources in one constructor without partial-failure cleanup.
- Nesting constructors in a single resource declaration (§7 case 5).
- Ignoring `getSuppressed()` when debugging — the real cause is often in there.
- Returning an unclosed resource from a method that has a try-with-resources block (the resource closes before the caller uses it).

## 10. Interview questions

**Beginner** — 1. What does try-with-resources do? 2. What interface must a resource implement? 3. In what order are multiple resources closed?

**Intermediate** — 4. What is a suppressed exception and when does one occur? 5. What was wrong with the old try/finally idiom? 6. Do `catch` and `finally` run before or after the resources close? 7. `AutoCloseable` vs `Closeable`?

**Advanced** — 8. Write the code javac generates for a one-resource block. 9. Why is `new BufferedReader(new FileReader(f))` in a resource header a leak risk? 10. How do you retrieve a suppressed exception, and when would you need to? 11. Why is the resource variable implicitly final?

**Senior** — 12. Design an `AutoCloseable` that holds a connection and a temp directory; handle partial construction failure. 13. Compare RAII and try-with-resources on safety, ergonomics and failure modes. 14. How would you detect unclosed resources in production?

## 11. Follow-ups

- *After Q4:* "Which exception does the caller see, and where is the other one?"
- *After Q9:* "How do you write it safely?" → separate resource declarations.
- *After Q14:* → JFR events, `-Djdk.tracePinnedThreads`-style diagnostics, leak-detection wrappers, static analysis, and `Cleaner` with a logged warning.

## 12. Exercise

1. Write `class Noisy implements AutoCloseable` that prints on open and close and can be configured to throw from either the body or `close()`.
2. Build a try-with-resources block with three `Noisy` instances and produce, in turn: normal completion; a body exception; a close exception; **both**.
3. For the fourth case, print `e.getMessage()` and `Arrays.toString(e.getSuppressed())` and explain the output.
4. Rewrite the same block with the pre-Java-7 idiom and show that the body exception is lost.

## 13. Output prediction

```java
class R implements AutoCloseable {
    private final String n; private final boolean failOnClose;
    R(String n, boolean f) { this.n = n; this.failOnClose = f; System.out.println("open " + n); }
    @Override public void close() {
        System.out.println("close " + n);
        if (failOnClose) throw new RuntimeException("close-" + n);
    }
}
public class Main {
    public static void main(String[] args) {
        try (R a = new R("a", true); R b = new R("b", true)) {
            throw new RuntimeException("body");
        } catch (Exception e) {
            System.out.println("caught: " + e.getMessage());
            for (Throwable s : e.getSuppressed()) System.out.println("suppressed: " + s.getMessage());
        } finally {
            System.out.println("finally");
        }
    }
}
```

## 14. Mastery check

1. Write the desugaring of a one-resource try-with-resources from memory.
2. When is an exception suppressed rather than thrown, and how do you retrieve it?
3. In what order do resources close relative to `catch` and `finally`?
4. What exactly was lost by the old try/finally idiom?
5. Why must a resource variable be final?
6. Give two resource types people routinely forget to close.
7. Why is nesting constructors inside one resource declaration risky?
8. How do you correctly acquire two resources inside a constructor?
9. Compare RAII with try-with-resources: who is responsible, and what is the failure mode of each?
10. Why does garbage collection not solve resource management?
