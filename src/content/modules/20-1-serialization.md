---
title: "Serialization: serialVersionUID, the constructor bypass, and why it is a security topic"
phase: 20
order: 1
minutes: 45
summary: "How Java serialization actually works, why deserialization skips your constructors, the gadget-chain attack class that made it notorious, and what records and JEP 290 changed."
tags: ["serialization", "serialversionuid", "externalizable", "deserialization", "security"]
---

## 1. Concept

Java serialization converts an **object graph** into a byte stream and back, driven entirely by the class's declared fields.

```java
class Session implements Serializable {                 // a MARKER interface — no methods
    @Serial private static final long serialVersionUID = 1L;
    private final String user;
    private final Instant createdAt;
    private transient Cipher cipher;                    // excluded
    private static int counter;                         // excluded — static is class state
}

try (var out = new ObjectOutputStream(Files.newOutputStream(p))) { out.writeObject(session); }
try (var in  = new ObjectInputStream(Files.newInputStream(p)))   { Session s = (Session) in.readObject(); }
```

What is written: **every non-`transient`, non-`static` instance field**, recursively, plus enough class metadata (name, `serialVersionUID`, field names and types) to reconstruct it. Every field's type must itself be serializable or the write fails with `NotSerializableException`.

**The graph, not the object.** The stream assigns each object a **handle**; a second reference to the same object writes the handle, not a copy. Shared structure and cycles are preserved exactly — deserializing a graph where A points to B and B points to A produces the same shape, not an infinite loop.

## 2. `serialVersionUID`

Every serializable class has one. If you do not declare it, **[JDK]** the runtime computes it as a SHA-1-derived hash of the class name, modifiers, interfaces, and every field and method signature.

That means **any** structural change — adding a method, changing a field's access modifier, adding an interface — changes the computed value, and deserializing old data throws:

```text
java.io.InvalidClassException: Session; local class incompatible:
  stream classdesc serialVersionUID = -3665804199014368530,
  local class serialVersionUID = 8384735122481894869
```

So: **always declare it explicitly.** Declaring it is a promise that you will manage compatibility by hand.

```java
@Serial private static final long serialVersionUID = 1L;    // @Serial (Java 14+) makes javac check the shape
```

With a fixed UID, the compatibility rules are:

| Change | Compatible? |
| --- | --- |
| Add a field | ✅ — old streams leave it at the default (`null`/`0`) |
| Remove a field | ✅ — the value in old streams is discarded |
| Add or remove a method | ✅ — methods are not serialized |
| Change a field's **type** | ❌ `InvalidClassException` |
| Change a field's name | ❌ effectively remove + add: the value is lost silently |
| Change `static`/`transient` status | ❌ effectively remove or add |
| Add a superclass to the hierarchy | ❌ |
| Change class → interface, or vice versa | ❌ |

Note the dangerous row: renaming a field is *compatible* but **silently loses the data**. There is no error.

## 3. Deserialization does not call your constructor

This is the single most important mechanical fact in the module, and everything about the security problem follows from it.

**[JDK]** `readObject` allocates the instance without running its constructor, then writes the fields directly from the stream. The **only** constructor that runs is the **no-arg constructor of the first non-serializable superclass** — which for most classes is `Object()`.

```java
public class Range implements Serializable {
    private final int lo, hi;
    public Range(int lo, int hi) {
        if (lo > hi) throw new IllegalArgumentException("lo > hi");   // NEVER runs on deserialize
        this.lo = lo; this.hi = hi;
    }
}
```

An attacker (or a corrupted file) can hand you a stream setting `lo = 100, hi = 1`, and you get a `Range` that your constructor would have rejected — with `final` fields, no less. Deserialization is **an extra, invisible, public constructor** on every serializable class, and it does not run your validation.

Two consequences:

- **A serializable class with invariants must defend them**, in `readObject` or with a serialization proxy (§5).
- **A non-serializable superclass must have an accessible no-arg constructor**, or deserializing the subclass throws `InvalidClassException`.

## 4. The customization hooks

