---
title: "How I'd take a card at a coffee shop"
description: "The prompt says payment. The product is a till: hold, tip, capture, then settle with each receiving bank at 10pm. Not Stripe."
pubDate: 2026-08-25
tags:
  - systems
---

A lot of "design a payment system" write-ups are Stripe in a trench coat: wallets, marketplaces, 10k charges a second, a webhook bible. I have drawn that board. It is the wrong board if the product is a coffee shop.

The product is a till. Someone taps a card for a latte. A tip might land thirty seconds later. At 10pm the store wants the captured rows bundled and sent to the banks that will actually pay the merchant. I do not get to skip to "we'll reconcile with Visa." Visa is a network. The money shows up per receiving bank, which means several files, not one.

I'm writing this the same way I wrote the [calendar note](/posts/how-id-design-google-calendar): lock the product, name the API, put a state machine on the board, then walk the pictures. I sketched these as a cheat sheet. I'm going to split them and say what each one is *for*, in language I would actually use.

I have not worked payments. That is not an excuse to stay vague. It is a reason to keep the nouns honest.

---

## What I would and wouldn't build

I'd start by reading the prompt twice. "Payment" is a title. The vertical is the design.

I'd include:

- Tap-to-pay at a counter: authorize fast, then capture
- A tip or a void after the tap, so the final amount can differ from the hold
- A receipt the barista can trust in under a second
- A nightly settlement job at 10pm
- One settlement file *per receiving bank / acquirer*, plus a recon pass against those files
- Refunds on captured (or settled) payments only
- Idempotency on hold, on capture, and on the batch itself

I'd leave out, unless someone really wanted them: a consumer wallet, P2P, subscription billing, "design Stripe," and a product-analytics pipeline. Those are other interviews.

A few product questions hide most of the difficulty:

**Hold then charge, or one shot?**  
A coffee shop is two steps. The tap *holds* funds (`authorized`). Adding a tip, or ringing up a second pastry, *captures* a final amount that may not match the hold. If nobody captures before the hold expires, the authorization is released. Hotels do the same trick between check-in and check-out. Amazon does it between order and ship. Merging auth and capture because "it's simpler" deletes those businesses.

**Who is "the bank"?**  
Three different companies will answer the phone.

- The **issuer** is the customer's bank. Chase, if they tapped a Chase card.
- The **network** is Visa / Mastercard. They move the message.
- The **acquirer** (receiving bank) is who the *merchant* settled with. That is who produces the report I recon against at night.

Not storing the raw card number does **not** mean I don't know where the payment went. I chose an acquirer when I routed the auth. I persist `acquirer_id`. PCI is "don't keep the PAN." Settlement is "remember who you talked to."

**When does the money move?**  
Authorize is a lock. Capture is "yes, take it." Settle is "the acquirer filed it and the merchant will see it in the deposit." The till must feel done at capture. Settlement can be a 10pm batch.

**What is allowed to be slow?**  
The tap is not. I would not put the authorization response on a queue and hope Kafka is having a good day. Settlement, webhooks to the merchant's back office, recon: those can wait.

Non-negotiables I'd write on the board:

- Money records are strongly consistent. Eventual consistency is for the receipt email, not the ledger.
- Retries must not double-charge. That is a unique key, not a vibe.
- A captured payment the nightly job cannot find is a bug in the index, not in "the batch."
- One Visa file is the wrong recon target if the prompt said receiving banks.

---

## The one number

I wouldn't invent cluster sizes. I'd name the bottleneck.

A large chain: tens of thousands of stores, a few taps per minute per register at peak, a daily settlement that is tiny next to the taps. Writes are small and spiky (morning rush). The hot path is **authorize in well under a second**. The scary path is **exactly-once capture** when the terminal retries. The operational path is **get every captured row into the right bank file at 10pm**.

I do not add a queue, a cache, or a second processor because a template said to. I add a box when it attacks one of those.

---

## The API that is the product

HTTP is fine. The till talks to me; I talk to an acquirer. The two calls I would actually defend:

