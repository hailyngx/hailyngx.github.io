---
title: "How I'd take a card at a coffee shop"
description: "A coffee shop card reader, start to finish: hold, tip, capture, then send the day to each receiving bank. Distilled from the usual Stripe-style walkthrough, with the tap kept live."
pubDate: 2026-08-25
tags:
  - systems
---

There's a [50-minute walkthrough](https://www.youtube.com/watch?v=ruxGKk51aHo) of "design a payment system" that a lot of people watch for this interview. It's aimed at Stripe: a merchant creates a payment, the customer confirms, a worker talks to Visa, once a day you settle. That's a useful skeleton. It isn't a coffee shop.

Here, someone taps a card for a latte. They might add a tip thirty seconds later. At 10pm the store sends that day's charges to the banks that actually pay them — not one Visa file. The tap has to come back while the person is still at the counter, so I would not put "approved" on a message queue the way that video does.

This note is that skeleton, rewritten for a register, in the order I'd want to learn it: one latte, then the records, then the API, then the pictures, then the parts that actually break (double charge, the 10pm file, telling the store).

I haven't worked in payments. Ordinary words first, jargon in parentheses.

---

## 1. One latte, start to finish

Oakland 12 rings up $4.75.

1. The customer taps. Our server asks the customer's bank: "set aside $4.75." The bank says yes. That's **authorize** (a hold). Nothing has moved yet.
2. The tip screen: +$1.00. We tell the bank: "actually take $5.75." That's **capture**. The register prints a receipt. The customer leaves.
3. At 10pm a job collects every captured row for the day, grouped by the **receiving bank** (the bank that pays the store). It writes small files and uploads them.
4. The bank says "got the file." Hours later it sends a **result** file: this line posted, that line rejected. Money in the store's account is a third step, often the next day.

If you remember only the sequence: **hold → capture → file per bank → result later.**

---

## 2. What to build

I'd include:

- Tap at the counter: authorize fast, then capture
- A tip or a cancel after the tap, so the final amount can differ from the hold
- A receipt in well under a second
- A 10pm job that builds one set of files **per receiving bank**
- Refunds only after capture (or after settle)
- A way to retry hold, capture, and the nightly job without charging twice

I'd leave out unless someone asked: wallets, peer-to-peer, subscriptions, "design Stripe," product analytics.

Four questions, answered up front:

**Hold then capture, or one charge?**  
Two steps. Hotels hold at check-in and capture at checkout. Amazon authorizes at order and captures at ship. A coffee shop holds at tap and captures after the tip. One `charge` call can't change the amount.

**Who is "the bank"?**  
Three companies:

- **Issuer** — the customer's bank (Chase, if they tapped a Chase card)
- **Network** — Visa / Mastercard. They move the message
- **Acquirer** (receiving bank) — who the *store* settled with. That's who sends the nightly report

Not storing the card number does not mean you don't know where the payment went. When you sent the tap, you picked an acquirer. Save that as `acquirer_id`.

**When does money actually move?**  
Authorize = lock. Capture = "yes, take it" (the register can treat this as done). Settle = the acquirer filed it. Deposit = later.

**What can be slow?**  
Not the tap. Settlement, emails to the back office, reconciling the result file: those can wait.

