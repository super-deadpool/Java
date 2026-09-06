---
title: "NIO: Path and Files, channels, ByteBuffer, and memory-mapped files"
phase: 19
order: 2
minutes: 50
summary: "The filesystem API that replaced File, the buffer position/limit discipline that causes half of all NIO bugs, zero-copy transfers, mmap, and why virtual threads retired most selector code."
tags: ["nio", "path", "files", "bytebuffer", "filechannel", "mmap"]
---

## 1. Concept

`java.nio` (Java 1.4, extended by NIO.2 in Java 7) replaced `java.io.File` and added a lower-level, buffer-and-channel I/O model.

```text
java.io                          java.nio
File                             Path + Files            filesystem metadata and operations
InputStream / OutputStream       Channel + ByteBuffer    bulk, positional, possibly non-blocking
(blocking only)                  Selector                multiplexed non-blocking I/O
—                                MappedByteBuffer        the file as memory
```

Two independent things live under the same package name, and interviews conflate them: **NIO.2's `Path`/`Files` API** (which everyone should use, always) and **channels/buffers/selectors** (which most code should not touch).

## 2. `Path` and `Files` — the parts you use daily

`java.io.File` had four fatal flaws: methods returned `boolean` instead of throwing (`delete()` returning `false` told you nothing), no symlink support, no file attributes, and no way to walk a tree efficiently. `Path` + `Files` fixes all four.

```java
Path p = Path.of("/var/log", "app", "server.log");     // Java 11+; Paths.get(...) is the older spelling
p.getFileName();          // server.log
p.getParent();            // /var/log/app
p.getNameCount();         // 3
p.resolve("x.txt");       // /var/log/app/server.log/x.txt   (append)
p.resolveSibling("b.log");// /var/log/app/b.log              (replace last element)
p.relativize(other);      // the path from p to other
p.normalize();            // collapse . and ..  — do this BEFORE any security check
p.toAbsolutePath();
p.startsWith("/var");     // element-wise, not string prefix
```

`Files` is the operations side, and it **throws** with a real reason:

```java
Files.exists(p); Files.notExists(p); Files.isDirectory(p); Files.isRegularFile(p);
Files.size(p);   Files.probeContentType(p);
Files.createDirectories(p);                              // mkdir -p, no error if it exists
Files.copy(src, dst, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.COPY_ATTRIBUTES);
Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE);    // rename(2) — see §5
Files.delete(p);                                          // throws NoSuchFileException if absent
Files.deleteIfExists(p);
Files.readAttributes(p, BasicFileAttributes.class);       // size, times, isSymbolicLink
Files.setPosixFilePermissions(p, PosixFilePermissions.fromString("rw-------"));
Files.createTempFile(dir, "pre", ".tmp");
Files.newInputStream(p, StandardOpenOption.READ);
Files.newBufferedReader(p, UTF_8);                        // already buffered
```

Walking a tree — three options with different tradeoffs:

```java
try (var s = Files.list(dir))       { ... }              // one level, lazy, MUST be closed
try (var s = Files.walk(dir, 5))    { ... }              // recursive, lazy, MUST be closed
Files.walkFileTree(dir, visitor);                        // full control: pre/post visit, error handling
```

`Files.walk` throws `UncheckedIOException` mid-stream if it cannot read a directory; `walkFileTree`'s `visitFileFailed` lets you handle it per entry. For robust production traversal, `walkFileTree` is the right tool.

## 3. `ByteBuffer` — the position/limit discipline

This is where NIO earns its reputation for being error-prone. A buffer has four numbers:

```text
0 <= mark <= position <= limit <= capacity

capacity  fixed at allocation
limit     the first index that must not be read/written
position  the next index to read/write
mark      a remembered position for reset()
```

Every buffer is in one of two modes, and **the buffer does not track which** — you do:

```java
ByteBuffer buf = ByteBuffer.allocate(1024);   // WRITE mode: position=0, limit=capacity

channel.read(buf);        // fills from position; position advances
buf.flip();               // limit = position; position = 0     -> READ mode
while (buf.hasRemaining()) process(buf.get());
buf.clear();              // position = 0; limit = capacity     -> WRITE mode (does NOT erase data)
// or
buf.compact();            // move unread bytes to the front, position = after them -> WRITE mode
```

