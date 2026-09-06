---
title: "Locks and synchronizers: ReentrantLock, AQS, latches, barriers, and blocking queues"
phase: 24
order: 3
minutes: 50
summary: "What Lock gives you that synchronized cannot, the AbstractQueuedSynchronizer that every synchronizer is built on, the four coordination primitives and when each applies, and how to reason about deadlock."
tags: ["reentrantlock", "aqs", "condition", "countdownlatch", "semaphore", "blockingqueue", "deadlock"]
---

## 1. The `Lock` interface

```java
public interface Lock {
    void lock();                                        // block until acquired, uninterruptibly
    void lockInterruptibly() throws InterruptedException;
    boolean tryLock();                                  // acquire or return false — never blocks
    boolean tryLock(long time, TimeUnit unit) throws InterruptedException;
    void unlock();
    Condition newCondition();
}
```

The mandatory idiom — there is no scoped release, so `unlock` **must** be in a `finally`:

```java
lock.lock();
try { criticalSection(); }
finally { lock.unlock(); }          // if this is missing, the lock is held forever

// tryLock is different: only unlock if you got it
if (lock.tryLock(100, TimeUnit.MILLISECONDS)) {
    try { criticalSection(); } finally { lock.unlock(); }
} else {
    handleContention();
}
```

## 2. `ReentrantLock` versus `synchronized`

`synchronized` is simpler, scoped, and cannot leak a lock. Prefer it **unless** you need one of these five things:

| Capability | `synchronized` | `ReentrantLock` |
| --- | --- | --- |
| Timed acquisition (`tryLock(timeout)`) | ❌ | ✅ |
| Interruptible acquisition | ❌ | ✅ `lockInterruptibly` |
| Non-blocking attempt (`tryLock()`) | ❌ | ✅ |
| **Fairness** option | ❌ (always barging) | ✅ `new ReentrantLock(true)` |
| **Multiple condition queues** | ❌ (one wait set per monitor) | ✅ `newCondition()` |
| Non-block-structured (acquire in one method, release in another) | ❌ | ✅ (hand-over-hand locking) |
| Automatic release on exception/return | ✅ | ❌ — you must write `finally` |
| Visible to thread dumps as a monitor | ✅ | Partially (`AbstractOwnableSynchronizer` shows the owner) |
| Performance, uncontended | Equal | Equal |

**Fairness is expensive.** An unfair (default) lock lets an arriving thread *barge* — grab the lock ahead of queued waiters if it happens to be free. That is dramatically better for throughput, because it avoids a context switch, at the price of possible starvation. **[JDK]** A fair lock can be an order of magnitude slower. Use fairness only when starvation is an observed problem, not preemptively.

```java
var lock = new ReentrantLock();        // unfair — the right default
lock.getHoldCount(); lock.isHeldByCurrentThread(); lock.getQueueLength();   // useful in tests
```

## 3. `Condition` — multiple wait sets

The killer feature. A monitor has **one** wait set, so producers and consumers waiting on the same object must use `notifyAll` and re-check (Module 24.2 §3). A `Lock` can have several.

```java
public class BoundedBuffer<E> {
    private final Object[] items;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull  = lock.newCondition();     // two SEPARATE wait sets
    private final Condition notEmpty = lock.newCondition();
    private int head, tail, count;

    public void put(E e) throws InterruptedException {
        lock.lock();
        try {
            while (count == items.length) notFull.await();       // still a while loop
            items[tail] = e; tail = (tail + 1) % items.length; count++;
            notEmpty.signal();                                   // wake exactly ONE consumer —
        } finally { lock.unlock(); }                             // safe, because this queue holds
    }                                                            // only consumers

    public E take() throws InterruptedException {
        lock.lock();
        try {
            while (count == 0) notEmpty.await();
            @SuppressWarnings("unchecked") E e = (E) items[head];
            items[head] = null; head = (head + 1) % items.length; count--;
            notFull.signal();
            return e;
        } finally { lock.unlock(); }
    }
}
```

