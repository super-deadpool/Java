---
title: "java.time: instants, local dates, zones, and the DST arithmetic that breaks systems"
phase: 21
order: 1
minutes: 45
summary: "Why Date and Calendar were replaced, how to pick between Instant, LocalDate, LocalDateTime, OffsetDateTime and ZonedDateTime, and what Duration.ofDays(1) does across a DST boundary that Period.ofDays(1) does not."
tags: ["java-time", "instant", "zoneddatetime", "duration", "dst", "clock"]
---

## 1. Concept

`java.time` (JSR-310, Java 8, designed by the author of Joda-Time) replaced `Date`/`Calendar` with a set of **immutable, domain-modelled** types. The organising idea is a split that the old API never made:

```text
MACHINE TIME — a point on the timeline, the same everywhere
    Instant          an instant in UTC: epoch seconds + nanos
    Duration         an elapsed amount: seconds + nanos

HUMAN TIME — what a calendar and a clock say, with no timeline position
    LocalDate        2026-09-06                    (a birthday, a holiday)
    LocalTime        14:30                          (a shop's opening time)
    LocalDateTime    2026-09-06T14:30               (still ambiguous — no zone)
    Period           an amount in years/months/days

THE BRIDGE — human time plus enough information to locate it on the timeline
    ZoneOffset       -05:00                         a fixed offset
    ZoneId           America/New_York               a set of RULES over time
    OffsetDateTime   2026-09-06T14:30-05:00         unambiguous, but no future-proof rules
    ZonedDateTime    2026-09-06T14:30-05:00[America/New_York]   the full thing
```

`LocalDateTime` is the type most often misused: **it is not a point in time.** "2026-03-08T02:30" does not exist in New York, and "2026-11-01T01:30" happens twice. It carries no offset, so it cannot be compared against an `Instant` or stored as a timestamp.

## 2. Why Java replaced `Date` and `Calendar`

Six defects, each of which caused real bugs for a decade:

| Defect | Consequence |
| --- | --- |
| `Date` is **mutable** | Cannot be a safe field, map key, or shared constant (Module 5.1) |
| `Date` is misnamed | It is an **instant** (millis since epoch), not a date. `getYear()` returns year − 1900 |
| `Calendar` months are **0-based** | `Calendar.set(2026, 9, 1)` is October |
| `SimpleDateFormat` is **not thread-safe** | A static formatter shared across threads produces silently wrong dates under load — the single most famous Java date bug |
| `Calendar` is **lenient** by default | `set(2026, 1, 30)` silently becomes March 2 instead of throwing |
| `java.sql.Timestamp extends Date` | Breaks `equals` symmetry (Module 3.2): `date.equals(ts)` and `ts.equals(date)` disagree |

Everything in `java.time` is **immutable and thread-safe**, including `DateTimeFormatter`. A `static final DateTimeFormatter` is correct; a `static final SimpleDateFormat` is a defect.

## 3. Which type to use

> Ask: **does this value need to be the same moment for everyone in the world?**
> Yes → `Instant`. No, it's a calendar concept → `LocalDate`/`LocalTime`. It's a wall-clock time in a specific place → `ZonedDateTime`.

| Value | Type | Why |
| --- | --- | --- |
| "when this row was written" | `Instant` | An event; one moment globally |
| a birthday, a contract date | `LocalDate` | No time, no zone — the date is the same regardless of where you read it |
| shop opens at 09:00 | `LocalTime` | Applies in whatever zone the shop is in |
| meeting at 14:00 New York next March | **`ZonedDateTime`** | Must survive a future tzdb change or DST rule change |
| a timestamp stored in a DB with offset | `OffsetDateTime` | Unambiguous, and maps to SQL `TIMESTAMP WITH TIME ZONE` |
| how long a request took | `Duration` | Time-based, exact |
| "3 months' notice" | `Period` | Date-based, calendar-aware |

**The future-event rule matters.** Store a future meeting as `ZonedDateTime` (or as `LocalDateTime` + `ZoneId`), never as an `Instant`: if a government changes its DST rules before the meeting, the *local wall time* is what people expect to be preserved, and only the zone rules can recompute the instant. Store *past* events as `Instant` — history does not move.

