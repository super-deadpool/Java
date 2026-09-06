---
title: "Creational and structural patterns in modern Java"
phase: 27
order: 1
minutes: 45
summary: "Singleton, factory, builder, adapter, decorator, proxy and flyweight — each with its JDK example, its Spring counterpart, and an honest note on which ones modern Java has made unnecessary."
tags: ["design-patterns", "singleton", "builder", "factory", "decorator", "proxy", "adapter"]
---

## 1. Why patterns still matter, and where they do not

The Gang of Four catalogue was written for C++ and Smalltalk in 1994. Java's ecosystem absorbed it so completely that the JDK itself is a pattern reference — and then Java changed enough that several patterns became language features.

Three honest positions to hold:

- **Patterns are vocabulary first.** "It's a decorator" communicates a design in three words. That value is undiminished.
- **Several patterns are workarounds for missing features.** Strategy is a workaround for the absence of function types; Java 8 removed the need. Visitor is a workaround for the absence of pattern matching; Java 21 removed the need.
- **Applying a pattern you do not need is a defect.** `AbstractSingletonProxyFactoryBean` is a real Spring class and a real cautionary tale.

## 2. Singleton

Covered mechanically in Modules 15.1 §6 and 25.2 §5. The summary:

```java
public enum ConnectionPool { INSTANCE;  /* the best implementation */ }

public class Cache {                     // the holder idiom: lazy, no synchronization
    private Cache() { }
    private static class Holder { static final Cache INSTANCE = new Cache(); }
    public static Cache getInstance() { return Holder.INSTANCE; }
}
```

**The design caveat matters more than the implementation.** A singleton is global mutable state with a hidden dependency edge: nothing in a method's signature reveals that it uses one, so it cannot be substituted in a test and it serialises every caller.

```java
// A hidden dependency — untestable without touching global state
public Report build() { return new Report(ConnectionPool.INSTANCE.query(...)); }

// An explicit one — trivially testable
public Report build(DataSource ds) { return new Report(ds.query(...)); }
```

Dependency injection frameworks give you *one instance per container* — the useful property — **without** the global access point. In a Spring application, `@Component` is the singleton you want; `INSTANCE` is the one you do not.

Legitimate uses remain: stateless utility holders, genuinely process-wide resources (a logger factory, a metrics registry), and enums used as strategies.

## 3. Static factory methods

**[Effective Java, Item 1]** The most useful "pattern" in Java is not in the GoF book: prefer a static factory method to a constructor.

```java
List.of(a, b)            Optional.ofNullable(x)      Integer.valueOf(5)
EnumSet.noneOf(C.class)  Stream.iterate(0, f)        Instant.ofEpochSecond(s)
Path.of("a", "b")        Executors.newFixedThreadPool(4)
```

What it buys over `new`:

| Advantage | Example |
| --- | --- |
| **A name** | `BigInteger.probablePrime(...)` versus a constructor with a boolean flag |
| **Need not create a new object** | `Integer.valueOf` returns cached instances; `Boolean.valueOf` returns two |
| **Can return a subtype** | `List.of` returns `List12` or `ListN`; `EnumSet.noneOf` returns `RegularEnumSet` or `JumboEnumSet` |
| **Can vary by argument** | Both of the above choose an implementation at runtime |
| **Better generic inference** | `Map.entry(k, v)` versus `new AbstractMap.SimpleEntry<>(k, v)` |

The conventional names — worth knowing because they are consistent across the JDK: `of`, `valueOf`, `from`, `instance`/`getInstance`, `create`/`newInstance`, `getType`, `newType`.

The **Factory Method** pattern proper is different: an *instance* method that subclasses override to choose the concrete type. `Collection.iterator()` is one — `ArrayList` and `LinkedList` each return their own implementation.

**Abstract Factory** produces *families* of related objects. It is heavier and rarer, and in a DI application it is usually replaced by injecting a configured set of beans.

```java
// JDK examples of abstract factory
DocumentBuilderFactory.newInstance().newDocumentBuilder();
SSLContext.getInstance("TLS").getSocketFactory();
// Spring's counterpart: FactoryBean<T>, or a @Configuration class producing related @Beans
```

