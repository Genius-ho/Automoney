#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import mammoth from 'mammoth';
import { loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { importPromptTemplate } from '../src/image-prompt-templates.mjs';

const templates = [
  ['main_image', '대표이미지 프롬프트', '돈버는하마_대표이미지_프롬프트.docx'],
  ['detail_page', 'AI 상세페이지 프롬프트', '돈버는하마_AI_상세페이지_프롬프트.docx'],
];
const db = await createPgPool(await loadDatabaseUrl(process.cwd()));
try {
  await runSchema(db);
  for (const [templateType, templateName, sourceFileName] of templates) {
    const path = join(process.cwd(), 'prompt-templates', sourceFileName);
    const result = await mammoth.extractRawText({ buffer: await readFile(path) });
    if (!result.value) throw new Error(`No text extracted: ${sourceFileName}`);
    const saved = await importPromptTemplate(db, { templateType, templateName, sourceFileName, templateBody: result.value });
    console.log(`${templateType}=version:${saved.version}`);
  }
} finally { await db.end(); }
