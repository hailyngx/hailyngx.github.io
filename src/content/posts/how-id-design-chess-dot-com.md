---
title: "How I'd design Chess.com"
description: "Matchmaking, a server-side clock, and one writer per game. The hard part is not the bytes — it is latency, legal moves, and never applying e2e4 twice."
pubDate: 2026-08-25
tags:
  - systems
---

A chess site looks like a board and two clocks. The product is: find someone in a few seconds, play in real time, and never argue about whose flag fell.

The board on your phone is a display. The clock on your phone is a display. The server is the boss of both. If we get that wrong, people leave — not because we ran out of RAM, but because the game felt unfair.

This note walks through that system in the order I'd teach it. One game so the words mean something. Then the records, the APIs, matchmaking, a move, the clock. After that the part people wave at: **serialization** — why one game can only have one writer, and what happens when your laptop and your phone both try to move. Then reconnects, and what changes at 80,000 games at once.

Assume standard 1-vs-1. No tournaments, no bots, unless someone asked.

[![Whiteboard for an online chess site: requirements, scale, tables, APIs, and a game shard that serializes, dedupes, and checks each move](/images/chess-design.png)](/images/chess-design.png)

---

## 1. One game, start to finish

Alice wants blitz, 5 minutes plus 3 seconds per move, rated. Bob wants the same.

1. Both **join a queue** with those settings. The matcher looks for similar ratings. If nobody close shows up, it widens the window.
2. The system pairs them, picks colors, sets both clocks to 5:00, opens a live connection. The game starts.
3. Alice plays e2e4. The server checks it is legal, subtracts the think time from her clock, adds 3 seconds, starts Bob's clock, and pushes the move to both phones.
4. They play until checkmate, resign, agree a draw, or a flag falls. Every accepted move is kept. If Alice's Wi-Fi dies, the clock keeps running. When she reconnects, she gets the latest board, not a guess.

If you remember only the sequence: **queue → pair → server validates each move → clock lives on the server → history is append-only.**

---

## 2. What to build

Lock the product or you design three chess sites.

I'd include:

- Join / leave a queue: time control, rated vs casual
- Pair two people and start a game
- Moves that show up on the other side in well under 200ms
- A clock the server owns. Flag fall is a loss
- Resign, offer/accept/decline draw
- Reconnect without losing the position or double-playing a move

I'd leave out unless asked: tournaments, bots, puzzles, chat, spectators at Twitch scale, anti-cheat as a full ML system. Friend challenges are a second path — same game once it starts — so I'll mention them, not design Uber around them.

Four questions hide most of the rest:

**Who owns the clock?**  
The server. The client's timer is a prediction so the UI feels live. We push a sync often enough that the two don't drift. Never subtract time because the phone said so.

**What is a "move"?**  
A legal change of the board, on the side whose turn it is, with a **move number**. `e2e4` sent twice is one move. `e2e4` sent as move 17 after we already have 18 is stale and we drop it.

**Rated or casual?**  
Rated games update ratings when the game ends. Casual do not. Do not mix those queues. A 5+0 blitz player should not sit next to a 10+5 rapid player either.

**What can be slow?**  
Not the move. Not the clock check. Matchmaking under a few seconds is the other budget. History search, "games I played last month," leaderboard pages: those can wait.

Volume of data is easy. 80,000 games, one move every 8 seconds, is about **10,000 writes/sec** and **20,000 pushes/sec** if both players hear every move. That's a few megabytes a second. The hard parts are **latency** and **correctness**.

I'd write numbers on the board:

| Goal | Target | Why |
|---|---|---|
| Match (P95) | under 5 seconds | People leave queues |
| Move (P95) | under 150ms | It has to feel live |
| Clock error | under 100ms | Flags have to be fair |
| Availability | 99.95% | Don't drop the game |
| Durability | no lost accepted move | Trust |

Scale sketch: 2 million players a day, peak ~8% online → 160,000 people, ~80,000 games. If 10% are waiting, 16,000 in queues. Insert and delete in those queues have to be cheap.

---

## 3. How we write a board, and a move

If you don't play chess, two strings do almost all of the talking.

**FEN** is a snapshot of the whole position: where every piece is, whose turn, whether you can still castle, en passant, move counters. One line. The server stores `current_fen` so it does not rebuild the board from move 1 every time someone reconnects.