| Method | Effect | Use when |
| --- | --- | --- |
| `flip()` | limit=position, position=0 | Finished writing, about to read |
| `clear()` | position=0, limit=capacity | Finished reading everything, about to write |
| `compact()` | Keep unread bytes, ready to write | Finished reading *some*, want to top up |
| `rewind()` | position=0, limit unchanged | Re-read the same data |
| `mark()` / `reset()` | Save / restore position | Backtracking parsers |

**The canonical bug is a missing `flip()`**: you fill the buffer, hand it to `write()`, and write zero bytes because position is already at the end. The second canonical bug is `clear()` where `compact()` was needed, silently discarding a partial message.

Typed accessors read/write at the current position and advance; absolute ones take an index and do not:

```java
buf.putInt(42); buf.getInt();            // relative — moves position by 4
buf.putInt(0, 42); buf.getInt(0);        // absolute — position unchanged
buf.order(ByteOrder.LITTLE_ENDIAN);      // default is BIG_ENDIAN — network order
buf.asIntBuffer(); buf.slice(); buf.duplicate();   // views sharing the same memory
```

**Heap versus direct:**

```java
ByteBuffer.allocate(n);        // heap: a byte[] inside the Java heap
ByteBuffer.allocateDirect(n);  // direct: off-heap, outside GC, passed straight to the OS
```

**[JDK]** A channel write from a heap buffer must first **copy into a temporary direct buffer**, because the GC can move a `byte[]` while a syscall is in flight. Direct buffers skip that copy — but they are expensive to allocate, are freed only when the buffer object is collected (via a `Cleaner`, not `free()`), and count against `-XX:MaxDirectMemorySize`. Use direct buffers for long-lived, reused, large I/O buffers; use heap buffers for everything else.

## 4. Channels, transfer, and mmap

```java
try (FileChannel ch = FileChannel.open(p, StandardOpenOption.READ)) {
    ByteBuffer buf = ByteBuffer.allocate(8192);
    while (ch.read(buf) != -1) { buf.flip(); consume(buf); buf.clear(); }

    ch.position();  ch.size();  ch.truncate(n);  ch.force(true);   // fsync
    FileLock lock = ch.lock();                                      // OS-level advisory lock
}
```

**Zero-copy transfer.** `transferTo`/`transferFrom` ask the OS to move bytes between two descriptors without passing through user space — on Linux this is `sendfile(2)`:

```java
try (var in = FileChannel.open(src, READ); var out = FileChannel.open(dst, WRITE, CREATE)) {
    long pos = 0, size = in.size();
    while (pos < size) pos += in.transferTo(pos, size - pos, out);   // may transfer partially — loop
}
```

That is the mechanism behind fast static-file serving and Kafka's throughput.

**Memory-mapped files.** `FileChannel.map` maps a region into the address space; reads and writes become memory accesses, and the OS page cache does the I/O.

```java
try (var ch = FileChannel.open(p, READ, WRITE)) {
    MappedByteBuffer mm = ch.map(FileChannel.MapMode.READ_WRITE, 0, ch.size());
    mm.putInt(0, 42);
    mm.force();                                    // msync — flush dirty pages
}
```

Its three well-known limits:

- **Region size is capped at `Integer.MAX_VALUE`** (~2 GB) per mapping, because `ByteBuffer` indexes with `int`. Larger files need multiple mappings.
- **There is no `unmap`.** The mapping is released when the `MappedByteBuffer` is collected, which on Windows means the file cannot be deleted until GC runs. This has been an open sore since 1.4.
- **A page fault can block on I/O** invisibly — and, before virtual threads pinning rules were settled, in ways that are hard to reason about.

**[JDK]** Java 22's **Foreign Function & Memory API** supersedes this: `Arena` + `MemorySegment` gives deterministic unmapping, segments larger than 2 GB, and bounds-checked access.

```java
try (Arena arena = Arena.ofConfined()) {
    MemorySegment seg = ch.map(FileChannel.MapMode.READ_ONLY, 0, ch.size(), arena);
    long v = seg.get(ValueLayout.JAVA_LONG, 0);
}   // unmapped deterministically here
```

