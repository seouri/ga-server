# GA texts you

GA can text you by iMessage: new out-of-range results as they arrive, and what is due once a day. You can reply to ask a question or to say you already had something. Texts work only on a Mac.

## What GA sends and when

- **New out-of-range results**, as they arrive. Only results collected within the last 30 days, and only ones that arrived after you set this up.
- **Due items**, once a day at the digest time (default 09:00): screenings, vaccines and follow-ups that are overdue, due soon, or due and of high or medium importance.
- Nothing during sleep hours (default 22:00-07:00); it waits until they end. Replies to your own texts still go out. The digest time cannot fall inside the sleep hours.
- Nothing on a day with nothing to say.
- Never the same item twice. A due item you did not act on comes back after 14, 60 or 365 days, depending on its importance.

The first line of each text is generic ("GA: 2 new results"), but iOS previews show more lines. To keep details off the lock screen, set Settings > Notifications > Messages > Show Previews > When Unlocked.

## Replying

- `done 2024` (or a month or day): you already had it. GA records it with the year and says what it recorded. Give at least the year it was done (YYYY, YYYY-MM or YYYY-MM-DD, in the past). Vaccines can't be marked done by text; import the record instead.
- `not now`, or `remind me after March`: GA holds the item back.
- Any question ("what's due?", "what was my last LDL?"): GA answers from your record.

If a reply could mean more than one item, GA asks which.

## What texts can and cannot do

Texts use a fixed list of tools: the read tools (`health_summary`, `lab_results`, `current_medications`, `current_problems`, `allergies`, `vitals`, `notes_search`, `fhir_search`, `fhir_read`, `whats_new`, `health_maintenance`, `vaccine_gaps`, `cardiovascular_risk_10yr`), `postpone`, and `share_create`, `hospital_enable` and `record_followup`.

Sharing, enabling a hospital data type and recording a follow-up are not done by text alone. GA texts you a link; you open it and press Confirm (passkey sign-in). These need `GA_PUBLIC_URL` ([chat apps](chat-apps.md)). Without it they are not offered.

Not available by text: connecting or syncing a hospital, revoking a share, importing files. Use a chat app or the CLI.

## AI provider

Replies need an AI provider. Put these in `.env`; any OpenAI-compatible provider works:

```
GA_LLM_BASE_URL=...
GA_LLM_API_KEY=...
GA_LLM_MODEL=...
```

Without a provider, alerts and the daily digest still work; replies say GA can't answer yet.

## Privacy

Your text, and the records needed to answer it, go to the AI provider you chose. Nothing else leaves your machine. GA's logs hold the time and kind of each message, never its content. Texts go through Apple's iMessage on your Mac.

## Setup

1. `ga notify setup --to <+phone or email> [--also <handle>]... [--digest HH:MM] [--sleep HH:MM-HH:MM]`. `--to` is the number your iPhone gets notifications on (sending to your own email Apple ID gives no iPhone notification); add `--also <your Apple ID email>` because iPhone replies to yourself are recorded under it.
2. In System Settings > Privacy & Security, give `node` (the path the command prints) Full Disk Access (to read your replies) and Automation > Messages (to send).
3. `docker compose restart ga-gateway`
4. `ga notify test`, then check your phone.

`ga notify status` shows the settings, last send, last error, queued messages and whether the bridge is running. `ga notify off` stops texting (restart the gateway to apply).

## Known limits

- The Mac must be awake with Messages signed in. Texts wait until it is.
- GA assumes you text yourself (your own number or Apple ID); other setups are untested.
- Delivery is at least once: if the bridge dies mid-send, you may get one duplicate.
- The conversation memory is kept for 30 minutes and is lost when the gateway restarts.
- Vaccines can't be marked done by text.
- `TZ` must be set in `.env` (`setup.sh` writes it); otherwise the gateway runs on UTC and sleep and digest times shift.
- `ga notify test` writes the outbox from the host; a rare overlap with an ack can resend one message.
