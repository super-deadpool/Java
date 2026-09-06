---
title: "Annotations: retention, targets, and how frameworks turn metadata into behaviour"
phase: 17
order: 1
minutes: 40
summary: "Declaring your own annotation, what each retention policy actually does to the class file, why annotation instances are dynamic proxies, and compile-time processing versus runtime reflection."
tags: ["annotations", "retention", "meta-annotation", "annotation-processing", "spring"]
---

## 1. Concept

An annotation is **metadata attached to a declaration** (or, since Java 8, to a *use* of a type). It has no behaviour of its own. Something else — the compiler, an annotation processor, or a framework reading it reflectively — must give it meaning.

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface Retry {
    int times() default 3;
    Class<? extends Exception>[] on() default { Exception.class };
    long backoffMillis() default 100;
}

@Retry(times = 5, on = { IOException.class })
public Response fetch(String url) { ... }
```

**[JLS]** `@interface` declares an interface implicitly extending `java.lang.annotation.Annotation`. Its members are **methods with no parameters**, optionally with defaults.

Legal member types are a closed list: **primitives, `String`, `Class` (possibly wildcarded), enum types, other annotation types, and one-dimensional arrays of those.** Nothing else — no `Object`, no `List`, no nested arrays, and **no `null`** as a value or a default. Everything must be a compile-time constant.

`value()` is special: a single-member annotation named `value` can be written without the name.

```java
@SuppressWarnings("unchecked")               // == @SuppressWarnings(value = "unchecked")
@Retry(5)                                    // would work if the member were named `value`
@Target({ ElementType.METHOD, ElementType.FIELD })    // array shorthand: braces; single element needs none
```

## 2. Meta-annotations

The five that annotate annotations:

```java
@Retention(SOURCE | CLASS | RUNTIME)   // how long it survives — see §3
@Target({...})                          // which declarations it may appear on
@Documented                             // include it in javadoc
@Inherited                              // a subCLASS inherits it from its superclass
@Repeatable(Container.class)            // Java 8 — allow it more than once on one declaration
```

`ElementType` values, with the ones added later marked:

```text
TYPE  FIELD  METHOD  PARAMETER  CONSTRUCTOR  LOCAL_VARIABLE  ANNOTATION_TYPE  PACKAGE
TYPE_PARAMETER (8)   TYPE_USE (8)   MODULE (9)   RECORD_COMPONENT (16)
```

`@Inherited` has two limits that are constantly misunderstood: it applies **only to class inheritance**, never to interfaces, and **only to type-level annotations**, never to inherited methods or fields.

`@Repeatable` needs an explicit container:

```java
@Repeatable(Schedules.class)
@Retention(RUNTIME) @Target(METHOD)
public @interface Schedule { String cron(); }

@Retention(RUNTIME) @Target(METHOD)
public @interface Schedules { Schedule[] value(); }      // the container: value() is an array

@Schedule(cron = "0 0 * * *")
@Schedule(cron = "0 12 * * *")
void job() { }

// Reading: getAnnotation(Schedule.class) returns NULL here — the compiler wrapped them
Schedule[] all = m.getAnnotationsByType(Schedule.class);      // this is the one you want
Schedules c    = m.getAnnotation(Schedules.class);            // the container is what is really present
```

## 3. Retention — what actually reaches the class file

| Policy | In `.java` | In `.class` | Readable via reflection | Examples |
| --- | --- | --- | --- | --- |
| `SOURCE` | ✅ | ❌ discarded by javac | ❌ | `@Override`, `@SuppressWarnings`, Lombok's |
| `CLASS` (**default**) | ✅ | ✅ stored | ❌ not loaded into the runtime | bytecode tools, nullability annotations |
| `RUNTIME` | ✅ | ✅ stored | ✅ | Spring, JPA, Jackson, JUnit |

**[JVMS]** The class file stores annotations in attributes: `RuntimeVisibleAnnotations` (for `RUNTIME`) and `RuntimeInvisibleAnnotations` (for `CLASS`), plus `...ParameterAnnotations` and `...TypeAnnotations` variants. "Invisible" means invisible to *core reflection* — a bytecode library like ASM reads both.

Getting this wrong is a silent failure: a custom annotation with the **default** `CLASS` retention, read by a framework via `getAnnotation`, simply returns `null` and nothing happens. Always write `@Retention(RUNTIME)` explicitly if reflection will read it.

## 4. The built-ins

```java
@Override            // SOURCE. Compile error if it does not override — catches typos and signature drift
@Deprecated(since = "17", forRemoval = true)   // RUNTIME. since/forRemoval added in Java 9
@SuppressWarnings("unchecked")                 // SOURCE. Narrow the scope: annotate the statement, not the class
@SafeVarargs                                   // Suppresses heap-pollution warnings; only on static/final/private methods
@FunctionalInterface                           // Compile error if the interface is not a SAM (Module 11.1)
```

`@Override` on an interface-method implementation has been legal since Java 6 and is worth using: it is the only thing that catches "I renamed the interface method and this class now silently overloads instead of overrides" (Module 2.2).

## 5. Reading annotations at runtime

```java
Method m = Service.class.getMethod("fetch", String.class);

