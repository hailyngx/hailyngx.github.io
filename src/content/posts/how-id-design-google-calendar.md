---
title: "How I'd design Google Calendar, part 1"
description: "A calendar looks simple until a weekly standup has to survive daylight saving. How I'd shard it, expand repeating rules, and keep a message queue off the month-view path."
pubDate: 2026-08-23
tags:
  - systems
---

I spent a while working through a calendar as a backend problem — the kind of system that looks simple until you invite three people to a weekly standup that survives daylight saving.

This is the design I landed on. I'm writing it down as notes I'd actually share: what the product is, how the data is shaped, how a request walks through the boxes, and why I wouldn't put a message queue on the month-view path.

A lot of the storage thinking is influenced by how products like [Notion](https://www.notion.com/blog/sharding-postgres-at-notion) shard Postgres by workspace, [re-shard without downtime](https://www.notion.com/blog/the-great-re-shard), and treat [blocks as one recursive data model](https://www.notion.com/blog/data-model-behind-notion). A calendar isn't a Notion doc, but the instincts transfer: pick a partition key (the id you split data on), keep related rows on one host, and don't pretend a hash of random ids is a uniform *load*.

---

## What I would and wouldn't build

I'd start by locking the product. Otherwise I accidentally design three calendars.

I'd include:

- Creating and listing events in a day / week / month window
- Recurring series, with "this event" / "this and following" / "all events"
- Invites and RSVP
- Free/busy and "find a time"
- Reminders
- Sharing a calendar as reader, writer, or free/busy-only

I'd leave out, unless someone really wanted them: video conferencing, rooms as a full resource scheduler, and a notification bus the size of Gmail.

A few product questions hide most of the difficulty:

**Single user or invites?**  
If it's only my dentist appointments, I don't need copies or fan-out (writing the meeting onto each attendee's calendar). The interesting product is multi-attendee: Alice creates a review, Bob and Cara RSVP, and a time change has to show up on *their* calendars.

**Recurring events?**  
If every event is one-off, I store start and end and go home. Recurrence means I store a *rule* ("every Tuesday 9am") and generate Tuesdays when someone opens March — plus exceptions when they move one of them. That is a string like "weekly, Tuesdays." It is not a list of dates.

**Timezones, all-day, daylight saving?**  
I store which timezone the event lives in. I don't pretend everything is a timestamp on the one global clock. All-day "March 1" is a calendar date, not midnight in UTC (which is still February in Los Angeles). Daylight saving is why "add seven days on the global clock" puts a meeting on the wrong Tuesday.

**Sharing: titles or only busy bars?**  
Same `GET /events`, different payload. A manager with free/busy access sees that I'm busy 2–3pm, not "Interview at OpenAI."

**Realtime?**  
If someone moves the 3pm while I have the week open, I'd push "this calendar changed" and let the client refetch. I would not build Google-Docs-style live co-editing. Two people editing one event: version check, conflict, reload.

Non-negotiables I'd write on the board:

- Reads dominate (month view). Writes are small.
- A wrong Tuesday after a clock change is worse than a 200ms slower month view.
- The grid should feel fresh in seconds, not minutes.
- Reminders can duplicate. Missing 9am cannot.

### Why a wrong Tuesday after daylight saving is a disaster

Here it just means: the product is lying about when you have to be somewhere.

In the US, most zones spring forward and fall back. Pacific time is eight hours behind the global clock in winter and seven in summer. Users want **Tuesday 9:00 on the wall in San Francisco**, every week. Adding seven 24-hour days on the global clock is not the same thing. When the offset changes, 9:00 Pacific is a different instant — and naive math can slip the instance onto Monday evening or 8:00am.

The fix is boring. Store three things, then generate the Tuesdays with a timezone database:

- when the first instance starts, in local time
- which timezone it lives in (`America/Los_Angeles` — that name stays "Pacific time" even when the offset flips). An offset like "minus eight hours" is not a timezone.
- the repeating pattern ("every Tuesday")

Local time stays Tuesday 9:00. The global clock is allowed to move.

---

## The one number

I wouldn't invent cluster sizes. I'd name the bottleneck.

Roughly: hundreds of millions of monthly actives, ~10 calendar opens a day, a couple of edits. Reads land around tens of thousands of queries per second; writes are smaller. A month view is 50–200 *expanded* instances, not 50–200 series rows.

The hard part is not disk. It's **range queries over recurrence** and **fan-out when the organizer edits**.

Those two are the scale pass. I do not add a load balancer, extra API machines, a split database, a queue, or a cache because a template said to. I add a box when it attacks one of those bottlenecks — or the fact that one Postgres cannot hold hundreds of millions of people.

---

## The API that is the product

HTTP is fine. Almost every endpoint is create / read / update / delete. The one I would actually defend is the range query:

```
GET  /calendars
GET  /calendars/{id}/events?timeMin=&timeMax=&expand=true
POST /calendars/{id}/events
PATCH /events/{id}?scope=this|thisAndFollowing|all
POST /events/{id}/rsvp          {status: yes|no|maybe}
POST /freeBusy                  {calendarIds, timeMin, timeMax}
POST /events:findTime           {attendees, duration, window}
```

A calendar is not `SELECT * FROM events`. Most rows are rules. The client needs instances that **overlap a window**. So this endpoint is a windowed expand, not a table dump.

Why each piece is there:

- **`calendar_id` in the path** — tenancy and shard key. I know which machine and which share list. "All events for these 50 users" is `freeBusy`, not this call.
- **`timeMin` / `timeMax`** — required. Without a window I'd expand forever. I'd cap the window (a month view is ~31 days). Inclusive `timeMin`, exclusive `timeMax` is a fine convention.
- **`expand=true`** — return concrete instances for the grid. `expand=false` is for sync/export: raw series + exceptions (Google's `singleEvents=true` is the same idea).
- **Overlap, not "starts inside"** — a meeting from Jan 31 11pm to Feb 1 1am belongs in both month views. The filter is `start < timeMax AND end > timeMin`.

What I would refuse: an unbounded `GET /events`, letting every phone expand the repeating rule (two phones, two daylight-saving bugs), or inserting ten years of Tuesday rows so a date-range query looks easy. "This and following" then becomes a 500-row rewrite.

Identity in the response matters as much as the times:

```json
{
  "events": [
    {
      "id": "series_abc_20260310T090000",
      "seriesId": "abc",
      "originalStart": "2026-03-10T09:00:00-07:00",
      "start": "2026-03-10T09:00:00-07:00",
      "end": "2026-03-10T10:00:00-07:00",
      "title": "Standup",
      "isException": false
    }
  ]
}
```

`originalStart` is "that Tuesday." If I drag 9am → 11am, `start` changes and `originalStart` does not. That's how the next edit still knows which occurrence I meant.

---

## The data model: a generator, not a pile of Tuesdays

```
Calendar
  id, owner_user_id, tz, name

CalendarAcl
  calendar_id, principal_id, role  -- owner | writer | reader | freebusy

EventSeries                    -- the rule
  id, calendar_id
  title, description
  first_start, duration        -- first occurrence + how long
  timezone                     -- "America/Los_Angeles"
  repeat_rule                  -- weekly on Tuesday
  until / count
  organizer_user_id

EventException                 -- one cancelled or moved occurrence
  series_id
  original_start               -- which Tuesday
  type                         -- cancelled | modified
  patched_fields...

EventSingle                    -- non-recurring
  id, calendar_id, start, end, timezone, ...

Attendee
  event_id, user_id, status, comment

Reminder
  event_id OR series_id, user_id, offset_min, method
```

The **share list** is who can do what on this calendar. I put it on the calendar, not on every event.

| Role | What they can do | What they see |
|---|---|---|
| owner | delete the calendar, change sharing | everything |
| writer | create / edit events | everything |
| reader | read only | titles and details |
| freebusy | read only | busy 2–3pm, no title |

The invariant I keep repeating: a series is a **generator**. A range query expands the repeating rule into the window, then applies exceptions. I persist the rule + exceptions, not the infinite instance list.

Timezone means `America/Los_Angeles`, not "minus eight hours." The repeating rule is the pattern. First start is the first occurrence. `original_start` is "that Tuesday," even if you dragged it to 11am.

---

## A picture of the system

I start with something I could draw in a few minutes: the *core* — API, expander, one Postgres, one transaction. Writes stay on the home shard. Anything that crosses users is async or scatter-gather. No distributed transaction.

[![High-level design of a Google Calendar–like system: clients, API, expander, sharded Postgres, and async fan-out](/images/calendar-design.png?v=3000)](/images/calendar-design.png?v=3000)

Then the scale pass, given the number above. More than one API machine, so a load balancer. More than one Postgres, so a shard map and a connection waiting room. A queue so Alice's save does not wait for 200 copies. A cache only if the same March is opened all day. Search and busy-bits sit off the month-view path on purpose.

I would start on **Postgres**. Something like Cassandra — a database built for huge keyed writes, weaker transactions — is a later conversation, if someone is actually pushing scale. I want one transaction for "delete this series and its exceptions." That is the rationale. Scale by splitting calendars, not by switching storage brands in minute two.

---

## A tour of every box

This is the part I wish someone had written for me. Same order as the sketch. I'll say when a box is the scale pass and when it is just the product.

### Clients

Web, iOS, Android. They don't store the real calendar. They paint what the server returns.

That's why the server returns *instances* (Tuesday 9am this week), not a raw repeating rule. If each phone expands recurrence, they will disagree after the first daylight-saving boundary.

### HTTPS, CDN, load balancer

This is the first scale pass, and it is boring on purpose.

HTTPS is encrypted HTTP. The API is just `GET` / `POST` / `PATCH`.

Encryption ends at the edge. A CDN caches JS and images, not events — static files are the same for everyone; Alice's March is not. A load balancer takes one public URL and spreads tens of thousands of calendar opens across many API machines. One process cannot take that, and I do not want one process to be the only way in. None of this is the interesting part; it's the front door.

### API gateway, login, permissions

The gateway is the API front door: logged in? too many requests? which `calendar_id`?

**Login** is *who are you?* (this token is Alice).  
**Permissions** is *are you allowed?* (Alice can read Bob's calendar but not edit it). That's the share list, not the login.

### Calendar API (stateless)

The program that implements range query, writes, RSVP, find-a-time. Stateless means any box can handle any request. Alice's March view does not live in one machine's RAM. Events live in Postgres. This is the scale pass for the API layer: cloning a stateless program is cheap; cloning the data is not. I add API boxes when traffic grows.

### Share list, again, on the request path

Before I touch events I load `(caller, calendar_id)`:

```
calendar_id | principal_id | role
------------|--------------|----------
alice-work  | alice        | owner
alice-work  | bob          | reader
alice-work  | manager      | freebusy
```

Manager hits the same range query. Role is `freebusy`. Titles get stripped. That's how find-a-time stays polite.

### Range query, write, RSVP, find-a-time

The range query is "everything that overlaps this window, as instances."

Writes for a series take a `scope`:

| scope | English | What I store |
|---|---|---|
| this | only this Tuesday | one exception row |
| all | every Tuesday | patch the series |
| thisAndFollowing | this Tuesday onward | split into two series |

RSVP is yes / no / maybe on *my* copy. I cannot change the title from Bob's phone. I write status on Bob's shard and notify the organizer.

**freeBusy** returns busy intervals. **findTime** asks: Alice, Bob, Cara need 30 minutes this week — which gaps work? I fetch each busy list, intersect free slots with working hours in each person's timezone, sweep endpoints, return top K.

**Scatter-gather** means Bob's calendar may be on another Postgres. I fire N small freeBusy calls (or read a busy cache), then merge in memory. I do not `JOIN` across machines, and I do not lock three calendars in one distributed commit just to suggest a slot.

### Shards and the home shard

This is the scale pass for storage. Postgres is the system of record. One instance cannot hold every calendar at this scale — CPU, disk, vacuum, connections. The rationale for splitting at all is that number, not fashion.

A **shard** is one slice of the data on its own Postgres. I split by `calendar_id`. All of Alice's work calendar — events, exceptions, share list, her reminders — lives on one machine. That machine is the **home shard** for that calendar.

Create / edit / delete is then one database transaction: all succeed or all fail. I never need a transaction across two buildings just to move my Tuesday.

Alice's calendar → shard A. Bob's → shard B. A meeting Alice organizes is *born* on A. A copy is later written to B.

Sharding by `event_id` would make "show March" hit every machine — the range-query bottleneck, made worse. Starting unsharded is fine. I'd shard when disk or vacuum start to hurt.

I'd also index `(calendar_id, first_start)` on that shard. That is the cheap scale pass for "open March": a range on one machine, not a scan, and not Redis yet.

### Logical shards vs physical machines

A **logical shard** is a bucket — often a Postgres schema like `schema017.event_series`. You might have hundreds of them.

A **physical machine** is the actual box. Five logical shards can sit on one host.

Two levels means I can slide five schemas onto a new box when one host is hot, without changing how `calendar_id` hashes. Notion grew 32 machines to 96 by spreading the same 480 logical shards thinner. 480 has a lot of factors, so 32 → 40 → 48 hosts stays even. A power of two forces you to double.

### The shard map (and region)

`calendar_id → (logical shard, physical host, region)`.

The API has to know which Postgres to talk to. I keep that mapping in the **application**, not as a magic layer inside the database. An EU calendar gets `region = eu` and never leaves EU disks.

If I skip the map I scan every database, or I hand routing to a packaged shard layer. I want control over which rows travel together — event, exceptions, and share list stay together because I put them together.

### Application-level sharding

My code computes something like `hash(calendar_id) % 480` and opens a connection to that host. Packaged sharding hides that. I'd rather see the routing.

### PgBouncer

Scale pass for connections, not for data. PgBouncer is **not a database**. It does not store events. It is a waiting room for connections.

Each Postgres connection costs memory. 100 API servers × 50 connections × 96 shards is a connection storm. Postgres hits `max_connections` and falls over.

```
1000 incoming app connections  →  PgBouncer  →  ~20 real connections per Postgres
```

When a query finishes, the slot goes to the next waiter. When you triple the number of databases, you also have to think about the pooler — Notion had to shard PgBouncer itself so a migration didn't 3× connections to the *old* hosts.

Analogy I use: 200 people, 10 teller windows. PgBouncer is the queue. Postgres is the vault. The expander is the teller doing math on your statement.

### One transaction

A transaction is a bundle of SQL that all commits or all rolls back.

"Delete this event and its exceptions and the outbox row" cannot leave orphans. Postgres transactions do not span two machines (unless I build two-phase commit, which I won't). So anything that must stay consistent lives on the same shard.

### What's actually in those tables

| Table | Plain English |
|---|---|
| Calendar | The container ("Alice / Work") and default timezone |
| EventSingle | One-off: dentist Friday 3pm |
| EventSeries | The rule: every Tuesday 9am in Los Angeles |
| EventException | This Tuesday is cancelled, or it's at 11am instead |
| CalendarAcl | The share list |
| Reminder | Notify me 10 minutes before — on *this user's* copy |

An "every Tuesday" rule is a generator, not a list of dates.

### The expander

This is not a scale box. This is correctness. Postgres cannot answer "which Tuesdays in March 2026, 9am Pacific, skipping the cancelled one, after daylight saving?" The expander turns a rule into meetings in a window. Scale would be caching that output if we open the same March all day — later, under Redis.

**Input:** series rows, exception rows, `timeMin`, `timeMax`.  
**Output:** a flat list the UI can draw.

Four steps:

1. **Load candidates** that could touch the window (first start is before the window ends, and the series hasn't already ended).
2. **Expand in the timezone** — Tuesdays 9:00 in Los Angeles in March, using a timezone database, not `+ 7 days` on the global clock.
3. **Apply exceptions** — drop cancelled Tuesdays; overlay moved ones.
4. **Overlap filter** — keep `start < timeMax AND end > timeMin`.

I run this in the API after SQL returns. Some diagrams hang it next to the shard because the *data* comes from the shard; the *CPU* is in the API.

I don't expand on the phone. I don't pre-write ten years of Tuesdays. Caching the next 18 months is optional if free/busy traffic hurts. The source of truth stays the rule.

Cost is the number of meetings in the window, not the lifetime of the series. A weekly meeting for ten years is still four or five rows in March.

### Outbox

A table in the **same Postgres transaction** as the event write. I insert the meeting and a row `EventUpdated {event_id, version: 1}` together.

If I COMMIT then publish to the queue and the publish fails, Bob never gets the invite. If I publish then crash before COMMIT, Bob has a ghost meeting. The outbox commits with the event. A worker publishes later. Delivering twice is fine if applying twice is the same as applying once.

### A durable queue

This is the scale pass for the *second* bottleneck: fan-out. A log of messages. Alice saving a meeting stays fast. Updating 200 attendee copies is slow and retryable, so it happens after. The rationale is write latency, not "we need a queue."

**Month view does not read the queue.** If a GET for March goes through a queue, I overdesigned the read path. Any boring queue is fine if nobody cares about the brand.

### Fan-out, copies, idempotent upsert

Fan-out is mail merge: one organizer write, many attendee writes.

Google's model is **copies**. Bob gets his own row on his shard. He can add a private reminder and a color. When Alice changes the title, a worker overwrites the *shared* fields on that copy and leaves Bob's reminder alone.

The other model is a **pointer**: Bob only stores "I was invited to event X." One source of truth, worse for offline and privacy. I'd use pointers for a v0 calendar inside a Notion page; copies for a consumer Google Calendar.

The worker writes with `(source_event_id, attendee_calendar_id, version)`. Running twice is the same as running once.

### I would not lock two databases as one

That is the "two-phase commit" trick: try to make two databases commit together. If Bob's shard is down, Alice couldn't create a meeting. Slow, easy to deadlock.

Instead: COMMIT on the home shard. The meeting exists. Fan-out eventually updates copies. Retry if B is down. Alice's calendar is already correct.

Cross-shard is async. No distributed commit.

### Catching every database write

Postgres keeps a diary of every change. A capture tool can tail that diary into the queue so search, busy-bitmaps, and a data lake see *all* writes — including ones a script made — not only the ones the API remembered to publish.

The outbox is enough for invite fan-out. Tailing the diary is how I'd keep search honest.

### Busy-bitmap

This is the scale pass for find-a-time when the attendee list is large. A projection, not the source of truth. For each person, something like 14 days × 15-minute slots: 0 free, 1 busy.

Find-a-time for 20 people shouldn't expand 20 repeating rules on every keystroke. A few seconds of staleness might suggest a slot that just got booked. **Booking** still writes the real event with a version check. For 20 people, asking each calendar is fine. I'd name the bitmap at 200.

### Data lake and search

Cheap storage off the primary: analytics, "search my events." Not how I load March. I wouldn't draw a data-processing cluster unless the conversation is actually about analytics.

### Pub/Sub and WebSockets

After a write I publish `calendar abc changed`. A WebSocket is a long-lived connection so the open tab hears it without a refresh.

I send an invalidate, not a stream of tiny typing operations. Live co-editing is for two people in one paragraph. The wrong tool here.

Polling every 30 seconds also works.

### Reminder sweeper

A small cron **per shard**: what fires in the next five minutes? For a series I expand the *next* occurrence, send one notification, then compute the following one.

One delayed job per event does not scale. I accept duplicate pushes; I key them on `(reminder_id, fire_at)`. Bob's "10 minutes before" lives on Bob's copy.

### Stale edits

Update this event only if `version` is still 4. If someone already wrote 5, fail. HTTP 409 means your view is stale — reload. Two tabs, or a find-a-time slot that got taken.

### Source of truth vs projection

| | Meaning | Example |
|---|---|---|
| Source of truth | If a cache disagrees, the cache is wrong | Home-shard Postgres (series + exceptions) |
| Projection | Derived, rebuildable | Busy-bitmap, search, an attendee copy's *shared* fields |

The organizer shard owns title and time. Bob's copy owns Bob's color.

### Hot tenants

Still the scale pass. One giant calendar — US Holidays, company PTO — can starve everyone else on that machine. Hashing random ids spreads *keys*. It does not spread *load*. That's the rationale for isolating it instead of hoping the hash is fair.

I'd isolate that logical shard on its own box, let subscribers store a **pointer + share list** instead of ten million copies, and send month views to a read replica (read-only Postgres, slightly behind). Writes stay on the primary.

### Moving to shards without a night of downtime

If I ever had to leave a monolith:

1. Create logical shards first. Route in the app.
2. Backfill old rows; tail new writes with an audit log or logical replication.
3. **Dark reads** — for a sample of traffic, query old and new, *serve the old*, log mismatches.
4. Per shard: pause the pooler, wait until the replica is caught up, flip the map, **reverse-replicate** so I can roll back.
5. Users might see a second of "Saving…", not five minutes of an outage.

---

## Three paths through the system

**Alice opens March**

1. Phone → load balancer → gateway checks the login token.  
2. Share list: she's the owner.  
3. Shard map: `alice-work` → shard A.  
4. PgBouncer hands a reused connection to A.  
5. Postgres returns series and exceptions that might overlap March.  
6. The expander turns "every Tuesday 9am PT" into five March Tuesdays and drops the cancelled one.  
7. JSON goes back. The grid paints.  
8. The queue was never touched.

**Alice invites Bob**

1. Same write path, but the COMMIT on A includes the event *and* an outbox row.  
2. Pub/sub tells Alice's open tab to refetch.  
3. A worker reads the outbox and upserts a copy on Bob's shard.  
4. Bob's tab hears "calendar changed."

If Bob's shard is down, the meeting still exists on A. The worker retries.

**Find a time, then book**

```
findTime → resolve each calendar → parallel freeBusy (or busy-bitmap)
        → merge gaps ∩ working hours → top K

book    → versioned write on organizer home shard
        → outbox fan-out
        → conflict if the version moved, then findTime again
```

---

## The hard parts

### Recurrence edits

| User choice | What I do |
|---|---|
| This event | One exception. Series unchanged. |
| All events | Patch the series. Keep exceptions unless they conflict. |
| This and following | **Split.** Set `UNTIL` on the old series just before the split. Create a new series from that Tuesday. Move later exceptions onto the new id. |

The split is the part I didn't want to hand-wave. All-day stays a date in the event timezone, not a UTC midnight.

### Copies vs pointers

I already picked copies for a Google-like product and pointers for a page-embedded calendar. Organizer is source of truth for shared fields. Last write wins with a version. Not live co-editing.

### Find-a-time

Same expand as the month view, clip to the window, merge overlaps. Cache a day's free/busy for a short time and delete it on write.

Company-wide room finding is a different product. Recurrence in find-a-time still expands only the search window.

---

## Where I'd use Redis (and where I wouldn't)

This is the rest of the scale pass for reads. The expander is correct; it is also CPU. If the same week is opened ten times a day, I should not re-expand "every Tuesday" from scratch every time. Redis is that shortcut. Never the calendar.

If Redis restarts, March still has to be right. That's how I know events don't belong there.

| I'd put in Redis | Shape | If Redis dies |
|---|---|---|
| Free/busy for a day | `fb:{calendar_id}:{date}` | Expand from Postgres |
| Busy bitmap for find-a-time | bits for ~14 days × 15 minutes | Rebuild from the change diary, or scatter freeBusy |
| Optional expanded month | `month:{calendar_id}:{yyyy-mm}` | Run the expander |
| Pub/sub for "calendar changed" | channel `cal:{id}` | Clients poll |
| Gateway rate limits | `rl:{user_id}` | Fail open or limit locally |

After COMMIT I delete that calendar's cached month and free/busy (and publish). A one- or two-minute expiry is a backstop.

I would **not** store repeating rules in Redis, lock a booking with a Redis lock (that's what `version` in Postgres is for), use a Redis list as an outbox, or make Redis the reminder system of record.

How I'd say it: *Redis holds answers I've already computed. Postgres holds the rules that make those answers true.*

```
Calendar API
    |  miss
    +-- month / freeBusy --> Redis --hit--> client
    |                         miss
    +-- expander <-- Postgres
    +-- after COMMIT: DEL cache keys, PUBLISH cal:{id}
```

---

## Sharding, if I think like a datastore team

The partition key I'd defend is **`calendar_id`**. It's the workspace-id move: month view, share list, and almost every write stay on one host. Invites and find-a-time become the cross-shard problems — which is the interesting part.

`user_id` is nicer for "all my calendars" and per-user copies, and then every shared calendar fans out. `event_id` kills range queries.

On the home shard, in one transaction:

```
Calendar, EventSeries, EventException, CalendarAcl, local Reminders
```

Attendee copies live on the attendee's shard. Organizer write → outbox → workers.

A holiday calendar with ten million subscribers is the noisy neighbor. Isolate it, pointer plus share list instead of copies, read replicas for the grid, cache busy bits so a million opens don't all hit primary.

EU residency is the same map with a region column. Find-a-time across the Atlantic should see busy bits only, or refuse and book per region.

I wouldn't open this design with a key-value store as the system of record, or with live co-editing, or with a queue in front of `GET /events`.

---

## Trade-offs I keep coming back to

The scale pass is just these choices with a number attached. Each line is a decision I already made, and why I would not flip it in minute one.

| Question | Where I am |
|---|---|
| Materialize vs expand | Expand on read for the UI. Materialize a horizon if free/busy traffic hurts. |
| Copy vs pointer | Copies for per-user privacy and sync. Pointers for a simple embedded calendar. |
| SQL vs something else | SQL until a single calendar is truly huge. Shard by `calendar_id`. |
| Realtime | Invalidate the open view. Don't co-edit the event. |
| Idempotency | Client `request_id` on create; fan-out on `source_version`. |
| Calendar vs scheduler | Find-a-time grows with attendees × window. Rooms and constraints are another service. |
| Redis | Derived data only. |

A few questions I like asking myself:

- Infinite weekly event, month view? Expand in the window. Apply exceptions.  
- Move one instance, then edit the series? Exception stays keyed by `original_start`.  
- Delete a series with 200 attendees? Soft-delete, fan-out cancel, sweeper skips.  
- All-day March 1, organizer in SF, viewer in Tokyo? Date-only in the event timezone — not a UTC midnight shift.  
- Two tabs? Version, 409, reload.

A calendar inside a Notion workspace would reuse page sharing and the existing realtime channel. The event becomes a database row. The hard part doesn't change: repeating rule, exceptions, split.

---

## One request, end to end

Alice opens March: login, share list, shard map, pooled connection, expand in Pacific time, draw the grid. No queue.

Alice invites Bob: one transaction on her shard (event + outbox), then a worker writes his copy. If his database is down, she still has a meeting.

That's the system I wanted — a boring primary, an expander that respects wall clocks, and everything else allowed to be a little late.

---

*I leaned on Notion's public writeups on [sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion), [the re-shard](https://www.notion.com/blog/the-great-re-shard), the [data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake), [multi-region](https://www.notion.com/blog/enabling-multi-region-data-systems-at-notion), and the [block data model](https://www.notion.com/blog/data-model-behind-notion).*