```
POST /v1/holds
POST /v1/holds/{hold_id}/capture
```

```json
POST /v1/holds
{
  "merchant_id": "store_oakland_12",
  "amount": 475,
  "currency": "USD",
  "payment_method": "tok_…",
  "idempotency_key": "term-88-20260825-104411-01"
}

→ 201
{
  "payment_id": "pay_01",
  "hold_id": "hold_01",
  "state": "authorized",
  "amount": 475,
  "expires_at": "2026-08-25T18:44:11Z"
}
```

```json
POST /v1/holds/hold_01/capture
{
  "amount": 575,
  "idempotency_key": "term-88-20260825-104411-01-cap"
}

→ 200
{
  "payment_id": "pay_01",
  "state": "captured",
  "amount_authorized": 475,
  "amount_captured": 575
}
```

Amounts are integer cents. I do not send `4.75` across a wire and argue about floats.

Why each piece is there:

- **`merchant_id` in the body (and as the shard key)** — the till is a store. Statements, tips, and "what did Oakland 12 take today" should live on one machine.
- **Two calls, not `POST /charge`** — the tip is a different amount. Capture can be less than the hold (partial fill) or a bit more (tip), within the acquirer's rules. If the prompt forbids over-capture, I clamp and say so.
- **`idempotency_key` on both** — the terminal will retry. Same key, same payment. A second key is a second charge, on purpose.
- **`hold_id`** — the acquirer's authorization id, plus mine. Capture has to point at a real hold. You cannot capture a payment that was never authorized.

The rest is boring on purpose:

```
GET  /v1/payments/{payment_id}
POST /v1/payments/{payment_id}/refunds   {amount, idempotency_key}
GET  /v1/merchants/{id}/payments?state=&from=&to=
POST /internal/settlement/run            {business_date, idempotency_key}
```

Refunds only from `captured` or `settled`. Database constraint, not an if-statement I will forget. Status reads are a primary-key lookup. I would not make the terminal poll Kafka to find out if the tap worked.

---

## The data model: a payment is a state, not a pile of flags

```
Payment
  payment_id            PK
  merchant_id           -- shard key
  store_id
  amount_authorized     cents
  amount_captured       cents, null until capture
  currency
  state                 created | authorized | captured
                        | settling | settled
                        | expired | failed | refunded
  acquirer_id           -- who we routed to; recon key
  hold_id               -- acquirer auth id
  psp_reference
  batch_id              null until the 10pm job claims it
  created_at, authorized_at, captured_at, settled_at

Idempotency
  merchant_id, idempotency_key   PK
  payment_id
  request_hash
  response_body
  terminal_state

LedgerEntry             -- append-only, two rows per event
  entry_id
  payment_id
  account               customer_hold | merchant_receivable | …
  amount                signed cents
  created_at

SettlementBatch
  batch_id
  acquirer_id
  business_date
  idempotency_key       -- the job's own key
  state                 submitted | settling | settled | failed
  file_uri
  row_count
  amount_cents
```

Indexes I would write on the board, because this is where people fail the night job:

```
UNIQUE (merchant_id, idempotency_key)

-- the 10pm query is "give me captured, not yet in a batch"
INDEX payments (state, captured_at)
INDEX payments (acquirer_id, state)

UNIQUE settlement_batches (acquirer_id, business_date, idempotency_key)
```

`WHERE state = 'captured'` has to be an index lookup, not a table scan. In Postgres that is a btree on `state`. In DynamoDB that is a local secondary index on `state` with `captured_at` as the sort. I would say the words *local secondary index* out loud if we were on Dynamo, so nobody thinks I plan to scan the world at 10:01pm.

A check constraint (or a real state-machine table) so you cannot jump `created → settled`, and you cannot refund `authorized`. The sticky on my board is the same idea: only valid transitions.

---

## A picture of the till

I start with something I could draw in a few minutes. The *core* is synchronous: terminal → payment service → acquirer → ledger. The batch is a second drawing.

