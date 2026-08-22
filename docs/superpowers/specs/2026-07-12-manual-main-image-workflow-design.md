# Manual Main Image Workflow Design

## Scope

Automoney will keep the AI Provider settings screen for future automated integrations, while draft 64's main-image workflow becomes provider-agnostic and manual. Automoney prepares source material and prompts, the user creates an image in an external AI tool, and Automoney accepts, validates, compares, approves, and exports the uploaded result.

This phase implements one main image per workflow. Detail-page image generation is out of scope. No AI provider connection test, API credential, credential master key, paid API call, or automatic image generation is required or performed.

## User Flow

1. The user opens the main-image prompt section for a draft.
2. The user downloads a ZIP work package or copies the rendered/original prompt.
3. The user selects ChatGPT, Google Gemini, Anthropic Claude, or Custom/Other as descriptive metadata.
4. The user creates or edits an image outside Automoney and uploads it.
5. Automoney validates and stores the immutable original, then creates a Coupang-safe JPEG derivative.
6. The administrator compares the source and generated images and approves or rejects a version.
7. Only the current approved derivative is preferred by Coupang and Naver exports.

## Architecture

The feature uses focused modules rather than placing binary and workflow logic directly in `admin-server.mjs`:

- A package service builds ZIP contents from the current main-image prompt and source images.
- A multipart reader accepts one bounded upload and text fields without exposing credentials.
- An image service verifies signature, MIME, decode integrity, dimensions, aspect ratio, size, and pixel count, then creates the registration JPEG.
- A workflow store owns database reads, version allocation, status transitions, and export selection.
- The admin server provides HTTP routing and renders the manual workflow UI.

The workflow never reads AI API credentials. Existing provider settings remain optional and independent.

## Database Model

Create `generated_ai_images` with:

- `id`
- `product_draft_id`
- `prompt_request_id`
- `prompt_revision`
- `task_type`, fixed to `main_image` in this phase
- `workflow_mode`, fixed to `manual_external_ai`
- `provider_code`
- `provider_display_name`
- `version`
- `original_stored_url`
- `coupang_stored_url`
- `original_file_size`
- `coupang_file_size`
- `original_mime_type`
- `coupang_mime_type`, always `image/jpeg`
- `width`, `height`, both describing the 1000x1000 registration derivative
- `original_width`, `original_height`
- `sha256`
- `status`: `uploaded`, `approved`, `rejected`, or `superseded`
- `notes`
- `approval_note`
- `created_at`, `approved_at`, `rejected_at`, `superseded_at`
- `superseded_by_image_id`

The `(product_draft_id, task_type, version)` tuple is unique. A PostgreSQL partial unique index on `(product_draft_id, task_type) WHERE status = 'approved'` guarantees at most one current approval.

Approval runs in one transaction. It locks relevant rows, changes the existing approval to `superseded` with `superseded_at` and `superseded_by_image_id`, then marks the selected version `approved`. Historical rows and timestamps are never deleted. Re-approving an old version is an explicit user action. Rejection only changes the selected version to `rejected`.

## Work Package

`GET /api/product-drafts/:id/ai-workflows/main-image/package` returns `draft-{draftId}-main-image-r{promptRevision}.zip` when the draft, current prompt, rendered prompt, and source main image exist.

The ZIP contains:

- `01-source-main-image.{ext}`
- `02-prompt-rendered.txt`
- `03-prompt-original.txt`
- `04-product-info.json`
- `05-instructions.txt`
- optional `references/optional-reference-NN.{ext}` entries

Package download and prompt copy are allowed while the prompt status is `draft`. Product metadata identifies the draft, request, revision, template version, prompt hash, source URL, and `manual_external_ai` mode. Instructions preserve product shape, color, and structure; prohibit text and competitor copying; request one square image; and direct the user to upload the result back to Automoney.

## Clipboard Behavior

The rendered and original prompt buttons copy their respective values. Successful UI feedback shows `복사 완료`, the prompt revision, and the first 12 characters of the prompt hash. If `navigator.clipboard` fails or is unavailable, the UI selects a temporary textarea and uses the browser copy command.