## 4. Builder

The problem it solves: **too many constructor parameters**, especially optional ones.

```java
// The telescoping constructor antipattern
new HttpRequest(url, method, headers, body, timeout, retries, followRedirects, proxy);
new HttpRequest(url, method, null, null, 5000, 3, true, null);     // which null is which?
```

```java
public final class HttpRequest {
    private final URI uri; private final String method;
    private final Duration timeout; private final Map<String, String> headers;

    private HttpRequest(Builder b) {                       // private constructor
        this.uri = b.uri; this.method = b.method;
        this.timeout = b.timeout; this.headers = Map.copyOf(b.headers);
    }
    public static Builder newBuilder(URI uri) { return new Builder(uri); }

    public static final class Builder {
        private final URI uri;                              // required: in the constructor
        private String method = "GET";                      // optional: sensible defaults
        private Duration timeout = Duration.ofSeconds(30);
        private final Map<String, String> headers = new LinkedHashMap<>();

        private Builder(URI uri) { this.uri = Objects.requireNonNull(uri); }
        public Builder method(String m)          { this.method = m; return this; }
        public Builder timeout(Duration d)       { this.timeout = d; return this; }
        public Builder header(String k, String v){ this.headers.put(k, v); return this; }

        public HttpRequest build() {                        // VALIDATE here, not in each setter
            if (timeout.isNegative()) throw new IllegalArgumentException("timeout");
            return new HttpRequest(this);
        }
    }
}
```

Four rules that separate a good builder from a bad one: **required arguments go in the builder's constructor**, not as optional setters; **validate in `build()`** so cross-field invariants are checkable; **the product is immutable** and copies mutable inputs; and **the builder is a static nested class** (Module 16.1 §5) because it needs no enclosing instance.

**The JDK's own builders:** `HttpRequest.newBuilder()`, `HttpClient.newBuilder()`, `Stream.builder()`, `Locale.Builder`, `Calendar.Builder`, `DateTimeFormatterBuilder`, `ProcessBuilder`.

**Records reduce the need.** For a small immutable value, a record plus a compact constructor is shorter and safer. Builders earn their keep at roughly **five or more parameters**, or when several are optional:

```java
public record Range(int lo, int hi) {                     // no builder needed
    public Range { if (lo > hi) throw new IllegalArgumentException(); }
}

// "Wither" methods cover incremental modification without a builder
public record Config(String host, int port, Duration timeout) {
    public Config withPort(int p) { return new Config(host, p, timeout); }
}
```

**Prototype** — the GoF pattern for copying — is effectively dead in Java: `Cloneable`/`clone()` is broken by design (Module 3.1), and the replacements are a **copy constructor**, a **static copy factory** (`List.copyOf`), or a record wither.

## 5. Adapter

Convert one interface into another so incompatible code can cooperate.

```java
// JDK adapters
Arrays.asList(array);                        // T[]           -> List<T>  (fixed-size view)
Collections.list(enumeration);               // Enumeration<T>-> ArrayList<T>
new InputStreamReader(in, UTF_8);            // InputStream   -> Reader   (Module 19.1 §1)
Collections.newSetFromMap(new ConcurrentHashMap<>());   // Map -> Set
list.iterator();                             // Iterable      -> Iterator
```

The distinction from **Facade**: an adapter changes an interface to a *required* one; a facade invents a *simpler* one over a complex subsystem. `Files` is a facade over the filesystem API; `JdbcTemplate` is a facade over JDBC's `Connection`/`Statement`/`ResultSet` dance.

## 6. Decorator

Wrap an object in another with the same interface, adding behaviour. `java.io` is the canonical implementation (Module 19.1 §2).

```java
new BufferedReader(new InputStreamReader(new GZIPInputStream(in), UTF_8));
Collections.unmodifiableList(list);          // adds "reject mutation"
Collections.synchronizedMap(map);            // adds locking
```

**Decorator versus inheritance** is the reason it exists: `n` independent behaviours need `2ⁿ` subclasses but only `n` decorators. Buffering × compression × encryption × counting is 16 subclasses or 4 decorators.

