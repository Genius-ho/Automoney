# Staggered Product Automation Schedule Design

## Goal

Distribute expensive product-automation work across fixed Korea Standard Time slots so draft creation, AI analysis, image generation, and candidate discovery do not compete for resources. Preserve the existing short polling intervals for orders, shipments, returns, and Telegram.

## Schedule

All fixed times use `Asia/Seoul`, independent of the Windows machine's local timezone.

| Time | Frequency | Work |
|---|---:|---|
| 07:00 | daily | Prepare at most one queued candidate as a product draft |
| 08:00 | daily | Analyze at most one draft that is ready for analysis |
| 09:00 | daily | Generate the main and detail images for at most one analyzed draft |
| 10:00 | every 3 days | Select categories, collect and score candidates, and enqueue winners |

The existing order collection, shipment, dispatch, returns, supplier monitoring, approval notification, Telegram callback polling, and daily summary schedules remain unchanged.

## Processing Stages

The existing daily product-processing cycle is split into three resumable stages with one explicit responsibility each:

1. **Draft preparation:** take the highest-priority queued candidate, reject an existing supplier-product duplicate, create or reuse its draft, slice source detail images, and mark it `ready_for_registration`.
2. **Analysis:** after the existing human registration action advances an eligible item, run Python/Codex analysis, apply only the existing safe auto-apply fields, and mark it `analysis_completed`. A successful prior analysis run is reused after restart.
3. **Image generation:** take an `analysis_completed` item, generate its main image and detail image set, and mark it `awaiting_approval`. Existing generated artifacts are reused when safe so a restart does not repeat completed work.

Each time slot processes no more than one item. A shared database lock continues to prevent two product-automation stages from running simultaneously.

## Due-Time Semantics

Each stage stores its own last successful service date in Korea time. The scheduler checks due work on its existing five-minute heartbeat.

- A stage becomes eligible at its scheduled time.
- It runs at most once per Korea calendar date.
- Restarting the server on the same day does not repeat a completed stage.
- When the server starts late, it runs only the single oldest due product stage on that heartbeat.
- Remaining overdue stages wait for later heartbeats and still use the shared lock, preventing a startup workload spike.
- A stage with no eligible queue item records a no-work completion for that date; it does not spin repeatedly.
- Candidate discovery remains once every three days and anchors its next due date to the 10:00 Korea slot.

This behavior ensures missed work can recover without launching the 07:00, 08:00, 09:00, and 10:00 jobs concurrently.

## Failures and Retries

- A stage failure records its stage and error on the queue item and emits the existing critical Telegram alert behavior.
- Codex quota exhaustion remains resumable and does not mark the item terminally failed.
- A failed stage is not retried continuously on every five-minute heartbeat. It becomes eligible at its next daily slot unless the operator explicitly retries it through an existing/manual action.
- Candidate or supplier-product deduplication remains unchanged.
- No failure in product automation stops order, shipment, return, or Telegram polling.

## Configuration and Admin Visibility

Store the four fixed schedule hours and Korea timezone as explicit application defaults. Extend the batch schedule state and admin batch status response so the operator can see:

- the next due time for draft preparation;
- the next due time for analysis;
- the next due time for image generation;
- the next due time for candidate discovery;
- the most recent outcome of each stage.

The initial database migration converts the current relative schedule into the next applicable fixed Korea slot without immediately executing multiple overdue stages.

## Safety and Compatibility

- Do not change order, shipment, return, supplier-monitor, dispatch, Telegram polling, notification, or summary intervals.
- Do not create more than one draft, analysis run, or image-generation run per corresponding daily slot.
- Do not reset existing queue items or drafts.
- Preserve existing human registration and approval gates.
- Preserve existing duplicate detection and shared batch lock behavior.
- Keep schedule calculations deterministic and testable without depending on the host timezone.

## Verification

Automated tests cover:

- exact `Asia/Seoul` slot calculation across UTC date boundaries;
- once-per-Korea-day execution;
- ordered recovery after a late server start;
- no-work completion without heartbeat spinning;
- independent 07:00, 08:00, 09:00, and three-day 10:00 state;
- one-item-per-stage limits;
- stage resume and Codex-quota behavior;
- unchanged order and Telegram interval construction;
- migration of existing schedule state without queue or draft loss.

After automated tests pass, run the server against the current database, inspect all four next-run timestamps in the admin status response, verify that Telegram polling remains configured, and confirm that no product stage runs outside its due-time rules.
