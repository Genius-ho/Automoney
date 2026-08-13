import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /password|secret|token|authorization|cookie/i;
const SENSITIVE_ASSIGNMENT = /(password|secret|token|cookie)\s*([=:])\s*[^\s;,]+/gi;
const AUTHORIZATION_HEADER = /(authorization\s*[:=]\s*)(?:[^\s;,]+(?:\s+[^\s;,]+)?)/gi;

export function redactSpeedgoValue(value) {
  if (Array.isArray(value)) return value.map(redactSpeedgoValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactSpeedgoValue(inner),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(SENSITIVE_ASSIGNMENT, '$1$2[REDACTED]')
    .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function asIsoTimestamp(now) {
  return new Date(now()).toISOString();
}

function artifactTimestamp(timestamp) {
  return timestamp.replace(/:/g, '-');
}

export async function createSpeedgoRunJournal({ rootDir, draftId, artifactDir, now = () => new Date() }) {
  const startedAt = asIsoTimestamp(now);
  const resolvedArtifactDir = resolve(
    artifactDir || join(rootDir, 'artifacts', 'speedgo', String(draftId), artifactTimestamp(startedAt)),
  );
  const resultPath = join(resolvedArtifactDir, 'result.json');
  const journal = {
    draftId,
    startedAt,
    steps: [],
  };

  await mkdir(resolvedArtifactDir, { recursive: true });

  async function persist() {
    const temporaryPath = `${resultPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(redactSpeedgoValue(journal), null, 2)}\n`, 'utf8');
    await rename(temporaryPath, resultPath);
  }

  return {
    artifactDir: resolvedArtifactDir,

    async recordStep(stage, details = {}) {
      journal.steps.push({ stage, at: asIsoTimestamp(now), details: redactSpeedgoValue(details) });
      await persist();
    },

    async recordFailure(failure) {
      journal.failure = redactSpeedgoValue(failure);
      await persist();
    },

    async setScreenshot(stage, path, metadata = {}) {
      const step = [...journal.steps].reverse().find((entry) => entry.stage === stage);
      if (!step) throw new Error(`cannot attach screenshot to unknown stage: ${stage}`);
      step.screenshot = redactSpeedgoValue({ path, ...metadata });
      await persist();
    },

    async finish(result) {
      journal.result = redactSpeedgoValue(result);
      journal.finishedAt = asIsoTimestamp(now);
      await persist();
      return redactSpeedgoValue(journal);
    },
  };
}
