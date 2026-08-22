# Coupang Telegram Sale Approval Design

## Goal

Send every newly created Coupang temporary-save listing to the configured Telegram chat for a human decision. The human can request Coupang sale approval exactly once or defer without changing external state. The first live target is product draft 119, seller product ID `16341358344`.

## Scope

This feature covers the handoff from an existing `coupang_product_registrations` row with `seller_product_id`, `status = 'created'`, and `requested = false` to a Telegram approval decision. It does not create Coupang products, edit listing content, choose stock, approve supplier purchase orders, or automatically retry a failed Coupang approval request.

## User Experience

The Telegram message contains the product draft ID, seller product ID, seller product name, live Coupang status, sale price, and option names with stock quantities. It has two Korean-labeled inline buttons meaning `Request Coupang sale approval` and `Defer`.

Selecting the approval button triggers a fresh live-state check. Approval is sent only when the registration is still unrequested and Coupang still reports its temporary-save status. The bot replaces the original message with the result. If message editing fails, it sends a new result message.

Selecting the defer button changes no database or Coupang state and updates the Telegram message accordingly.

## Data Model

Add nullable notification metadata to `coupang_product_registrations`:

- `telegram_notified_at timestamptz` records that an approval prompt was successfully sent;
- `telegram_message_id bigint` records the Telegram message used for later result editing.

Only rows with a seller product ID, `requested = false`, and no `telegram_notified_at` are notification candidates. Successful delivery and metadata persistence form the deduplication boundary. A send failure leaves the row eligible for a later scheduler sweep.

No separate decision status is needed. Approval state remains authoritative in the existing `status`, `requested`, and `approval_requested_at` fields. A defer action does not repeatedly notify; notification state must be manually cleared to send another prompt.

## Components

### Registration store

Add narrowly scoped queries to list pending Telegram sale-approval notifications and record successful delivery. The list query returns only the product and registration fields required to format a message.

### Telegram sale-approval module

Create a module separate from the supplier purchase-order bot. It owns message formatting, callback-data parsing, inline-keyboard construction, pending notification delivery, and callback handling.

Callback data uses stable, bounded identifiers:

- `approve_cp:<draftId>`
- `defer_cp:<draftId>`

The approval handler delegates the external mutation to `requestCoupangSaleApproval`. That existing function remains the single safety gate for fresh live-state verification, duplicate prevention, the Coupang API call, and persistence.

### Scheduler

Add a notification sweep and callback poller alongside the existing purchase-order Telegram jobs. Telegram `getUpdates` is a single shared stream, so one routing poller owns the offset and dispatches each recognized callback prefix to its handler. This prevents purchase-order and Coupang callbacks from consuming each other's updates.

## Safety and Idempotency

- Never request approval while formatting or sending a notification.
- Never trust the displayed message state; query the database and Coupang immediately before approval.
- Never call Coupang when the registration is missing, already requested, or no longer in temporary-save status.
- Treat repeated button clicks as a status response, not a second approval request.
- Answer Telegram callback queries even when no mutation occurs.
- Do not expose API credentials or raw Coupang responses in Telegram.
- Escape Telegram HTML in all product-controlled text.
- A defer callback performs no external or database mutation except Telegram result presentation.

## Error Handling

- Notification send failure: log the error and leave `telegram_notified_at` null for retry.
- Notification metadata persistence failure after send: report loudly. A later sweep may duplicate the prompt, but cannot duplicate Coupang approval because the approval gate remains idempotent.
- Expired callback query: continue updating the message or send a fallback result.
- Coupang API or live-state failure: show a concise failure result and leave approval state unchanged unless the guarded approval function confirms otherwise.
- Telegram message edit failure: send a new result message.

## Verification

Automated tests cover pending-row selection, notification metadata persistence, escaped message content, keyboard callbacks, unconfigured Telegram behavior, notification deduplication, one guarded approval call, repeated approval, non-temporary state, missing registration, defer behavior, expired callback handling, fallback result delivery, shared update routing, and scheduler registration.

After tests pass, send the pending notification for draft 119 and verify that its Telegram message ID and notification timestamp are persisted. Do not press the approval button on the user's behalf.
