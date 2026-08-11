# Image Approval Auto-Registration Design

## Goal

Remove the circular dependency between Coupang registration and image generation. Product automation prepares and improves a draft before registration; approving the generated images automatically creates a temporary Coupang listing, then sends the existing Telegram sale-approval request. A queue item becomes terminal only after Coupang confirms sale approval.

## Corrected Workflow

The product lifecycle is:

1. `queued`: candidate winner waits for the 07:00 draft slot.
2. `draft_created`: the draft and sliced source images are ready.
3. `analyzing`: the 08:00 stage runs product analysis.
4. `analysis_completed`: safe fields have been applied.
5. `generating_images`: the 09:00 stage produces the main and detail images.
6. `awaiting_image_approval`: generated images wait for the existing human image review.
7. `registering`: an image-approval event has claimed the item for registration.
8. `awaiting_sale_approval`: Coupang temporary registration succeeded and the existing Telegram sale-approval message was sent.
9. `completed`: Coupang confirms live status `승인완료`.
10. `failed`: a terminal technical failure records its stage and message.

Draft preparation no longer moves an item directly to `ready_for_registration`. Registration is never a prerequisite for analysis or image generation.

## Image Approval Trigger

The existing image approval endpoint remains the only human gate for registration. After it commits the approval:

- find the non-terminal processing queue row for the approved draft;
- atomically change `awaiting_image_approval` to `registering` so duplicate clicks or concurrent callbacks cannot register twice;
- verify an approved main image and approved detail image set exist;
- check `coupang_product_registrations` before any external API call;
- if no registration exists, call the existing confirmed direct-registration flow in raw mode;
- if a registration already exists, reuse it without calling Coupang create-product again;
- enqueue/send the existing Telegram sale-approval notification;
- change the queue row to `awaiting_sale_approval`.

If registration or notification fails, record `failed`, the exact failure stage, and a safe error message. The already-created Coupang seller product ID remains linked so an operator can retry notification without creating a duplicate listing.

## Sale Approval Completion

The existing Telegram sale-approval callback continues to make the approval request. After the callback refreshes the live Coupang product:

- `승인완료` changes the queue row for that draft to `completed`;
- `승인대기중` keeps it `awaiting_sale_approval`;
- rejection or a terminal live error changes it to `failed` with the live status;
- repeated callbacks are idempotent and never send a second create-product request.

A lightweight reconciliation pass also checks non-terminal queue rows that already have a linked Coupang registration. This repairs state after restarts or registrations performed through another supported admin path.

## Scheduling and Backlog

The fixed product schedule remains:

- 07:00 draft preparation;
- 08:00 analysis;
- 09:00 image generation;
- every three days at 10:00 candidate discovery.

Only machine-actionable statuses (`queued`, `draft_created`, `analyzing`, `analysis_completed`, `generating_images`, `registering`) count as processing backlog. Human-wait statuses (`awaiting_image_approval`, `awaiting_sale_approval`) and terminal statuses (`completed`, `failed`) do not prevent candidate discovery. Discovery still deduplicates by supplier product and draft, so excluding human waits from the backlog does not enqueue the same product twice.

## Existing Data Migration

The migration adds the new queue statuses without deleting or recreating rows.

- Queue item 3 / draft 119 has linked seller product `16341358344` and confirmed live status `승인완료`; reconciliation sets it to `completed`.
- Queue item 2 / draft 118 has no Coupang registration and no approved generated images; it returns to `draft_created` so the 08:00 analysis and 09:00 image stages can process it in order.
- Queue item 1 / draft 117 retains its current approval-related state and is reconciled from its linked registration and image records rather than being blindly rewritten.

Migration logic is data-driven by draft and registration state; the identifiers above are verification expectations, not hard-coded update conditions.

## Safety

- Never register before both image approvals exist.
- Never call Coupang create-product when a registration row already exists.
- Use an atomic queue transition before external registration.
- Preserve the protected-draft guard and all current registration-readiness checks.
- Do not automatically press the final sale-approval action; that remains a Telegram human decision.
- Do not expose `.env`, API credentials, customer data, or raw external error bodies.
- Do not change order, shipment, return, supplier-monitor, dispatch, or Telegram polling intervals.

## Verification

Automated tests cover:

- the corrected queue stage order;
- analysis and image generation before registration;
- image approval triggering exactly one registration;
- concurrent/double approval idempotency;
- existing registration reuse;
- failure after create-product without duplicate retry;
- Telegram sale-approval notification after registration;
- live `승인완료` completion reconciliation;
- human-wait statuses not blocking discovery;
- supplier-product deduplication remaining active;
- migration of representative 117, 118, and 119 states without data loss.

Runtime verification refreshes live Coupang status, confirms draft 119 is `completed`, advances draft 118 from `draft_created` only through the scheduled stages, and verifies that no duplicate seller product was created.
