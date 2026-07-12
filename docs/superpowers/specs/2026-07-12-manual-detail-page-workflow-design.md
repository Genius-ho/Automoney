# Manual Detail Page Image Set Workflow Design

## Scope

Automoney will add a credential-free, provider-agnostic manual workflow for a ten-image `detail_page` set. Draft 64 is the first verified target. The existing manual main-image workflow, its database rows, and its files remain unchanged.

This phase never requires or reads OpenAI, Google, Anthropic, or master-key credentials. It never performs a provider connection test or paid AI request. It does not generate images. Users create ten images in an external tool and upload them as one ordered set.

The existing `generated_detail_html`, HTML detail page v2, and current Coupang/Naver HTML exports remain immutable. Approved AI detail images are an additional export representation, not a replacement for HTML.

## Draft 64 Prompt Contract

The current draft 64 `detail_page` request is request ID 8, revision 1, template version 1. The package and uploaded sets bind to that current revision rather than creating revision 2.

The ten sections are snapshotted with every package and set:

1. `hero` — Hero
2. `review` — 리뷰/평점
3. `core_values` — 3가지 핵심가치
4. `point_01` — Point 01
5. `point_02` — Point 02
6. `point_03` — Point 03
7. `comparison` — Comparison
8. `detail` — Detail
9. `color_size` — Color & Size
10. `product_info` — Product Info

The section list is a versioned metadata snapshot associated with the prompt, not an assumption made from uploaded filenames. Future prompt structures can supply a different ten-entry snapshot without changing storage or approval logic.

## Architecture

The detail workflow extends the existing `src/manual-ai/` boundary with detail-specific modules:

- A detail package builder assembles prompt files, product metadata, source images, and optional references.
- A streaming multipart receiver writes exactly ten ordered uploads to a staging directory under a bounded request size.
- A detail image processor validates each source and produces a registration JPEG without cropping or enlargement.
- A detail set store owns version allocation, set/image persistence, status transitions, and approved-set lookup.
- The admin server maps focused services to HTTP routes and renders the detail set UI.
- Export formatters append approved detail-set metadata while preserving all existing HTML fields.

Main-image service functions, constraints, routes, and UI remain intact.

## Database Model

### `generated_ai_detail_sets`

Fields:

- `id`
- `product_draft_id`
- `prompt_request_id`
- `prompt_revision`
- `task_type`, fixed to `detail_page`
- `workflow_mode`, fixed to `manual_external_ai`
- `provider_code`
- `provider_display_name`
- `set_version`
- `expected_image_count`, fixed to 10
- `image_count`, fixed to 10 for persisted sets
- `sections_json`
- `status`: `uploaded`, `approved`, `rejected`, or `superseded`
- `notes`
- `approval_note`
- `created_at`, `approved_at`, `rejected_at`, `superseded_at`
- `superseded_by_set_id`

`(product_draft_id, task_type, set_version)` is unique. A partial unique index on `(product_draft_id, task_type) WHERE status='approved'` guarantees one current approved detail set per draft.

### `generated_ai_detail_images`

Fields:

- `id`
- `detail_set_id`
- `image_index`, constrained to 1 through 10
- `section_key`, `section_label`
- `original_stored_url`, `normalized_stored_url`
- `original_width`, `original_height`
- `normalized_width`, `normalized_height`
- `original_file_size`, `normalized_file_size`
- `original_mime_type`, `normalized_mime_type`, with normalized fixed to `image/jpeg`
- `jpeg_quality`
- `sha256`
- `status`, matching the parent set lifecycle
- `created_at`, `approved_at`, `rejected_at`, `superseded_at`

`(detail_set_id, image_index)` is unique. Foreign keys preserve set membership and replacement history.

## Work Package

`GET /api/product-drafts/:id/ai-workflows/detail-page/package` returns `draft-{draftId}-detail-page-r{promptRevision}.zip` only when the draft, current detail prompt, rendered prompt, and at least one downloadable reference image exist.

The ZIP contains:

- `01-prompt-rendered.txt`
- `02-prompt-original.txt`
- `03-product-info.json`
- `04-instructions.txt`
- `main-image/source-main-image.{ext}` when available
- `detail-images/source-detail-NN.{ext}` for source-full, existing detail, and useful slice assets
- `references/optional-reference-NN.{ext}` for additional prompt references

Local archived assets are preferred. URLs are de-duplicated. Optional unavailable remote references are skipped, but package creation fails if no usable source/reference image remains.

`03-product-info.json` includes draft/product/request/template/hash metadata, `workflowMode:'manual_external_ai'`, `expectedImageCount:10`, options and available product information, and the exact ten-section snapshot.

Instructions require ten ordered mobile portrait images, unchanged product design/color, prompt-compliant and non-deceptive copy, complete section coverage, and upload back to Automoney.

Package download is independent of API provider settings and credentials.

## Prompt Copy

The detail prompt card adds package download, rendered prompt copy, and original prompt copy controls. Clipboard fallback uses a temporary selected textarea when the Clipboard API is unavailable. Feedback shows the prompt revision, `expectedImageCount=10`, and the first twelve prompt-hash characters.

## Ordered Multi-Upload

`POST /api/product-drafts/:id/ai-workflows/detail-page/upload` accepts multipart fields:

- `images[]`, exactly ten files
- `providerCode`
- `providerDisplayName`
- `promptRequestId`
- `promptRevision`
- `notes`

Any count other than ten returns HTTP 422:

```json
{
  "error": "DETAIL_IMAGE_COUNT_INVALID",
  "message": "상세페이지 이미지는 정확히 10장을 업로드해야 합니다.",
  "expectedCount": 10,
  "receivedCount": 8
}
```

