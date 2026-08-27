---
title: "How I'd design Sora"
description: "Sora is a task queue on a GPU pool that can vanish. Leases, fencing tokens, checkpoints, and what you do when the box dies at minute nine."
pubDate: 2026-08-25
tags:
  - systems
---

Sora looks like a prompt and an MP4. The product is: take the job, put it on a GPU, survive the GPU disappearing, and never run the same video twice.

Generation takes minutes. The public request cannot sit open until the file exists. The pool is not a web fleet — one worker, one video, and the machine may be a spot instance that dies with a two-minute warning or with none. Prompt safety, billing, and moderation sit upstream. This note is the scheduler, the worker, and every way that pair fails.

This is the order I'd teach it. One job so the words mean something. Then the records — a job is not an attempt — the API, and why we persist before we say accepted. After that: which queue, pull vs push, the lease and the fencing token, checkpoints, cancel, and what we do when there are no GPUs left. Last, the failure cases one by one. That last section is the design.

[![Whiteboard for a Sora-like scheduler: requirements, job vs attempt, and a pull-based GPU pool with Postgres as the source of truth](/images/sora-architecture.png)](/images/sora-architecture.png)

---

## 1. One video, start to finish

Alice wants ten seconds, 720p, model `sora-v1`. "Drone shot over a snowy mountain at sunrise."

1. She submits. We write a generation job (queued) in Postgres, in the same transaction as an outbox row. We return **accepted** with a job id and an ETA. We do not wait for a GPU.
2. A worker that is idle and already has that model in VRAM **pulls**. We claim the job in Postgres, create an attempt with a **fencing token** and a 30-second lease, mark the worker busy. At most one active video on that box.
3. The worker loads the prompt blob, generates, and every ~5 seconds writes progress. Every ~10 seconds it heartbeats and extends the lease. Every ~30 seconds it uploads a **checkpoint** to object storage and stores the ref on the attempt.
4. It uploads the MP4, completes with the same fencing token. The job becomes completed. Alice gets a signed URL. We delete old checkpoints.

If the box dies at minute two, the lease expires. A new worker takes **attempt 2**, loads the latest checkpoint, continues. Alice still has one job id. Seeing attempt 2 is how she can tell we recovered.

If you remember only the sequence: **durable job → worker pulls → fenced attempt → checkpoint often → complete once.**

---

## 2. What to build

Lock the product or you design a model-serving paper.

I'd include:

- Submit prompt + model version + duration + output settings; get a job id in well under 500ms
- Poll (or a live stream / webhook) for status, progress, and a download URL
- Cancel queued or running work
- Assign each queued job to an idle GPU; **one active video per worker**
- Survive worker death, provider death, and a blip on the network without losing a job we already accepted

I'd leave out unless asked: the diffusion math, prompt safety, billing, a public gallery, multi-GPU for one video. Friendlier ETA math can wait; a honest "queue is 12 minutes" cannot.

Four questions hide most of the rest:

**Who is the job?**  
The row in *our* database. Not a message in the provider's queue, not a cache key, not "the VM is still up." If the cloud loses the instance, we still have to know Alice is owed a video.

**What is an attempt?**  
One run on one worker. Preemption starts a new attempt of the *same* job. That split is how retry stays clean.

**When is the GPU ours?**  
Only while a lease is live and the worker still holds the current fencing token. A box that missed heartbeats is not ours, even if it later phones home with an MP4.

**What can be slow?**  
The render. Not the accept. Not cancel. Not "show me 62%." Queue *wait* may blow past 30 seconds when the pool is empty — that is capacity, not a scheduler bug. We show an ETA and we **admit** only what we will actually run. We do not pretend the fleet is infinite.

I'd write numbers on the board:

| Goal | Target | Why |
|---|---|---|
| Ack (P95) | under 500ms | Control plane. She is not waiting on CUDA. |
| Start when capacity exists (P95) | under 30s | "Queued" should become "running" |
| Progress freshness | under 5s | The bar has to move |
| Accepted-job durability | no lost jobs | Accepted means we wrote the row |
| Work lost on preemption | under 30s | Checkpoint bound |
| Availability (submit) | 99.9% | The queue can be long; submit cannot be down |