Five special methods, all found by **name and signature via reflection**, not by an interface:

```java
@Serial private void writeObject(ObjectOutputStream out) throws IOException {
    out.defaultWriteObject();                     // write the normal fields first
    out.writeInt(derivedThing);                   // then anything extra
}

@Serial private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
    in.defaultReadObject();
    this.derivedThing = in.readInt();
    if (lo > hi) throw new InvalidObjectException("lo > hi");     // VALIDATE HERE
    this.cache = new HashMap<>();                                  // rebuild transient state
}

@Serial private void readObjectNoData() throws ObjectStreamException { ... }   // rare: superclass added later

@Serial private Object writeReplace() throws ObjectStreamException { ... }     // write a substitute object
@Serial private Object readResolve()  throws ObjectStreamException { ... }     // replace after reading
```

`readResolve` is how a singleton stays a singleton:

```java
private static final Config INSTANCE = new Config();
@Serial private Object readResolve() { return INSTANCE; }     // otherwise every readObject makes a new one
```

(An enum needs none of this — enums serialize by `name()` and are resolved via `Enum.valueOf`, which is one of the three reasons a single-element enum is the best singleton, Module 15.1 §6.)

**`Externalizable`** is the opt-out: you write and read every byte yourself.

```java
public class Fast implements Externalizable {
    public Fast() { }                                        // a PUBLIC no-arg constructor is REQUIRED
    @Override public void writeExternal(ObjectOutput out) throws IOException { out.writeUTF(name); }
    @Override public void readExternal(ObjectInput in) throws IOException { this.name = in.readUTF(); }
}
```

It is faster and more compact (no field metadata), but the no-arg constructor **is** called, the object is fully mutable during `readExternal`, and you own all versioning by hand. Rarely worth it.

## 5. The serialization proxy pattern

**[Effective Java, Item 90]** The right answer for any serializable class with invariants: never serialize the real object at all.

```java
public final class Period implements Serializable {
    private final Date start, end;
    public Period(Date start, Date end) {
        this.start = new Date(start.getTime());          // defensive copies (Module 5.1)
        this.end   = new Date(end.getTime());
        if (this.start.compareTo(this.end) > 0) throw new IllegalArgumentException();
    }

    private static final class SerialProxy implements Serializable {
        @Serial private static final long serialVersionUID = 1L;
        private final long start, end;                    // a simple, invariant-free representation
        SerialProxy(Period p) { this.start = p.start.getTime(); this.end = p.end.getTime(); }
        @Serial private Object readResolve() { return new Period(new Date(start), new Date(end)); }
    }                                                     //          ^ the real CONSTRUCTOR runs

    @Serial private Object writeReplace() { return new SerialProxy(this); }
    @Serial private void readObject(ObjectInputStream in) throws InvalidObjectException {
        throw new InvalidObjectException("proxy required");    // block direct deserialization
    }
}
```

This restores every guarantee: the constructor runs, invariants are enforced, `final` fields are genuinely final, and the class can even return a different subclass. The cost is a second class and slower serialization.

## 6. Why deserialization is a security topic

**Deserializing untrusted data is remote code execution.** This is not a hypothetical.

The mechanism: `readObject` **instantiates arbitrary classes named in the stream** and **runs their `readObject`/`readResolve`/`finalize` code** during reconstruction. An attacker does not need your classes to be vulnerable — they need *any* class on your classpath whose deserialization path can be chained into a dangerous call. Those chains are called **gadget chains**.

The canonical one (2015, "Java Apocalypse"): Apache Commons Collections' `InvokerTransformer` invokes an arbitrary method reflectively; chained through `ChainedTransformer` and triggered by `LazyMap`'s `get`, reached via `AnnotationInvocationHandler.readObject`, it yields `Runtime.exec(...)`. Every application with commons-collections on the classpath that deserialized user input was remotely exploitable — including WebLogic, WebSphere, JBoss, and Jenkins. `ysoserial` packages dozens of such chains.

The three properties that make it so bad:

1. **Type is chosen by the attacker.** The stream says what classes to instantiate; your declared field type is checked only *after* the object exists.
2. **Code runs during construction**, before you can inspect anything.
3. **The attack surface is your entire classpath**, including transitive dependencies you have never heard of.

**[JDK]** Java's answers, in order:

- **JEP 290 (Java 9) — serialization filters.** A filter is consulted for every class, array length, depth, and stream size, and can reject.

  ```java
  var filter = ObjectInputFilter.Config.createFilter(
          "com.example.dto.*;java.base/*;!*");           // allow-list, reject everything else
  ObjectInputStream ois = new ObjectInputStream(in);
  ois.setObjectInputFilter(filter);
  ```
  Plus a JVM-wide default: `-Djdk.serialFilter=maxdepth=20;maxarray=10000;com.example.*;!*`

- **JEP 415 (Java 17) — filter factories**, so a container can install a per-context filter.
- **`ObjectInputFilter.allowFilter` / `rejectUndecidedClass`** helpers (Java 17) for writing allow-lists correctly.

And the guidance from the JDK team itself, which you should be able to quote: **serialization is a "long-term liability"; new code should not use it, and untrusted data must never be deserialized.** Project Amber has an ongoing effort to replace it with an opt-in, constructor-based mechanism.

**Records changed the picture for the better.** **[JDK]** A record's deserialization **calls its canonical constructor** with the stream's component values. There is no field-injection path and no way to bypass the compact constructor's validation, so a record cannot be deserialized into an invalid state and cannot be used as a gadget the way a hand-written `readObject` can.

```java
public record Range(int lo, int hi) implements Serializable {
    public Range { if (lo > hi) throw new IllegalArgumentException(); }   // RUNS on deserialize
}
```

## 7. What happens internally

**[JDK]** The stream format is specified (the Java Object Serialization Specification) and self-describing:

```text
AC ED           STREAM_MAGIC
00 05           STREAM_VERSION
73              TC_OBJECT
  72            TC_CLASSDESC
    00 07 "Session"        class name
    <8-byte serialVersionUID>
    <flags: SC_SERIALIZABLE | SC_WRITE_METHOD ...>
    <field count, then for each: type code, name, and for objects the type signature>
    78          TC_ENDBLOCKDATA
    <superclass descriptor, recursively>
  <field values, primitives first, then object fields — each a nested object or a handle>
```

Two observations that answer common questions:

- **The class metadata is in the stream**, which is why Java serialization is 3–10× larger than protobuf for the same data and why the format leaks your internal field names.
- **Objects are written once and referenced by handle** thereafter, which is how cycles work — and also why `writeObject` on a mutated object that was already written silently writes the *old* state until you call `reset()`.

**`ObjectStreamClass`** caches the reflective plumbing per class; `ObjectStreamField` describes each field. Field values are matched **by name and type** between the stream and the local class, which is exactly why renaming a field loses data rather than failing.

**Performance:** Java serialization is slow — reflection per field, per-class metadata, and a large output. Rough orders of magnitude for a small object graph: protobuf and Avro are ~5–10× faster and ~3–5× smaller; Jackson JSON is comparable in speed and larger but human-readable and cross-language. **For anything crossing a process or a version boundary, use an explicit schema format.** Java serialization's remaining legitimate niches are in-JVM deep copies (rarely the best way), RMI, and legacy protocols.