**Decorator versus proxy** — both wrap and forward, and the distinction is intent: a decorator **adds behaviour** to an object the caller knows about; a proxy **controls access** to an object the caller may not know exists.

The modern lightweight form, when the interface is functional, is plain composition:

```java
Function<Request, Response> handler = this::handle;
handler = withRetry(withTimeout(withLogging(handler)));    // decorators as higher-order functions

static Function<Request, Response> withLogging(Function<Request, Response> next) {
    return req -> { log.info("-> {}", req); var r = next.apply(req); log.info("<- {}", r); return r; };
}
```

## 7. Proxy

A stand-in that controls access. Java has first-class runtime support (Module 18.1 §8), which is why the pattern is everywhere in frameworks and rarely hand-written.

| Kind | Purpose | Example |
| --- | --- | --- |
| **Virtual** | Defer expensive creation | JPA/Hibernate lazy associations |
| **Remote** | Represent an object in another process | RMI stubs, gRPC/Feign clients |
| **Protection** | Enforce access rules | Spring Security method interception |
| **Smart / interception** | Add cross-cutting behaviour | `@Transactional`, `@Cacheable`, `@Retryable` |

```java
@SuppressWarnings("unchecked")
static <T> T logging(Class<T> iface, T target) {
    return (T) Proxy.newProxyInstance(iface.getClassLoader(), new Class<?>[]{ iface },
        (p, method, args) -> {
            log.debug("-> {}", method.getName());
            try { return method.invoke(target, args); }
            catch (InvocationTargetException e) { throw e.getCause(); }
        });
}
```

**[JDK]** `java.lang.reflect.Proxy` can only proxy **interfaces**. Spring therefore uses JDK proxies when the bean implements an interface and **CGLIB/ByteBuddy subclass proxies** otherwise — and that choice has two consequences everyone eventually hits:

- **`final` methods and `final` classes cannot be proxied** by the subclass strategy, so the annotation silently does nothing.
- **Self-invocation bypasses the proxy.** Calling `this.transactionalMethod()` from inside the same bean goes straight to the implementation; the proxy is not in the call path, so `@Transactional` does not apply (Module 17.1 §7). The fix is to inject the bean into itself, or to move the method to another bean.

## 8. Flyweight

Share immutable instances instead of allocating duplicates. Java uses it internally in three places you already rely on:

```java
Integer.valueOf(127) == Integer.valueOf(127);    // true  — the -128..127 cache (Module 1.2)
"abc" == "abc";                                  // true  — the string pool  (Module 1.4)
Color.RED == Color.RED;                          // true  — enum constants   (Module 15.1)
Boolean.valueOf(true)                            // two instances, ever
```

Roll your own only when profiling shows duplicate-object pressure, and only for **immutable** values — a shared mutable flyweight is a data race waiting to happen.

**Composite** (uniform treatment of leaves and containers) has no strong JDK example but is the right shape for file trees, UI hierarchies and expression ASTs. In modern Java it is a **sealed interface** with record cases (Module 14.2 §6) rather than an abstract class with a children list.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>The GoF book was written in C++, so the patterns are native there</strong> — but C++ has since absorbed several into the language differently than Java did. Strategy is a template parameter (zero-cost, resolved at compile time) rather than an interface; RAII replaces most resource-management patterns outright; and CRTP gives compile-time template method with no virtual call.</p>
<p><strong>Java's runtime proxy support has no C++ equivalent.</strong> Generating a class at runtime that implements an arbitrary interface requires metadata C++ binaries do not carry (Module 18.1 §9), which is why C++ frameworks use templates, macros, or code generation where Java frameworks use proxies. That single capability is why Spring-style AOP exists in Java and not in C++.</p>
</div>

