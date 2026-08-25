---
title: "How I'd take a card at a coffee shop"
description: "A coffee shop card reader: hold the funds, add a tip, then send the day to each receiving bank at 10pm."
pubDate: 2026-08-25
tags:
  - systems
---

Most write-ups titled "design a payment system" are really about Stripe: wallets, marketplaces, thousands of charges a second, a lot of webhooks. I've drawn that. It doesn't fit a coffee shop.

Here, someone taps a card for a latte. They might add a tip thirty seconds later. At 10pm the store sends that day's charges to the banks that actually pay them. That is not the same as "reconcile with Visa." Visa moves the message. The money shows up at the receiving bank, so you get one file per bank, not one big Visa file.

Same shape as the [calendar note](/posts/how-id-design-google-calendar): what we're building, the API, the states a payment can be in, then the diagrams I sketched, one at a time.

I haven't worked in payments. I'm still going to say what each box does in ordinary words.

---

## What I would and wouldn't build

I'd start by asking which payment system. A register is not Stripe.

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
A coffee shop is two steps. The tap *holds* funds (`authorized`) — the bank sets the money aside. Adding a tip, or a second pastry, *captures* a final amount that may not match the hold. If nobody captures before the hold expires, the bank releases it. Hotels do this between check-in and check-out. Amazon does it between order and ship. If you merge auth and capture into one call, you can't change the amount, so you can't do the tip.

**Who is "the bank"?**  
Three different companies will answer the phone.

- The **issuer** is the customer's bank. Chase, if they tapped a Chase card.
- The **network** is Visa / Mastercard. They move the message.
- The **acquirer** (receiving bank) is who the *merchant* settled with. That is who produces the report I recon against at night.

Not storing the raw card number does **not** mean I don't know where the payment went. When I sent the tap to a bank, I picked which bank. I save that as `acquirer_id`. PCI (the card-data rules) means: don't keep the full card number. Settlement means: remember who you sent it to.

**When does the money move?**  
Authorize is a lock. Capture is "yes, take it." Settle is "the acquirer filed it and the merchant will see it in the deposit." The till must feel done at capture. Settlement can be a 10pm batch.

**What is allowed to be slow?**  
The tap is not. I would not put the "approved" response on a message queue. If the queue is slow, the person is still standing at the counter. Settlement, emails to the store's back office, reconciling with the bank: those can wait.

I'd write these down:

- Money records need to be correct immediately. It's fine if the receipt email is a few seconds late. It's not fine if the ledger is.
- If the terminal retries, we must not charge twice. That's a unique key in the database.
- If the 10pm job can't find a captured payment, the table isn't indexed for that query.
- If the prompt said receiving banks, one Visa file is the wrong target.

---

## The one number

I wouldn't invent cluster sizes. I'd say what's hard.

A large chain: tens of thousands of stores, a few taps per minute per register at peak. The daily settlement file is small next to that. Mornings are spiky. Three things matter:

1. The tap has to come back in well under a second (authorize).
2. If the reader retries, we charge once, not twice (capture).
3. At 10pm, every captured row has to land in the right bank's file.

I don't add a queue or a cache because a template said to. I add a box when it helps one of those three.

---

## The API

HTTP is fine. The card reader talks to me; I talk to a bank. The two calls that matter:

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

Refunds only from `captured` or `settled`. I'd enforce that in the database, not only in application code. Looking up a payment is a simple id lookup. I would not make the card reader wait on a queue to find out if the tap worked.

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

`WHERE state = 'captured'` has to use an index. Otherwise the 10pm job scans the whole table. In Postgres that's a btree on `state`. In DynamoDB that's a local secondary index on `state`, sorted by `captured_at`. I'd mention the index so it's obvious we're not reading every row at 10:01pm.

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

## The tap

This is the first picture. Client, payment service, gateway, bank. The names in the sketch are web-flavored (Stripe). For a till, the "client" is the terminal, and the "gateway" is whichever acquirer I routed to. Same arrows.

[![Payment processing flow: client pays, payment service auths through a gateway to a bank, and every step is recorded in a ledger](/images/payment-flow.png)](/images/payment-flow.png)

Left to right:

