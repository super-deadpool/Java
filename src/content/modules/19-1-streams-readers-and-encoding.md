---
title: "Byte streams, character streams, buffering, and the encoding bug you will ship"
phase: 19
order: 1
minutes: 45
summary: "The decorator hierarchy, why one unbuffered read per byte is 1000× slower, the Reader/Writer bridge, and what JEP 400 changed about the default charset."
tags: ["io", "inputstream", "reader", "buffering", "charset", "utf-8"]
---

## 1. Concept

Java's classic I/O has **two parallel hierarchies**, and choosing the wrong one is the root of most encoding bugs.

```text
BYTES                                   CHARACTERS
InputStream  / OutputStream             Reader / Writer
  read() -> int (0..255, -1 at EOF)       read() -> int (0..65535 = one UTF-16 code unit, -1 at EOF)
  images, zips, protocols, anything       text, and only text
```

They are bridged in exactly one place — the two classes that own the charset decision:

```java
Reader r = new InputStreamReader(inputStream, StandardCharsets.UTF_8);   // bytes -> chars (decode)
Writer w = new OutputStreamWriter(outputStream, StandardCharsets.UTF_8); // chars -> bytes (encode)
```

Every `FileReader`, `Scanner`, `PrintWriter` and `BufferedReader` sits on top of one of these two. If you cannot point at where the charset was chosen, it was chosen for you.

## 2. The decorator pattern

**[JDK]** `java.io` is the textbook example of the decorator pattern (Phase 27): each class wraps another and adds one capability.

```java
// Read a gzipped UTF-8 text file, line by line, buffered
try (var in = new BufferedReader(
                new InputStreamReader(
                  new GZIPInputStream(
                    new BufferedInputStream(
                      Files.newInputStream(path))),
                  StandardCharsets.UTF_8))) {
    String line;
    while ((line = in.readLine()) != null) process(line);
}
```

Read it outside-in: buffer characters ← decode UTF-8 ← decompress ← buffer bytes ← read the file. Each layer knows only about the layer below.

| Decorator | Adds |
| --- | --- |
| `BufferedInputStream` / `BufferedReader` | An in-memory buffer; `readLine()` on `BufferedReader` |
| `InputStreamReader` / `OutputStreamWriter` | The bytes↔chars charset boundary |
| `DataInputStream` / `DataOutputStream` | `readInt`, `writeLong` — big-endian primitives |
| `GZIPInputStream`, `InflaterInputStream` | Decompression |
| `ObjectInputStream` | Java serialization (Phase 20) |
| `PrintWriter` / `PrintStream` | `println`, `printf`, and **swallowed `IOException`s** |
| `PushbackInputStream` | `unread()` for one-token lookahead parsers |

## 3. Buffering — the difference is not subtle

An unbuffered `FileInputStream.read()` is **one `read(2)` system call per byte**.

```java
// ~1 syscall per byte: for a 10 MB file, 10 million syscalls
try (var in = new FileInputStream(f)) { int b; while ((b = in.read()) != -1) sum += b; }

// ~1 syscall per 8192 bytes: ~1 200 syscalls for the same file
try (var in = new BufferedInputStream(new FileInputStream(f))) { ... }
```

The difference on a typical machine is **two to three orders of magnitude**. `BufferedInputStream`'s default buffer is 8192 bytes; `BufferedReader`'s is 8192 chars.

Two things that are *already* buffered, so wrapping them adds nothing:

- `Files.newBufferedReader(path)` — the name says so.
- Bulk reads: `in.read(byte[])` with a large array is one syscall per array-full regardless of buffering.

And one that is **not**: `FileOutputStream.write(int)` in a loop. Always buffer writes, and remember that **`close()` flushes but an unclosed buffer loses data silently**.

```java
var w = new BufferedWriter(new FileWriter(f));
w.write("important");
// no close, no flush -> nothing on disk. try-with-resources exists for exactly this.
```

`PrintWriter`/`PrintStream` compound it: they **swallow `IOException`** (you must call `checkError()` to notice), and `PrintWriter(Writer, true)` auto-flushes only on `println`, not on `print`.

## 4. Charsets and JEP 400

This is the single highest-value correctness topic in the module.

**[JDK]** Before Java 18, methods without an explicit charset used the **platform default** — `UTF-8` on modern Linux and macOS, but historically `windows-1252` on a Western Windows machine and `Shift_JIS` on a Japanese one. The same program produced different bytes on different machines.