Because each condition queue holds only threads waiting for *that* condition, `signal()` is now correct and cheap — no thundering herd, no missed signals. That is the whole reason `Condition` exists.

The naming is deliberately different from `Object`'s so you cannot confuse them: `await`/`signal`/`signalAll` versus `wait`/`notify`/`notifyAll`. Calling `condition.wait()` by mistake compiles (it is `Object.wait`) and throws `IllegalMonitorStateException`.

## 4. `AbstractQueuedSynchronizer`

**[JDK]** Nearly every synchronizer in `java.util.concurrent` — `ReentrantLock`, `Semaphore`, `CountDownLatch`, `ReentrantReadWriteLock`, `ThreadPoolExecutor.Worker`, `FutureTask` — is a thin subclass of **AQS**, Doug Lea's framework. Understanding it explains all of them at once.

AQS provides two things:

```java
private volatile int state;              // the meaning is yours to define
// plus a CLH-variant FIFO queue of waiting threads, parked with LockSupport.park
```

A subclass defines what `state` means and implements `tryAcquire`/`tryRelease` (or the shared variants):

| Synchronizer | `state` means |
| --- | --- |
| `ReentrantLock` | Hold count. 0 = free; N = held N times by `exclusiveOwnerThread` |
| `Semaphore` | Available permits |
| `CountDownLatch` | Remaining count. Threads wait until it reaches 0 |
| `ReentrantReadWriteLock` | 16 bits of read holds \| 16 bits of write holds |

The acquire path:

```text
tryAcquire(arg)  ->  succeeded? return.
                 ->  failed? enqueue this thread as a node, then park.
release(arg)     ->  tryRelease(arg), then unpark the head's successor.
```

The queue is a doubly-linked list manipulated with CAS; waiting threads are parked with `LockSupport.park`/`unpark`, which is a direct, monitor-free thread suspension primitive. **Exclusive** mode wakes one successor; **shared** mode (used by `Semaphore`, `CountDownLatch`, read locks) propagates the release down the queue so several threads wake at once.

Writing your own is short:

```java
/** A non-reentrant binary latch: state 0 = closed, 1 = open. */
class Gate {
    private static class Sync extends AbstractQueuedSynchronizer {
        @Override protected int tryAcquireShared(int ignored) { return getState() == 1 ? 1 : -1; }
        @Override protected boolean tryReleaseShared(int ignored) { setState(1); return true; }
    }
    private final Sync sync = new Sync();
    public void await() throws InterruptedException { sync.acquireSharedInterruptibly(1); }
    public void open() { sync.releaseShared(1); }
}
```

## 5. `ReadWriteLock` and `StampedLock`

**`ReentrantReadWriteLock`** allows many concurrent readers **or** one writer.

```java
var rw = new ReentrantReadWriteLock();
rw.readLock().lock();  try { read(); }  finally { rw.readLock().unlock(); }
rw.writeLock().lock(); try { write(); } finally { rw.writeLock().unlock(); }
```

Two rules and one warning:

- **Downgrade is allowed** (acquire read while holding write, then release write); **upgrade deadlocks** and is prohibited.
- It only pays off when reads greatly outnumber writes **and** the critical sections are long. For short sections the extra bookkeeping makes it slower than a plain `ReentrantLock`.
- With the default unfair policy, a steady stream of readers can **starve writers**; `new ReentrantReadWriteLock(true)` fixes that at a throughput cost.

**`StampedLock`** (Java 8) adds the mode that actually wins for read-heavy data — **optimistic reading**, which acquires nothing at all:

```java
class Point {
    private final StampedLock sl = new StampedLock();
    private double x, y;

    double distanceFromOrigin() {
        long stamp = sl.tryOptimisticRead();          // NO lock acquired — just a version stamp
        double cx = x, cy = y;                        // read the fields
        if (!sl.validate(stamp)) {                    // did a writer intervene?
            stamp = sl.readLock();                    // fall back to a real read lock
            try { cx = x; cy = y; } finally { sl.unlockRead(stamp); }
        }
        return Math.sqrt(cx * cx + cy * cy);
    }

    void move(double dx, double dy) {
        long stamp = sl.writeLock();
        try { x += dx; y += dy; } finally { sl.unlockWrite(stamp); }
    }
}
```