**UCI** is one move: `e2e4` means the piece on e2 goes to e4. That's what the client sends. The server checks it against the current FEN, then produces the next FEN.

Example: start of the game, Alice plays the king's pawn. UCI `e2e4`. FEN after that starts with `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR` and says it is black to move.

We also keep **SAN** (`e4`) for humans reading a recap. The engine talks UCI. The database talks FEN.

---

## 4. The records

A relational database holds what must survive a crash. A fast memory store holds what the live game needs in milliseconds.

**Player** — id, username, rating per time control (blitz vs rapid are different numbers), created_at.

**QueueEntry** — player, mode (rated/casual), time control (`5+0`, `10+5`), rating at join, region, joined_at, status (waiting, matched, cancelled, expired).

**Game** — white, black, mode, base time in ms, increment in ms, status (active, white_won, black_won, draw, aborted), why it ended (checkmate, resign, timeout, draw, disconnect forfeit), `current_fen`, move_count, whose turn, started_at, ended_at.

**MoveEvent** — game, move_number, player, uci, optional san, fen_after, both clocks after the move, when the server received it, whether it was legal. Append-only. This is the history.

**ClockState** — remaining white/black ms, whose clock is running, **when that turn started on the server**, a version number.

Player 1:N queue rows. Player 1:N games (as white or black). Game 1:N moves. Game 1:1 clock.

The live board also sits in **Redis**: FEN, move number, clocks, version. Postgres is the log and the game row. Redis is so a reconnect does not wait on a disk join. When the game ends, drop it from Redis; keep Postgres.

That is a **relational** store on purpose: foreign keys, unique (game_id, move_number), one transaction for "accept move + new FEN + new clocks." Redis is not the source of truth for last month's games.

Three places the live state can live. I would pick the third.

**Postgres only.** Every move is a disk write, then a read for the opponent.

- Pro: if the process dies, the board is still in the database. There is one place to look.  
  *Why:* a committed row survives a reboot. You do not have a second store to forget to update.
- Pro: unique `(game_id, move_number)` is enforced by the same engine that stores the board.  
  *Why:* two writers racing lose on the unique index, not on a cache that can reboot empty.
- Con: 10,000 moves/sec with a 150ms budget is a lot of fsyncs and row updates on hot games.  
  *Why:* a move is a read-modify-write on one row plus an insert. Disk and WAL are slower than RAM. P99 will miss 150ms when the same game is hot.
- Con: reconnect still waits on that disk path.  
  *Why:* `GET` has to join `Game` + last moves. Fine for history; sluggish for "I refreshed mid-blitz."

**Redis (or process memory) only.** Fast. If the box dies, the game is gone.

- Pro: sub-millisecond get/set. Easy to hit 150ms.  
  *Why:* the working set is small (one FEN, two clocks). No WAL.
- Con: a crash mid-game deletes the position. Rated blitz cannot do that.  
  *Why:* RAM is not durable. Replication helps until both sides of a failover lose the key.
- Con: no durable unique constraint unless you reinvent it.  
  *Why:* Redis can `SETNX`; it is not your audit log for last month.

**Hybrid — Redis for the live game, Postgres for the log. This is the one I'd take.**

- Pro: the tap is fast; history and disputes still have a row.  
  *Why:* apply in RAM, append `MoveEvent` (sync or almost-sync), snapshot in Redis. Reconnect reads Redis. Replay / fairness reads Postgres.
- Pro: when the game ends you delete the Redis key, so 80,000 games do not become 80 million.  
  *Why:* finished games do not need 150ms. Disk is cheaper for cold data.
- Con: two stores can disagree if you push to the socket before the insert commits.  
  *Why:* persist first, then broadcast. If you reverse that, a crash leaves clients ahead of the log.
- Con: you now operate Redis and Postgres.  
  *Why:* more failure modes (Redis full, replica lag). Worth it because neither store alone hits both latency and "no lost move."

---

## 5. How we talk

Setup and history are request/response. The game itself is a long-lived pipe.

**HTTP for every move (the client polls, or POSTs and waits).**

- Pro: every load balancer and phone already speaks HTTP. Easy to debug.  
  *Why:* no upgrade, no sticky sockets, no "half-open TCP."
- Con: the opponent only learns about e2e4 when they ask. That is not 150ms unless they poll every 50ms, which is waste.  
  *Why:* HTTP is request/response. The server cannot speak first.