**Java 18 (JEP 400) made UTF-8 the default charset everywhere**, for `file.encoding` and for every default-charset API. `Charset.defaultCharset()` now returns UTF-8 unless you explicitly set `-Dfile.encoding=` to something else. `System.console()` and `System.out` still use the *console* encoding, which can differ (`stdout.encoding`).

The rule survives the change: **always pass the charset explicitly.**

```java
new String(bytes);                             // default charset — was a portability bug for 25 years
new String(bytes, StandardCharsets.UTF_8);     // say it

"x".getBytes();                                // same problem
"x".getBytes(StandardCharsets.UTF_8);

new FileReader(f);                             // pre-11: platform default, no charset parameter at all
new FileReader(f, StandardCharsets.UTF_8);     // Java 11+ added the overload
Files.readString(path);                        // UTF-8 by specification — always, on every version
Files.readString(path, cs);
```

**Decoding failures do not throw by default.** `InputStreamReader` and `String(byte[], Charset)` use `CodingErrorAction.REPLACE`, substituting U+FFFD `<?>` for malformed input. That is why corrupt text spreads silently instead of failing fast. To make it fail:

```java
var decoder = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT);
try (var r = new BufferedReader(new InputStreamReader(in, decoder))) { ... }   // throws on bad bytes
```

**Bytes are not characters and characters are not code points.** A UTF-8 `é` is 2 bytes; an emoji is 4 bytes and **two** Java `char`s (a surrogate pair, Module 1.4). `"👍".length()` is 2. Reading a fixed number of bytes and decoding the chunk can split a multi-byte sequence — one more reason to let a `Reader` handle the boundary.

## 5. Realistic example

```java
/** Stream a large CSV, decode strictly, never load it all, and fail loudly on bad bytes. */
public long sumColumn(Path path, int col) throws IOException {
    var decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT);
    long total = 0;
    try (var reader = new BufferedReader(
                        new InputStreamReader(Files.newInputStream(path), decoder), 1 << 16)) {
        String line = reader.readLine();                   // header
        while ((line = reader.readLine()) != null) {
            total += Long.parseLong(line.split(",", -1)[col]);   // -1 keeps trailing empty fields
        }
    }
    return total;
}

/** Copy without a manual loop — Java 9+ */
try (var in = Files.newInputStream(src); var out = Files.newOutputStream(dst)) {
    in.transferTo(out);                                     // 8 KB chunks, or better in the NIO path
}

/** Small files: the one-liners. Do not use these on a 4 GB file. */
String text  = Files.readString(path);                      // UTF-8
byte[] bytes = Files.readAllBytes(path);
List<String> lines = Files.readAllLines(path);              // whole file in memory
Files.writeString(path, text, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
```

## 6. What happens internally

**A stream is a thin wrapper over a file descriptor.** `FileInputStream.read()` is a native call into `read(2)`; every call crosses the user/kernel boundary, costing a syscall (~0.5–2 µs) regardless of how many bytes it moves. `BufferedInputStream` fills an 8 KB `byte[]` with one syscall and serves subsequent `read()` calls from the array.

**`BufferedReader.readLine()`** scans the char buffer for `\n`, `\r`, or `\r\n`, returns the content **without** the terminator, and cannot tell you which one it found. Round-tripping a file through `readLine` + `println` therefore rewrites its line endings to `System.lineSeparator()`.

**The decoder is a state machine.** `InputStreamReader` holds a `CharsetDecoder` plus a `ByteBuffer` of undecoded bytes, so a multi-byte sequence split across two reads is handled correctly. This is the concrete reason to decode with a `Reader` rather than by chunking bytes yourself.

**`close()` on a decorator closes the whole chain.** Closing the outermost is sufficient and correct; closing an inner one first breaks the outer. In try-with-resources, declare only the outermost resource — but note the leak if a constructor throws mid-chain:

```java
// If GZIPInputStream's constructor throws (bad header), the FileInputStream is NEVER closed
try (var in = new GZIPInputStream(new FileInputStream(f))) { ... }

// Safe: each resource is independently tracked, closed in reverse order
try (var raw = new FileInputStream(f); var in = new GZIPInputStream(raw)) { ... }
```