No partial set, database row, or final file is created. Multipart order defines indices 1 through 10. The browser shows ten ordered previews and supports drag-and-drop reordering before constructing multipart form data.

Prompt request ID, revision, current state, and draft ownership must match. Custom/Other provider metadata requires a display name.

## Source Image Validation

Every file must pass before any set is persisted:

- PNG, JPEG, or WebP; declared MIME must match its file signature.
- Sharp must decode the complete image successfully.
- Maximum original size is 10,000,000 bytes per image.
- Width is at least 860 pixels and height at least 1100 pixels.
- Neither side exceeds 5000 pixels and total pixels do not exceed 25,000,000.
- Landscape images are rejected.
- `width / height` must be between 0.45 and 0.90 inclusive.

No crop, automatic repair, or partial acceptance occurs.

## Registration JPEG Policy

Originals are retained unchanged. Registration images are:

- JPEG
- sRGB
- stripped of EXIF, original ICC, and unnecessary metadata
- flattened onto white when the input has alpha
- resized down to width 1000 only when the original width exceeds 1000
- never enlarged
- never cropped
- encoded at qualities 92, 88, 84, then 80

The processor accepts the first quality at or below the recommended 800KB target. If quality 80 remains above 800KB but is at most 1.5MB, it is accepted. A registration image above 1.5MB at quality 80 fails the complete set. After all ten conversions, their combined normalized size must be at most 10MB. The 300KB lower recommendation is informational and does not cause artificial padding or rejection.

The later, looser 2.5MB/3MB thresholds do not apply. Main/extra product image limits and detail content image policies stay separate in code and schema.

## Atomic Persistence

Files are staged under a unique temporary directory. The receiver and processor complete these steps:

1. Stream exactly ten originals to staging with per-file and total request bounds.
2. Validate all originals.
3. Generate all ten registration JPEGs in staging.
4. Verify per-image and aggregate limits.
5. Begin a PostgreSQL transaction and lock the draft's detail-set version allocation.
6. Insert one set and ten child image rows.
7. Atomically rename the staging directory to its immutable final version directory.
8. Commit the database transaction.

Any caught error rolls back the database and removes staging and final version directories. Since PostgreSQL and the filesystem cannot share one physical transaction, cleanup compensates for failures on either side. Persisted final filenames are:

- `detail-r{revision}-v{setVersion}-{index}-original.{ext}`
- `detail-r{revision}-v{setVersion}-{index}-registered.jpg`

Existing versions are never overwritten.

## Approval Lifecycle

An uploaded set starts as `uploaded`; all ten child rows share that status. Only a set containing exactly ten valid child rows can be approved.

Approval is one database transaction:

1. Lock the current approved detail set and target set.
2. Change the existing set and its children to `superseded`, preserving approval timestamps and recording the replacement set.
3. Change the target set and its ten children to `approved`.
4. Commit under the partial unique index.

Rejection changes the set and all children to `rejected`. Historical sets remain queryable. Superseded sets are never automatically restored.

## Admin UI

Under the existing AI image detail-page prompt card, the UI states that HTML detail page v2 and the manual AI image set are managed in parallel. It explains that HTML remains the default when no AI set is approved and that approved images appear as separate export data.

Controls include:

- detail package download
- rendered/original prompt copy
- ten-file picker and drag-and-drop drop zone
- provider metadata and notes
- ordered pre-upload preview with drag reordering
- set approval/rejection and new-version upload

The latest set view shows version, prompt revision, time, count, provider, status, missing-count indicator, and ten section cards. Each card shows its number, section label, thumbnail, dimensions, status, and image-open action. The current approved set and newest uploaded set are identifiable without mixing their statuses.

## Export and Debug Output

Coupang and Naver exports retain existing `detailHtml`/`detailContent`. They add:

- `approvedAiDetailImages`
- `approvedAiDetailImageCount`
- `approvedAiDetailSetVersion`
- `approvedAiDetailProvider`
- `approvedAiDetailPromptRevision`

Only normalized JPEG URLs from the one approved, complete ten-image set are returned, ordered by image index. Original uploads and uploaded/rejected/superseded sets are excluded. Each selected image is rechecked for JPEG MIME, size at most 1.5MB, and valid URL. The aggregate is rechecked at at most 10MB.

Debug export may include metadata for all sets and children, but never image bytes. The representative-image export selection remains unchanged.

## Error Handling

Stable 4xx errors cover invalid count, unknown fields, unsupported format, MIME mismatch, corruption, byte/dimension/pixel/aspect violations, prompt mismatch/staleness, provider metadata, optimization failure with `imageIndex`, aggregate-size failure, version collision, incomplete-set approval, missing set, and invalid lifecycle transition.

Errors never contain file bytes, credential values, or authorization data.

## Verification

Tests cover API-key-independent package and copy, exact ZIP metadata, draft 64 prompt revision 1 and section snapshot, source/reference prerequisites, exact count rejection without residue, ordered multipart persistence, all formats, every validation rule, alpha-on-white JPEG conversion, no enlargement/crop, aspect preservation, metadata stripping, quality ladder, per-file and aggregate limits, full rollback, provider metadata, current prompt checks, version history, set approval/superseding, partial unique enforcement, export selection and exclusions, debug history, representative-image regression, and HTML invariance.

Playwright verifies the draft 64 controls, ten-file input, provider selection, empty state, ordered ten-slot preview UI, set approval control, and empty console/page/request error arrays. It also verifies `generated_detail_html` length 3896 and SHA-256 `67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758`.

Final verification runs focused tests, the complete `npm.cmd test`, administrator Playwright checks, manual detail Playwright checks, database invariants, and representative main-image workflow regression. Paid API calls must remain zero.