- Con: 80,000 games × poll is a thundering herd.  
  *Why:* most polls return "nothing new." You paid for 80,000 empty GETs.

**WebSocket (or similar) for the live game. This is the one I'd take.**

- Pro: the server **pushes** the move and the clock. Both phones hear it without asking.  
  *Why:* one long-lived connection, frames in both directions. That is how you hit 150ms.
- Pro: reconnect is "open the socket again, send me the snapshot."  
  *Why:* the gateway already knows the `game_id`.
- Con: you must hold connections (memory, load-balancer timeouts, mobile radios).  
  *Why:* a million idle sockets is a real bill. Gateways exist so game logic is not sitting on those sockets.
- Con: NAT and phone OS will kill idle connections. You need heartbeats.  
  *Why:* the pipe is not free forever. Heartbeat ≠ ticking the chess clock.

REST stays for queue, history, and "load this finished game." The socket is only the data plane.

| Action | How | Why |
|---|---|---|
| Join / leave queue | HTTP | One shot, not a stream |
| Load a finished game | HTTP | Not live |
| Moves, clock, "you lost on time" | WebSocket | Server must push |
| Game service ↔ matcher | gRPC or HTTP inside the cluster | Typed, not the public internet |

The WebSocket starts as HTTP. The client asks to **upgrade**. If the server agrees, you get **101 Switching Protocols** and the same TCP connection starts carrying WebSocket frames. REST is the control plane (queue, fetch history). The socket is the data plane (this move, this clock).

HTTP we actually need:

```
POST   /api/chess/queue
DELETE /api/chess/queue/{entry_id}
GET    /api/chess/queue/status

GET    /api/chess/games/{game_id}
POST   /api/chess/games/{game_id}/move
POST   /api/chess/games/{game_id}/resign
POST   /api/chess/games/{game_id}/draw
POST   /api/chess/games/{game_id}/abort
GET    /api/chess/games/{game_id}/moves
```

A move body:

```json
{
  "move_number": 17,
  "uci": "e2e4",
  "client_sent_at_ms": 1730000000000,
  "idempotency_key": "4f8d7a3f"
}
```

`client_sent_at_ms` is a hint for debugging. We do **not** bill the clock from it. `move_number` is the turn index. `idempotency_key` is "this tap on the glass." Same key twice → return the first result, do not apply e2e4 again.

Success comes back with the new FEN, whose turn, both clocks, whether the game is still active.

On the socket (`WSS /ws/chess?token=…`):

```
game.matched     you are white, opponent rating 1830
game.move        move 17, e2e4, black to play, clocks
game.clock_sync  white 178450ms, black 180000ms, server_now
game.ended       white_won, timeout
```

Friend challenge (optional path): `POST` a match at a specific user, they `accept` or `decline`. No queue. Same game service after that. Check a **friendship** row before you create the pending match.

---

## 6. Finding a game

Two services, not one blob.

The **HTTP handler** takes "put me in 5+0 rated." It writes a `QueueEntry` and returns. It does not scan 16,000 waiters inside that request.

The **matcher** is a separate worker. It consumes each **bucket** — time control + rated/casual + roughly a rating band + region — and pairs people.

How wide is "similar rating"? Three policies:

**Always strict (only ±50).**

- Pro: games feel fair. A 2100 rarely sits across from a 1600.  
  *Why:* the matcher refuses pairs outside the band, so skill gap stays small.
- Con: at off-peak, a 2100 waits minutes or never matches.  
  *Why:* there are few people in a tight band. The 5-second P95 dies.
- Con: the hottest band (everyone is ~1500 blitz) is still huge; the tails starve.  
  *Why:* strictness does not split the hot key. It only rejects pairs.

**Always loose (anyone in 5+0 rated).**

- Pro: you almost always start a game in seconds.  
  *Why:* the pool is the whole mode, not a 50-point window.
- Con: a 2100 plays a 900. People rage-quit and tank ratings.  
  *Why:* "matched" optimized wait, not quality. Rated especially cannot eat that.
- Con: you still have a giant set to scan if you did not bucket.  
  *Why:* loose is a policy, not a data structure. One list of 16,000 is O(n) to search.

**Start strict, widen with wait (±50, then ±100, then ±200). This is the one I'd take.**