## 4. The API

```java
// Creation
Instant.now();  Instant.ofEpochSecond(s);  Instant.ofEpochMilli(ms);  Instant.EPOCH;
LocalDate.now();  LocalDate.of(2026, 9, 6);  LocalDate.of(2026, Month.SEPTEMBER, 6);  LocalDate.parse("2026-09-06");
LocalDateTime.of(date, time);  ZonedDateTime.now(ZoneId.of("Europe/London"));
Year.of(2026);  YearMonth.of(2026, 9);  MonthDay.of(2, 29);  DayOfWeek.MONDAY;

// Conversion — the four moves you need constantly
instant.atZone(zone);                          // Instant   -> ZonedDateTime
zdt.toInstant();                               // ZonedDateTime -> Instant
localDateTime.atZone(zone);                    // LocalDateTime -> ZonedDateTime (may adjust! §6)
zdt.toLocalDate();  zdt.toLocalDateTime();     // drop information

// Arithmetic — every one returns a NEW object
date.plusDays(1);  date.minusMonths(3);  date.plusWeeks(2);
date.withDayOfMonth(1);  date.withYear(2027);
date.with(TemporalAdjusters.lastDayOfMonth());
date.with(TemporalAdjusters.next(DayOfWeek.FRIDAY));
date.with(TemporalAdjusters.firstInMonth(DayOfWeek.MONDAY));

// Amounts and differences
Duration.between(startInstant, endInstant);    Duration.ofMinutes(90);  d.toMillis();  d.toHoursPart();
Period.between(startDate, endDate);            Period.ofMonths(3);      p.getYears();
ChronoUnit.DAYS.between(d1, d2);               // the one you usually want for "how many days"

// Comparison
a.isBefore(b);  a.isAfter(b);  a.isEqual(b);   // isEqual compares the INSTANT; equals also compares zone
```

**Immutability is the most common beginner bug in this API:**

```java
LocalDate d = LocalDate.of(2026, 1, 1);
d.plusDays(30);                  // result DISCARDED — d is unchanged
d = d.plusDays(30);              // correct
```

## 5. Formatting and parsing

```java
static final DateTimeFormatter F = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss")
        .withZone(ZoneId.of("UTC"));           // safe to share: IMMUTABLE

String s = F.format(instant);
LocalDate d = LocalDate.parse("2026-09-06");   // ISO_LOCAL_DATE by default — no formatter needed
LocalDate e = LocalDate.parse("06/09/2026", DateTimeFormatter.ofPattern("dd/MM/uuuu"));
```

Built-in constants cover the standard shapes: `ISO_LOCAL_DATE`, `ISO_INSTANT`, `ISO_OFFSET_DATE_TIME`, `RFC_1123_DATE_TIME`.

**`uuuu` versus `yyyy`** is the pattern trap. `yyyy` is *year-of-era* and `uuuu` is *proleptic year*; they differ before year 1 and — crucially — `yyyy` with `ResolverStyle.STRICT` requires an era field, so a strict parse of `"2026-09-06"` with `yyyy` throws. Use **`uuuu`**.

```java
DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT)
        .parse("2026-02-30");                  // throws — 30 February does not exist
// The default resolver style is SMART, which silently clamps 2026-02-30 to 2026-02-28.
```

Localised output uses `ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)`; a hand-written pattern is not localisable.

## 6. DST — the arithmetic that breaks systems

Two things go wrong at a DST transition, and both are exam-grade.

**Gaps and overlaps.** In New York, 2026-03-08 02:30 does not exist (clocks jump 02:00 → 03:00) and 2026-11-01 01:30 exists twice.

```java
// GAP: the local time is invalid. atZone() does NOT throw — it shifts forward by the gap length.
LocalDateTime.of(2026, 3, 8, 2, 30).atZone(NY);      // -> 2026-03-08T03:30-04:00[America/New_York]

// OVERLAP: the local time is ambiguous. atZone() picks the EARLIER offset (still on DST).
var amb = LocalDateTime.of(2026, 11, 1, 1, 30).atZone(NY);   // -04:00
amb.withLaterOffsetAtOverlap();                              // -05:00 — the second occurrence
```