## 5. Realistic example — an atomic file write

Never write in place. The pattern every configuration writer, cache, and log rotator should use:

```java
public static void writeAtomically(Path target, byte[] content) throws IOException {
    Path dir = target.toAbsolutePath().getParent();
    Path tmp = Files.createTempFile(dir, target.getFileName().toString(), ".tmp");   // SAME filesystem
    try {
        try (var ch = FileChannel.open(tmp, WRITE, TRUNCATE_EXISTING)) {
            ch.write(ByteBuffer.wrap(content));
            ch.force(true);                       // fsync the DATA before the rename
        }
        Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException e) {
        Files.deleteIfExists(tmp);
        throw e;
    }
}
```

Why each step matters: the temp file must be on the **same filesystem** or `ATOMIC_MOVE` throws `AtomicMoveNotSupportedException`; `force(true)` guarantees the bytes are durable *before* the rename publishes them; the rename itself is atomic, so a reader sees either the old file or the new one, never a truncated one.

## 6. Selectors, and why you probably do not need them

**[JDK]** `Selector` + non-blocking `SocketChannel` was NIO's headline feature: one thread multiplexing thousands of connections via `epoll`/`kqueue`.

```java
var selector = Selector.open();
channel.configureBlocking(false);
channel.register(selector, SelectionKey.OP_READ);
while (running) {
    selector.select();
    for (var key : selector.selectedKeys()) { if (key.isReadable()) read(key); }
    selector.selectedKeys().clear();
}
```

It works, and it is miserable: your application logic becomes a state machine spread across callbacks, every partial read must be buffered by hand, and stack traces tell you nothing. That is why almost nobody writes selector code directly — Netty exists to encapsulate it.

**[JDK]** **Java 21's virtual threads changed the calculus.** The reason for non-blocking I/O was that one OS thread per connection did not scale past a few thousand. A virtual thread costs a few hundred bytes, and blocking one **unmounts** it from its carrier rather than blocking the OS thread — so `while (true) { read(); write(); }` on a virtual thread per connection scales to a million connections while reading like ordinary sequential code.

```java
try (var exec = Executors.newVirtualThreadPerTaskExecutor()) {
    while (true) {
        Socket s = server.accept();
        exec.submit(() -> handle(s));          // blocking code, a million times over
    }
}
```

The honest summary: use `Path`/`Files` always, use channels/buffers when you need bulk or positional or memory-mapped I/O, and reach for selectors essentially never.

## 7. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong><code>std::filesystem</code></strong> (C++17) is the direct analogue of <code>Path</code>/<code>Files</code> and arrived 10 years later: <code>fs::path</code> with <code>/</code> as the join operator, <code>fs::copy</code>, <code>fs::remove</code>, <code>fs::recursive_directory_iterator</code>, and both throwing and <code>error_code</code> overloads. Java's is nearly one-for-one, minus operator overloading.</p>
<p><strong><code>ByteBuffer</code> has no C++ equivalent and needs none.</strong> A C++ program reads into a <code>std::vector&lt;std::byte&gt;</code> or a <code>char[]</code> and tracks how much it read with a plain integer — because pointers and sizes are already first-class. The whole position/limit/flip protocol exists because Java has no pointer arithmetic and wanted one object that could describe both heap and off-heap memory. <code>std::span</code> is the closest idea.</p>
<p><strong><code>mmap</code></strong> maps to <code>FileChannel.map</code>, but C++ has <code>munmap</code> and Java, until the FFM API, did not.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Path type | `std::filesystem::path` | `Path` |
| Join | `p / "x"` | `p.resolve("x")` |
| Directory walk | `recursive_directory_iterator` | `Files.walk` / `walkFileTree` |
| Error reporting | Throws, or `error_code` overload | Throws typed `IOException` subclasses |
| Buffer | `vector<byte>`, `span`, raw pointer | `ByteBuffer` with position/limit |
| Off-heap memory | Just allocate it | `allocateDirect`, or `MemorySegment` |
| Zero-copy | `sendfile`, `splice` directly | `transferTo` |
| mmap | `mmap`/`munmap` — deterministic | `FileChannel.map` — GC-dependent; `Arena` since 22 |
| >2 GB mapping | Native | Multiple mappings, or `MemorySegment` |
| Async I/O | `io_uring`, ASIO, threads | Selectors, `AsynchronousFileChannel`, or virtual threads |
| fsync | `fsync(fd)` | `FileChannel.force(true)` |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Reading a <code>ByteBuffer</code> as if <code>position</code> were a pointer you control freely. It is shared state mutated by every relative operation, including the ones the channel performs. When in doubt use absolute <code>get(i)</code>/<code>put(i, v)</code>, which do not touch position.</p>
<p>Expecting <code>MappedByteBuffer</code> to unmap when it goes out of scope. It does not. On Windows that means the file stays locked.</p>
</div>