- Pro: first seconds prefer a good game; if the queue is thin, you still play.  
  *Why:* the band is a function of `now - joined_at`. Early pairs are fair; late pairs are "good enough."
- Pro: you can show the client "expanding search…" so the wait is honest.  
  *Why:* the policy is visible. People tolerate a slightly worse opponent more than a silent queue.
- Con: two people who waited a long time can still be a mismatch.  
  *Why:* the cap (±200) is a product knob. Set it, say it, don't pretend it is perfect.
- Con: you must **not** mix time controls or rated/casual in the same bucket, or widening is meaningless.  
  *Why:* a 5+0 vs 10+5 pair is not "a bit worse rated." It is a different game.

Keep queues **separate**. The hot queue is "blitz 5+0." Split it by region and rating buckets so one Redis set is not a million members.

- Pro of split-by-region: US-East plays US-East, clocks and RTT stay in budget.  
  *Why:* a move that crosses an ocean already burned the 150ms.
- Con: a thin region waits longer.  
  *Why:* fewer bodies in the bucket. Widen rating first, region second — or show "searching nearby, then worldwide."

HTTP handler vs matcher as **two services**:

- Pro: `POST /queue` returns in milliseconds. Pairing can loop for seconds.  
  *Why:* you do not hold an HTTP request open while you scan 16,000 waiters.
- Con: the waiter is pending until the matcher writes `matched` and you poll or get a push.  
  *Why:* that is the product ("searching…"), not a bug — as long as P95 stay under 5s.

When two ids match, **atomically claim** both (`waiting → matched`) so two matchers don't pair Alice twice. Then the game service creates the `Game`.

---

## 7. A move, on the wire

Alice's phone already has a socket to a **WebSocket gateway**. The gateway holds connections. The **game service** owns the rules.

1. Alice sends move 17, `e2e4`, key `4f8d7a3f`.
2. Route that game to **one owner** (next section). If this is a duplicate key, return the stored reply.
3. If `move_number` is not the next one, or it is not Alice's turn, reject.
4. A **rule engine** (a chess library on the server) loads current FEN, asks "is e2e4 legal?" If no, reject. The client can show a pretty board; we do not trust it.
5. Apply the move. New FEN. Checkmate / stalemate / draw by rule.
6. Update the clock (next section).
7. **Append** `MoveEvent`. Update Redis snapshot. Optionally update `Game.current_fen` every N moves, not every ply — the log is the truth; the row is a cache for reconnects. On crash you load the last snapshot and **replay the tail** (a handful of moves), not 80 moves from the start.

**Snapshot every move** vs **log + snapshot every N:**

- Every-move snapshot: reconnect is one row. Con: extra UPDATE per ply, write amplification at 10k/sec.  
  *Why:* FEN is derived from the log. Storing it 80 times in a game is cache, not new facts.
- Every-N or every-T seconds: less WAL. Con: failover replays up to N moves. Keep N small (10).  
  *Why:* 10 legal applies are milliseconds in the engine. 80 from move 1 is wasted CPU on reconnect.

8. Broadcast `game.move` to both sockets.

Do not have the client poll. Push.

---

## 8. The clock (do not tick the database)

**Write remaining time every second (a tick).**

- Pro: the row always equals what the UI shows. Easy to explain.  
  *Why:* you materialize `white_remaining_ms` 1, 2, 3, …
- Con: 80,000 games × 1 write/sec = 80,000 extra writes, for a number you can compute.  
  *Why:* elapsed time is `now - turn_started`. Storing it every second is a loop, not information.
- Con: two ticks and a move can race and jump the flag.  
  *Why:* the tick worker and the move worker both update the same row without a single writer.

**Compute elapsed only on events (a move, a timeout alarm, a sync). This is the one I'd take.**

- Pro: work is proportional to moves (~10k/sec), not to wall-clock seconds.  
  *Why:* a 5-minute think is one subtraction when they finally move, not 300 updates.
- Pro: the server number is exact at the moment of the event, which is when fairness matters.  
  *Why:* flag fall is decided when we apply the move or when the alarm fires, using `now_server`.
- Con: between events the database does not show a ticking integer.  
  *Why:* you don't need it. The client animates; we send `clock_sync` so it does not drift.
- Con: you must still **schedule an alarm** for "now + remaining," or a disconnected player never flags.  
  *Why:* if nobody moves, no event arrives. The alarm is the event.

