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

---

## 5. How we talk

Setup and history are request/response. The game itself is a long-lived pipe.

| Action | How | Why |
|---|---|---|
| Join / leave queue | HTTP | Simple |
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

The **matcher** is a separate worker. It consumes each **bucket** — time control + rated/casual + roughly a rating band + region — and pairs people. If you wait, the band **widens** (start ±50, then ±100, then ±200). Strict forever means a 2100 waits ten minutes. Instant forever means a 2100 plays a 900. Dynamic is the product.

Keep queues **separate**. Do not dump 3-minute blitz into the same list as daily chess. The hot queue is "blitz 5+0." Split it by region (US / EU / Asia) and by rating buckets so one Redis set is not a million members.

In memory (Redis sets / sorted sets keyed by rating) you can insert and pop fast. When two ids match, **atomically claim** both entries (`waiting → matched`) so two matchers don't pair Alice twice. Then the **game service** creates the `Game`, assigns colors, sets clocks, mints a short-lived join token, and tells both clients the WebSocket URL.

If nobody is in your bucket, you wait. You are not a "failed request." You are pending.

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
8. Broadcast `game.move` to both sockets.

Do not have the client poll. Push.

---

## 8. The clock (do not tick the database)

Writing remaining time every second at 80,000 games is a second 80,000 writes. We do not do that.

We store:

- `white_remaining_ms`, `black_remaining_ms`
- whose clock is running
- `turn_started_server_ms` — server clock when that turn began
- `version`

When a move arrives (or when a timeout worker wakes up):

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

After we accept a move we **schedule a timeout** for "now + that side's remaining." If the timer fires, we look at the game. If they still have not moved, they lose. If they moved, the timer is a no-op.

The phone still animates a ticking clock. Periodically we send `game.clock_sync` with `server_now_ms` so a laggy client can catch up. If Alice disconnects, **the clock still runs**. That is the product: you don't pause rated blitz because a cable wiggled.

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

Easy to draw. Fragile in production: the lock expires while you are still thinking, or you crash holding it, or two servers both think they won the lock after a network split. You also still have to **route the WebSocket** — after the lock, which process broadcasts? Two servers can both believe they are authoritative.

Fine for a prototype. I would not make it the only ordering mechanism at 80,000 live games.

**2. Let the database serialize (compare-and-swap).**  
Any server tries. The update is:

```
UPDATE games
SET move_count = 18, current_fen = $new, version = version + 1
WHERE id = $game AND move_count = 17 AND version = $v
```

If zero rows, someone else already took move 17. Retry or tell the client to sync.

Deterministic. No special routing. At this scale the **database becomes the conveyor for every hot game**, and we are latency-sensitive. Use CAS as a **guardrail** (a second line of defense). Do not make Postgres the thing that orders 10,000 moves/sec by itself.

**3. A queue partitioned by `game_id` (Kafka, etc.).**  
All moves for game 123 land on the same partition. One consumer processes them in order. Durability for in-flight moves is nice.

Extra hop: enqueue, then dequeue, then apply. That hop fights the 150ms budget. Heavy for "two people, one board." I would use a log for **analytics** or **archiving**, not for the tap on e2e4.

**4. One writer process per game (shard / actor) — this is the one I'd take.**  
Hash the `game_id`. Game 123 always goes to **game-service shard 7**. Inside that process, one in-memory actor (or a single-threaded loop) applies moves **sequentially**. The WebSocket gateway uses the **same hash** so both players' sockets talk to the shard that owns the board.

- One game → one order → one writer.
- Postgres stores the append-only moves (durability) and can still CAS as a backstop.
- Broadcast is obvious: the owner already has both connections, or publishes to a channel the gateways subscribe to.
- Scale out: more shards, more games. A game is tiny; 80,000 actors is normal.

Cost: **deterministic routing** (consistent hashing), and a **failover** when shard 7 dies — another shard must take game 123, load Redis/Postgres, and continue. Ownership transfer is the extra complexity. It is worth it.

On that owner, three cheap checks before the engine even runs:

1. **Serialize** — one queue in memory for that `game_id`. No parallel apply.
2. **Dedupe** — same `idempotency_key` → same response, no second apply.
3. **Order** — `move_number` must be next; reject stale or out-of-turn.

That is "serialization" in this interview: **not JSON**, **one timeline per game**.

---

## 10. Phone and laptop at the same time

Serialization per *game* is not enough if **one user** has two writers.

Alice's laptop still has a socket open. She opens her phone. Both can send e2e4. Move numbers and idempotency keys help, but the UI becomes chaos ("why was my move rejected?") and the two clocks on the two screens disagree.

Goal: **at most one writer device per (game_id, user_id).** Other devices may **watch**.

**Allow every device to write**, rely on move numbers. Simplest. Spamy. Unclear who owns the clock UI. Reject.

**Drop the old socket when the new one connects.** Clear ownership. A blip on Wi-Fi then looks like "new device" and you flap: connect, kill, reconnect, kill. Reject as the only mechanism.

**Session lease + fencing token** — this is the one I'd take.

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

If we **broadcast then crash before persist**, clients saw a move the log does not have. Owner should **persist first, then push**. If we crash after persist, before push, reconnect heals it — the move is in the log.

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