Silent adjustment is deliberate (it is what users expect from a calendar app) and dangerous (a scheduler that fires "every day at 02:30" fires at 03:30 once a year). If you need to detect it: `zone.getRules().getValidOffsets(localDateTime)` returns 0, 1, or 2 offsets.

**`Duration` versus `Period` across a transition.** This is the single most important distinction in the module:

```java
var before = ZonedDateTime.of(2026, 3, 7, 12, 0, 0, 0, NY);   // day before "spring forward"

before.plus(Duration.ofDays(1));    // 2026-03-08T13:00-04:00  <- exactly 86 400 seconds later
before.plus(Period.ofDays(1));      // 2026-03-08T12:00-04:00  <- the same wall time, next day
before.plusDays(1);                 // same as Period: 12:00 — ZonedDateTime.plusDays is DATE-based
```

`Duration` is **exact elapsed time**; `Period` (and `plusDays`/`plusMonths` on a date-based type) is **calendar arithmetic**. A "day" is 23, 24, or 25 hours depending on where you stand. Use `Duration` for timeouts, SLAs, and rate limits; use `Period`/`plusDays` for billing cycles, notice periods, and anything a human would call "a day".

`Duration.ofDays(1)` is defined as exactly 86 400 seconds, and `Period.ofMonths(1)` has no fixed length at all — which is why `Duration.between` refuses date-only arguments and `Period.between` refuses instants.

## 7. `Clock` — the part that makes time testable

Every `now()` method has an overload taking a `Clock`. That is the injection point.

```java
public class SubscriptionService {
    private final Clock clock;                                    // inject it
    public SubscriptionService(Clock clock) { this.clock = clock; }

    public boolean isExpired(Subscription s) {
        return s.expiresAt().isBefore(Instant.now(clock));         // never Instant.now()
    }
}

// production
new SubscriptionService(Clock.systemUTC());
// test — deterministic, no sleeping, no flakiness
new SubscriptionService(Clock.fixed(Instant.parse("2026-09-06T00:00:00Z"), ZoneOffset.UTC));
Clock.offset(base, Duration.ofDays(30));       // "30 days from now"
Clock.tick(base, Duration.ofSeconds(1));       // coarse-grained
```

A codebase that calls `Instant.now()` directly in business logic cannot test time-dependent behaviour without sleeping or mocking statics. Injecting a `Clock` is the single highest-value practice in this module.

## 8. What happens internally

**[JDK]** `Instant` stores a `long` epoch-second and an `int` nano-of-second. The reference point is **1970-01-01T00:00:00Z**, and the range covers roughly ±1 billion years.

**Leap seconds do not exist** in `java.time`. **[JDK]** The specification defines a "Java time-scale" in which every day has exactly 86 400 seconds; a real UTC leap second is absorbed by the platform clock (typically by smearing). So `Duration.between` two instants spanning a leap second is off by one second from true UTC elapsed time — which matters for astronomy and essentially nothing else.

**Resolution.** `Instant.now()` returned millisecond precision through Java 8; **[JDK]** Java 9 changed the default `Clock` to use the OS's higher-resolution clock, so it typically yields microseconds on Linux/macOS. Code asserting that the nano field is always a multiple of 1 000 000 broke on the Java 9 upgrade.

**Never use `Instant.now()` to measure elapsed time.** The wall clock can jump backwards (NTP correction, manual change, VM migration). Use `System.nanoTime()`, which is monotonic but has no relationship to wall time:

```java
long t0 = System.nanoTime();
work();
Duration took = Duration.ofNanos(System.nanoTime() - t0);
```

**`ZoneId` versus `ZoneOffset`.** A `ZoneOffset` is a fixed number of hours/minutes from UTC. A `ZoneId` is a **region** whose offset is a function of the instant, resolved through `ZoneRules` loaded from the **IANA tzdb** shipped in the JDK. That database changes several times a year as governments change their rules, so a JDK that is two years old computes future local times incorrectly. `-Djava.time.zone.DefaultZoneRulesProvider` and the `tzupdater` tool exist for out-of-band updates.