The price is real: `StampedLock` is **not reentrant** (re-acquiring deadlocks), has **no `Condition`**, and the optimistic block must read into locals and validate *before* using them — a stale read that escapes the validation is a correctness bug, not just a stale value.

## 6. The synchronizers

| Class | Shape | Reusable | Use for |
| --- | --- | --- | --- |
| **`CountDownLatch(n)`** | Threads `await()` until `countDown()` has run n times | ❌ one-shot | "Wait until startup finishes", "wait for N tasks" |
| **`CyclicBarrier(n, action)`** | n threads `await()`; all release together | ✅ | Iterative parallel algorithms with phases |
| **`Semaphore(n)`** | n permits; `acquire`/`release` | ✅ | Bounding concurrent access to a resource |
| **`Phaser`** | Barrier with **dynamic** party registration | ✅ | Variable numbers of participants per phase |
| **`Exchanger`** | Two threads swap objects at a rendezvous | ✅ | Pipeline buffer swapping |

```java
// Latch: N workers, one waiter
var ready = new CountDownLatch(3);
IntStream.range(0, 3).forEach(i -> pool.execute(() -> { init(i); ready.countDown(); }));
ready.await();                       // returns when all three have counted down

// Barrier: N workers wait for EACH OTHER, repeatedly
var barrier = new CyclicBarrier(4, () -> mergeResults());     // barrier action runs on the LAST arriver
for (int round = 0; round < 10; round++) { computeMyChunk(); barrier.await(); }

// Semaphore: bound concurrency, not threads
var permits = new Semaphore(10);
permits.acquire();
try { callRateLimitedApi(); } finally { permits.release(); }   // release in finally, always
```

The distinction people get wrong: **a latch counts events and cannot be reset; a barrier counts *threads* and resets automatically.** A latch's waiters and counters are different threads; a barrier's participants are the same threads doing both.

**`CyclicBarrier` is fragile by design**: if any waiting thread is interrupted or times out, the barrier is **broken** and every other participant gets `BrokenBarrierException`. That is deliberate — a partial barrier is meaningless — but it means you must handle it.

## 7. Blocking queues

The single most useful concurrency abstraction: they turn producer/consumer into two independent, decoupled loops with backpressure built in.

```java
public interface BlockingQueue<E> extends Queue<E> {
    void put(E e) throws InterruptedException;                     // BLOCKS until space
    E take() throws InterruptedException;                          // BLOCKS until an element
    boolean offer(E e, long t, TimeUnit u) throws InterruptedException;
    E poll(long t, TimeUnit u) throws InterruptedException;
}
```

**Four method families, and choosing the wrong one is a classic bug:**

| | Throws | Returns special | Blocks | Times out |
| --- | --- | --- | --- | --- |
| Insert | `add` | `offer` | `put` | `offer(e, t, u)` |
| Remove | `remove` | `poll` | `take` | `poll(t, u)` |
| Examine | `element` | `peek` | — | — |

`add` on a full bounded queue throws `IllegalStateException`; `offer` returns `false` (and **silently drops your work** if you ignore the result); `put` blocks and gives you backpressure. For a producer that must not lose data, `put` is the answer.

| Implementation | Structure | Bounded | Notes |
| --- | --- | --- | --- |
| `ArrayBlockingQueue` | Ring buffer, one lock | ✅ always | Predictable memory; optional fairness |
| `LinkedBlockingQueue` | Linked nodes, **two** locks (head and tail) | Optional | Higher throughput; unbounded by default — the `newFixedThreadPool` hazard (Module 24.1 §5) |
| `SynchronousQueue` | **Zero capacity** — a handoff | n/a | Every `put` waits for a `take`. Used by `newCachedThreadPool` |
| `PriorityBlockingQueue` | Heap | Unbounded | Ordered; `put` never blocks |
| `DelayQueue` | Heap by expiry | Unbounded | Elements available only after their delay elapses |
| `LinkedTransferQueue` | Linked, lock-free | Unbounded | `transfer()` waits for a consumer to take the element |

