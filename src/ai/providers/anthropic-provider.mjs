import { createProvider, providerError } from './base-provider.mjs';
import { checkClaudeCliAvailability, runClaudeVisionReview } from '../../claude-cli-client.mjs';

// Every other capability (text_generation) stays on createProvider's
// NOT_IMPLEMENTED stub -- only vision_analysis (generated_image_review, see
// task-routing.mjs) is real so far. Deliberately never given
// image_generation/image_edit capabilities: this provider's role in the
// pipeline is reviewing images a different model (Codex) already generated,
// not generating them itself -- an independent reviewer catches blind spots
// a self-review by the same model would share.
//
// This runs through the local Claude Code CLI (subscription login, see
// claude-cli-client.mjs) rather than the Anthropic API -- the operator
// explicitly rejected paying for a separate API key when the Claude Code
// subscription already covers this. `provider_code` stays 'anthropic' in
// the DB (ai_provider_configs/ai_task_routing) since that label just means
// "uses Claude" -- API key vs. subscription CLI is an implementation detail
// this provider owns, not something the task-routing schema needs to know.
const base = createProvider({ id: 'anthropic', displayName: 'Anthropic Claude', capabilities: ['text_generation', 'vision_analysis'] });

const DEFAULT_MODEL = 'sonnet';

// images are local absolute file paths the caller already resolved
// ({ filePath }) -- this module never touches remote URLs or raw bytes,
// that's the caller's job (generated-image-qa.mjs's loadImageForVision/
// loadRemoteImageForVision).
async function analyzeImages(config = {}, { images, prompt } = {}, { checkAvailabilityImpl = checkClaudeCliAvailability, runReviewImpl = runClaudeVisionReview } = {}) {
  if (!Array.isArray(images) || images.length === 0) throw providerError('NO_IMAGES', 'analyzeImages requires at least one image');
  if (!prompt) throw providerError('MISSING_PROMPT', 'analyzeImages requires a prompt');

  const availability = await checkAvailabilityImpl({ config });
  if (!availability.available || !availability.loggedIn) {
    throw providerError('CLAUDE_CLI_UNAVAILABLE', availability.message || 'Claude Code CLI is not available or not logged in');
  }

  const model = config.model || config.defaultVisionModel || DEFAULT_MODEL;

  let result;
  try {
    result = await runReviewImpl({ config: { ...config, model }, images: images.map((image) => image.filePath), prompt });
  } catch (error) {
    throw providerError('ANTHROPIC_API_ERROR', error.message || String(error));
  }

  return { model: result.model, rawText: result.rawText, usage: result.usage || null };
}

export default { ...base, analyzeImages };