We store remaining ms, whose clock is running, `turn_started_server_ms`, and a version. Formula:

```
elapsed = now_server - turn_started_server
time_left = old_time_left - elapsed
if time_left <= 0 → that side lost on time
else time_left += increment   // the "+3" in 5+3
switch side
turn_started_server = now_server
version += 1
```

Worked example. 5+3. Alice has 180,000ms. Her turn started at server time 1000. She moves at 4000. Elapsed 3,000ms. She has 177,000ms, plus 3,000 increment → 180,000ms again. Bob's clock starts at 4000.

The phone still animates a ticking clock. If Alice disconnects, **the clock still runs**. That is the product: you don't pause rated blitz because a cable wiggled.

**Pause the clock on disconnect** is a different product (casual, or correspondence).

- Pro: fair if the cable really died.  
  *Why:* they did not choose to stop thinking.
- Con: you can disconnect on purpose with 2 seconds left.  
  *Why:* the pause becomes a cheat. Rated blitz should not offer it. I would not.

---

## 9. Serialization, from the ground up

This is the word that sounds like "turn a struct into JSON." That is not what we mean here.

**Serialize a game** means: for one `game_id`, apply events **one at a time, in a single order**, so there is only one timeline.

### Why chess still needs this

Chess is turn-based. Alice moves, then Bob. You would think the rules already serialize.

The **network** does not know whose turn it is.

Picture Alice on move 17. She taps e2e4. The Wi-Fi hiccups. The UI does not get an ack in 200ms, so the phone **sends e2e4 again**. Two packets. If we apply both, the board tries to play e2e4 on move 18, which is nonsense — or worse, we append two rows and the clocks jump twice.

Same game, Bob's client is lagging. He had pre-moved a reply. His packet arrives **before** Alice's ack is processed on a second game server. Now two machines both think they are "the" game.

Or Alice has the site open on **phone and laptop**. Both send e2e4.

None of that is "she cheated." It is retries, two sockets, two processes. Without a single serialization point you get **two truths**: server A has Alice's move, server B has already started Bob's clock.

"Just lock it" is a one-liner that interviewers ding if you cannot say *what* is locked and *who* holds the write.

### What "one writer" buys you

Imagine a grocery store. One conveyor per game. Items (moves, resign, flag) go through **in order**. Two cashiers on the same belt will scan the milk twice.

So: **one conveyor per `game_id`.** Many games → many conveyors → many machines. Games do not share a belt.

### Four ways to get that conveyor

**1. A distributed lock (Redis `SETNX` per game).**  
Any game server can handle a move, but it must grab `lock:game:123` first, apply, release.

- Pro: any replica can serve any game. The load balancer stays dumb.  
  *Why:* ownership is the lock, not the routing table. Easy to draw in two minutes.
- Pro: you serialize applies while the lock is held.  
  *Why:* the second process blocks or fails `SETNX` instead of forking the FEN.
- Con: the lock has a TTL. If apply is slower than TTL, two holders exist.  
  *Why:* network blips and GC pauses are real. A 3s lock and a 4s engine call = two writers.
- Con: crash-while-holding, or a split brain after a partition, leaves a stuck or double lock.  
  *Why:* distributed locks are lease + hope unless you add fencing (and then you built option 4 with extra steps).
- Con: the lock does not tell you **which process should broadcast** on the WebSocket.  
  *Why:* two servers can both think they won, apply in order, then both push. Clients see duplicates or flaps.

Fine for a prototype. I would not make it the only ordering mechanism at 80,000 live games.

**2. Let the database serialize (compare-and-swap).**  
Any server tries:

```
UPDATE games
SET move_count = 18, current_fen = $new, version = version + 1
WHERE id = $game AND move_count = 17 AND version = $v
```

Zero rows means someone else already took move 17.

- Pro: the order is whatever Postgres committed. No special routing.  
  *Why:* isolation + `WHERE version = $v` is a single source of "who won the write."
- Pro: unique `(game_id, move_number)` is a second backstop.  
  *Why:* even if CAS is forgotten, the insert of `MoveEvent` 17 twice fails.
- Con: every live move is a round trip to disk on the hot row.  
  *Why:* 10,000/sec of compare-and-swap on contended keys is a serialization engine made of WAL. P99 misses 150ms.
- Con: you still fan out the WebSocket from whoever won the CAS — possibly a different box than the opponent's socket.  
  *Why:* CAS orders writes, not connections. You still need pub/sub or sticky routing.