```
  POS terminal                 Payment service              Acquirers
  (tap is sync)                (orchestrator)
       |                            |
       |  hold / capture            |  auth / capture
       |  + idempotency key         |
       +--------------------------->+------------------->  Acquirer A
                                    |                      Acquirer B
                                    | record every step
                                    v
                              Postgres (merchant_id)
                              Ledger (two rows, sum 0)
                              Redis optional, not SoT

  10pm worker:  WHERE state='captured' AND captured_at < cutoff
                GROUP BY acquirer_id, shard
                part files (~100k rows), cursor = payment_id
                receipt ack ≠ result file
```

Then the scale pass, given the number above. More than one API machine, so a load balancer. More than one Postgres, so a shard map. A second acquirer if the first is on fire. A queue only for settlement and back-office notifications — **after** the customer already has a receipt.

I would start on **Postgres**. I want one transaction for "move `authorized` → `captured` and append two ledger rows." That is the rationale. Cassandra is a later conversation, and only if someone is actually pushing write volume I do not believe a coffee chain has.

---

## The tap, boxed

This is the first picture. Client, payment service, gateway, bank. The names in the sketch are web-flavored (Stripe). For a till, the "client" is the terminal, and the "gateway" is whichever acquirer I routed to. Same arrows.

[![Payment processing flow: client pays, payment service auths through a gateway to a bank, and every step is recorded in a ledger](/images/payment-flow.png)](/images/payment-flow.png)

Left to right:

1. The terminal says **pay**. That is `POST /holds`.
2. My service writes `created` (or `authorized` once the acquirer answers), and **records** the attempt in the ledger. If the acquirer never comes back, the row still exists, in a state that says where it died.
3. The gateway **charges** the bank. In real life this is authorize, not "take the money." The sketch's word `charge` is doing too much work. I would label the arrow `auth` on a whiteboard and keep `capture` for later.
4. Approve comes back. I confirm to the terminal. The barista sees a receipt. The customer is already putting the card away.

The note under the ledger is the whole point of this box: **every step is recorded. If any step fails, the payment should reflect exactly where it failed.** A tap that times out is `authorized` or `failed` or `created` — a known state — not a missing row I will "figure out tomorrow."

What I would not do: wait for settlement before returning. Tap-to-pay has a latency budget. Settlement is tonight.

---

## States you can actually point at

[![Payment state machine from created to authorized, captured, and settled, with failed and refunded as exits](/images/payment-state-machine.png)](/images/payment-state-machine.png)

Happy path, in order:

`created → authorized → captured → settled`

Exits:

- `created` or `authorized` can **fail** (issuer says no, terminal cancelled, hold expired).
- `captured` or `settled` can **refund**. You do not refund a hold that was never captured. You *void* or let it expire.

I would put the legal transitions in the database so a bug cannot skip. `CHECK` constraints, an enum, a trigger — I don't care which, I care that `created → settled` is impossible.

The coffee-shop mapping, said out loud:

| What the human does | State |
|---|---|
| Card tapped, issuer said yes | `authorized` (hold) |
| Tip entered, "charge" | `captured` |
| 10pm file acked by that bank | `settled` |
| Nobody captured in time | `expired` |
| Issuer declined | `failed` |

`settling` is the in-between while a file is in flight. I want it so a crashed job does not pick the same rows again and also does not leave them as ordinary `captured` forever. Claim with `batch_id`, then mark `settling`, then `settled` on ack.

---

## Why auth and capture are two calls

[![Sticky note: why not merge AUTH and capture? Hotels hold at check-in; ecommerce captures after ship](/images/auth-vs-capture.png)](/images/auth-vs-capture.png)

Because the final number is not known at tap time.

A hotel holds at check-in and captures at checkout. An online shop authorizes at order and captures at ship. A coffee shop holds at tap and captures after the tip screen. Same gap, smaller dollar amounts, worse latency budget.

If I merge them into one `charge`, I have to guess the tip, or I have to run a second charge for $1.00 and pray the idempotency story still holds. Two-step is the product.

