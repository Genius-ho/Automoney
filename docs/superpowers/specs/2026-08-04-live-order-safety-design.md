# Live Order Safety Design

## Goal

Make the running Mumae service safe across the Korea-midnight boundary, broker
eventual consistency, web/Telegram retries, and transient notification errors.

## Design

- Derive every daily strategy order ID from the Toss US market calendar's
  trading-session date, and pass that date explicitly into plan generation.
- Treat a submitted order with a returned Toss `orderId` as `UNCONFIRMED`, not
  `UNSENT`. Never create a fresh broker client ID until the original order is
  definitively `REJECTED` or `CANCELED`.
- Match broker history by persisted Toss order ID first. A fallback
  side/quantity/price match is allowed only inside the same trading session.
- Put retry commands behind the same web live-action gate as every other order
  mutation. Record automatic phase attempts only after a definitive submission
  outcome, while retaining a short retry cooldown for transient failures.
- Bind Telegram price input to a force-reply prompt with a finite timeout and
  keep the polling thread alive after unexpected per-update failures.
- Preserve detailed Toss API error text and query order detail when a list row
  reports `REJECTED` without a reason.
- Prune old, fully historical runtime tracking keys without removing current,
  custom, or unresolved orders.

## Safety boundaries

- No existing Toss order is canceled, modified, or resubmitted during repair.
- Tests run with `MUMAE_MODE=DRY_RUN` and empty live/Telegram credentials.
- Service remains stopped until the full suite and static checks pass.