The three-letter IDs are **ambiguous and mostly deprecated**: `"IST"` means Irish, Indian, or Israeli Standard Time depending on who you ask. Always use region IDs (`Europe/Dublin`, `Asia/Kolkata`).

**`ZonedDateTime.equals` compares the zone too**, so the same instant in two zones is `isEqual` but not `equals`:

```java
var a = Instant.parse("2026-09-06T12:00:00Z").atZone(ZoneId.of("UTC"));
var b = a.withZoneSameInstant(ZoneId.of("Asia/Tokyo"));
a.isEqual(b);   // true  — same instant
a.equals(b);    // false — different zone
a.compareTo(b); // NOT zero — compares local datetime first, then zone
```

That makes `ZonedDateTime` a poor `TreeSet` element and a poor map key. Normalise to `Instant` for comparison and storage.

## 9. C++ comparison

<div class="cpp">
<span class="label">C++ mental model → Java</span>
<p><strong><code>std::chrono</code></strong> is the closest analogue in any language, and since C++20 it covers the same ground: <code>duration</code> ≈ <code>Duration</code>, <code>time_point</code> ≈ <code>Instant</code>, <code>year_month_day</code> ≈ <code>LocalDate</code>, <code>zoned_time</code> ≈ <code>ZonedDateTime</code>, and a <code>tzdb</code> loaded from the same IANA database.</p>
<p>The deep difference is <strong>where the units live</strong>. A C++ <code>duration</code> carries its unit in the <em>type</em> as a compile-time <code>std::ratio</code>, so <code>hours + minutes</code> produces <code>minutes</code> automatically, a lossy conversion requires an explicit <code>duration_cast</code>, and the arithmetic compiles down to integer ops with no object at all. Java's <code>Duration</code> is one runtime class holding seconds and nanos — uniform and allocating, but with no unit safety: <code>Duration.ofDays(1)</code> and <code>Duration.ofHours(24)</code> are indistinguishable afterwards.</p>
<p>The other difference is <strong>clock typing</strong>: C++ makes <code>system_clock</code> (wall, adjustable) and <code>steady_clock</code> (monotonic) different types, so you <em>cannot</em> accidentally measure elapsed time with the wall clock. Java offers <code>Instant.now()</code> and <code>System.nanoTime()</code> as unrelated APIs and lets you pick wrong.</p>
</div>

| Concern | C++20 `<chrono>` | `java.time` |
| --- | --- | --- |
| Instant | `system_clock::time_point` | `Instant` |
| Monotonic clock | `steady_clock` — a distinct type | `System.nanoTime()` — a `long` |
| Duration | `duration<Rep, Period>` — unit in the type | `Duration` — seconds + nanos |
| Unit safety | Compile-time; lossy needs `duration_cast` | None |
| Calendar date | `year_month_day` (C++20) | `LocalDate` |
| Time zone | `zoned_time`, `tzdb` (C++20) | `ZonedDateTime`, `ZoneId` |
| Calendar amount | `months`, `years` (civil, C++20) | `Period` |
| Formatting | `std::format` with chrono specs | `DateTimeFormatter` |
| Cost of arithmetic | Zero — integer ops | An object per operation |
| Testable clock | Pass a clock type | Inject a `Clock` |
| Leap seconds | `utc_clock` models them | Not modelled |

<div class="trap">
<span class="label">C++ programmer mistakes</span>
<p>Expecting <code>Duration</code> arithmetic to be unit-checked. <code>Duration.ofDays(1)</code> is just 86 400 seconds; add it to a <code>ZonedDateTime</code> spanning a DST boundary and the wall-clock time shifts by an hour. In C++ you would reach for <code>days{1}</code> on a <code>zoned_time</code>, which does the calendar-aware thing — the Java equivalent is <code>Period.ofDays(1)</code> or <code>plusDays(1)</code>, not <code>Duration</code>.</p>
<p>Treating a <code>ZonedDateTime</code> like a <code>time_point</code> for ordering. Its <code>equals</code> and <code>compareTo</code> include the zone; convert to <code>Instant</code> first.</p>
</div>

## 10. Edge cases

