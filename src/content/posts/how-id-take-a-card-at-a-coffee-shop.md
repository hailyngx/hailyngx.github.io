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

  10pm worker:  WHERE state='captured'
                GROUP BY acquirer_id
                one file per acquirer
                settle only after ack
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
3. Write one file per group. Name it with `acquirer_id + business_date + batch_id`.
4. Mark those rows `settling` and stamp `batch_id`.
5. Upload. Wait for ack, or pick up the ack in the morning.
6. On ack, `settled`. On nack, keep them claimable and do not emit a duplicate file — same batch idempotency key.

Recon, later:

- My ledger, filtered to that `acquirer_id` and date, versus **that acquirer's** report, keyed by `psp_reference` / `hold_id`.
- Missing on their side: I captured, they never got it — retry or ticket.
- Extra on their side: they charged something I don't have — don't "fix" it by inserting a quiet row; ticket it.
- Amount mismatch: same id, different cents — ticket.

Several reports. Not one. I would say that sentence even if the interviewer already knew it, because it is the requirement.

A partially failed batch is the other trap. If I write 10,000 lines, flush 6,000, die, and rerun *without* a batch key, the acquirer sees 16,000 lines and I have invented money. The batch is a payment. It gets a key.

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

- "We'll find the captured rows and send them." Without an index, a group-by-acquirer, a batch key, and an ack, that sentence is fan fiction.
- "Eventual consistency is fine for payments." It is fine for the thank-you email.
- "We don't store cards, so we can't recon per bank." We store `acquirer_id`.
- "I'll put the tap on Kafka so it's scalable." I'll put the tap on Kafka so it's slow.

The whole design, said once: **hold is sync and idempotent, capture is sync and idempotent, settle is a 10pm batch grouped by the bank that will pay us, recon is a ledger diff against those files, and the card number was never mine.**