1. The terminal says **pay**. That is `POST /holds`.
2. My service writes `created` (or `authorized` once the acquirer answers), and **records** the attempt in the ledger. If the acquirer never comes back, the row still exists, in a state that says where it died.
3. The gateway **charges** the bank. In real life this is authorize, not "take the money." The sketch's word `charge` is doing too much work. I would label the arrow `auth` on a whiteboard and keep `capture` for later.
4. Approve comes back. I confirm to the terminal. The barista sees a receipt. The customer is already putting the card away.

The note under the ledger is the point: **every step is recorded. If something fails, the payment should show exactly where it stopped.** A tap that times out is still a row — `authorized`, `failed`, or `created` — not a missing row I'll try to reconstruct tomorrow.

I would not wait for settlement before returning. The person is at the counter. Settlement is tonight.

---

## Payment states

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

The leftover line on that sticky — you cannot refund a transaction that was never captured — is a rule about states. Cancel the hold. Don't call it a refund.

---

## Double charge is a missing unique key

If you skip this picture, a flaky Wi-Fi retry charges the customer twice.

Without a key: the reader posts `$50`, the network drops on the way back, the reader retries, I charge twice. The customer is still at the register.

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

Why I bother: if the two sides don't sum to zero, something is already wrong — you don't wait until month-end to find out. Matching a bank file is then comparing two lists. I only append rows; I don't edit a running balance in place.

The payment row and the two ledger rows should commit in the same database transaction.

---

## Nightly recon is per receiving bank

Easy to draw this one wrong.

[![Reconciliation engine compares an internal ledger to a bank file and flags a missing txn4](/images/reconciliation.png)](/images/reconciliation.png)

The sketch compares our ledger to "the bank" and finds `txn4` missing on their side. That's the right idea. The mistake is thinking "the bank" is Visa.

Visa and Mastercard will sell you network reports. If the prompt says **receiving banks**, you want each **acquirer's** settlement file: different formats, different cut-off times, different ids. Chase acquiring is not Adyen, and neither is "the Visa file."

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

Several reports. Not one.

If a job writes 10,000 lines, dies after 6,000, and reruns *without* a key, the bank sees 16,000 lines and you've charged extra. Treat the batch like a payment: it gets its own idempotency key.

The sketch is only the idea. The rest is what the bank actually accepts, how big the files get, and how you restart a worker without sending money twice.

### Authorize TPS is not a settlement API