100K videos/day. Peak **20 jobs/sec**. Average **3 minutes** on one GPU. 20 × 180s = **3,600** running at peak. I'd keep ~4,000 workers (about a 10% idle buffer) so a blip in scale-up does not empty the ready pool.

Control plane is small: ~20 job writes/sec, ~360 heartbeats/sec, ~720 progress events/sec. Final artifacts: 100K × 25 MB = **2.5 TB/day**. Checkpoints can exceed that if you keep a museum. Keep the latest one or two, aggressive TTL.

GPU capacity, cold starts, and lost work dominate. The metadata database is not the bottleneck.

```
  Client                         Control plane                    GPU pool
    |                                  |                              |
    |  submit (idempotency key)        |                              |
    +--------------------------------->|  write job + outbox          |
    |  accepted  job id, ETA           |  Postgres                    |
    |<---------------------------------+                              |
    |                                  |  ready hint (Redis / SQS)    |
    |                                  |                              |
    |                                  |     pull / lease             |
    |                                  |<-----------------------------+
    |                                  |  claim in Postgres           |
    |                                  |  fencing token + 30s lease   |
    |                                  +----------------------------->|
    |                                  |     heartbeat 10s            |
    |                                  |     progress 5s              |
    |                                  |     checkpoint ~30s → object |
    |  status / live progress / hook   |     complete → MP4           |
    |<---------------------------------+<-----------------------------+
```

---

## 3. Two records: the video, and each run

The first data-model mistake is one row that is both "the video" and "who is rendering it." It looks clean. Then the worker dies, you retry, and you can no longer tell "we ran this twice" from "the old box is still uploading." Disputes and refunds of GPU time need that history.

A **generation job** is the intent: Alice wants this prompt, this model, this length. One row. It moves queued → assigned → running → completing → completed (or failed, or cancelled).

A **job attempt** is one try on one worker: lease, fencing token, checkpoint, how it ended (leased, running, lost, failed, succeeded).

We also keep **workers** (type, region, idle / busy / draining, which job if any), **artifacts** (input blob, checkpoint, final video), and an **event log** (queued, leased, progress, checkpointed, completed, …).

User 1:N jobs. Job 1:N attempts, artifacts, events. Worker 1:N attempts.

The prompt itself lives in object storage; the job row holds a reference, not a giant text column. Priority is a tier on the job: free, pro, enterprise.

These rows live in **Postgres**. Same reasons as any other money-shaped state: one transaction for "this job is assigned, this attempt exists, this worker is busy"; a unique pair of user + idempotency key so a retried submit is the same video; the database refuses a jump from queued straight to completed.

**One jobs row that is also the attempt.**

- Pro: fewer tables. One write to mark running.  
  *Why:* a prototype fits in a screenshot.
- Con: retry overwrites the only history of the first run.  
  *Why:* you cannot answer "did worker A still finish after we started worker B?" without an audit log you then have to invent.
- Con: fencing, lease expiry, and "current attempt" become flags on the same row and fight.  
  *Why:* two writers, one noun. Split the noun.

**Job + attempt. This is the one I'd take.**

---

## 4. The API

Generation is minutes. HTTP is request/response. So the public API is async.

Submit returns accepted with a job id. Status is a get. Cancel is a delete. Event history is optional if they want a trail.

She sends prompt, model, duration, resolution, an optional callback, and an **idempotency key**. We answer with the job id, queued, and estimated wait in seconds.

Same idempotency key → same job. A new key is a new video, on purpose.

Status includes state, progress, attempt number, a result URL when we have one, and a failure reason when we don't. Attempt number moving from 1 to 2 while the id stays the same is preemption you can see.

**Block until the MP4 exists.**

- Pro: one call, one file. Simple client.  
  *Why:* that is how a 50ms image resize API feels.
- Con: minutes of GPU on a load-balancer timeout.  
  *Why:* idle TCP is not a job record. A retry looks like a second video if you have not already persisted.

**Accepted + a durable job id. This is the one I'd take.**

