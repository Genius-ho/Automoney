const PROVIDERS=Object.freeze({chatgpt:'ChatGPT',google_gemini:'Google Gemini',anthropic_claude:'Anthropic Claude',custom:null});

export function validateManualWorkflowMetadata(context,fields={}){
  if(!context?.draft)throw workflowError('DRAFT_NOT_FOUND','Product draft not found');
  if(!context.request)throw workflowError('MAIN_IMAGE_PROMPT_MISSING','Main-image prompt is missing');
  if(context.request.state!=='current')throw workflowError('MAIN_IMAGE_PROMPT_STALE','Main-image prompt is not current');
  if(Number(fields.promptRequestId)!==Number(context.request.id))throw workflowError('PROMPT_REQUEST_MISMATCH','Prompt request does not match current draft prompt');
  if(Number(fields.promptRevision)!==Number(context.request.revision))throw workflowError('PROMPT_REVISION_MISMATCH','Prompt revision does not match current draft prompt');
  const providerCode=String(fields.providerCode||'');if(!Object.hasOwn(PROVIDERS,providerCode))throw workflowError('MANUAL_PROVIDER_INVALID','Unsupported external AI tool metadata');
  const customName=String(fields.providerDisplayName||'').trim();if(providerCode==='custom'&&!customName)throw workflowError('MANUAL_PROVIDER_NAME_REQUIRED','Custom provider display name is required');
  return{providerCode,providerDisplayName:providerCode==='custom'?customName:PROVIDERS[providerCode],promptRequestId:Number(fields.promptRequestId),promptRevision:Number(fields.promptRevision),notes:String(fields.notes||'').trim()||null};
}
function workflowError(code,message){const error=new Error(message);error.code=code;return error;}