## 8. Deadlock, livelock, starvation

**Deadlock** needs all four Coffman conditions simultaneously: mutual exclusion, hold-and-wait, no preemption, and circular wait. **Break any one** and deadlock is impossible.

```java
// The classic circular wait
void transfer(Account a, Account b, long amount) {
    synchronized (a) { synchronized (b) { a.debit(amount); b.credit(amount); } }
}
// transfer(x, y) on thread 1 and transfer(y, x) on thread 2 deadlock.
```

The fixes, in order of preference:

```java
// 1. GLOBAL LOCK ORDERING — breaks circular wait. The standard answer.
void transfer(Account a, Account b, long amount) {
    Account first  = a.id() < b.id() ? a : b;
    Account second = a.id() < b.id() ? b : a;
    synchronized (first) { synchronized (second) { a.debit(amount); b.credit(amount); } }
}

// 2. tryLock with timeout and backoff — breaks hold-and-wait
while (true) {
    if (lockA.tryLock(50, MILLISECONDS)) {
        try { if (lockB.tryLock(50, MILLISECONDS)) { try { work(); return; } finally { lockB.unlock(); } } }
        finally { lockA.unlock(); }
    }
    Thread.sleep(ThreadLocalRandom.current().nextInt(50));   // randomised backoff avoids livelock
}

// 3. Take one lock at a time — restructure so you never hold two
```

**Detection:** `jstack <pid>` or `jcmd <pid> Thread.print` prints "Found one Java-level deadlock" with the exact cycle for monitors **and** for AQS-based locks. `ThreadMXBean.findDeadlockedThreads()` does it programmatically, which is worth wiring into a health check.

**Livelock** is threads actively responding to each other and making no progress — two `tryLock` loops that always back off in lockstep. The fix is **randomised** backoff.

**Starvation** is a thread that never gets the resource: an unfair lock with constant contention, or a low-priority thread. The fix is fairness, or removing the contention.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong>C++ locking is RAII; Java's is <code>try/finally</code>.</strong> <code>std::lock_guard</code> and <code>std::scoped_lock</code> release on scope exit including during stack unwinding, so "forgot to unlock" is not a category of C++ bug. Java's <code>Lock</code> has no such support — every <code>lock()</code> needs a hand-written <code>finally</code>, which is why <code>synchronized</code> remains preferable when you do not need the extra capabilities.</p>
<p><strong><code>std::scoped_lock(a, b)</code> is deadlock-free by construction</strong> — it uses a lock-ordering algorithm internally, so C++ hands you the §8 fix as a library feature. Java has no equivalent; you must impose the ordering yourself.</p>
<p><strong>C++20 caught up on synchronizers</strong>: <code>std::latch</code> ≈ <code>CountDownLatch</code>, <code>std::barrier</code> ≈ <code>CyclicBarrier</code>, <code>std::counting_semaphore</code> ≈ <code>Semaphore</code>, <code>std::shared_mutex</code> (C++17) ≈ <code>ReadWriteLock</code>. What C++ still lacks is a standard <strong>blocking queue</strong> — the abstraction Java programmers reach for first.</p>
</div>

| Concern | C++ | Java |
| --- | --- | --- |
| Scoped release | `lock_guard`, `scoped_lock`, `unique_lock` | `synchronized`, or `try/finally` |
| Deadlock-free multi-lock | `std::scoped_lock(a, b)` | Manual lock ordering |
| Timed acquisition | `timed_mutex::try_lock_for` | `tryLock(timeout)` |
| Reentrant | `recursive_mutex` (opt-in) | Always (monitors, `ReentrantLock`) |
| Reader/writer | `std::shared_mutex` (C++17) | `ReentrantReadWriteLock` |
| Optimistic read | Hand-rolled seqlock | `StampedLock.tryOptimisticRead` |
| Condition | `condition_variable` + predicate | `Condition.await` + `while` |
| Latch / barrier / semaphore | C++20 | Since Java 5 |
| Blocking queue | **None standard** | Six implementations |
| Framework for new synchronizers | None | AQS |
| Fairness | Not specified | `new ReentrantLock(true)` |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Writing <code>lock.lock()</code> without <code>try/finally</code> because RAII has never let you forget. An exception in the critical section then leaks the lock permanently and every other thread hangs — a total outage from one missing keyword.</p>
<p>Assuming <code>StampedLock</code> is reentrant like every other Java lock. It is not; re-acquiring deadlocks silently.</p>
</div>