The leftover line on that sticky — you cannot refund a transaction that was never captured — is a state-machine rule, not a business slogan. Void the hold. Don't pretend a refund.

---

## Double charge is a missing unique key

This is the picture people skip, and then they ship a till that charges twice when the Wi-Fi hiccups.

Without a key: the terminal posts `$50`, the network drops on the way back, the terminal retries, I charge twice. The customer is still at the register. This is how you get a one-star review and a chargeback.

[![A pay request times out with no idempotency key, so a retry may double-charge](/images/idempotency-timeout.png)](/images/idempotency-timeout.png)

With a key: the terminal sends `abc123`. I store `abc123 → payment_id` before I talk to the acquirer, or in the same database transaction that inserts the payment. Retry with `abc123` returns the same body. I do not call the acquirer again.

[![Retry with the same idempotency key hits a key store and returns the cached result](/images/idempotency-key.png)](/images/idempotency-key.png)

Where the key lives: the sketch says Redis, millisecond lookups, expire in 24 hours. Redis is a fine *cache*. It is not the source of truth for money. Two API machines can both miss Redis in a race. The thing that actually saves you is a **unique constraint** on `(merchant_id, idempotency_key)` in Postgres. Second insert loses, reads the winner, returns that response.

I would keep the response body next to the key so a retry does not reconstruct a slightly different JSON and confuse the terminal.

Keys on **hold**, on **capture**, and on **the 10pm batch**. A batch that dies after sending 60% of a file must resume with the same batch token, not open a second file the acquirer will treat as new money.

Same story inbound: if the acquirer retries a webhook, my handler is idempotent too. Their `event_id` is unique. I do not move `authorized → captured` twice.

---

## Two rows that sum to zero

[![Double-entry ledger: debit customer -100 and credit merchant +100; a refund reverses both](/images/double-ledger.png)](/images/double-ledger.png)

Every money event writes two ledger lines whose amounts sum to zero.

Authorize $4.75:

- debit `customer_hold` 475
- credit `merchant_receivable` 475

Capture with a $1 tip (now $5.75): extra pair for the 100, or a capture pair that replaces the hold — I'd pick one scheme and not mix them. Refund reverses the pair.

Why I bother: if the two sides don't sum to zero, the system is lying *right now*, not at month-end. Recon against a bank file becomes a diff of two lists instead of archaeology. Append-only means I don't update a balance in place and lose the plot.

I would not "eventual-consist" this. The payment row and the two ledger rows commit together.

---

## Nightly recon is per receiving bank

This is the picture that is easy to draw wrong.

[![Reconciliation engine compares an internal ledger to a bank file and flags a missing txn4](/images/reconciliation.png)](/images/reconciliation.png)

The sketch compares "internal ledger" to "the bank" and finds `txn4` missing on the bank side. That is the right *shape*. The mistake is thinking "the bank" is Visa.

Visa/Mastercard will happily sell you network reports. A coffee-shop prompt that says **receiving banks** wants the **acquirer settlement files**: one per acquirer, different formats, different cut-off times, different ids. Chase acquiring is not Adyen is not "the Visa file."

So the 10pm job is:

1. Select `state = 'captured'` (that's why the index exists).
2. **Group by `acquirer_id`.**
3. Cut into **part files** (~100k rows / ~50 MB), not one 40 GB blob. Name them `acquirer + date + shard + part_seq`.
4. Mark those rows `settling` and stamp `batch_part_id` in the same transaction as the part row.
5. Upload. Receipt-ack is "they got the file." Result-ack is a later file. Only then `settled`.
6. On nack, keep them claimable and do not emit a duplicate part — same object key, same cursor.

Recon, later:

- My ledger, filtered to that `acquirer_id` and date, versus **that acquirer's** report, keyed by `psp_reference` / `hold_id`.
- Missing on their side: I captured, they never got it — retry or ticket.
- Extra on their side: they charged something I don't have — don't "fix" it by inserting a quiet row; ticket it.
- Amount mismatch: same id, different cents — ticket.

Several reports. Not one. I would say that sentence even if the interviewer already knew it, because it is the requirement.

A partially failed batch is the other trap. If I write 10,000 lines, flush 6,000, die, and rerun *without* a batch key, the acquirer sees 16,000 lines and I have invented money. The batch is a payment. It gets a key.

That sketch is the *shape*. The rest of this section is the part most write-ups skip: what the bank actually accepts, how big the files get, and how you restart a worker without inventing money.

### Authorize TPS is not a settlement API

The [ShowOffer video](https://www.youtube.com/watch?v=ruxGKk51aHo) is a Stripe-shaped 10k-TPS board. It puts confirm on Kafka. I would not. Authorize is a phone call to a bank with a latency budget; a queue in the middle is how you miss tap-to-pay. Settlement is allowed to be slow. Those two facts are the whole split.

They are also two different *provider APIs*:

| Path | What it is | Shape | When |
|---|---|---|---|
| Authorize / capture | ISO 8583-style online message | request/response, milliseconds | every tap |
| Settlement / clearing | a file (Visa BASE II, Mastercard IPM, or the acquirer's SFTP spec) | header + detail lines + trailer | once a day, per receiving bank |
| Result / recon | a *different* file coming back | same, hours later | next window |

Nobody is settling 10k rows per second against Chase SFTP. If the interviewer says "10k TPS," that number is the till. The nightly job is "how many captured rows accumulated while we were at 10k."

A coffee-shop prompt may never reach 10k. If they keep the Stripe number anyway, I do the arithmetic on the board so they can see I am not hand-waving 40GB.

### The 40GB file is a fake requirement

10,000 taps/sec × 86,400 seconds = **864 million** captured rows in a full day, if that rate never sleeps. Ten acquirers, even split: **86.4 million rows each**, not 86,400. (86,400 is the seconds.) At 500 bytes a line that is ~43 GB *per acquirer*, ~432 GB across the system.

I would not pack that into one file.

Real clearing files have a header, detail records, and a trailer with counts and amount totals. Upload limits are hundreds of MB, not tens of GB. A 40GB PUT that dies at 97% is how you spend the night. Retry wants a small blast radius.

So I cut on **record count** (or byte size), not on "one file per bank per day":

100,000 rows × 500 B ≈ 50 MB. That is 864 part-files per acquirer per day at the even split. Ugly on a slide, boring in production.

If the bank insists on one *logical* batch, the header still carries `batch_id` + `part 017 of 864`. They concatenate. I do not.

Submit is not the result. I upload a part, they ack **receipt** (checksum, line count matches trailer) — that can be an SFTP drop or an HTTP 200. They **process** asynchronously. Hours later a result file shows up: accepted, rejected, amount mismatch, per line. Money in the merchant account is a third clock (ACH), and I would not pretend my `settled` flag is a wire transfer.

### I would not CDC the cutoff

CDC (a change feed off the primary: every insert/update becomes an event) is a good way to ping a merchant webhook. It is a bad way to decide "what is in Tuesday's Chase file."

Cutoff is a **snapshot**. "Every `captured` row with `captured_at < 22:00 America/Los_Angeles`." A change feed has lag. Shards have different lags. A row that captured at 21:59:59 can show up in the feed at 22:00:20, or not, depending on the replica. You now have a distributed snapshot problem, which is how you double-settle or drop a latte.

S3 is not a log you append line-by-line. You write an object. CDC-into-S3 means a worker buffering, rotating parts, and reconciling "did this line land" after a crash — all the failure cases of a file job, plus unordered events.

After cutoff, Tuesday's captured set is frozen if I define it that way: new taps after 10pm belong to Wednesday. Refunds of Tuesday captures become reversal lines in Tuesday's file or a separate reversal file, not silent updates to a blob I already started.

I would **read the database**. Shard by `merchant_id`. Run the job on **replicas** so the till keeps writing. `WHERE state = 'captured' AND captured_at >= day_start AND captured_at < cutoff AND batch_part_id IS NULL ORDER BY payment_id LIMIT 100000`.

`ORDER BY payment_id` is the restart cursor. Same cutoff, same shard, same acquirer → same sequence of ids → same part bytes. The object key is deterministic: `s3://settle/{acquirer}/{date}/shard_{n}/part_{k}.csv`.

### A part-file is a state machine, not a script

```
SettlementPart
  part_id
  acquirer_id
  business_date
  shard_id
  part_seq                 -- 0, 1, 2, …
  first_payment_id
  last_payment_id
  row_count
  amount_cents             -- trailer
  s3_uri
  state                    -- writing | uploaded | submitted
                           -- ack_receipt | result_applied | failed
  idempotency_key
```

Worker loop, one shard, one acquirer:

1. `SELECT … ORDER BY payment_id LIMIT 100000` from the replica. If empty, this pair is done.
2. Write the CSV locally (or stream multipart to S3). Trailer = count + sum. Object key as above. If the worker dies here, S3 may have a partial multipart; abort it. Restart rebuilds the same key.
3. **One primary transaction:** insert/upsert the `SettlementPart` row; `UPDATE payments SET state = 'settling', batch_part_id = $part WHERE payment_id IN (…) AND state = 'captured'`. The `AND state = 'captured'` is the lock against a double claim. If the transaction fails, payments are still `captured`, S3 object is overwritten next try. If it commits, those rows will not appear in the next `SELECT`.
4. A **submitter** (separate from the writer) sends `state = 'uploaded'` parts to the acquirer. Crash after S3 but before send: submitter retries. The bank sees the same file id; they must treat re-upload as idempotent, or I only send after a local "submitted" that I never rewind without a human.
5. Receipt ack → `ack_receipt`. I do **not** flip every payment to `settled` yet. I do not know they posted.

A crashed writer does not "resume the left" by guessing. It looks at the last committed `last_payment_id` for that `(acquirer, date, shard)` and selects `payment_id > that`. Uncommitted work is still `captured` and will be picked again. That is the point of sorting.

### Recon is a diff, not 864 million UPDATEs

When the result file lands, I do not `UPDATE payments SET state = 'settled'` on 86 million rows in one statement. That is how you lock a shard for an hour and take the till down after all.

Most lines match. I store **exceptions**, not applause.

```
SettlementException
  part_id
  payment_id          -- null if they have a line I don't
  theirs_reference
  kind                -- missing_theirs | extra_theirs | amount_mismatch
  ours_cents
  theirs_cents
  state               -- open | retried | written_off
```

For a part whose trailer matches theirs (same count, same cents, no per-line rejects): mark the **part** `result_applied`. Payments in that part can move to `settled` in **chunks** — 1,000 to 10,000 ids at a time, `WHERE batch_part_id = $part AND payment_id > $cursor`, each chunk a small transaction on the **merchant shard that owns those ids**. Checkpoint `last_payment_id` on the part. Crash, continue. 86 million rows is 8,600 chunks of 10k, spread across shards, not one 864-million-row write. (The scary number is the *row count*, not "864 MB.")

Partial failure in the result file: process in line-offset checkpoints. A poison line becomes an exception row; the rest of the part continues. Retry is "resubmit the missing ids as a new part with a new `part_seq`," never rewrite history in the old object.

If they reject 12 lines, those 12 stay `settling` (or return to `captured` with a reason) and get a ticket. The other 99,988 settle. I would not hold the whole part hostage for twelve lattes.

CDC still has a job: merchant webhooks, search, the data lake. Not Tuesday's Chase file.

---

## The card number never visits my server

[![PCI tokenization: card number goes browser to processor iframe to Stripe; the server only gets a token](/images/pci-tokenization.png)](/images/pci-tokenization.png)

The sketch is the **web** version: the browser posts the PAN into a processor iframe (Stripe Elements and friends). My server receives a token. Raw card number never lands in my process, which is how you collapse a mountain of PCI into a questionnaire.

A coffee shop is not a browser. The till is a certified terminal. The PAN stays in the terminal / acquirer tunnel (PCI PTS, whatever the vendor already paid lawyers to stamp). I still persist only a token, last4, brand, and **`acquirer_id`**.

That last column is how I can not store card numbers *and* still recon per bank. Those are not in conflict. The failed version of this argument is "PCI means I don't know which bank." PCI means I don't keep the PAN. Routing is my table.

---

## Webhooks are for the back office, not the tap

[![Webhook pipeline: payments DB to CDC to Kafka to a delivery worker posting to the merchant, with backoff and a DLQ](/images/webhook-delivery.png)](/images/webhook-delivery.png)

Once a row is `captured`, the store's inventory system, payroll, or "we made money" dashboard may want a ping. That path is allowed to be async:

Payments DB → change feed → queue → worker HTTP POSTs the merchant → 200 means done.

At-least-once, exponential backoff (a minute, five, thirty, two hours), then a dead-letter queue a human can see. Each delivery carries an idempotency key so *their* server can ignore my retries.

I would not run the **authorization response** through this pipe. Under load, a queue adds wait. Tap-to-pay is a synchronous round trip: terminal → me → acquirer → me → terminal. The picture above is what happens *after* the customer already walked off with the latte.

If the acquirer is down mid-tap: fail fast (circuit breaker), retry with backoff only for timeouts that look transient, and if I have a second acquirer, route there **for a new hold**, not as a silent double. Fallback is a product decision I would say out loud: "this tap may hit a backup bank."

---

## How I would shard, if someone asks

This is a decision, not a default.

**`transaction_id` / `payment_id`.** Writes spread evenly. A store's day and an acquirer's 10pm file become scatter-gather across every machine. Recon gets harder. I would not pick this first for a till.

**`merchant_id` (or `store_id`).** Oakland 12's payments, tips, and refunds sit together. A merchant statement is one shard. The risk is a hot tenant — a flagship store, or a franchisee who is actually 2,000 stores stuffed under one id. I'd shard on the grain statements are issued at, and split a hot key if we get there. This is my default.

**`acquirer_id` / card-bank.** The nightly `GROUP BY acquirer` becomes local, which is lovely for the batch. A single store that routes to two acquirers now spans shards. A customer-support lookup by store is scatter-gather. I only pick this if the prompt's main workflow is bank-shaped settlement and they are willing to pay that cost.

I would say: *merchant_id for the product, and the 10pm worker fans out per shard, then concatenates per acquirer.* If they push on "but each bank wants one file," the concatenator is a small collector, not a reason to shard on bank from minute one.

---

## When they 10× it

Same till, ten times the taps.

- More API boxes, connection pooling in front of Postgres (PgBouncer — a waiting room for database connections, so I don't open 10k sockets).
- Shard as above. Re-shard by merchant, not by hashing UUIDs and hoping.
- Cache the idempotency lookup if the unique index is hot. Cache is a hint. The unique index is the lock.
- Acquirer rate limits: queue *captures that already succeeded locally*? No. Authorize is still sync. I shed load at the till ("card reader busy") rather than lie.

Global: region-local authorize, because a San Francisco tap should not wait on Europe. Settlement pipelines stay in-region so the files match residency rules. PCI and GDPR are not a footnote; they are why the PAN never arrives.

---

## What I would refuse to say

- "We'll find the captured rows and send them." Without an index, a group-by-acquirer, part files, a cursor on `payment_id`, and an ack, that sentence is fan fiction.
- "Eventual consistency is fine for payments." It is fine for the thank-you email.
- "We don't store cards, so we can't recon per bank." We store `acquirer_id`.
- "I'll put the tap on Kafka so it's scalable." I'll put the tap on Kafka so it's slow.

The whole design, said once: **hold is sync and idempotent, capture is sync and idempotent, settle is a 10pm batch grouped by the bank that will pay us, recon is a ledger diff against those files, and the card number was never mine.**