| Pattern | C++ idiom | Java idiom |
| --- | --- | --- |
| Singleton | Meyers singleton (function-local static) | Enum, or the holder idiom, or a DI-scoped bean |
| Factory | Free function, or a factory class | Static factory method |
| Builder | Named-parameter idiom, designated initialisers (C++20) | Builder class, or a record + withers |
| Prototype | Copy constructor — **the language default** | Copy constructor / static copy factory (`clone` is broken) |
| Adapter | Wrapper class, or a template adaptor (`std::stack`) | Wrapper class, or a JDK view method |
| Decorator | Wrapper, or a template mixin | Wrapper implementing the same interface |
| Proxy | Smart pointer, or a handle class | `java.lang.reflect.Proxy`, CGLIB |
| Flyweight | `std::flyweight` (Boost), interning | `Integer` cache, string pool, enums |
| Composite | Virtual hierarchy | Sealed interface + records |
| Pimpl | `unique_ptr<Impl>` — an ABI/compile-time tool | No equivalent; Java has no header files |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Reaching for a template-style zero-cost strategy and finding only interfaces. In Java a strategy is an object and the call is virtual — usually inlined when the call site is monomorphic, and not when it is not (Module 22.3 §4). Design for the common case being one implementation on a hot path.</p>
<p>Expecting a copy constructor to exist. Java has no copy semantics, no assignment operator, and <code>clone()</code> is a trap. Write a copy constructor or a static copy factory explicitly.</p>
</div>

## 10. Edge cases

- **A singleton with a `synchronized` getter** is correct and needlessly slow; the holder idiom is free after initialization.
- **A builder that validates in each setter** cannot check cross-field invariants; validate in `build()`.
- **A builder reused after `build()`** may share mutable collections with the product unless `build()` copies them.
- **`Arrays.asList` returns a fixed-size *view*** — `set` writes through to the array, `add` throws (Module 8.1).
- **A decorator that forwards to an interface must forward *every* method**, including `equals`, `hashCode` and `toString`, or wrapper/wrapped comparisons break (Module 5.3).
- **`Collections.synchronizedMap` still needs manual locking to iterate** (Module 10.1 §6).
- **A JDK proxy's `equals`/`hashCode`/`toString` reach the `InvocationHandler`** — handle them or you get surprising behaviour.
- **Spring proxies do not intercept `private`, `final`, or `static` methods**, and self-invocation bypasses them entirely.
- **A flyweight cache keyed on user input is an unbounded-cache leak** (Module 23.2 §5).
- **`Integer` caching is configurable upward** with `-XX:AutoBoxCacheMax`, which makes `==` behaviour *environment-dependent* — one more reason never to compare boxes with `==`.

## 11. Common mistakes

- A singleton where a DI-scoped bean belongs.
- A builder for a three-field immutable class that should be a record.
- Telescoping constructors.
- A builder whose product is mutable.
- Confusing adapter, decorator, facade and proxy.
- A decorator that forgets to forward one method.
- Expecting `@Transactional` to work on a self-invoked or `final` method.
- Hand-writing a proxy where `java.lang.reflect.Proxy` or an interceptor would do.
- Using `clone()`.
- Applying a pattern because it is in the book, adding two indirections and no capability.

## 12. Interview questions

**Beginner** — 1. What is a singleton and how do you implement one in Java? 2. What problem does a builder solve? 3. What is a decorator?

**Intermediate** — 4. Give five advantages of a static factory over a constructor. 5. Adapter versus decorator versus facade versus proxy. 6. Where does the JDK use the decorator pattern? 7. When is a record better than a builder?

**Advanced** — 8. Why is a singleton hard to test, and what replaces it? 9. Why must a builder validate in `build()` rather than in its setters? 10. Why can `java.lang.reflect.Proxy` only proxy interfaces, and what does Spring do about it? 11. Explain the self-invocation problem with `@Transactional`.

**Senior** — 12. Design a fluent, immutable HTTP request API with 12 fields, 3 required. Show the builder, the validation strategy, and how you would evolve it when field 13 arrives. 13. Which GoF patterns has modern Java made unnecessary, and by which feature? 14. When is applying a pattern a design smell? Give three concrete examples.

## 13. Follow-ups