**`System.out` is a `PrintStream` with autoflush on newline**, and it is `synchronized` internally — which makes it a genuine contention point in a multithreaded hot loop, and a reason logging frameworks buffer asynchronously.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ iostreams</strong> unify the two hierarchies: <code>std::istream</code> is character-oriented and <code>std::ios::binary</code> is a mode flag, not a different type. Buffering lives in the <code>std::streambuf</code> the stream owns, and is on by default for <code>fstream</code> — so the "forgot to buffer" catastrophe of §3 has no C++ equivalent. Formatting and I/O are fused (<code>&lt;&lt;</code>, <code>&gt;&gt;</code>); Java keeps them separate.</p>
<p><strong>Encoding</strong> is where C++ is weaker: <code>char</code> is a byte, <code>std::string</code> is a byte string, and there is no transcoding layer — a <code>locale</code>'s <code>codecvt</code> facet nominally does it and is deprecated in practice. Java's <code>Reader</code>/<code>Writer</code> boundary is an explicit, mandatory design choice, which is why Java programs handle multilingual text correctly far more often.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Byte vs text types | One type, a binary flag | Two hierarchies |
| Buffering | `streambuf`, on by default | Explicit decorator, **off** by default |
| Flush on destruction | `fstream` destructor flushes | `close()` must be called (try-with-resources) |
| Encoding conversion | None practical; `codecvt` deprecated | `InputStreamReader` / `Charset` |
| Default text encoding | Whatever the bytes are | UTF-8 since Java 18 (JEP 400) |
| Error signalling | Stream state bits (`fail()`, `eof()`) | `IOException`, except `PrintStream` |
| Formatting | `<<` with manipulators | `String.format`, `printf` |
| Line reading | `std::getline` | `BufferedReader.readLine` |
| RAII | Destructors | try-with-resources (Phase 7) |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Assuming a stream flushes when it goes out of scope. Java has no destructors — an unclosed <code>BufferedWriter</code> silently discards its buffer. Every stream belongs in try-with-resources.</p>
<p>Treating <code>String</code> as a byte container the way <code>std::string</code> is. A Java <code>String</code> is UTF-16 text; <code>new String(bytes)</code> <em>decodes</em>, and decoding binary data corrupts it irreversibly.</p>
</div>

## 8. Edge cases

- **`read()` returns `int`, not `byte`**, because `-1` must be distinguishable from the valid byte `0xFF`. Casting to `byte` before checking EOF is a classic bug.
- **`read(byte[])` may return fewer bytes than requested** without being at EOF. Loop, or use `readNBytes` / `readAllBytes`.
- **`skip(n)` may skip fewer than `n`.** Java 12 added `skipNBytes`.
- **`available()` is not the file size.** It is "bytes readable without blocking" — for a socket, often 0.
- **`FileReader` before Java 11 had no charset parameter at all**; the overload was added in 11.
- **`Scanner` is slow** (regex-based) and swallows `IOException` into `ioException()`. Fine for a prompt, wrong for a 1 GB file.
- **`String.split(",")` drops trailing empty fields**; `split(",", -1)` keeps them. A CSV bug waiting to happen.
- **A BOM is not stripped.** `UTF_8` decoding of a file with a UTF-8 BOM leaves `﻿` as the first character — usually breaking the first column header.
- **`Files.lines` must be closed** (Module 12.1); `Files.readAllLines` need not be but loads everything.
- **`new PrintWriter(file)`** uses the default charset and truncates the file; it also never throws on write errors.
- **Windows line endings** survive `readAllBytes` and are normalised away by `readLine`.

## 9. Common mistakes

- No buffering on a per-byte loop.
- Not closing, or not using try-with-resources.
- Constructing a decorator chain inside one try-with-resources resource, leaking the inner stream if an outer constructor throws.
- Any charset-less `new String(bytes)`, `getBytes()`, `FileReader`, `FileWriter`, `PrintWriter`.
- Assuming the platform default is UTF-8 on a JDK older than 18.
- Reading a whole file with `readAllBytes` when it may be gigabytes.
- Using `PrintWriter` and never checking `checkError()`.
- Mixing a `Reader` and an `InputStream` on the same source — the buffered one steals bytes.
- Treating `String.length()` as a byte count.
- Splitting bytes into fixed chunks and decoding each chunk independently.

## 10. Interview questions

**Beginner** — 1. `InputStream` versus `Reader`? 2. Why wrap a stream in a `BufferedInputStream`? 3. What does `read()` return at end of stream?

**Intermediate** — 4. What is the decorator pattern here, and name four decorators. 5. Where exactly is the charset decided? 6. Why does an unclosed `BufferedWriter` lose data? 7. What does `read(byte[])` guarantee about how much it reads?