m.isAnnotationPresent(Retry.class);
Retry r = m.getAnnotation(Retry.class);        // null if absent
r.times();                                      // 5
r.on();                                         // Class<? extends Exception>[]

m.getAnnotations();                             // including @Inherited ones (types only)
m.getDeclaredAnnotations();                     // only directly present
m.getParameterAnnotations();                    // Annotation[][] — one row per parameter
Service.class.getAnnotatedInterfaces();         // type annotations
```

A retry interceptor, end to end:

```java
public static <T> T invokeWithRetry(Method m, Object target, Object... args) throws Exception {
    Retry cfg = m.getAnnotation(Retry.class);
    int attempts = cfg == null ? 1 : cfg.times();
    Exception last = null;
    for (int i = 0; i < attempts; i++) {
        try { @SuppressWarnings("unchecked") T v = (T) m.invoke(target, args); return v; }
        catch (InvocationTargetException e) {
            Throwable cause = e.getCause();                     // the REAL exception (Phase 18)
            if (cfg == null || Arrays.stream(cfg.on()).noneMatch(c -> c.isInstance(cause))) throw e;
            last = (Exception) cause;
            Thread.sleep(cfg.backoffMillis() << i);
        }
    }
    throw last;
}
```

## 6. What happens internally

**Annotation instances are dynamic proxies.** **[JDK]** `getAnnotation(Retry.class)` does not return an object of some generated class holding your values. It returns a `java.lang.reflect.Proxy` implementing the annotation interface, backed by `sun.reflect.annotation.AnnotationInvocationHandler`, which holds a `Map<String, Object>` of member name → value parsed from the class-file attribute.

```java
Retry r = m.getAnnotation(Retry.class);
r.getClass();                   // class jdk.proxy1.$Proxy4  — NOT Retry
r.annotationType();             // interface Retry            — use THIS, not getClass()
Proxy.isProxyClass(r.getClass());  // true
```

Consequences:

- **`getClass()` is useless**; `annotationType()` is the accessor that exists for this reason.
- **Every member access is a proxy `invoke`** and a map lookup — cheap, but not free.
- `equals`, `hashCode` and `toString` are **specified by `Annotation`'s javadoc** and implemented by the handler: two annotation instances are equal if the types match and all member values are equal (arrays compared with `Arrays.equals`). The hash code is a specified sum, not identity.
- Values are **parsed lazily on first access** per class, then cached in the `Class`'s annotation data.

**Annotation processing (compile time)** is the other consumer, and the more efficient one. **[JDK]** `javax.annotation.processing.Processor` implementations run *inside javac*, in **rounds**: javac parses, gives processors the annotated elements, collects any files they generate, then runs another round over the generated files, until a round produces nothing new.

```java
@SupportedAnnotationTypes("com.example.Retry")
@SupportedSourceVersion(SourceVersion.RELEASE_21)
public class RetryProcessor extends AbstractProcessor {
    @Override public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment env) {
        for (Element e : env.getElementsAnnotatedWith(Retry.class)) {
            if (e.getModifiers().contains(Modifier.PRIVATE))
                processingEnv.getMessager().printMessage(Diagnostic.Kind.ERROR, "@Retry cannot be private", e);
            // or: processingEnv.getFiler().createSourceFile(...) to GENERATE code
        }
        return true;     // claimed — no other processor sees these
    }
}
```

Processors can **generate** new sources and **validate**, but cannot **modify** existing sources — that is a deliberate design constraint. (Lombok modifies javac's AST through internal compiler APIs; it works, but it is not annotation processing, which is why it breaks on JDK upgrades.)

The real-world split:

| | Runtime reflection | Compile-time processing |
| --- | --- | --- |
| Cost | Startup scanning + per-call proxy lookups | Zero at runtime |
| Errors surface | At runtime, possibly in production | At compile time |
| Examples | Spring (classic), Hibernate, Jackson, JUnit | Dagger, MapStruct, Immutables, Micronaut, Quarkus |
| Native image (GraalVM) | Needs explicit configuration | Works naturally |

That last row is why the modern frameworks moved: **reflection-heavy startup is the main obstacle to fast-starting and natively compiled Java**, so Micronaut/Quarkus/Spring-AOT do at build time what Spring historically did at boot.

**Type annotations (Java 8, JSR 308)** with `@Target(TYPE_USE)` attach to any use of a type, stored in `RuntimeVisibleTypeAnnotations` with a "path" describing where in the type they sit:

```java
List<@NonNull String> names;
@NonNull String @Nullable [] arr;         // a nullable array of non-null strings
void m() throws @Critical IOException { }
var x = (@NonNull String) o;
```

The JDK ships the syntax; the *checking* is external (the Checker Framework, IDE nullability analysis, NullAway).

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ attributes</strong> — <code>[[nodiscard]]</code>, <code>[[deprecated("use x")]]</code>, <code>[[maybe_unused]]</code>, <code>[[likely]]</code> — look like annotations and are not. The set is fixed by the standard plus implementation-defined vendor namespaces; you cannot declare your own with meaning, they carry no data you can query, and <strong>nothing survives to runtime</strong>. C++'s answer to "attach metadata to a declaration and act on it" has always been macros, template traits classes, or an external code generator.</p>
<p><strong>Java's annotations</strong> are a first-class declaration form with a type, members, defaults, a retention policy, and a documented reflection API. That is the enabling mechanism for the entire framework ecosystem: <code>@Autowired</code>, <code>@Entity</code>, <code>@Test</code>, <code>@JsonProperty</code> all rely on being readable at runtime or at compile time.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| User-defined metadata | Macros / traits / external tooling | `@interface` |
| Carries typed data | ✗ | ✅ members with defaults |
| Survives to the binary | ✗ | `CLASS` / `RUNTIME` |
| Queryable at runtime | ✗ (C++26 reflection is compile-time) | ✅ |
| Compile-time processing | Templates, `constexpr`, codegen scripts | Annotation processors, in javac |
| Compile-time validation | `static_assert`, concepts | Processor `Messager` errors |
| Applies to a type *use* | ✗ | `TYPE_USE` annotations |
| Cost | Zero | Class-file bytes; proxies at runtime |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Assuming an annotation <em>does</em> something. <code>@Transactional</code> on a method called from within the same class does nothing at all in Spring, because the proxy is bypassed. An annotation is inert data; the behaviour lives in whatever reads it, and you need to know what that is.</p>
</div>

## 8. Edge cases

- **Default `@Retention` is `CLASS`, not `RUNTIME`.** The most common cause of "my annotation is ignored".
- **No `null`.** Use a sentinel (`""`, `Void.class`) or an empty array to mean "unset".
- **Annotation members cannot be generic** and cannot have parameters.
- **Circular annotation types are illegal** (an annotation cannot, directly or indirectly, have a member of its own type).
- **`@Inherited` does not apply to interfaces or methods.**
- **`getAnnotation` on a repeatable annotation used twice returns `null`** — ask for the container or use `getAnnotationsByType`.
- **`@Target` omitted** means the annotation is applicable to every declaration context (but not `TYPE_USE`).
- **`@SafeVarargs`** is only permitted on `static`, `final`, or (since Java 9) `private` methods and constructors, because those cannot be overridden.
- **Array member defaults are shared?** No — each access returns a **clone**, so mutating `r.on()[0]` does not corrupt the annotation. That clone is a per-call allocation.
- **Annotations on record components** propagate to the field, the accessor, and the constructor parameter according to their `@Target`, which is why `@NotNull String name` on a record component works.
- **`@Deprecated(forRemoval = true)`** upgrades the warning at every use site and cannot be suppressed by `@SuppressWarnings("deprecation")` alone (use `"removal"`).

## 9. Common mistakes

- Forgetting `@Retention(RUNTIME)`.
- Assuming an annotation has an effect without a processor or framework reading it.
- `getClass()` on an annotation instance instead of `annotationType()`.
- `getAnnotation` on a repeated annotation.
- `@SuppressWarnings` on a whole class instead of the one statement that needs it.
- Expecting `@Inherited` to work through interfaces.
- Calling an annotated method from inside the same class and expecting proxy-based behaviour (Spring `@Transactional`, `@Cacheable`).
- Reading annotations in a hot loop instead of caching the lookup.
- Building a framework on runtime reflection when a processor would move the errors to compile time.
- Using `Class<?>` members and then needing the class to be loadable in every context that reads the annotation.

## 10. Interview questions

**Beginner** — 1. What is an annotation? 2. Name three built-in ones and what they do. 3. What does `@Override` actually check?

**Intermediate** — 4. What are the three retention policies and what does each mean? 5. Which member types are legal? 6. What is `@Target` for? 7. How do you read an annotation at runtime?

**Advanced** — 8. What is the default retention and why does that cause bugs? 9. What object does `getAnnotation` actually return? 10. Explain `@Repeatable` and what `getAnnotation` returns for a repeated annotation. 11. What are the limits of `@Inherited`?

**Senior** — 12. Compare runtime reflection and compile-time annotation processing across cost, error timing, and native-image compatibility. 13. Explain how Spring turns `@Transactional` into behaviour, and why self-invocation bypasses it. 14. Design a `@Retry` feature for a codebase: annotation shape, where the behaviour lives, how you validate misuse, and how you keep startup fast.

## 11. Follow-ups

- *After Q4:* "Which class-file attributes hold each?"
- *After Q8:* "What is the symptom when you get it wrong?" → `getAnnotation` returns null, silently.
- *After Q9:* "So what does `equals` do on two annotation instances?"
- *After Q12:* "Which frameworks moved and why?" → Micronaut, Quarkus, Spring AOT; startup and GraalVM.
- *After Q13:* "How do you fix self-invocation?" → self-injection, or move the method to another bean.

## 12. Exercise

1. Write `@Retry` with three members and defaults, `RUNTIME` retention, `METHOD` target. Write the interceptor from §5 and prove it retries on the configured exception types only.
2. Change the retention to `CLASS` and observe exactly what breaks and how silently. Then read the same annotation with ASM to prove it is still in the class file.
3. Write a repeatable `@Schedule` with its container. Show what `getAnnotation`, `getAnnotationsByType`, and `getDeclaredAnnotations` each return.
4. Write an `AbstractProcessor` that rejects `@Retry` on a private method with a compile error pointing at the exact element. Wire it into a build and show the error message.
5. Take a class with a runtime-annotation-driven mapper and rewrite it as a code-generating processor. Measure startup time for 1 000 mapped types both ways.

## 13. Output prediction

```java
import java.lang.annotation.*;
import java.lang.reflect.*;
import java.util.*;