The [ShowOffer video](https://www.youtube.com/watch?v=ruxGKk51aHo) is a Stripe-style 10k-TPS design. It puts the confirm step on Kafka. I wouldn't. Authorize is a live call to a bank; the person is waiting. A queue in the middle makes that slower. Settlement can be slow. That's the split.

They are also two different *provider APIs*:

| Path | What it is | Shape | When |
|---|---|---|---|
| Authorize / capture | ISO 8583-style online message | request/response, milliseconds | every tap |
| Settlement / clearing | a file (Visa BASE II, Mastercard IPM, or the acquirer's SFTP spec) | header + detail lines + trailer | once a day, per receiving bank |
| Result / recon | a *different* file coming back | same, hours later | next window |

Nobody is sending 10k settlement rows per second to Chase over SFTP. If someone says "10k TPS," that's the taps. The nightly job is: how many captured rows piled up during the day.

A coffee shop may never hit 10k. If they still want that number, I'd do the file-size math so 40GB isn't a surprise.

### The 40GB file is a fake requirement

10,000 taps/sec × 86,400 seconds = **864 million** captured rows in a full day, if that rate never sleeps. Ten acquirers, even split: **86.4 million rows each**, not 86,400. (86,400 is the seconds.) At 500 bytes a line that is ~43 GB *per acquirer*, ~432 GB across the system.

I would not pack that into one file.

A real clearing file has a header, detail lines, and a trailer with counts and totals. Uploads are usually capped at hundreds of MB, not tens of GB. If a 40GB upload dies at 97%, you start over. Smaller files are easier to retry.

So I split on **how many rows** (or how many bytes), not "one file per bank per day":

100,000 rows × 500 B ≈ 50 MB. That's 864 part-files per acquirer per day if traffic is even. A lot of files, each small enough to retry.

If the bank wants one *logical* batch, the header still says `batch_id` and `part 017 of 864`. They can stitch them. I don't build a 40GB object.

Sending a file is not the result. I upload a part; they ack **receipt** (checksum, line count matches the trailer) — SFTP or HTTP 200. They **process** later. Hours later a result file comes back: accepted, rejected, or amount mismatch, per line. Actual money in the store's account is a third step (ACH, a bank transfer that takes a day or two). `settled` in my database is not the same as "the wire landed."

### I wouldn't use a change feed for the cutoff

CDC (every database write becomes an event) is fine for pinging a webhook. It's a bad way to decide "what goes in Tuesday's Chase file."

Cutoff is a snapshot: every `captured` row with `captured_at` before 10pm Pacific. A change feed lags. Different shards lag differently. A row captured at 9:59:59 might show up at 10:00:20, or not. Then you either send it twice or drop it.

S3 isn't a log you append line by line. You write a whole object. Feeding CDC into S3 means buffering, rotating files, and asking "did this line land?" after a crash — all the hard parts of a file job, plus events arriving out of order.

After cutoff, Tuesday's captured set is frozen if I define it that way: new taps after 10pm belong to Wednesday. Refunds of Tuesday captures become reversal lines in Tuesday's file or a separate reversal file, not silent updates to a blob I already started.

I would **read the database**. Shard by `merchant_id`. Run the job on **replicas** so the till keeps writing. `WHERE state = 'captured' AND captured_at >= day_start AND captured_at < cutoff AND batch_part_id IS NULL ORDER BY payment_id LIMIT 100000`.

`ORDER BY payment_id` is the restart cursor. Same cutoff, same shard, same acquirer → same sequence of ids → same part bytes. The object key is deterministic: `s3://settle/{acquirer}/{date}/shard_{n}/part_{k}.csv`.

### Each part file has a status

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

When the result file lands, I don't `UPDATE` 86 million payments to `settled` in one statement. That locks the database and the registers stall.

Most lines match. I store the **mismatches** only.

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

If they reject 12 lines, those 12 stay `settling` (or go back to `captured` with a reason) and someone looks at them. The other 99,988 can settle. I wouldn't block the whole file for twelve drinks.

CDC is still useful for webhooks, search, and analytics. Not for Tuesday's Chase file.

---

## The card number never visits my server

[![PCI tokenization: card number goes browser to processor iframe to Stripe; the server only gets a token](/images/pci-tokenization.png)](/images/pci-tokenization.png)

The sketch is the **web** version: the browser posts the PAN into a processor iframe (Stripe Elements and friends). My server receives a token. Raw card number never lands in my process, which is how you collapse a mountain of PCI into a questionnaire.

A coffee shop is not a browser. The till is a certified terminal. The PAN stays in the terminal / acquirer tunnel (PCI PTS, whatever the vendor already paid lawyers to stamp). I still persist only a token, last4, brand, and **`acquirer_id`**.

That last column is how I can skip storing card numbers and still recon per bank. Those aren't in conflict. "We don't store cards, so we don't know the bank" mixes up two things. PCI means don't keep the full number. Routing is a column I wrote when I sent the tap.

---

## Webhooks are for the back office, not the tap

[![Webhook pipeline: payments DB to CDC to Kafka to a delivery worker posting to the merchant, with backoff and a DLQ](/images/webhook-delivery.png)](/images/webhook-delivery.png)

Once a row is `captured`, the store's inventory system, payroll, or "we made money" dashboard may want a ping. That path is allowed to be async:

Payments DB → change feed → queue → worker HTTP POSTs the merchant → 200 means done.

At-least-once, exponential backoff (a minute, five, thirty, two hours), then a dead-letter queue a human can see. Each delivery carries an idempotency key so *their* server can ignore my retries.

I would not send the **authorization response** through this pipe. A queue adds wait. Tap-to-pay is a straight round trip: reader → me → bank → me → reader. The picture above is what happens *after* the customer already left with the coffee.

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

## Things I wouldn't skip

- "We'll find the captured rows and send them." You still need an index, grouping by bank, small part files, a cursor on `payment_id`, and an ack.
- "It's fine if payment records catch up later." That's fine for a thank-you email, not for the ledger.
- "We don't store cards, so we can't recon per bank." We store `acquirer_id`.
- "I'll put the tap on Kafka so it scales." I'll put the tap on Kafka so the person waits.

Once through: **hold is live and safe to retry, capture is live and safe to retry, settle is a 10pm batch grouped by the bank that pays us, recon is comparing our list to their file, and the card number never sat on my server.**
