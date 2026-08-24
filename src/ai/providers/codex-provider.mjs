import { checkCodexAvailability, runCodexAnalysis } from '../../codex-client.mjs';
import { createProvider, providerError } from './base-provider.mjs';

const DEFAULT_MODEL = 'gpt-5.6-luna';
const base = createProvider({
  id: 'codex',
  displayName: 'OpenAI Codex',
  capabilities: ['text_generation', 'vision_analysis', 'image_generation', 'image_edit'],
});

async function runStructured(config = {}, { images = [], prompt, schemaPath, outputPath, cwd } = {}, {
  checkAvailabilityImpl = checkCodexAvailability,
  runAnalysisImpl = runCodexAnalysis,
} = {}) {
  if (!prompt) throw providerError('MISSING_PROMPT', 'Codex analysis requires a prompt');
  if (!schemaPath || !outputPath || !cwd) throw providerError('MISSING_ANALYSIS_PATHS', 'Codex analysis requires cwd, schemaPath, and outputPath');

  const availability = await checkAvailabilityImpl({ config });
  if (!availability.available || !availability.loggedIn) {
    throw providerError('CODEX_CLI_UNAVAILABLE', availability.message || 'Codex CLI is not available or not logged in');
  }

  const result = await runAnalysisImpl({
    config,
    cwd,
    images: images.map((image) => typeof image === 'string' ? image : image.filePath),
    schemaPath,
    outputPath,
    prompt,
  });
  if (!result.success) {
    throw providerError(result.timedOut ? 'CODEX_TIMEOUT' : 'CODEX_ANALYSIS_ERROR', result.log || 'Codex analysis failed');
  }
  if (!result.analysis || typeof result.analysis !== 'object') {
    throw providerError('CODEX_INVALID_OUTPUT', 'Codex analysis returned no structured object');
  }

  return {
    model: config.model || DEFAULT_MODEL,
    rawText: JSON.stringify(result.analysis),
    analysis: result.analysis,
    usage: null,
  };
}

export default {
  ...base,
  async generateText(config = {}, request = {}, options = {}) {
    return runStructured(config, request, options);
  },
  async analyzeImages(config = {}, request = {}, options = {}) {
    if (!Array.isArray(request.images) || request.images.length === 0) {
      throw providerError('NO_IMAGES', 'Codex image analysis requires at least one image');
    }
    return runStructured(config, request, options);
  },
};