- **`LocalDate.plusMonths` clamps.** `2026-01-31.plusMonths(1)` is `2026-02-28`, and `.plusMonths(1).minusMonths(1)` is `2026-01-28` — **date arithmetic is not associative or reversible**.
- **`Period.between(a, b)` is not symmetric** in units: it decomposes into years/months/days, so `Period.ofDays(45)` and `Period.between` over 45 days give different objects.
- **`Duration.between` on two `LocalDate`s throws** — a date has no time component to subtract. Use `ChronoUnit.DAYS.between`.
- **`Period.getDays()` is not "total days"** — it is the days *component*. `Period.ofMonths(2).getDays()` is 0.
- **`Duration.toHours()` truncates**; `toHoursPart()` (Java 9) gives the component. Mixing them silently double-counts.
- **`MonthDay.of(2, 29)` is legal**; `LocalDate.of(2026, 2, 29)` throws. Leap-day birthdays need `MonthDay` plus a resolution policy.
- **`ZoneId.systemDefault()` is process-wide, mutable state** (`TimeZone.setDefault` affects it) and differs between your laptop and the container. Depend on it nowhere.
- **`Instant` has no zone, so `instant.getHour()` does not exist** — you must `atZone` first. That is the API preventing a whole bug class.
- **`toString` is ISO-8601 and round-trips**: `Instant.parse(instant.toString())` works for every `java.time` type.
- **`Date.from(instant)` truncates nanos to millis** silently.
- **`java.sql.Date` extends `java.util.Date` and its time fields must be zero** — use `LocalDate` and let the JDBC 4.2 driver map it.
- **Two `ZonedDateTime`s can be `isEqual` but have different `hashCode`s** — never use one as a `HashMap` key.

## 11. Common mistakes

- `date.plusDays(1);` without assigning the result.
- A `static SimpleDateFormat` shared across threads.
- `LocalDateTime` for a timestamp — it is not a point in time.
- `Instant` for a future scheduled meeting.
- `Duration.ofDays(1)` where `Period.ofDays(1)` was meant.
- `Instant.now()` in business logic instead of an injected `Clock`.
- `Instant.now()` for elapsed-time measurement.
- `yyyy` in a strict-resolver pattern.
- Three-letter zone IDs.
- `ZoneId.systemDefault()` anywhere it can differ between environments.
- Storing local times without a zone and "fixing it in the display layer".
- Comparing `ZonedDateTime` with `equals`.

## 12. Interview questions

**Beginner** — 1. Name four `java.time` types and what each represents. 2. Why is `SimpleDateFormat` dangerous? 3. Is `LocalDate` mutable?

**Intermediate** — 4. `LocalDateTime` versus `ZonedDateTime` versus `Instant` — when do you use each? 5. `Duration` versus `Period`. 6. What does `ZoneId` hold that `ZoneOffset` does not? 7. How do you make time testable?

**Advanced** — 8. What does `atZone` do with a local time that falls in a DST gap? In an overlap? 9. Show the difference between `plus(Duration.ofDays(1))` and `plusDays(1)` across a spring-forward. 10. Why is `2026-01-31.plusMonths(1).minusMonths(1)` not the original date? 11. Why must a future meeting be stored as `ZonedDateTime` rather than `Instant`?

**Senior** — 12. Design the storage schema for a global scheduling product: past events, future events, recurring events, and user display. Justify every column type. 13. A batch job silently skipped one run last March and ran twice last November. Diagnose. 14. `yyyy` versus `uuuu`, resolver styles, and how you would harden a public date-parsing API.

## 13. Follow-ups

- *After Q2:* "What replaced it, and why is the replacement safe?"
- *After Q5:* "Which one does `ZonedDateTime.plusDays` use?"
- *After Q8:* "How do you detect the gap instead of silently shifting?" → `getRules().getValidOffsets`.
- *After Q11:* "What if the government changes the rules?" → the local time is preserved; the instant is recomputed.
- *After Q13:* → a `Duration`-based daily scheduler across DST, or a naive `LocalDateTime` cron.

## 14. Exercise