Workers are not the public internet. Internal, typed RPCs: register after boot, ask for a lease, then heartbeat, progress, checkpoint, complete, or fail. Every one of those after assignment carries the **fencing token**. A write with the wrong token is a no-op. That is the whole split-brain defense.

Progress to Alice: she can poll status. A live stream is nicer for a tab. Webhooks for her backend. The GPU path does not wait on her server — same outbox idea as a receipt that must print before inventory is told.

---

## 5. The queue is a hint

A common sketch is: push the job into Redis (or SQS, or Kafka), workers pop, done. That is a prototype. The bug is treating the broker as the job.

If Redis restarts, Alice's accepted response is a lie unless the row is in Postgres. If SQS delivers twice, two GPUs render unless the claim is in Postgres. If we pop a hint and then crash before the row is claimed, the message is gone and the job is still queued — or the opposite.

**The move from queued to assigned happens in Postgres.** Redis (or SQS) is a **ready index**: "there is something this GPU type can run." Stale hints are fine. Double assignment is not.

The API writes the job **and** an outbox / ready event in one transaction. A dispatcher fills Redis. A Redis miss must not lose an accepted job. A sweeper can find queued rows that are missing from the index and repair it.

### Which broker

**Postgres as the only queue** (workers contend on queued rows).

- Pro: one system. The claim *is* the row lock. Crash-safe.  
  *Why:* 20 inserts/sec is nothing. You already need this write for correctness.
- Con: every idle worker polls the primary.  
  *Why:* 4,000 workers × a tight loop is a connection and lock storm. A pooler helps; a hot queued index still sits on the control plane you wanted quiet.
- Con: priority + model + GPU type is several indexes or one messy sort.  
  *Why:* you will partition anyway. Might as well put the *index* in Redis and keep the *claim* here.

**Redis sorted set (priority + time). This is the ready index I'd take**, in front of the Postgres claim.

- Pro: popping the best candidate is cheap. Paid jobs can rank ahead of free.  
  *Why:* score is a priority bucket plus time. Cross-partition priority is what Kafka does not give you for free.
- Pro: partition the ready lists by tier, model, and GPU type. A 720p worker does not walk enterprise 4K.  
  *Why:* one giant FIFO lets a mismatched job block a compatible GPU.
- Con: Redis is not durable in the way an accepted submit needs.  
  *Why:* replication still is not the job. Rebuild from Postgres. Treat pop as a hint, then claim only if the row is still queued.

**SQS (or any cloud queue with a visibility timeout).**

- Pro: you do not run Redis. At-least-once is explicit. Visibility timeout *is* a lease. Dead-letter after too many receives.  
  *Why:* ops likes a managed box. The timeout maps to "if the worker did not finish, give it to someone else."
- Con: no real priority. A paid user does not jump 10,000 free jobs. FIFO variants have throughput caps and still are not "pro jumps the line."  
  *Why:* priority is a product requirement. You would still filter in Postgres or run several queues (which is partitioning by another name).
- Con: at-least-once means two workers can see the same job.  
  *Why:* that is fine **if** only one claim wins. SQS is the wake-up; Postgres is the mutex. Drop the extra message after a successful claim, extend visibility on heartbeat — or you will get a second delivery while the first GPU is still rendering.
- Con: long-poll and redrive do not replace an attempt row.  
  *Why:* the queue has no checkpoint. The provider losing a message cannot mean "the job is gone."

If someone asks why SQS: I would use it as the **dispatcher** (outbox → queue → worker wakes → claim in Postgres), not as the system of record. Visibility timeout about 30s, heartbeat extends it, complete deletes the message. Same fencing token as in the Redis design. I would not skip Postgres because SQS is durable.

**Kafka.**

- Pro: the log is the history of "please run this." Replay after a poison consumer.  
  *Why:* that is what a log is for.
- Con: partitions do not give you global priority. A consumer group is extra hops on a path that is already "find an idle GPU."  
  *Why:* 20 messages/sec is not a streaming problem. Kafka shines when you fan out to many independent consumers. Here one job must run on **one** GPU. I would use a log for analytics and the event trail, not for the claim.

**If Redis and Postgres disagree, Postgres wins.** A stale ready hint is a wasted lookup. A stale pop that cannot claim is a no-op.