Use CAS as a **guardrail**. Do not make Postgres the only conveyor.

**3. A queue partitioned by `game_id` (Kafka, etc.).**  
All moves for game 123 land on one partition. One consumer applies them in order.

- Pro: the log is durable before you apply. A crash replays the partition.  
  *Why:* that's what the log is for. In-flight e2e4 is not only in RAM.
- Pro: bursts get absorbed.  
  *Why:* the producer returns once the broker has the message; the consumer can catch up.
- Con: enqueue + dequeue + apply is extra hops.  
  *Why:* each hop is a network + storage wait. The 150ms budget is for the player, not the bus.
- Con: you built a streaming platform for two people and a board.  
  *Why:* operational cost (brokers, consumer groups) is for high fan-out or async work. The move path is neither.

I would use a log for **analytics** or **archiving**, not for the tap on e2e4.

**4. One writer process per game (shard / actor) — this is the one I'd take.**  
Hash the `game_id`. Game 123 always goes to **game-service shard 7**. Inside that process, one in-memory loop applies moves **sequentially**. The WebSocket gateway uses the **same hash**.

- Pro: one game → one order → one writer, in RAM, no lock TTL.  
  *Why:* a single thread cannot interleave two applies. That is the conveyor.
- Pro: broadcast is local (or one pub to gateways that already hash the same way).  
  *Why:* the owner is the process that just applied. No "who won the lock" argument.
- Pro: more shards, more games. A game is tiny.  
  *Why:* 80,000 actors is 80,000 small state machines, not 80,000 disk rows in a hot loop.
- Con: you need **deterministic routing** (consistent hashing) on every gateway.  
  *Why:* if two gateways hash differently, you have two writers again.
- Con: when shard 7 dies, someone must **take over** game 123, load Redis/Postgres, and continue.  
  *Why:* ownership lived in the process. Failover is the complexity you accepted. Load snapshot + replay tail; do not start a second writer before the first is fenced.

On that owner, three cheap checks before the engine even runs:

1. **Serialize** — one queue in memory for that `game_id`. No parallel apply.
2. **Dedupe** — same `idempotency_key` → same response, no second apply.
3. **Order** — `move_number` must be next; reject stale or out-of-turn.

That is "serialization" here: **not JSON**, **one timeline per game**.

---

## 10. Phone and laptop at the same time

Serialization per *game* is not enough if **one user** has two writers.

Alice's laptop still has a socket open. She opens her phone. Both can send e2e4. Move numbers and idempotency keys help, but the UI becomes chaos ("why was my move rejected?") and the two clocks on the two screens disagree.

Goal: **at most one writer device per (game_id, user_id).** Other devices may **watch**.

**Allow every device to write; rely on move numbers and idempotency keys.**

- Pro: no session model. Phone and laptop both send e2e4; the server keeps one.  
  *Why:* `move_number` 17 twice is one apply. You already built that for retries.
- Con: both UIs think they are in charge. Rejections look like bugs.  
  *Why:* the laptop sent a legal 17 a millisecond after the phone won. The user sees "invalid move" on one screen.
- Con: two clocks on two screens drift and people claim unfairness.  
  *Why:* both clients animate from different last-sync times. Nobody is the display owner.
- Con: resign / draw / takeback from two devices is a mess even if e2e4 dedupes.  
  *Why:* those are not sequenced like move 17. Two resigns, two draw offers.

**Drop the old socket when a new one connects.**

- Pro: exactly one TCP writer. Mental model is "last login wins."  
  *Why:* you close the laptop socket, so it cannot send.
- Con: a Wi-Fi blip looks like a new device. You flap: connect, kill, reconnect, kill.  
  *Why:* the OS reopened a socket. You treated it as takeover.
- Con: a malicious or accidental second tab kicks the real player.  
  *Why:* there is no epoch. Whoever connects second wins, even for 200ms.
- Con: packets already in flight from the old socket can still arrive after the kill.  
  *Why:* TCP does not vanish instantly. You still need move numbers — so this is not a complete solution.

**Session lease + fencing token (epoch). This is the one I'd take.**

- Pro: one writer by contract; everyone else is read-only and still sees the game.  
  *Why:* the laptop can watch. The phone moves. UX matches "I switched devices," not "I got kicked."