## Upload Validation and Storage

`POST /api/product-drafts/:id/ai-workflows/main-image/upload` accepts multipart fields `image`, `providerCode`, `providerDisplayName`, `promptRequestId`, `promptRevision`, and `notes`.

Validation rules:

- At most 10MB.
- PNG, JPEG, or WebP, verified by declared MIME, file signature, and successful Sharp decode.
- At least 1000x1000, at most 5000 pixels on either side, and at most 25 megapixels.
- Square within 1 percent; non-square images are rejected and never auto-cropped.
- Prompt request, revision, current state, and draft ownership must match.
- Custom/Other requires a user-entered provider display name.

Originals are immutable under `public/generated-ai-images/drafts/{draftId}/main/manual/` with revision and monotonically increasing version in the filename.

The registration derivative is a 1000x1000 JPEG named `manual-r{revision}-v{version}-coupang-1000x1000.jpg`. Because accepted originals are at least 1000x1000, the derivative never enlarges an image. Sharp converts to sRGB and strips EXIF and unnecessary metadata. Encoding starts at quality 90 and retries at 85, 80, and 75 until the file is at most 2.5MB. Failure at quality 75 rejects the upload and leaves neither database state nor partial output. Every accepted derivative is therefore below Coupang's absolute 3MB limit.

## Admin UI

The main-image prompt area provides package download, rendered prompt copy, original prompt copy, external result upload, approve, and reject controls. Provider selection records ChatGPT, Google Gemini, Anthropic Claude, or Custom/Other metadata; Custom/Other reveals a display-name field.

The comparison area shows the immutable source image on the left and the selected external result on the right. It shows provider, prompt revision, upload version, dimensions, format, time, state, and notes. The latest version is selected by default, while older uploaded, rejected, approved, and superseded versions remain browsable. Before any upload, the UI explicitly reports that no generated image exists.

The AI Provider settings screen remains. Its heading explains that image generation currently uses a manual external-AI workflow and API settings are optional for future automation. Connection-test actions are disabled in this phase.

## Export Rules

Coupang export prefers only the `coupang_stored_url` of the current `approved` main-image row. The selected file must be JPEG, 1000x1000, square, and below 3MB. It must never use the original AI upload, WebP, an oversized file, or an `uploaded`, `rejected`, or `superseded` row. Without a valid approval, export falls back to the existing original representative image.

Naver export uses the same current approved registration derivative first and otherwise falls back to the existing original. Debug export may list all workflow metadata and replacement history, including provider, revision, version, status, stored URLs, SHA-256, timestamps, and superseding relationship, but never embeds image bytes.

The original representative image and `generated_detail_html` are immutable throughout this workflow.

## Error Handling and Safety

HTTP errors use stable codes for missing draft/prompt/source, stale prompt, ownership mismatch, unsupported media, corrupt image, size/dimension/aspect violations, derivative compression failure, and invalid transition. File writes use temporary paths and atomic finalization; failures remove temporary files. Database insertion happens only after both immutable files are complete.

No route in this workflow reads `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, or `AUTOMONEY_CREDENTIAL_MASTER_KEY`. No connection test or paid provider method is invoked.

## Verification

Unit and integration tests cover ZIP entries and revision metadata; missing prerequisites; API-key independence; PNG/JPEG/WebP uploads; signature, corruption, 10MB, dimension, pixel, and aspect rejection; WebP-to-JPEG conversion; 1000x1000 sRGB JPEG output below 3MB; stale prompt rejection; multiple immutable versions; approval superseding; unique approval enforcement; export fallback and approved selection; history preservation; source-image invariance; and `generated_detail_html` invariance.

Playwright verifies all draft 64 controls, provider metadata UI, API-key-independent enablement, empty comparison state, approval/rejection controls, and zero browser console errors, page errors, or failed requests. It also verifies `generated_detail_html` length 3896 and SHA-256 `67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758`.

The final verification runs the focused workflow tests, export tests, Playwright workflow check, and `npm.cmd test`. Paid API calls must remain zero.