1. Write a `Duration` versus `Period` comparison across both DST transitions in `America/New_York`, printing wall time and offset for `plus(Duration.ofDays(1))`, `plus(Period.ofDays(1))`, `plusDays(1)`, and `plusHours(24)`. Explain all four.
2. Write a function that, given a `LocalDateTime` and a `ZoneId`, returns whether it is valid, ambiguous, or in a gap — and for the ambiguous case returns both instants.
3. Refactor a class calling `Instant.now()` in three places to take an injected `Clock`, then write tests for "expires at midnight", "renews in 30 days", and "grace period ends", with zero sleeps.
4. Take `2026-01-31` and apply `plusMonths(1)` twelve times, printing each. Explain the trajectory, then write a "same day of month, or last day if shorter" adjuster that is reversible.
5. Parse `"2026-02-30"` with SMART, LENIENT, and STRICT resolver styles, and with `yyyy` versus `uuuu`. Tabulate the six outcomes.

## 15. Output prediction

```java
import java.time.*;
import java.time.format.*;
import java.time.temporal.*;

public class Main {
    static final ZoneId NY = ZoneId.of("America/New_York");

    public static void main(String[] args) {
        LocalDate d = LocalDate.of(2026, 1, 31);
        d.plusDays(1);
        System.out.println(d);
        System.out.println(d.plusMonths(1) + " " + d.plusMonths(1).minusMonths(1));

        var before = ZonedDateTime.of(2026, 3, 7, 12, 0, 0, 0, NY);
        System.out.println(before.plus(Duration.ofDays(1)));
        System.out.println(before.plus(Period.ofDays(1)));
        System.out.println(before.plusDays(1));
        System.out.println(Duration.between(before, before.plusDays(1)).toHours());

        System.out.println(LocalDateTime.of(2026, 3, 8, 2, 30).atZone(NY));
        var amb = LocalDateTime.of(2026, 11, 1, 1, 30).atZone(NY);
        System.out.println(amb + " " + amb.withLaterOffsetAtOverlap());
        System.out.println(NY.getRules().getValidOffsets(LocalDateTime.of(2026, 3, 8, 2, 30)).size());

        var utc = Instant.parse("2026-09-06T12:00:00Z").atZone(ZoneId.of("UTC"));
        var tokyo = utc.withZoneSameInstant(ZoneId.of("Asia/Tokyo"));
        System.out.println(utc.isEqual(tokyo) + " " + utc.equals(tokyo) + " " + tokyo);

        Period p = Period.between(LocalDate.of(2026, 1, 1), LocalDate.of(2026, 3, 15));
        System.out.println(p + " " + p.getDays() + " " + p.getMonths());
        System.out.println(ChronoUnit.DAYS.between(LocalDate.of(2026, 1, 1), LocalDate.of(2026, 3, 15)));

        Duration dur = Duration.ofMinutes(150);
        System.out.println(dur + " " + dur.toHours() + " " + dur.toHoursPart() + " " + dur.toMinutesPart());

        System.out.println(MonthDay.of(2, 29));
        try { LocalDate.of(2026, 2, 29); } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var smart = DateTimeFormatter.ofPattern("uuuu-MM-dd");
        System.out.println(LocalDate.parse("2026-02-30", smart));
        try {
            LocalDate.parse("2026-02-30", smart.withResolverStyle(ResolverStyle.STRICT));
        } catch (Exception e) { System.out.println(e.getClass().getSimpleName()); }

        var clock = Clock.fixed(Instant.parse("2026-09-06T00:00:00Z"), ZoneOffset.UTC);
        System.out.println(LocalDate.now(clock) + " " + Instant.now(clock));
    }
}
```

## 16. Mastery check

1. Draw the machine-time / human-time / bridge split and place eight types in it.
2. Give six concrete defects of `Date`/`Calendar`/`SimpleDateFormat`.
3. State the decision rule for `Instant` versus `LocalDate` versus `ZonedDateTime`, with an example of each.
4. Explain `Duration` versus `Period` and give the DST example where they diverge.
5. What does `atZone` do in a DST gap and in an overlap, and how do you detect each?
6. Why must a future meeting be stored as a `ZonedDateTime`?
7. Explain `ZoneId` versus `ZoneOffset` and where the rules come from.
8. Why is `plusMonths` neither reversible nor associative?
9. Why is `Instant.now()` wrong for measuring elapsed time?
10. Explain `uuuu` versus `yyyy` and the three resolver styles.