## 8. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ has no built-in serialization and cannot have one</strong>, because the binary carries no field metadata (Module 18.1). Every C++ approach requires you to name the fields somewhere: Boost.Serialization's <code>ar &amp; field;</code> intrusive method, a protobuf/FlatBuffers schema plus generated code, or hand-written read/write pairs. Pointers need explicit fix-up tables to reconstruct shared structure; polymorphic types need explicit type registration.</p>
<p><strong>Java's automatic reachability-based graph walk</strong> — cycles, sharing, and polymorphism handled with no schema — is genuinely something C++ cannot do without codegen. It is also the reason for the security disaster: the same "just instantiate whatever the stream names" mechanism is what an attacker uses.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Built-in mechanism | ✗ | `Serializable` |
| Field discovery | Manual, or codegen from a schema | Reflection over declared fields |
| Cycles / shared objects | Manual pointer fix-up | Handles, automatic |
| Polymorphic types | Explicit registration | Class name in the stream |
| Versioning | Explicit version field you write | `serialVersionUID` + field matching |
| Endianness | Yours to decide | Big-endian, specified |
| Constructor runs on load | Yes — you wrote the code | **No** (except for records) |
| Untrusted-input risk | Whatever your parser does | Arbitrary code execution by design |
| Typical choice | protobuf, FlatBuffers, Cap'n Proto | protobuf, JSON, Avro — same answer |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Reading <code>implements Serializable</code> as "opt in to a convenience". It is a public API commitment: the field layout becomes part of your published contract, an extra constructor path appears that skips your validation, and the class joins your deserialization attack surface. <em>Effective Java</em> Item 86 is titled "Implement <code>Serializable</code> with great caution" for exactly these reasons.</p>
</div>

## 9. Edge cases

- **`transient` fields are `null`/`0` after deserialization**, not re-initialized — field initializers and instance blocks do not run either. Rebuild them in `readObject`.
- **A `final` transient field cannot be reassigned in `readObject`** without reflection; use a proxy or `readResolve`.
- **Serializing an inner class serializes the enclosing instance** (Module 16.1) — or fails if it is not serializable.
- **Lambdas and anonymous classes** serialize only if the target type is `Serializable`, and their generated names depend on compilation order, so a recompile breaks old data (Module 11.1 §6).
- **`ObjectOutputStream.reset()`** clears the handle table; without it, writing a mutated object twice writes the old state the second time.
- **Arrays and `String` are serializable**; `Optional` is deliberately not (Module 13.1).
- **Collections are serializable, but their contents must be too** — the failure surfaces as a `NotSerializableException` naming the element class.
- **A subclass is serializable if any superclass is**; you cannot opt out except by making `writeObject` throw.
- **`Externalizable` requires a public no-arg constructor** and, unlike `Serializable`, actually calls it.
- **`serialVersionUID` must be `private static final long`** — declared in a superclass it does not apply to subclasses.
- **`@Serial`** (Java 14) tells javac to check that these special members have the exact required shape; a typo'd `readObject(ObjectInputStream)` that is `public` instead of `private` is silently ignored otherwise.

## 10. Common mistakes

- Not declaring `serialVersionUID`, then breaking every stored object with a refactor.
- Assuming the constructor runs on deserialization.
- Not validating invariants in `readObject`.
- Deserializing untrusted input at all.
- Not installing a serialization filter on any stream that could see hostile bytes.
- Renaming a field and silently losing data.
- Forgetting `readResolve` on a serializable singleton.
- Serializing a lambda or anonymous class.
- Using Java serialization for a network protocol or a cache format.
- Making a class `Serializable` reflexively, without treating the field layout as public API.

## 11. Interview questions

**Beginner** — 1. What is `Serializable`? 2. What does `transient` do? 3. What is `serialVersionUID`?

**Intermediate** — 4. What happens if you do not declare `serialVersionUID` and change the class? 5. Which fields are serialized? 6. Are constructors called during deserialization? 7. What is `Externalizable` and how does it differ?

**Advanced** — 8. How are cycles and shared references handled? 9. How do you enforce invariants on a deserialized object — give two mechanisms. 10. Which class changes are compatible and which are not? 11. Why does renaming a field lose data silently?

**Senior** — 12. Explain a deserialization gadget chain end to end and why the vulnerability is in the mechanism rather than in any one class. 13. What is JEP 290, how do you configure a filter, and what does an allow-list look like? 14. Why are records safer to deserialize? 15. You inherit a service that deserializes Java objects from a message queue. Give a migration plan.

## 12. Follow-ups