---

## 6. Pull vs push

**Push: scheduler picks an idle worker and assigns.**

- Pro: the job can start as soon as you know a GPU is free. No extra round trip from the worker.  
  *Why:* you have a map of idle ids. Dispatch is one RPC.
- Con: the map lies. The worker you pushed to has already died, or is mid-OOM, or never finished booting.  
  *Why:* volatile pools. You just wasted a dispatch and maybe a cold start on a corpse.
- Con: "one video per worker" is a rule you must enforce in the pusher. Two schedulers both see idle.  
  *Why:* you reinvent a claim on the worker row — which pull already is.

**Pull: idle worker asks for one job. This is the one I'd take.**

- Pro: only currently-alive workers get work.  
  *Why:* a dead box does not poll. Assignment is "this process is here."
- Pro: a worker that just finished booting pulls immediately.  
  *Why:* cold start already cost 30–90s to load weights. Do not add "wait until the scheduler notices me."
- Pro: one outstanding lease per worker is natural: do not poll until complete or drain.  
  *Why:* that is the product constraint, not a lock you forget.
- Con: an idle worker polls. Empty pool → sleep with jitter.  
  *Why:* 4,000 workers at 1 Hz is 4,000 RPCs/sec. Batch or long-poll the lease call; do not hit Postgres on each tick — use the Redis hint first.

**Hybrid (push into hot, already-warm pools).**

- Pro: you skip the poll on a pool that is always hungry.  
  *Why:* lower scheduling latency when you trust liveness.
- Con: two paths.  
  *Why:* the cold/spot path still needs pull. I would not start here.

---

## 7. The claim, and the token

Invariant: **one logical job has at most one valid active attempt.**

The worker peeks at the ready index (hint only). Then, in one database transaction: take a queued job that still is queued, insert an attempt with a fresh fencing token and a lease 30 seconds out, mark the worker busy. If nothing is claimable, roll back. Delete the hint after commit, best-effort.

Prefer a job that already has a checkpoint on a worker with the same model — resume beats start-from-zero.

**Distributed lock in Redis, then run.**

- Pro: fast. Familiar.  
  *Why:* a cache lock is one round trip.
- Con: lock TTL vs a 3-minute render. Two holders if a pause lasts past the TTL.  
  *Why:* we already lived this on chess. The job row is the lock.

**Compare-and-swap in Postgres. This is the one I'd take** (after the hint).

Lease: 30s. Heartbeat every 10s extends it. Three missed beats → lost. Progress can be more frequent than the heartbeat; it does not *replace* the heartbeat.

**Fencing token.** When we create attempt 2, we mint a new id. Attempt 1's complete is rejected even if the old VM's network comes back. Think of a hotel keycard. New guest, new key. Old key does not open the door.

Complete and fail are safe to retry on the same attempt and token. A redelivered success is the same MP4, not a second job.

---

## 8. What the worker actually does

1. Boot, register (booting → idle). Load the model if this pool is dedicated to it.
2. Pull — ask for one job.
3. If a checkpoint exists, restore; else start from the beginning.
4. Loop: generate, every 5s progress, every 10s heartbeat, every ~30s checkpoint.
5. Encode MP4, upload, complete.
6. If the provider says draining: stop pulling, finish or checkpoint, mark draining.

**One video per worker.**

- Pro: VRAM and the runtime are a bad roommate. Latency and checkpoint times stay predictable. Failure is one job, not two.  
  *Why:* a diffusion model is not a 5ms HTTP handler. Two videos on one GPU steal each other's memory bandwidth and make "30s checkpoint" a lie.
- Con: utilization looks "low" if you think like a CPU packer.  
  *Why:* the constraint is VRAM and isolation, not idle CUDA cores between steps. If they ask about packing: smaller models, sliced GPUs, or a cheap tier — not two Sora jobs on one box in v1.

**Model warmth.** A cold worker downloads weights and loads VRAM: 30–90s. Route the next job for that model to a box that already has it. If none is idle, any compatible GPU is better than waiting for a specialist that does not exist. Keep a small **warm idle buffer** (that 10%) so a spike does not pay cold start on every job.

