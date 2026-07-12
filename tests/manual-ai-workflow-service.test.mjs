import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManualWorkflowMetadata } from '../src/manual-ai/workflow-service.mjs';

const context={draft:{id:64},request:{id:91,revision:2,state:'current',promptRendered:'ready'},sourceMainImage:{url:'/original.jpg'}};

test('manual metadata accepts supported external tools without API credentials',()=>{
  assert.deepEqual(validateManualWorkflowMetadata(context,{providerCode:'chatgpt',promptRequestId:'91',promptRevision:'2'}),{providerCode:'chatgpt',providerDisplayName:'ChatGPT',promptRequestId:91,promptRevision:2,notes:null});
  assert.deepEqual(validateManualWorkflowMetadata(context,{providerCode:'custom',providerDisplayName:'Local tool',promptRequestId:'91',promptRevision:'2',notes:'ok'}).providerDisplayName,'Local tool');
});

test('manual metadata rejects stale prompt identity and unsupported providers',()=>{
  assert.throws(()=>validateManualWorkflowMetadata(context,{providerCode:'chatgpt',promptRequestId:'90',promptRevision:'2'}),{code:'PROMPT_REQUEST_MISMATCH'});
  assert.throws(()=>validateManualWorkflowMetadata(context,{providerCode:'chatgpt',promptRequestId:'91',promptRevision:'1'}),{code:'PROMPT_REVISION_MISMATCH'});
  assert.throws(()=>validateManualWorkflowMetadata({...context,request:{...context.request,state:'stale'}},{providerCode:'chatgpt',promptRequestId:'91',promptRevision:'2'}),{code:'MAIN_IMAGE_PROMPT_STALE'});
  assert.throws(()=>validateManualWorkflowMetadata(context,{providerCode:'openai',promptRequestId:'91',promptRevision:'2'}),{code:'MANUAL_PROVIDER_INVALID'});
  assert.throws(()=>validateManualWorkflowMetadata(context,{providerCode:'custom',providerDisplayName:'',promptRequestId:'91',promptRevision:'2'}),{code:'MANUAL_PROVIDER_NAME_REQUIRED'});
});