- *After Q4:* "What exception, and what does the message contain?"
- *After Q6:* "Then which constructor does run?"
- *After Q9:* "Which of the two also protects `final` fields?" → the proxy.
- *After Q12:* "Does removing the vulnerable library fix it?" → only that chain.
- *After Q14:* "What exactly does the record path call?" → the canonical constructor.

## 13. Exercise

1. Serialize a class without `serialVersionUID`, add a private method, and deserialize the old bytes. Record the exact exception and both UID values. Then add an explicit UID and repeat.
2. Write the `Range` class from §3, serialize a valid instance, edit the bytes by hand (or write a fake stream) to violate the invariant, and deserialize it. Then fix it three ways: validation in `readObject`, a serialization proxy, and converting it to a record.
3. Serialize an object graph with a cycle (A↔B) and inspect the raw bytes to find the handle reference. Then mutate and re-write the same object without `reset()` and show the stale output.
4. Install an `ObjectInputFilter` allow-list on a stream, feed it a class outside the list, and observe the rejection. Then set `-Djdk.serialFilter` globally and compare.
5. Serialize a 1 000-object graph with Java serialization, Jackson JSON, and protobuf. Compare byte size and round-trip time, and write down which you would ship and why.

## 14. Output prediction

```java
import java.io.*;
import java.util.*;

class Node implements Serializable {
    @Serial private static final long serialVersionUID = 1L;
    String name; Node peer; transient String cache = "init"; static int count = 0;
    int calls;
    Node(String n) { this.name = n; count++; this.calls = 99; }
}

record Pair(int a, int b) implements Serializable {
    Pair { if (a > b) throw new IllegalArgumentException("a>b"); }
}

class Singleton implements Serializable {
    @Serial private static final long serialVersionUID = 1L;
    static final Singleton INSTANCE = new Singleton();
    @Serial private Object readResolve() { return INSTANCE; }
}

public class Main {
    static byte[] ser(Object o) throws Exception {
        var b = new ByteArrayOutputStream();
        try (var out = new ObjectOutputStream(b)) { out.writeObject(o); }
        return b.toByteArray();
    }
    static Object de(byte[] bytes) throws Exception {
        try (var in = new ObjectInputStream(new ByteArrayInputStream(bytes))) { return in.readObject(); }
    }

    public static void main(String[] args) throws Exception {
        Node a = new Node("a"), b = new Node("b");
        a.peer = b; b.peer = a;
        Node.count = 100;

        Node r = (Node) de(ser(a));
        System.out.println(r.name + " " + r.peer.name + " " + (r.peer.peer == r));
        System.out.println(r.cache + " " + Node.count + " " + r.calls);

        System.out.println(de(ser(new Pair(1, 2))));

        Singleton s = (Singleton) de(ser(Singleton.INSTANCE));
        System.out.println(s == Singleton.INSTANCE);

        byte[] bytes = ser(a);
        System.out.printf("%02X %02X%n", bytes[0], bytes[1]);

        var out = new ByteArrayOutputStream();
        var oos = new ObjectOutputStream(out);
        Node m = new Node("m");
        oos.writeObject(m);
        m.name = "changed";
        oos.writeObject(m);
        oos.close();
        var ois = new ObjectInputStream(new ByteArrayInputStream(out.toByteArray()));
        System.out.println(((Node) ois.readObject()).name + " " + ((Node) ois.readObject()).name);

        try { ser(new Object() { }); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
    }
}
```

## 15. Mastery check

1. What exactly is written for a serializable object, and what is excluded?
2. Explain `serialVersionUID`: what it is, what happens without it, and what declaring it commits you to.
3. Give the full compatible/incompatible change table, and name the change that fails silently.
4. Which constructor runs during deserialization, and what does that mean for invariants?
5. Name the five hook methods and what each is for.
6. Describe the serialization proxy pattern and every guarantee it restores.
7. Explain a gadget chain: the three properties of the mechanism that make it possible.
8. What is JEP 290 and how do you write an allow-list filter?
9. Why are records safe from the constructor-bypass problem?
10. Give three reasons to choose protobuf or JSON over Java serialization for anything crossing a boundary.
