# State Machine — Consent & Intro

The consent flow is the load-bearing trust primitive. Every transition is logged in `events`; every invariant is tested in `tests/consent/*.test.ts`.

---

## States (table: `match_requests.status`)

```
discovering ──Accept──► proposed ──(notify target)──► awaiting_mutual
                                                          │
                                     ┌────────────────────┼────────────────────┐
                                     │ target Accept      │ target Decline     │ 72h no reply
                                     ▼                    ▼                    ▼
                               mutual_accept          declined              expired
                                     │
                                     ▼
                               intro_sent
```

## Transitions

| From | Event | To | Side effects |
|---|---|---|---|
| — (new request) | requester Accepts a candidate | `proposed` | row inserted; `expires_at = now + 72h`; event logged |
| `proposed` | notification sent to target | `awaiting_mutual` | outbound WATI interactive message with Accept/Decline |
| `awaiting_mutual` | target clicks Accept | `mutual_accept` | event logged |
| `mutual_accept` | intro message drafted + sent to both | `intro_sent` | one `intros` row; two outbound WATI sends |
| `awaiting_mutual` | target clicks Decline | `declined` | requester notified with soft message; no target identity revealed beyond what was already shown |
| `awaiting_mutual` | `now > expires_at` | `expired` | requester softly nudged; nothing sent to target |
| any | requester cancels (future) | `cancelled` | not in MVP |

## Invariants (tested)

1. **No target profile data beyond `name`+`city` is sent to the requester** until `mutual_accept`.
2. **No requester profile data beyond `name`+`city`+1-line rationale is sent to the target** until `mutual_accept`.
3. A single `(requester_id, target_id)` pair cannot have two concurrent `awaiting_mutual` rows.
4. `intro_sent` implies exactly one row in `intros` with non-null `intro_text` and `sent_at`.
5. `expired` can only be reached from `awaiting_mutual`; never from `proposed` without notification.
6. The state machine is the only writer of `match_requests.status` — no other module SHALL update that column.

## Expiry job

- Runs every 15 minutes (simple interval in MVP; Fastify plugin, not a separate worker).
- `UPDATE match_requests SET status='expired' WHERE status='awaiting_mutual' AND expires_at < now()`.
- Sends a soft nudge to the requester: _"Didn't hear back from {targetName} — happy to keep looking."_

## Failure handling

- If outbound send to the target fails, state stays at `proposed` and is retried with backoff up to 5 times. Still-failed after that: transition to `failed_delivery` (future), MVP logs an event and leaves the row for manual review.
- If intro draft fails: retry once; if still failing, send a deterministic fallback intro template and log a warning.
