# Retrieval evaluation

Run: 2026-09-04T11:08:44.652Z
k = 5 (matches lib/workflow/decide.ts's RETRIEVAL_K)
Policies indexed: 15 (14 active + 1 superseded)

## Summary

- hit@5: 15/15 (100%) — expected policy appears somewhere in the top 5
- precision@1: 14/15 (93%) — expected policy is specifically the top-ranked result
- superseded doc (return-window-2023) ever appeared in a top-5 result: no

## Superseded-policy exclusion check

retrievePolicies filters `{superseded_by: null}` before ranking, so the 2023 doc structurally cannot appear in the results above — that part is guaranteed by construction, not by the embedding model's judgment. What's worth actually checking is whether that filter is doing necessary work, i.e. whether the superseded doc would otherwise have been a strong contender. Re-running the return-window questions against the full, unfiltered policy set (superseded doc included) answers that:

| Query | 2026 (current) rank | 2026 score | 2023 (superseded) rank | 2023 score |
|---|---|---|---|---|
| Customer wants to return an unused item in original packaging, 40 days after delivery, no damage, just changed their mind. | 2 | 0.6737 | 1 | 0.6838 |
| What is the current return window policy — how many days does a customer have to return an unused item? | 1 | 0.6741 | 2 | 0.6521 |

## Per-question results

### 1. Customer wants to return an unused item in original packaging, 40 days after delivery, no damage, just changed their mind.

- Expected: `return-window-2026`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `return-window-2026` — Return Window Policy (2026) (score 0.6737) ← expected
  2. `damage-general` — Damaged Item — General Policy (score 0.5580)
  3. `damage-perishable` — Damaged Perishable/Food Items (score 0.5258)
  4. `regional-rights-uk` — Regional Consumer Rights — United Kingdom (score 0.5107)
  5. `regional-rights-eu` — Regional Consumer Rights — European Union (score 0.4913)

### 2. What is the current return window policy — how many days does a customer have to return an unused item?

- Expected: `return-window-2026`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `return-window-2026` — Return Window Policy (2026) (score 0.6741) ← expected
  2. `regional-rights-eu` — Regional Consumer Rights — European Union (score 0.5234)
  3. `regional-rights-uk` — Regional Consumer Rights — United Kingdom (score 0.5230)
  4. `regional-rights-us` — Regional Consumer Rights — United States (score 0.5195)
  5. `damage-general` — Damaged Item — General Policy (score 0.5047)

### 3. Customer says the item arrived damaged, reported 3 days after delivery, no photo provided but describes the damage clearly.

- Expected: `damage-general`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `damage-general` — Damaged Item — General Policy (score 0.6089) ← expected
  2. `damage-perishable` — Damaged Perishable/Food Items (score 0.4879)
  3. `missing-item-policy` — Missing or Incomplete Order (score 0.4251)
  4. `damage-electronics` — Damaged/Defective Electronics (score 0.3866)
  5. `return-window-2026` — Return Window Policy (2026) (score 0.3649)

### 4. A laptop arrived dead on arrival, customer reports it 10 days after delivery.

- Expected: `damage-electronics`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `damage-electronics` — Damaged/Defective Electronics (score 0.5400) ← expected
  2. `damage-general` — Damaged Item — General Policy (score 0.4408)
  3. `late-delivery-policy` — Late Delivery Compensation (score 0.3815)
  4. `return-window-2026` — Return Window Policy (2026) (score 0.3514)
  5. `missing-item-policy` — Missing or Incomplete Order (score 0.3374)

### 5. A grocery delivery of frozen food arrived spoiled and melted, customer reports it the same day.

- Expected: `damage-perishable`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `damage-perishable` — Damaged Perishable/Food Items (score 0.4693) ← expected
  2. `damage-general` — Damaged Item — General Policy (score 0.3629)
  3. `missing-item-policy` — Missing or Incomplete Order (score 0.3343)
  4. `late-delivery-policy` — Late Delivery Compensation (score 0.3118)
  5. `damage-electronics` — Damaged/Defective Electronics (score 0.2929)

### 6. Customer says only 2 of the 3 items in their order arrived; the third one never showed up.

- Expected: `missing-item-policy`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `missing-item-policy` — Missing or Incomplete Order (score 0.5357) ← expected
  2. `late-delivery-policy` — Late Delivery Compensation (score 0.3948)
  3. `escalation-fraud-signals` — Fraud and Abuse Signals (score 0.3378)
  4. `damage-perishable` — Damaged Perishable/Food Items (score 0.3229)
  5. `damage-general` — Damaged Item — General Policy (score 0.3194)

### 7. Order arrived 9 days later than the quoted delivery date; customer is unhappy about the delay but still wants to keep the item.

- Expected: `late-delivery-policy`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `late-delivery-policy` — Late Delivery Compensation (score 0.5241) ← expected
  2. `damage-general` — Damaged Item — General Policy (score 0.4057)
  3. `missing-item-policy` — Missing or Incomplete Order (score 0.3961)
  4. `damage-electronics` — Damaged/Defective Electronics (score 0.3771)
  5. `return-window-2026` — Return Window Policy (2026) (score 0.3669)

### 8. US customer wants to cancel a standard retail purchase just because they changed their mind, citing a federal cooling-off right.

- Expected: `regional-rights-us`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `regional-rights-us` — Regional Consumer Rights — United States (score 0.6983) ← expected
  2. `regional-rights-uk` — Regional Consumer Rights — United Kingdom (score 0.5671)
  3. `regional-rights-eu` — Regional Consumer Rights — European Union (score 0.5351)
  4. `return-window-2026` — Return Window Policy (2026) (score 0.4355)
  5. `goodwill-standard` — Standard Goodwill Refund Limit (score 0.3726)

### 9. EU customer requests to withdraw from their purchase 10 days after delivery under their statutory cancellation right, no reason given.

- Expected: `regional-rights-eu`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `regional-rights-eu` — Regional Consumer Rights — European Union (score 0.6196) ← expected
  2. `regional-rights-uk` — Regional Consumer Rights — United Kingdom (score 0.5593)
  3. `regional-rights-us` — Regional Consumer Rights — United States (score 0.4184)
  4. `damage-general` — Damaged Item — General Policy (score 0.4044)
  5. `damage-electronics` — Damaged/Defective Electronics (score 0.4019)

### 10. UK customer wants to cancel under the Consumer Contracts Regulations cooling-off period, 12 days after delivery.

- Expected: `regional-rights-uk`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `regional-rights-uk` — Regional Consumer Rights — United Kingdom (score 0.7567) ← expected
  2. `regional-rights-eu` — Regional Consumer Rights — European Union (score 0.5941)
  3. `regional-rights-us` — Regional Consumer Rights — United States (score 0.4957)
  4. `return-window-2026` — Return Window Policy (2026) (score 0.4471)
  5. `damage-general` — Damaged Item — General Policy (score 0.4196)

### 11. Customer is requesting a refund of $650 on a single order.

- Expected: `escalation-high-value`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `escalation-high-value` — High-Value Refund Escalation (score 0.5080) ← expected
  2. `escalation-repeat-requests` — Repeat Refund Requests (score 0.5009)
  3. `missing-item-policy` — Missing or Incomplete Order (score 0.4822)
  4. `late-delivery-policy` — Late Delivery Compensation (score 0.4682)
  5. `goodwill-standard` — Standard Goodwill Refund Limit (score 0.4462)

### 12. This customer has submitted 4 refund requests in the past two months, this being the latest.

- Expected: `escalation-repeat-requests`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `escalation-repeat-requests` — Repeat Refund Requests (score 0.6394) ← expected
  2. `escalation-high-value` — High-Value Refund Escalation (score 0.4893)
  3. `missing-item-policy` — Missing or Incomplete Order (score 0.4160)
  4. `goodwill-standard` — Standard Goodwill Refund Limit (score 0.3604)
  5. `late-delivery-policy` — Late Delivery Compensation (score 0.3436)

### 13. High-value order with a missing-item claim and no delivery confirmation on file.

- Expected: `escalation-fraud-signals`
- hit@5: ✓ (rank 2)
- precision@1: ✗
- Retrieved:
  1. `missing-item-policy` — Missing or Incomplete Order (score 0.6069)
  2. `escalation-fraud-signals` — Fraud and Abuse Signals (score 0.4946) ← expected
  3. `late-delivery-policy` — Late Delivery Compensation (score 0.4568)
  4. `damage-perishable` — Damaged Perishable/Food Items (score 0.3912)
  5. `damage-general` — Damaged Item — General Policy (score 0.3797)

### 14. Customer wants a small $30 goodwill credit for a minor inconvenience that doesn't fit any specific refund policy.

- Expected: `goodwill-standard`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `goodwill-standard` — Standard Goodwill Refund Limit (score 0.6943) ← expected
  2. `goodwill-loyalty` — Loyalty Customer Goodwill Limit (score 0.5645)
  3. `late-delivery-policy` — Late Delivery Compensation (score 0.5610)
  4. `escalation-high-value` — High-Value Refund Escalation (score 0.4820)
  5. `escalation-repeat-requests` — Repeat Refund Requests (score 0.4769)

### 15. A VIP loyalty customer is requesting a $120 goodwill gesture for an inconvenience outside normal policy.

- Expected: `goodwill-loyalty`
- hit@5: ✓ (rank 1)
- precision@1: ✓
- Retrieved:
  1. `goodwill-loyalty` — Loyalty Customer Goodwill Limit (score 0.6894) ← expected
  2. `goodwill-standard` — Standard Goodwill Refund Limit (score 0.5836)
  3. `late-delivery-policy` — Late Delivery Compensation (score 0.4636)
  4. `escalation-high-value` — High-Value Refund Escalation (score 0.4507)
  5. `escalation-repeat-requests` — Repeat Refund Requests (score 0.4193)
