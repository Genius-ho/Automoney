import { createHash } from 'node:crypto';
export function computeImagePromptState(request, activeTemplate) {
 if (!request) return {state:'no_request',isLatest:false,issues:['no_request']};
 if (!activeTemplate) return {state:'template_missing',isLatest:false,issues:['template_missing']};
 const activeHash=createHash('sha256').update(activeTemplate.template_body).digest('hex'); const originalHash=createHash('sha256').update(request.prompt_original||'').digest('hex');
 if (Number(request.template_version||0)<Number(activeTemplate.version)) return {state:'stale_template_version',isLatest:false,issues:['stale_template_version'],activeTemplateHash:activeHash};
 if (request.template_hash!==originalHash || request.template_hash!==activeHash) return {state:'original_mismatch',isLatest:false,issues:['original_mismatch'],activeTemplateHash:activeHash};
 if (!String(request.prompt_rendered||'').trim()) return {state:'rendered_missing',isLatest:false,issues:['rendered_missing'],activeTemplateHash:activeHash};
 return {state:'current',isLatest:true,issues:[],activeTemplateHash:activeHash};
}