- Pro: a late packet from the old device cannot win after handover.  
  *Why:* it carries `epoch=3`. The server now has 4. That number is the fence — like a new hotel keycard, old key dead.
- Pro: retries from the **current** owner still work (same key, same epoch).  
  *Why:* you did not throw away idempotency. You added who is allowed to use it.
- Con: heartbeats, TTL, takeover logic. More state.  
  *Why:* leases expire. You must decide what happens when the phone dies in a tunnel. That is real product work; it is cheaper than unfair clocks.
- Con: a bug that forgets to check epoch is a silent hole.  
  *Why:* every write path (move, resign, draw) must read the lease. Miss one and you are back to two writers.

For each (game, user) we store a **lease**:

- who owns it (connection id / device id)
- **epoch** (a number that only goes up)
- expiry (heartbeat / TTL)

Only the owner may resign, move, accept a draw. Everyone else on that account is read-only: they get `game.move` and `clock_sync`, they cannot write.

When the phone takes over, the server **increments the epoch** (3 → 4) and grants the phone the lease. The laptop is demoted. Any in-flight move from the laptop still says `epoch=3`. The server rejects it. That number is the **fencing token**: a late packet cannot sneak in after a handover.

Think of a hotel keycard. New guest gets a new key. Old key stops the door even if it arrives in the mail tomorrow.

Heartbeats keep the lease alive. If the phone dies, TTL expires, laptop can request takeover. Deterministic resume: same FEN, same move number, same clocks, no double accept.

---

## 11. Disconnects and crashes

Redis: live FEN, move number, clocks, version, lease.

Postgres: every `MoveEvent`, the `Game` row.

Reconnect: `GET /games/{id}` (or a socket `sync`). We send the Redis snapshot. If Redis is empty (shard crashed), load last Postgres snapshot and replay tail moves from `MoveEvent`.

The clock did not pause.

**Broadcast first, then persist.**

- Pro: the opponent's UI updates as soon as RAM applied the move.  
  *Why:* you skip waiting for Redis/Postgres before the push.
- Con: a crash after the push, before the insert, leaves phones ahead of the log.  
  *Why:* they saw e2e4. Reconnect loads the old FEN. Now you have two truths, and rated clocks already moved on the client.
- Con: "fix it on reconnect" means walking the move back on a live board.  
  *Why:* the other person may have already pre-moved. You cannot un-see a ply in blitz.

**Persist first (Redis snapshot + `MoveEvent`), then push. This is the one I'd take.**

- Pro: anything a client saw is in the log, or they never saw it.  
  *Why:* if we die after persist, before push, reconnect sends the snapshot. The move is not lost; it is just late by one round trip.
- Con: the opponent waits on that write.  
  *Why:* that is milliseconds in Redis, or a short append in Postgres. Still inside 150ms. A forked board is not.

Version on `ClockState` / Redis: two applies at once, second CAS fails, client refreshes. Belt and suspenders next to the single writer.

---

## 12. When this gets bigger

**Sticky or hashed routing** so game 123 does not hop machines every move.

**Hot queue:** split blitz 5+0 by region and rating band.

**Redis memory:** only **active** games. End of game → Postgres is enough, delete the key.

**Leaderboard** (if they ask): do not scan Postgres for top 10 on every page load. Keep a Redis sorted set (ZSET) per board (global is huge; prefer region or season). On game end, update the player's rating in Postgres and `ZINCRBY` the set. Reads are `ZREVRANGE` / `ZREVRANK`. Win / draw / loss increments are a product choice; I would not invent Elo in the first five minutes, but I would say ratings are **not** updated inside the move loop.

**Spectators, multi-region, cheating:** later. Cheating is "compare moves to an engine after the fact," not a check on the hot path. Multi-region: play in the region of the match; clocks and writers hate cross-ocean round trips.

---

## Recap

Match in separate queues, widen the rating window. HTTP puts you in line; a **matcher service** pairs you. The game service is the only one that says a move is legal. The clock is subtraction on the server, plus a timeout alarm — not a row written every second. Live state in Redis, history in Postgres. WebSockets to push.

The sentence that is the design: **one writer per game** (hash the id, apply in order, idempotency key + move number), and **one writer device per player** (lease + epoch) so a second phone cannot fork the timeline.

If a box does not help match speed, move latency, or that single timeline, it does not belong on the board.