- *After Q1:* "Which implementation, and why is the enum the best?"
- *After Q4:* "Which one does `EnumSet.noneOf` exploit?" → returning a subtype.
- *After Q5:* "Adapter and proxy both wrap and forward — what actually differs?" → intent.
- *After Q10:* "What breaks with the subclass strategy?" → `final` methods and classes.
- *After Q13:* → strategy (lambdas), visitor (patterns), iterator (for-each), prototype (records).

## 14. Exercise

1. Implement the `HttpRequest` builder from §4 with required/optional separation, `build()` validation, and defensive copying. Write a test proving the product is immutable after the builder is reused and mutated.
2. Take a class with an 8-parameter constructor. Convert it to a builder, then to a record with withers. Write down which you would ship and why.
3. Build a decorator chain over a `Function<Request, Response>`: logging, timing, retry, circuit breaker. Then build the same thing as classes implementing an interface. Compare the two.
4. Write a `java.lang.reflect.Proxy` that adds caching to any interface. Then explain precisely why it cannot cache a `final` method, and what you would do instead.
5. Find three uses of the adapter, decorator and proxy patterns in the JDK that are not listed in this module. Name the classes and explain the intent of each.

## 15. Output prediction

```java
import java.util.*;
import java.util.function.*;
import java.lang.reflect.*;

public class Main {
    interface Greeter { String greet(String name); default String hi() { return greet("hi"); } }

    static final class Config {
        private final String host; private final int port; private final List<String> tags;
        private Config(Builder b) { host = b.host; port = b.port; tags = List.copyOf(b.tags); }
        static Builder builder(String host) { return new Builder(host); }
        @Override public String toString() { return host + ":" + port + tags; }

        static final class Builder {
            private final String host; private int port = 80;
            private final List<String> tags = new ArrayList<>();
            Builder(String host) { this.host = host; }
            Builder port(int p) { this.port = p; return this; }
            Builder tag(String t) { tags.add(t); return this; }
            Config build() { if (port < 1) throw new IllegalArgumentException("port"); return new Config(this); }
        }
    }

    public static void main(String[] args) {
        var b = Config.builder("example.com").port(8080).tag("a");
        Config c1 = b.build();
        b.tag("b").port(9090);
        Config c2 = b.build();
        System.out.println(c1);
        System.out.println(c2);

        try { Config.builder("x").port(0).build(); }
        catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        Greeter real = name -> "hello " + name;
        Greeter proxy = (Greeter) Proxy.newProxyInstance(
            Greeter.class.getClassLoader(), new Class<?>[]{ Greeter.class },
            (p, m, a) -> { System.out.print("[" + m.getName() + "] "); return m.invoke(real, a); });
        System.out.println(proxy.greet("world"));
        System.out.println(proxy.hi());
        System.out.println(proxy.getClass().getSimpleName() + " " + Proxy.isProxyClass(proxy.getClass()));
        System.out.println(proxy.equals(proxy));

        var arr = new String[]{ "x", "y" };
        var view = Arrays.asList(arr);
        view.set(0, "z");
        System.out.println(arr[0]);
        try { view.add("w"); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        System.out.println(Integer.valueOf(127) == Integer.valueOf(127));
        System.out.println(Integer.valueOf(128) == Integer.valueOf(128));
        System.out.println(Boolean.valueOf(true) == Boolean.TRUE);

        Function<String, String> f = s -> s + "!";
        Function<String, String> decorated = f.andThen(s -> "<" + s + ">").compose(String::trim);
        System.out.println(decorated.apply("  hey  "));
    }
}
```

## 16. Mastery check

1. Give the two best singleton implementations and the design objection to singletons generally.
2. List five advantages of a static factory method over a constructor, with a JDK example of each.
3. State the four rules of a well-written builder.
4. When does a record replace a builder, and when does it not?
5. Distinguish adapter, decorator, facade and proxy by intent, with a JDK example of each.
6. Explain why decorators beat subclassing for combinable behaviours, with the counting argument.
7. Name the four kinds of proxy and a real framework using each.
8. Why can `java.lang.reflect.Proxy` only proxy interfaces, and what does Spring use otherwise?
9. Explain the self-invocation problem and two fixes.
10. Name three flyweights built into the JDK and the hazard each creates.