Provider **drain / preemption notice**: mark draining, no new leases, checkpoint now, release. **No notice** (kernel panic, some clouds): the only signal is a missed heartbeat. Do not design as if a shutdown signal always arrives.

Keep the system of record in our database. Do not hand the job to the GPU vendor's queue and assume it is safe.

---

## 9. Checkpoints

Without them, a death at minute 2.5 of 3 wastes almost a full GPU-video. The budget is **under 30 seconds of lost work**, so we checkpoint on that order — every 20–30s, or at a milestone if the model has one, whichever comes first.

Upload resume state to object storage. A finished upload is the whole object or nothing. Keep **the previous** checkpoint until the new one's checksum is on the attempt row. Restore fails → try the previous; none valid → start over.

Keep only the latest 1–2 per active job. Delete after success or terminal failure. TTL the rest. Spread keys across prefixes so a fleet-wide reclaim does not hammer one folder.

**Checkpoint every few seconds.**

- Pro: almost no rework.  
  *Why:* the bound is the interval.
- Con: serialize + upload steals GPU, CPU, and network from generation. Checkpoint volume exceeds the MP4s.  
  *Why:* a multi-GB dump every 5s at 3,600 concurrent jobs is a storage and bandwidth product, not a footnote.

**Checkpoint every few minutes.**

- Pro: cheap.  
  *Why:* few uploads.
- Con: you miss the 30s lost-work budget.  
  *Why:* a preemption near the end of a 3-minute cadence can replay almost the whole job.

**Fixed ~30s. This is the one I'd take first.** Then talk about adapting: longer jobs, flakier providers, deeper queues → more often; stable on-demand pools → less often. Fixed is debuggable. Adaptive is a second pass.

On a shutdown warning: one emergency checkpoint, then stop. Do not spend the whole notice window on a second encode of the MP4 "in case."

---

## 10. Cancel

Queued: mark cancelled, drop the ready hint. The next claim sees a job that is no longer queued and skips.

Running: set cancel-requested on the job. Next heartbeat the worker sees it, checkpoints if that is cheap, stops, fails with reason cancelled. Late complete from a stale attempt: fencing token + terminal state → reject. We do not publish that MP4 as Alice's video.

Do not wait for the GPU to acknowledge before cancel returns. She asked to stop. The row says cancelled. The worker is eventually consistent; the token makes a late success harmless.

---

## 11. No GPUs left

20 jobs/sec × 3 minutes is 3,600 running **if** you have 3,600 GPUs. If you have 400, the other jobs wait. Pretending otherwise is how you blow the scheduling SLA and then lie on the ETA.

**Admission queue** (cheap, can be huge) vs **running set** (capped by the pool). Separate them. The running set is assigned / running. The rest stay queued with a position and an estimated wait.

ETA is roughly queued compatible jobs × average duration, divided by workers in that pool. Show it. When wait exceeds a tier's max, **reject** or degrade (lower resolution) — product call. Free tier hits the cap first. Enterprise may have a reserved on-demand slice.

**Fair-share:** a free user with 10,000 queued prompts should not freeze a paying customer's one job. Priority at *admission and dequeue*, not by killing a running video every time someone richer arrives. Preempt a running free job only if you checkpoint and the policy says so; pair with a cooldown or you thrash.

**Autoscaler (capacity manager):** watch queue depth, wait time, idle buffer. Call the provider to add workers. New VMs are **cold**. Do not count them as capacity until they register idle. Scale down: drain, no new leases, then terminate.

**10× spike, fleet size N.** Queue grows. Priority + fair-share + honest ETA. Scale out as fast as the cloud sells GPUs. Do not drop accepted jobs. Stop *accepting* if the wait is unbounded and the product allows it.

---

## 12. Failure cases

This is the section I would spend the time on.

**Spot / provider drain, with warning.**  
Detect: instance metadata, or "this box is draining."  
Do: worker draining, no new pull, checkpoint, finish the current step if it fits the notice window, release. Job stays queued or goes straight to a new attempt.  
Bound: at most one checkpoint interval of rework, plus whatever the new worker spends restoring.