The [video](https://www.youtube.com/watch?v=ruxGKk51aHo) also lists security, "exactly once," durability, and ~10,000 requests a second. For a coffee chain, the hard numbers are: authorize in well under a second, never double-charge on retry, and get every captured row into the right bank file at 10pm. I only add boxes that help those.

---

## 3. Two records: the intent, and each attempt

This is the part of the video I'd steal first.

A **payment** is the business intent: "Oakland 12 wants $5.75 from this tap." One row. It has a status: created, authorized, captured, settled, failed, refunded.

A **transaction** (I'd call it an **attempt**) is one try to talk to the bank: this authorize, that capture, a refund, a settlement submit. One payment can have several attempts — the first authorize timed out, the second succeeded, later a refund.

If you only flip a status on the payment row, you lose the history. You can't tell "we asked Chase twice" from "we asked once." Retries and disputes need the attempts.

```
Merchant     id, name, api_key, status

Payment      the intent
  payment_id
  merchant_id
  amount_authorized, amount_captured   -- cents, not 4.75
  currency
  state
  acquirer_id                          -- which receiving bank
  payment_method_token                 -- not the card number
  batch_part_id                        -- null until the 10pm job claims it

Attempt      one call to a bank
  attempt_id
  payment_id
  type          authorize | capture | refund | settle
  status        initiated | success | failed | retrying
  provider_ref  what the bank returned
  idempotency_key
  processed_at
```

Never put card number, expiry, or CVC on `Payment`. That's the next section.

---

## 4. The API

The card reader talks to us; we talk to a bank. Two calls that matter:

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

Amounts are integer cents. Same `idempotency_key` = same payment. A new key = a new charge, on purpose.

The video also has "create payment" (intent, no money) then "confirm" (customer pays). At a register those collapse: the tap *is* the confirm. I'd still keep hold and capture as two calls because of the tip.

The rest:

```
GET  /v1/payments/{payment_id}
POST /v1/payments/{payment_id}/refunds    {amount, idempotency_key}
GET  /v1/merchants/{id}/payments?state=&from=&to=
POST /internal/settlement/run             {business_date, idempotency_key}
```

`GET` returns the payment plus its attempts, so support can see the trail. Refunds only from `captured` or `settled` — enforced in the database.

---

## 5. States

A state machine is just: a payment is in one named place, and only some moves are allowed. You should not be able to settle something that was never authorized. Put that in the database, not only in application code.

[![Payment state machine from created to authorized, captured, and settled, with failed and refunded as exits](/images/payment-state-machine.png)](/images/payment-state-machine.png)

Happy path: `created → authorized → captured → settled`.

| At the store | State |
|---|---|
| Card tapped, bank said yes | `authorized` (hold) |
| Tip entered | `captured` |
| 10pm file received by that bank | still not `settled` — wait for their result |
| Their result says posted | `settled` |
| Nobody captured in time | `expired` |
| Bank said no | `failed` |

Refunds from `captured` or `settled` only. A hold that wasn't captured is cancelled or expires — don't call that a refund.

Attempts have their own little life: `initiated → success`, or `failed` then `retrying` if the error looks temporary (timeout), or stay failed if it's permanent (stolen card). Don't retry a decline in a loop.

[![Sticky note: why not merge AUTH and capture? Hotels hold at check-in; ecommerce captures after ship](/images/auth-vs-capture.png)](/images/auth-vs-capture.png)

If you merge authorize and capture, you have to guess the tip or run a second $1 charge. Two calls is the product.

---

## 6. The tap (keep it live)

[![Payment processing flow: client pays, payment service auths through a gateway to a bank, and every step is recorded in a ledger](/images/payment-flow.png)](/images/payment-flow.png)

Left to right, for a register:

1. The reader says pay → `POST /holds`.
2. We write a payment row (`created` or `authorized` once the bank answers) and a ledger line. If the bank never comes back, the row still exists and says where it stopped.
3. The gateway asks the bank to **authorize** (the sketch says "charge"; I'd label that arrow `auth`).
4. Approve comes back. Receipt prints. Customer puts the card away.

The [video](https://www.youtube.com/watch?v=ruxGKk51aHo) puts step 3 on Kafka: API returns, a worker calls the bank later. That decouples a slow bank from a website. At a counter it means the person waits on a queue. I call the bank **in the request**. Queues are for 10pm and for "tell the store's other software."

```
  Card reader                   Our payment service           Banks
  (wait for yes/no)             (orchestrator)
       |                              |
       |  hold / capture              |  auth / capture
       |  + idempotency key           |
       +----------------------------->+------------------>  Acquirer A
                                      |                    Acquirer B
                                      |  record every step
                                      v
                                Postgres (keyed by store)
                                Ledger (two rows, sum 0)

  Later: 10pm files, webhooks to the store's back office
```

I'd use Postgres. I want one transaction for "move to `captured` and write two ledger rows."

---

## 7. Don't keep the card number

[![PCI tokenization: card number goes browser to processor iframe to Stripe; the server only gets a token](/images/pci-tokenization.png)](/images/pci-tokenization.png)

If the full card number, expiry, or CVC hits your servers — API, logs, queue, database — you fall under **PCI DSS level 1**: heavy audits, encryption rules, a lot of cost. The video's first deep dive is this, and it's right.

**Tokenization:** the number goes to a certified vault (a processor iframe on the web; a certified terminal in a shop). You get back `tok_…`. You store the token. You send the token when you authorize. A leak of your database is not a leak of card numbers.

On the web: browser → processor iframe → processor → **token** → your server. On a coffee shop: the PAN stays in the terminal / bank tunnel. Same idea. You still save last4, brand, and **`acquirer_id`**.

"We don't store cards, so we don't know the bank" mixes those up. PCI = don't keep the number. Routing = a column you wrote when you sent the tap.

---

## 8. Charge once, even when things retry

This is the video's second deep dive. In payments, doing the happy path twice is the bug.

[![A pay request times out with no idempotency key, so a retry may double-charge](/images/idempotency-timeout.png)](/images/idempotency-timeout.png)

No key: reader posts $50, network drops, reader retries, you charge twice.

[![Retry with the same idempotency key hits a key store and returns the cached result](/images/idempotency-key.png)](/images/idempotency-key.png)

With key `abc123`: you store `abc123 → payment_id` and the response. Same key comes back → return the saved body. Do not call the bank again.

Four habits, in ordinary words (this is the video's list, fitted to a register):

**1. Idempotency keys on every money call.**  
Hold, capture, refund, and the 10pm batch. Unique in Postgres on `(merchant_id, idempotency_key)`. Redis can cache lookups; the unique row is what stops two machines racing. Stripe's `Idempotency-Key` header is this. Also send *your* key to the bank if they support it, so they dedupe too.

**2. Don't lose the bank's answer.**  
Dangerous sequence: bank says yes, then your process dies before you write `authorized`. The customer is held, you have no row.

On the tap I still call the bank live, but I write `created` + the key **first**, then call, then write the result. If we die in the middle, a retry with the same key sees `created` and asks the bank again **with the same key** (or an "inquire" call). It does not open a second hold.

The video's **transactional outbox** (write "please authorize" into a table in the same commit as the payment, then a worker does the side effect) is the right pattern for things that *can* be async: webhooks, "build tonight's file." I wouldn't use it to hide the tap behind Kafka.

**3. Only legal state moves, in the database.**  
`UPDATE … SET state = 'captured' WHERE state = 'authorized'`. If two workers try, one gets zero rows. A version column (optimistic locking) is the same idea. You cannot jump `created → settled`.

**4. A token on the nightly batch.**  
Each run has a `batch_id` / part id. Rows already tagged are skipped on retry. Otherwise a crashed 10pm job settles the same latte twice.

Keep the response body next to the key so a retry doesn't rebuild slightly different JSON.

---

## 9. Two ledger rows that sum to zero

[![Double-entry ledger: debit customer -100 and credit merchant +100; a refund reverses both](/images/double-ledger.png)](/images/double-ledger.png)

Every money event writes two lines that add to zero. Authorize $4.75:

- debit `customer_hold` 475
- credit `merchant_receivable` 475

A refund reverses the pair. If they don't sum to zero, something is already wrong — you don't wait until month-end. Matching a bank file is then comparing two lists. Append only; don't edit a running total in place.

Payment row + two ledger rows: same database commit.

---

## 10. 10pm: files per receiving bank

The video's settlement step is: cron at midnight, find authorized (or captured) payments, send a batch, mark settled. That's the right *shape*. It doesn't say how big the file is, how you restart a worker, or that "the bank" is each acquirer.

[![Reconciliation engine compares an internal ledger to a bank file and flags a missing txn4](/images/reconciliation.png)](/images/reconciliation.png)

Visa will sell you a network report. If the prompt said receiving banks, you want **Chase's file, Adyen's file, …** — different formats, different cut-offs.

**Authorize is not settlement.** The tap is a fast request/response. Settlement is a file: header, detail lines, trailer with counts and totals. They ack **receipt** ("we got it"). They **process** later. A **result** file comes back. Deposit is later still.

### Don't make one 40GB file

If someone uses the video's 10,000 taps/sec all day: 10,000 × 86,400 seconds = **864 million** rows. Ten banks, even split: **86.4 million** each, not 86,400 (that's the seconds). At 500 bytes a line, ~43 GB per bank.

Uploads are usually capped at hundreds of MB. A 40GB put that dies at 97% starts over. Split on row count: 100,000 rows ≈ 50 MB → hundreds of **part files** per bank per day. Header can still say `batch_id`, `part 17 of 864`.

Receipt ack ≠ result. Don't flip every payment to `settled` just because SFTP succeeded.

### Don't use a change feed for the cutoff

CDC (every database write becomes an event) is fine for webhooks. It's a bad way to decide "Tuesday's Chase file." Cutoff is a snapshot: `captured_at` before 10pm. Feeds lag; shards lag differently. You double-send or drop a row.

S3 isn't a log you append line by line. You write a whole object.

After 10pm, new taps belong to Wednesday. Read **replicas**, shard by `merchant_id`:

```
WHERE state = 'captured'
  AND captured_at >= day_start AND captured_at < cutoff
  AND batch_part_id IS NULL
ORDER BY payment_id
LIMIT 100000
```

Same sort order → same file bytes if you restart. Object key: `s3://settle/{acquirer}/{date}/shard_{n}/part_{k}.csv`.

```
SettlementPart
  acquirer_id, business_date, shard_id, part_seq
  first_payment_id, last_payment_id
  row_count, amount_cents
  s3_uri
  state     writing | uploaded | submitted | ack_receipt | result_applied
  idempotency_key
```

Worker, one shard, one bank:

1. Select the next 100k ids from the replica. Empty → done.
2. Write the file (trailer = count + sum). Crash here: abort the partial upload, rebuild the same key.
3. **One transaction on the primary:** save the part row; `UPDATE payments SET state = 'settling', batch_part_id = $part WHERE id IN (…) AND state = 'captured'`. The `AND state = 'captured'` stops a double claim.
4. A separate submitter uploads `uploaded` parts. Crash after S3, before send: submitter retries the same file id.
5. Receipt → `ack_receipt`. Not `settled` yet.

Restart cursor: last committed `last_payment_id`, then `payment_id > that`. Uncommitted work is still `captured` and will be picked again. That's why we sort.

### Recon: store mismatches, don't UPDATE 86 million rows at once

When the result file lands, most lines match. Keep an **exception** table for the rest (missing on their side, extra on theirs, amount differs). If the trailer matches, mark the **part** done, then move payments to `settled` in chunks of 1,000–10,000 ids on the store's shard, with a cursor. Crash, continue.

Twelve rejected lines: those twelve stay `settling` (or go back to `captured` with a reason). The other 99,988 can settle. Don't block the whole file.

---

## 11. Tell the store later (webhooks)

[![Webhook pipeline: payments DB to CDC to Kafka to a delivery worker posting to the merchant, with backoff and a DLQ](/images/webhook-delivery.png)](/images/webhook-delivery.png)

The store's other software (inventory, payroll) may want a ping when a payment is captured. They should not poll every second. That's a **webhook**: we POST them.

The video's third deep dive: do **not** wait for their server before you print the receipt. In the same database commit that sets `captured`, insert a `webhook_events` row. A dispatcher sends it later.

Production habits from that section, kept:

- Exponential backoff (a minute, five, thirty, two hours)
- Status on each event: pending / delivered / failed
- Dead-letter queue after too many tries
- **HMAC** signature with a shared secret so they can tell it's really us
- Idempotency key on the payload so *they* can ignore our retries

```
WebhookEvent
  event_id, merchant_id, type, payload
  status, attempts, last_attempt_at
```

Plus a small config table: their URL and signing secret.

If the bank is down *during the tap*: fail fast, retry only timeouts, optional backup acquirer as a **new** hold (new key), not a silent second charge.

---

## 12. If this gets bigger

**Shard key** (which id you split data on):

- `payment_id` — writes spread evenly; a store's day and a bank's 10pm file hit every machine. I'd skip this first.
- `merchant_id` / `store_id` — Oakland 12 lives together. Default. Watch a huge franchise stuffed under one id.
- `acquirer_id` — 10pm grouping is local, but one store that uses two banks spans machines. Only if settlement is the main workflow.

I'd shard by store, run the 10pm job per shard, then stitch parts per bank if they want one logical batch.

Ten times the taps: more API machines, a connection pool in front of Postgres (PgBouncer — a waiting room so you don't open 10,000 database sockets), cache the idempotency lookup if it's hot (cache is a hint; the unique row is the lock). Authorize stays live. If the bank is rate-limiting, the reader says busy — don't lie with a queue.

Global: authorize near the store. Keep settlement files in-region (residency rules). Same reason the card number never arrives.

---

## Recap

From the [video](https://www.youtube.com/watch?v=ruxGKk51aHo): payment vs attempt, don't store cards, keys + legal state moves + a batch token, webhooks off the hot path.

From the register: the tap is live, capture is a second call for the tip, 10pm is **small files per receiving bank**, recon is a result file and an exception list — not one Visa dump and not one 40GB upload.

Once through: **hold is live and safe to retry, capture is live and safe to retry, settle is tonight grouped by the bank that pays us, recon is comparing two lists, and the card number never sat on our server.**