## 8. Edge cases

- **`Path.resolve` with an absolute argument returns the argument** — `Path.of("/a").resolve("/etc/passwd")` is `/etc/passwd`. That is a path-traversal vulnerability if the argument is user input; `normalize()` then `startsWith(baseDir)` is the check.
- **`Files.exists` returning false does not mean "absent"** — it can mean "not permitted to know". `Files.notExists` is a distinct three-valued answer.
- **`Files.delete` on a non-empty directory** throws `DirectoryNotEmptyException`.
- **`ATOMIC_MOVE` across filesystems** throws; across the same filesystem it is `rename(2)`.
- **`Files.copy(InputStream, Path)` does not close the stream**; the `Path`-to-`Path` overload has nothing to close.
- **`Files.list`/`walk`/`find`/`lines` return closeable streams** and leak descriptors otherwise.
- **`FileChannel.write` may write fewer bytes than the buffer holds** — loop on `hasRemaining()`.
- **`transferTo` may transfer fewer bytes than requested**, and had a 2 GB per-call limit historically. Loop.
- **`buf.array()` throws** on a read-only or direct buffer; guard with `hasArray()`.
- **`ByteBuffer.equals` compares remaining content**, not identity or capacity — two buffers with different capacities can be equal.
- **`FileLock` is advisory and per-JVM**: a second lock attempt from the same JVM throws `OverlappingFileLockException` rather than blocking.
- **`WatchService`** on macOS has no native backend and falls back to polling, so it is slow there; on Linux it uses `inotify` with its per-user watch limits.

## 9. Common mistakes

- Forgetting `flip()` before writing a filled buffer.
- `clear()` where `compact()` was required, dropping a partial message.
- Assuming `channel.write` wrote everything.
- Allocating a direct buffer per request.
- Mapping a file and expecting the mapping to be released promptly.
- `Path.resolve` on untrusted input without `normalize` + `startsWith`.
- Writing config in place instead of temp-file + `ATOMIC_MOVE`.
- Not closing `Files.walk` / `Files.list` streams.
- Using selectors by hand instead of Netty or virtual threads.
- Treating `File` as still current — it should not appear in new code.

## 10. Interview questions

**Beginner** — 1. Why does `Path` exist when `File` already did? 2. What are `flip()` and `clear()`? 3. What does `Files.walk` return and what must you do with it?

**Intermediate** — 4. Heap versus direct `ByteBuffer`. 5. What does `transferTo` avoid? 6. Give four `Files` methods and what each throws. 7. What are the four `ByteBuffer` invariants?

**Advanced** — 8. Explain the extra copy a heap buffer forces on a channel write, and why. 9. Explain the memory-mapped file lifecycle and its three limitations. 10. Write an atomic file replacement and justify every step. 11. `Path.of("/a").resolve(userInput)` — what is the vulnerability and the fix?

**Senior** — 12. Why did virtual threads make selector-based servers largely unnecessary, and when would you still want one? 13. Design a durable append-only log: write path, fsync policy, crash recovery, and the tradeoffs of mmap versus channel writes. 14. What does the FFM API give you that `MappedByteBuffer` cannot, and how would you migrate?

## 11. Follow-ups

- *After Q2:* "What does `clear()` do to the bytes?" → nothing; only the pointers.
- *After Q4:* "Why not use direct buffers everywhere?"
- *After Q9:* "How do you force an unmap today?" → you don't; use `Arena` (Java 22+).
- *After Q10:* "What if the temp file is in /tmp?" → cross-device, `ATOMIC_MOVE` fails.
- *After Q12:* "What still pins a virtual thread?" → `synchronized` blocks pre-24, native frames.