**Worker vanishes (memory kill, kernel, no notice).**  
Detect: **heartbeat only.** Assume the warning will not come.  
Do: lease monitor marks the attempt lost, job queued, ready hint restored. New worker resumes from the latest checkpoint.  
Bound: 30s lease + restore. Tune lease to "fast detect" vs "do not false-positive a 2s blip." 10s heartbeat / 30s lease is the spec I'd start from.

**Network partition (split brain).**  
Scheduler thinks the worker is dead; the worker is still rendering.  
Do: expire lease, start attempt 2 with a **new** fencing token. Worker A's complete is rejected. Worker B is the owner.  
A's MP4 may still land in object storage — it is not the artifact we publish unless the token matches. Delete orphans with a sweeper.

**Stale complete after we already succeeded on attempt 2.**  
Same token check. Complete is safe to retry for the *current* attempt only.

**Redis empty or down.**  
Running jobs keep heartbeating to Postgres. New scheduling: fall back to claiming queued rows directly (degraded, slower) or pause *starts* while submits still accept. Rebuild hints from the outbox / from queued rows. Never treat Redis loss as job loss.

**Postgres primary down.**  
Fail over. Submits fail or wait — that is the 99.9% you actually spend money on (replicas, backups). Workers that already have a payload in memory can keep generating; they buffer heartbeats a few seconds. They cannot complete without the database. If failover takes longer than the lease, the monitor on the new primary will requeue — fencing still applies when the old worker returns.

**Checkpoint upload fails.**  
Retry with backoff. If it still fails, keep generating and log "running without a net." Next preemption costs more rework. Do not fail the job because one checkpoint missed unless the product says so.

**Checkpoint file is garbage.**  
Fall back to previous object. None → restart from zero. Do not loop crash-restore.

**The wake-up queue delivers the same job twice.**  
First worker claims. Second claim sees it is no longer queued and gives up. Drop the extra message. If we used the broker as source of truth, this is a double GPU bill.

**Provider region dies.**  
Jobs are in *our* Postgres, not in their queue. Mark workers lost. Requeue running jobs with checkpoints. Spin capacity in another region if the model artifacts are there. ETA jumps; we do not lose the jobs we already accepted.

**Fleet-wide reclaim (hundreds of spot VMs at once).**  
Hundreds of checkpoints at once. Spread object prefixes. A **warm on-demand reserve** (part of that 10% buffer) absorbs the dip while spot comes back. Queue depth is allowed to spike; admission control is what keeps submit alive.

**Worker reports success, then crashes before we ack.**  
Complete is safe to retry. Same artifact.

**Alice retries submit without the idempotency key.**  
Two jobs. That is correct. The key is the dedupe; we do not guess.

---

## 13. Progress that goes backwards

If you show 85% and then preemption, a naive bar jumps to 0 then to 85. Say **resuming from 85%** (or skip the number and say processing). Status can include attempt number and where we resumed. Webhooks fire from the outbox after the state change, not from the GPU thread.

---

## 14. When this gets bigger

Sticky pools per model so warmth is the default.

Spot vs on-demand: spot is cheaper and dies more. I would not pick a ratio in minute one without their cost numbers. I would say: on-demand (or reserved) for the SLA tier and a warm buffer; spot for the rest; **checkpointing is what makes spot sane**. A 90% spot fleet that gets half-reclaimed is a capacity incident, not a surprise.

Multi-region: run the job near the GPUs; artifacts in-region; control plane can be global if the job row is the source of truth.

Do not put Redis in front of status as the only copy. Cache if gets are hot; Postgres remains truth.

---

## Recap

Submit writes a job in Postgres before we say accepted. Workers **pull**. A ready queue (Redis, or SQS as a wake-up) is a hint; the claim is a row lock and a **job attempt** with a **fencing token** and a 30-second lease. One video per GPU. Checkpoint about every 30 seconds so preemption wastes a bounded amount of work. Cancel is a state plus a token, not a polite wait for CUDA. When the pool is short, show ETA and stop pretending.

The sentence that is the design: **the GPU is not the source of truth.** The job is. The attempt is how we retry. The token is how we ignore a ghost.