**Advanced** — 8. Quantify unbuffered versus buffered per-byte reading and explain the mechanism. 9. What did JEP 400 change and what breaks because of it? 10. What happens to malformed bytes by default, and how do you make it fail loudly? 11. Why can splitting a byte array into chunks and decoding each corrupt text?

**Senior** — 12. Design the read path for a 50 GB log processed line by line, strict UTF-8, resumable. Justify every layer. 13. A service produces `?` characters for some customer names in one region only. Give five hypotheses and how you would test each. 14. When is `Scanner` acceptable and when is it a defect? Give the performance model.

## 11. Follow-ups

- *After Q2:* "What is the default buffer size and how did you pick a different one?"
- *After Q5:* "Name every class that makes that decision."
- *After Q9:* "How do you get the old behaviour back, and should you?"
- *After Q10:* "What is U+FFFD and why is it dangerous?"
- *After Q13:* → wrong charset on read, on write, in the DB, in the HTTP header, or a BOM.

## 12. Exercise

1. Time reading a 100 MB file four ways: `FileInputStream.read()`, `BufferedInputStream.read()`, `read(byte[8192])`, and `Files.readAllBytes`. Explain all four numbers with syscall counts (use `strace -c` or `dtruss`).
2. Write a file containing `é`, an emoji, and a BOM. Read it with the platform default, with explicit UTF-8, and with ISO-8859-1. Print `length()`, `codePointCount`, and the raw bytes for each.
3. Build a strict decoder that throws on malformed input, feed it a truncated multi-byte sequence, and confirm it throws where the lenient path silently produced U+FFFD.
4. Write the mid-chain leak from §6: a decorator whose constructor throws. Prove with `lsof` (or a finalizer-free reachability test) that the inner descriptor leaks, then fix it.
5. Implement `readLine()` yourself over a raw `InputStream` with correct `\r`, `\n`, `\r\n` handling and UTF-8 decoding across chunk boundaries. This is harder than it looks; that is the point.

## 13. Output prediction

```java
import java.io.*;
import java.nio.charset.*;
import java.nio.file.*;

public class Main {
    public static void main(String[] args) throws Exception {
        Path p = Files.createTempFile("t", ".txt");
        Files.writeString(p, "héllo\n👍\n");

        System.out.println(Files.readString(p).length());
        System.out.println(Files.size(p));
        System.out.println("héllo".length() + " " + "héllo".getBytes(StandardCharsets.UTF_8).length);
        System.out.println("👍".length() + " " + "👍".codePointCount(0, "👍".length()));

        byte[] utf8 = "héllo".getBytes(StandardCharsets.UTF_8);
        System.out.println(new String(utf8, StandardCharsets.ISO_8859_1));
        System.out.println(new String(utf8, StandardCharsets.ISO_8859_1)
                             .getBytes(StandardCharsets.ISO_8859_1).length);

        byte[] bad = { (byte) 0xC3 };                       // truncated 2-byte sequence
        String lenient = new String(bad, StandardCharsets.UTF_8);
        System.out.println(lenient.length() + " " + (int) lenient.charAt(0));

        System.out.println(Charset.defaultCharset());

        Path q = Files.createTempFile("u", ".txt");
        var w = new BufferedWriter(new FileWriter(q.toFile(), StandardCharsets.UTF_8));
        w.write("lost?");
        System.out.println(Files.size(q));
        w.close();
        System.out.println(Files.size(q));

        var in = new ByteArrayInputStream(new byte[]{ 1, 2, (byte) 0xFF });
        int b;
        while ((b = in.read()) != -1) System.out.print(b + " ");
        System.out.println();

        System.out.println("a,b,,".split(",").length + " " + "a,b,,".split(",", -1).length);
    }
}
```

## 14. Mastery check

1. Draw the two hierarchies and name the two classes that bridge them.
2. Explain the decorator pattern in `java.io` with a four-layer example, read outside-in.
3. Quantify the cost of unbuffered per-byte reading and explain it in syscalls.
4. Name every API where the charset is chosen implicitly, and its explicit alternative.
5. What did JEP 400 change, in which release, and what is the remaining exception?
6. What is the default malformed-input action, and how do you change it?
7. Why can `read(byte[])` return fewer bytes than asked without EOF, and what do you do about it?
8. Explain why a decorator chain built in a single try-with-resources resource can leak.
9. Why does decoding fixed-size byte chunks independently corrupt text?
10. Give five distinct causes of mojibake in a web service.
