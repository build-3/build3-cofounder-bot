# WATI Configuration Runbook

This bot owns the conversation. WATI is just the transport. Any flow or
auto-reply configured inside the WATI dashboard will **intercept messages
before our webhook fires** and double-reply (or hijack) the conversation.

If a founder ever sees a message from the number that our code did not
produce, one of the toggles below is the culprit.

## Symptoms this runbook fixes

- Founder sends "Hey" and gets a scripted "List them separated by commas"
  follow-up. → WATI chatbot keyword flow.
- Founder gets "Thank you for the message and welcome to our WhatsApp
  account. Our team will be with you shortly!" → WATI default-assignee
  auto-reply.
- Founder gets two replies for one inbound (one from WATI, one from our
  bot). → Welcome Message flow overlap.

## Required WATI dashboard state

Log into WATI → the Build3 tenant.

### 1. Automation → Welcome Message

- **Disable** any Welcome Message flow.
- Verify: send a first-time message from a fresh number. You should get
  exactly one reply — ours.

### 2. Chatbot → Keyword / Flow builder

- **Disable** every published chatbot flow. No keyword triggers, no menu
  flows, no "Hi / Help / Start" handlers.
- Specifically kill any flow that asks:
  - "What skills are you looking for in a cofounder?"
  - "List them separated by commas"
  - Any role menu with "engineering, product, marketing, sales, design,
    operations, finance"

That flow is a WATI template, not our code. Our greeting is generated live
by `src/llm/prompts/voice_v3.ts` and never uses the word "Examples:".

### 3. Settings → Team Inbox / Default Assignee auto-reply

- **Disable** the "Our team will be with you shortly" auto-reply.
- **Disable** any away-message, office-hours, or holiday auto-reply.

### 4. Webhooks → Event subscriptions

Our webhook is the only integration that should be receiving messages.

Required subscribed events — and only these:

- `Message Received`
- `Interactive Message Reply` (button clicks)

**Do not** subscribe to:

- `Message Status` (delivered / read receipts) — our dispatcher does not
  idempotency-guard on these, so they can trigger spurious work.
- Template or broadcast-send events — we do not re-act to outbound status.

Webhook URL and header exactly as documented in [CLAUDE.md](../CLAUDE.md):

```
POST https://<PUBLIC_HOSTNAME>/webhooks/wati
Header: X-Webhook-Secret: <value of WATI_WEBHOOK_SECRET>
```

### 5. Team members / Live agents

- **Disable** the "assign to agent after N minutes" rule if one exists. The
  bot is the agent.
- If a human teammate needs to step in for a specific conversation, they
  should do it from the WATI inbox UI. Our dispatcher does not know about
  assignment and will happily continue replying on top of a human — Batch B
  will address this.

## Smoke test after changes

From a non-cohort number, send `hi`. You should see exactly ONE reply,
something like:

> Hey — I'm the matching bot for the Build3 founder cohort, so I can't help
> directly here. If you're a cohort founder getting this by mistake, ping
> the Build3 team. Otherwise: build3.com.

If you see a second message ("Thank you for the message…" or "What skills
are you looking for…"), one of the toggles above is still on.

From a cohort number, send `hi`. You should see exactly ONE reply, a warm
two-beat opener that explains how we match and asks a sharpening question.
It should not contain the word "Examples:" or "separated by commas".

## Why this runbook exists

The screenshot incident on 2026-04-21: a non-cohort user sent `Hey` and
received three messages — a WATI auto-reply, a WATI chatbot keyword flow,
and finally our bot's non-cohort rejection. The auto-replies came from
configurations a teammate had set months earlier. This runbook pins down
the dashboard state so that never happens again.

If a teammate re-enables any of the toggles above, it is a regression —
treat it like a code revert and undo it.