## 10. Edge cases

- **`unlock()` from a thread that does not hold the lock** throws `IllegalMonitorStateException`.
- **`tryLock()` (no timeout) barges even on a fair lock** — it is documented to ignore fairness.
- **`Condition.await` can wake spuriously**, exactly like `Object.wait`. Always a `while`.
- **`awaitUninterruptibly()`** exists and is almost always wrong.
- **`CountDownLatch.await()` on a latch already at zero** returns immediately; `countDown()` past zero is a no-op.
- **A `CyclicBarrier`'s barrier action runs on the last arriving thread**, while all others are still blocked — a slow action delays everyone.
- **`Semaphore.release()` without a matching `acquire()` adds permits.** A `finally`-less release in a retry loop can silently raise the bound.
- **`Semaphore` permits are not owned by a thread** — one thread may acquire and another release, which is a feature (resource handoff) and a footgun.
- **`ReadWriteLock` upgrade deadlocks**: the writer waits for readers to finish, including itself.
- **`SynchronousQueue.offer()` succeeds only if a consumer is already waiting**, so it returns `false` far more often than people expect.
- **`DelayQueue.poll()` returns null when the head has not expired**, even if the queue is non-empty.
- **`ThreadMXBean.findDeadlockedThreads()` covers both monitors and ownable synchronizers**; `findMonitorDeadlockedThreads()` covers only monitors.

## 11. Common mistakes

- `lock.lock()` with no `finally`.
- `unlock()` inside the `try` instead of the `finally`.
- Unlocking after a failed `tryLock`.
- Using a fair lock by default.
- Attempting a read→write lock upgrade.
- Using `StampedLock` reentrantly, or using an optimistic read's values without validating.
- `add`/`offer` on a bounded queue and ignoring the result.
- An unbounded `LinkedBlockingQueue` in a pool.
- Confusing `CountDownLatch` with `CyclicBarrier`.
- Nested locks with no global ordering.
- Diagnosing a hang by reading code instead of taking a thread dump.

## 12. Interview questions

**Beginner** — 1. Why does `unlock()` go in a `finally`? 2. What is a deadlock? 3. What does `CountDownLatch` do?

**Intermediate** — 4. Give five things `ReentrantLock` can do that `synchronized` cannot. 5. `CountDownLatch` versus `CyclicBarrier`. 6. What does a `Semaphore` bound? 7. Name the four `BlockingQueue` method families.

**Advanced** — 8. Why does `Condition` allow `signal()` where a monitor needs `notifyAll()`? 9. What is AQS, what is `state`, and what does it mean for `ReentrantLock`, `Semaphore`, and `CountDownLatch`? 10. Explain `StampedLock`'s optimistic read and its three restrictions. 11. Why is fairness expensive?

**Senior** — 12. Give the four Coffman conditions and a concrete fix that breaks each. 13. Design a bounded work queue with backpressure, graceful shutdown, and per-resource concurrency limits. Name every primitive you use. 14. A service hangs under load with no CPU usage. Walk through the diagnosis from thread dump to root cause.

## 13. Follow-ups

- *After Q4:* "So when do you still prefer `synchronized`?"
- *After Q5:* "Which one resets, and which one's waiters are the same threads that count?"
- *After Q9:* "How does shared mode differ from exclusive?"
- *After Q10:* "What happens if you use the optimistic values without validating?"
- *After Q12:* "Which fix is standard, and why is timeout-and-retry second choice?"