@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE) @Inherited
@interface Marked { String value() default "x"; int[] nums() default {1, 2}; }

@Retention(RetentionPolicy.CLASS) @Target(ElementType.TYPE)
@interface Invisible { }

@Repeatable(Tags.class) @Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE)
@interface Tag { String value(); }
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE)
@interface Tags { Tag[] value(); }

@Marked("base") @Invisible interface Iface { }
@Marked("parent") class Parent { }
class Child extends Parent { }
class Impl implements Iface { }
@Tag("a") @Tag("b") class Tagged { }
@Tag("solo") class Solo { }

public class Main {
    public static void main(String[] args) {
        Marked m = Parent.class.getAnnotation(Marked.class);
        System.out.println(m.value() + " " + Arrays.toString(m.nums()));
        System.out.println(m.annotationType().getSimpleName() + " " + (m.getClass() == Marked.class));
        System.out.println(Proxy.isProxyClass(m.getClass()));

        System.out.println(Child.class.getAnnotation(Marked.class));
        System.out.println(Child.class.getDeclaredAnnotations().length);
        System.out.println(Impl.class.getAnnotation(Marked.class));

        System.out.println(Iface.class.getAnnotation(Invisible.class));
        System.out.println(Iface.class.getAnnotations().length);

        System.out.println(Tagged.class.getAnnotation(Tag.class));
        System.out.println(Arrays.toString(Tagged.class.getAnnotationsByType(Tag.class)));
        System.out.println(Solo.class.getAnnotation(Tag.class));
        System.out.println(Arrays.toString(Solo.class.getAnnotationsByType(Tag.class)));

        int[] a = m.nums(); a[0] = 99;
        System.out.println(Arrays.toString(Parent.class.getAnnotation(Marked.class).nums()));
    }
}
```

## 14. Mastery check

1. Write a complete annotation declaration with three members, defaults, retention and target, from memory.
2. List every legal annotation member type, and say what is forbidden.
3. Give the three retention policies, the class-file attribute for each, and one real annotation using each.
4. What is the default retention, and what is the symptom of getting it wrong?
5. Explain what `getAnnotation` returns and why `annotationType()` exists.
6. How is `equals` defined for two annotation instances?
7. Explain `@Repeatable`: the container requirement and the three different read APIs.
8. State both limitations of `@Inherited`.
9. Describe the annotation-processing round model and what a processor may and may not do.
10. Give three reasons modern frameworks moved from runtime reflection to compile-time processing.
