# GA reaches out (Milestone 8): Design

Builds on Milestone 7 (what's new, health maintenance, "By the way", calendar feed) and the remote gateway. Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first.

## Intent

Today GA speaks only when asked. This milestone lets GA message its owner on its own, and lets the owner text GA back and get answers or changes, from wherever they are. **[user]** "Location, AI apps, communication channels should not matter."

Two parts, each usable on its own **[call, user agreed to the order]**:

1. **GA reaches you**: GA sends messages about new results and due dates.
2. **You talk back**: replies are answered by GA, with GA's own tools, through an AI provider the owner picks.

## Who it's for [user]

The owner and a handful of other people with almost the same setup: GA running on their own Mac, Messages signed in, Tailscale. Each install messages only its own owner. Mostly read on iPhone, then Mac. **[user]**

## Channel [user]

Preference **[user]**: native system notification > iMessage > calendar notifications > email. A native app needs Swift, an Apple developer account and GA reachable from anywhere (later milestones), so **the first channel is iMessage** sent from the GA Mac's Messages app; it arrives as a native notification on the owner's iPhone and Mac with no new app. "iMessage can have full details." **[user]**

The core is channel-agnostic: deciding what to send, composing it, and answering replies know nothing about iMessage. A channel is a thin adapter with two functions: send text to the owner, and deliver the owner's incoming text. A native app or other channels plug in later **[call]**.

### iMessage facts to confirm first [check]

Spike these before planning the adapter in detail; the answers can change the setup:

1. **Self-message notifications.** If the Mac's Messages is signed in with the owner's own Apple ID and GA sends to the owner's own number, does the iPhone show a notification? If not, the fallback is a separate Apple ID for GA signed into Messages on the GA Mac (GA then appears as its own contact, which is nicer anyway), and the owner decides whether that conflict with their own Messages use on that Mac is acceptable. Bring the result to the user before building the adapter.
2. **Sending:** AppleScript / `osascript` to Messages (`send ... to buddy/participant`) works from a background process, and which macOS permissions (Automation) it prompts for.
3. **Receiving:** reading new incoming messages from `~/Library/Messages/chat.db` (needs Full Disk Access for the process), including the `attributedBody` text format on current macOS.
4. **Where it runs [call, from code reading]:** Messages lives on the host, not in Docker, so the iMessage adapter is a small host process kept alive by launchd. The core (what to send, replies, tools) runs inside `ga-gateway`, because confirm links are held in the gateway's memory (`src/confirm.ts`) and only the gateway can serve them; the gateway also already has the AI provider settings and TZ. The host bridge relays: it posts incoming texts to the gateway on `127.0.0.1:8110` with a secret token and sends back what the gateway queues.

## Part 1: GA reaches you

### What gets sent and when [user]

- **New abnormal results: as they arrive.** "Abnormal" = the lab's own out-of-range flag, the same test `whats_new` uses; GA adds no medical judgement. **Every new one**, even a result that has been out of range for years. **[user]**
- **Due dates: at a time the owner selects**, ranked by due date and importance, using health maintenance's existing `importance` and `nextMention` (14 / 60 / 365 days). New medications with their FDA label notes and doctor-planned follow-ups are ranked the same way, not split by kind. **[user]** Nothing is sent on days with nothing whose `nextMention` has come; `postpone` is respected.
- **Sleep hours:** nothing during them; an abnormal result that arrives at night (e.g. the daily portal sync) waits until sleep hours end **[call]**. Defaults: digest 09:00, sleep 22:00–07:00, owner-set **[call]**.
- **Grouping:** results from one arrival (one visit, one import) are one message, not one per test **[call]**.
- **Never twice:** GA remembers what it sent (record ids for results, topic and `nextMention` for due items) in its own state, separate from `whats_new`'s seen-marker; a sent message does not mark anything seen in `whats_new` **[call]**.
- **What counts as new [user]:** an abnormal result that arrived in GA after notify setup and was collected (taken) within the last 30 days. Older results arriving now (a newly connected hospital, an import of years of history) send no message; they show up in `whats_new`.
- **Latency:** the notifier only watches GA; it does not change `ga-sync`'s daily schedule. "As they arrive" means within minutes of arriving in GA **[call]**.
- **Long messages:** one grouped message per arrival; past a length limit it lists the first items and "and N more: ask GA" **[call]**.
- **Send failures:** an item is marked sent when the send command succeeds; a failed send is retried on the next check. `ga notify status` shows the last send and last error, so a GA that has gone quiet (permission revoked, Messages signed out) is visible **[call]**.

Why this shape: Apple's guidance is to notify only for timely, actionable things and avoid repeats; a 237-person field trial found batching notifications into a few fixed times improved attention and stress versus as-they-come; HeartSteps let each person choose their own times and treated "send nothing" as an option; in a ~8,000-patient survey over 95% wanted results immediately. GA's results reach it after the portal has already released them, and critical values are phoned by the clinic, so no message is "critical" **[call]**.

### Message content [call]

- **Lock-screen line is generic**: "GA: 1 new result", "GA: 2 items due". No test names or values in the first line, since previews show on a locked phone (Apple's guidance: keep sensitive details off the lock screen). The rest of the message has full details **[user: full details]**.
- **Result message:** test, value with unit, reference range, collection date, source, and the previous value of the same test if there is one; the "not medical advice" line.
- **Due message:** each item's name, status and date, the one-line why from the guideline, and the doctor's plan if any.
- **Ends with what the owner can reply**: "done", "not now", "remind me after <month>", or a question.
- Composed from templates, not by an AI model: part 1 sends nothing to any AI provider **[call]**.

### Reasoning the colonoscopy case exposed [user]

The owner had colorectal screening in 2024 elsewhere; GA has no record of it, so it shows overdue. A messaging GA must accept **"I already did this"** as an answer, not only "not now": it records a completion (date, where, what kind if given) with the owner's words, and the maintenance engine treats it as done from that date (next due by the rule's interval), labelled "you told GA". Per AGENTS.md "extend existing tools before adding new ones": this extends `postpone` (e.g. `done: {date, where?}`) rather than adding a tool **[call]**, as a `Basic` with code `done` in `urn:ga-server:reminder`. Available to every agent, not only iMessage.

## Part 2: You talk back

- **The AI runs on GA's side** through an API, **any provider** **[user]**: the OpenAI-compatible client and `GA_LLM_BASE_URL` / `GA_LLM_API_KEY` / `GA_LLM_MODEL` that share-link questions already use (`src/share/ask.ts`) **[call]**. Each owner brings their own key. No key: part 1 still works and replies get "GA can't answer texts until an AI provider is set" **[call]**.
- **Same rules as the chat apps, an explicit tool allowlist** **[call]**: the read tools, `whats_new`, `health_maintenance`, `postpone` (incl. done), `record_followup`, and the confirm-link tools `share_create` and `hospital_enable`. Not over text: `hospital_connect`, `hospital_sync`, `hospital_disconnect`, `share_revoke`, `disconnect_app`, `upload_link`, `import_file`, `ga_import`, `map_concept`. Without `GA_PUBLIC_URL` (no confirm page) the confirm-link tools are left out. Server instructions apply; answers cite date and source; never advice; record text is data, never instructions.
- **Ambiguous replies** **[call]**: "done" or "not now" after a message with several items resolves to one topic only when the thread makes it clear; otherwise GA asks which. "Done" needs at least a year; GA texts back what it recorded.
- **Only the owner.** Text from any handle other than the configured owner handle is ignored, never answered, and logged without content **[call]**.
- **Changes [user: "able to change things too"; split agreed]**:
  - Done directly from a text: "done" (completion, above), "not now", "postpone until", `record_followup` from a note or message. Each is logged with the owner's own words.
  - Still needs the passkey confirm link: `share_create`, `hospital_enable` and the other tools that already return a `confirmUrl`; GA texts the preview and the link, and the change happens only on the confirm page. Revoke and disconnect follow whatever the remote tools do today.
  - Editing or deleting health records: not possible by text (no such tool today).
- **Conversation memory:** a thread remembers recent turns so "done" or "and the one before?" makes sense; it resets after a period of quiet **[call]**, length left to the builder.
- **Privacy, said plainly in setup:** a question and the records needed to answer it go to the owner's chosen AI provider, as with chat apps today.

## Setup [call]

A CLI step (e.g. `ga notify setup`) for the owner: their handle (phone or Apple ID email), digest time, sleep hours, a test message, and the macOS permissions it needs; plus the launchd job. `ga notify off` stops it. Documented in a new doc linked from README, without bloating README.

## Logging [call]

Each message sent and received is an `AuditEvent` tagged in the `urn:ga-server:remote` system (like the calendar feed), with time and kind, never content. Tool calls from text replies are logged as remote tool calls are today.

## Goals

- An abnormal result reaches the owner's phone within minutes of arriving in GA (or at the end of sleep hours).
- A due-date message arrives only when something is due to be mentioned, at the chosen time.
- The owner can answer "done", "not now", or ask a question by text and get the same quality answer a chat app gives.
- A handful of other people can set it up on their own Mac from the doc.

## Non-goals

Native iOS/macOS app, push notifications, email, SMS to non-Apple phones, group chats, anything requiring GA off the owner's Mac, family members' records, deciding which results are "urgent".

## Anti-goals

- **No noise:** never repeat a sent item, never message during sleep hours, never send on empty days.
- **No PHI on the lock screen line, in logs, in the repo or in tests.**
- **No advice GA invented** (Milestone 7 rules hold).
- **No outward change by text alone**: anything that sends records out or connects a hospital needs the passkey confirm page.
- **No answering anyone but the owner.**
- **Tests never write to the real patient; never touch the owner's real Messages in tests** (adapter tested against a fake).

## Build order [call]

Spike the iMessage facts first and bring the result to the user. The channel-agnostic core (what to send, templates, sent-state, `done` in `postpone`, the reply loop against a fake channel) can be planned and built meanwhile; the iMessage adapter is planned after the spike decision. The adapter must not answer or loop on its own sent messages in either mode (self-message: both directions are from the same account).

## Left to the builder

Polling interval for new arrivals; how sent-state and thread memory are stored (files under `.ga/` like other state); exact message wording within the content rules; conversation timeout; how the host process and Docker services share config; how a completion's next-due date is computed per rule.