## 12. Exercise

1. Copy a 1 GB file five ways: `InputStream` loop, `BufferedInputStream`, `Files.copy`, `FileChannel` with a heap buffer, and `transferTo`. Measure throughput and syscall counts; explain the ordering.
2. Write a buffer exercise that deliberately omits `flip()` and prove zero bytes are written. Then write a framing protocol reader that must use `compact()`, and show what `clear()` corrupts.
3. Implement `writeAtomically` from §5. Kill the JVM with `-9` mid-write in a loop and assert the target file is always either the old or the new content, never partial.
4. Memory-map a 3 GB file. Handle the 2 GB limit with multiple mappings; then rewrite it with `Arena` + `MemorySegment` and compare the code and the unmapping behaviour.
5. Write a path-traversal check: given a base directory and a user-supplied relative path, return a safe resolved `Path` or reject. Test it against `../`, absolute paths, symlinks, and encoded separators.

## 13. Output prediction

```java
import java.nio.*;
import java.nio.file.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;

public class Main {
    public static void main(String[] args) throws Exception {
        Path a = Path.of("/var/log", "app");
        System.out.println(a.resolve("x.txt"));
        System.out.println(a.resolve("/etc/passwd"));
        System.out.println(a.resolveSibling("other"));
        System.out.println(Path.of("/a/b/../c/./d").normalize());
        System.out.println(Path.of("/a/b/c").relativize(Path.of("/a/x/y")));
        System.out.println(Path.of("/a/bc").startsWith("/a/b"));

        ByteBuffer b = ByteBuffer.allocate(8);
        b.put((byte) 1).put((byte) 2).put((byte) 3);
        System.out.println(b.position() + " " + b.limit() + " " + b.remaining());
        b.flip();
        System.out.println(b.position() + " " + b.limit() + " " + b.remaining());
        System.out.println(b.get() + " " + b.get());
        b.compact();
        System.out.println(b.position() + " " + b.limit() + " " + b.get(0));
        b.clear();
        System.out.println(b.position() + " " + b.limit() + " " + b.get(0));

        ByteBuffer i = ByteBuffer.allocate(4);
        i.putInt(1);
        System.out.println(java.util.Arrays.toString(i.array()));
        i.clear(); i.order(ByteOrder.LITTLE_ENDIAN); i.putInt(1);
        System.out.println(java.util.Arrays.toString(i.array()));

        ByteBuffer d = ByteBuffer.allocateDirect(4);
        System.out.println(d.isDirect() + " " + d.hasArray());

        ByteBuffer x = ByteBuffer.allocate(4).put("ab".getBytes(StandardCharsets.UTF_8));
        ByteBuffer y = ByteBuffer.allocate(9).put("ab".getBytes(StandardCharsets.UTF_8));
        x.flip(); y.flip();
        System.out.println(x.equals(y));

        Path t = Files.createTempFile("z", ".bin");
        try (var ch = FileChannel.open(t, StandardOpenOption.WRITE)) {
            System.out.println(ch.write(ByteBuffer.wrap(new byte[]{9, 9, 9})));
        }
        System.out.println(Files.size(t));
        System.out.println(Files.deleteIfExists(t) + " " + Files.deleteIfExists(t));
    }
}
```

## 14. Mastery check

1. Name four things `File` could not do that `Path`/`Files` can.
2. State the four `ByteBuffer` invariants and what `flip`, `clear`, `compact`, and `rewind` each do to them.
3. When is `compact()` required and what does using `clear()` instead lose?
4. Explain the extra copy a heap buffer causes on a channel write and why the GC forces it.
5. Give three reasons not to allocate direct buffers casually.
6. Describe `transferTo` and the OS mechanism behind it.
7. List the three limitations of `MappedByteBuffer` and what the FFM API changes.
8. Write the atomic-file-replacement sequence and justify each of its four steps.
9. Explain the `Path.resolve` traversal vulnerability and the correct check.
10. Why did virtual threads make selector-based servers largely unnecessary, and what did *not* change?