## 14. Exercise

1. Implement `BoundedBuffer` three ways: `synchronized` + `wait`/`notifyAll`, `ReentrantLock` + two `Condition`s, and `ArrayBlockingQueue`. Benchmark all three at 4 producers / 4 consumers and explain the ordering.
2. Write your own `Semaphore` on AQS with `tryAcquireShared`/`tryReleaseShared`. Test fairness, interruption, and timed acquisition against the JDK's.
3. Reproduce the account-transfer deadlock, capture it with `jstack`, then fix it three ways (ordering, `tryLock` with backoff, single lock) and show each fix under a 60-second stress test.
4. Benchmark `ReentrantLock`, `ReentrantReadWriteLock` and `StampedLock` on a read-mostly structure at 95%, 99% and 99.9% reads. Find where the read-write lock starts to lose to a plain lock.
5. Build a livelock with two `tryLock` loops that back off deterministically, then fix it with randomised backoff and measure the difference in completion time.

## 15. Output prediction

```java
import java.util.concurrent.*;
import java.util.concurrent.locks.*;

public class Main {
    public static void main(String[] args) throws Exception {
        var lock = new ReentrantLock();
        lock.lock(); lock.lock();
        System.out.println(lock.getHoldCount() + " " + lock.isHeldByCurrentThread());
        lock.unlock();
        System.out.println(lock.getHoldCount() + " " + lock.isLocked());
        lock.unlock();
        try { lock.unlock(); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var latch = new CountDownLatch(2);
        System.out.println(latch.getCount());
        latch.countDown(); latch.countDown(); latch.countDown();
        System.out.println(latch.getCount());
        latch.await();
        System.out.println("latch passed");

        var sem = new Semaphore(2);
        sem.acquire(); sem.acquire();
        System.out.println(sem.availablePermits() + " " + sem.tryAcquire());
        sem.release(); sem.release(); sem.release();
        System.out.println(sem.availablePermits());

        var q = new ArrayBlockingQueue<Integer>(2);
        System.out.println(q.offer(1) + " " + q.offer(2) + " " + q.offer(3));
        try { q.add(4); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }
        System.out.println(q.poll() + " " + q.poll() + " " + q.poll());

        var sq = new SynchronousQueue<Integer>();
        System.out.println(sq.offer(1) + " " + sq.size() + " " + sq.isEmpty());

        var barrier = new CyclicBarrier(2, () -> System.out.println("barrier action"));
        var t = new Thread(() -> { try { barrier.await(); } catch (Exception e) {} });
        t.start();
        barrier.await();
        t.join();
        System.out.println(barrier.getParties() + " " + barrier.isBroken());

        var rw = new ReentrantReadWriteLock();
        rw.writeLock().lock();
        rw.readLock().lock();                            // downgrade: allowed
        rw.writeLock().unlock();
        System.out.println(rw.getReadHoldCount() + " " + rw.isWriteLocked());
        rw.readLock().unlock();

        var sl = new StampedLock();
        long stamp = sl.tryOptimisticRead();
        System.out.println(sl.validate(stamp));
        long w = sl.writeLock();
        System.out.println(sl.validate(stamp));
        sl.unlockWrite(w);
    }
}
```

## 16. Mastery check

1. Write the mandatory `Lock` idiom and say what breaks without it.
2. Give five capabilities `ReentrantLock` has that `synchronized` lacks, and one it lacks.
3. Explain why fairness costs throughput, and when to enable it.
4. Explain why `Condition` makes `signal()` safe where a monitor requires `notifyAll()`.
5. Describe AQS: what `state` is, what the queue is, and what `state` means in four different synchronizers.
6. Explain `StampedLock`'s optimistic read and its three restrictions.
7. Contrast `CountDownLatch`, `CyclicBarrier`, `Semaphore`, and `Phaser` in one sentence each.
8. Give the four `BlockingQueue` method families and when each is correct.
9. State the four Coffman conditions and a fix that breaks each.
10. How do you diagnose a hung service, in order of steps?
