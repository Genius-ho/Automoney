import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FIELDS=new Set(['providerCode','providerDisplayName','promptRequestId','promptRevision','notes']);

export async function readManualImageMultipart(request,{maxBytes=10_000_000}={}){
  const contentType=String(request.headers?.['content-type']||'');const match=contentType.match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if(!match)throw multipartError('MULTIPART_REQUIRED','multipart/form-data is required');const boundary=match[1]||match[2];
  const chunks=[];let total=0;for await(const chunk of request){total+=chunk.length;if(total>maxBytes+65_536)throw multipartError('UPLOAD_TOO_LARGE','Upload exceeds 10MB');chunks.push(Buffer.from(chunk));}
  const body=Buffer.concat(chunks), marker=Buffer.from(`--${boundary}`), parts=[];let cursor=0;
  while(true){const start=body.indexOf(marker,cursor);if(start<0)break;const contentStart=start+marker.length;if(body.subarray(contentStart,contentStart+2).toString()==='--')break;const next=body.indexOf(marker,contentStart);if(next<0)break;let part=body.subarray(contentStart+2,next);if(part.subarray(-2).toString()==='\r\n')part=part.subarray(0,-2);parts.push(part);cursor=next;}
  let image=null;const fields={};
  for(const part of parts){const split=part.indexOf(Buffer.from('\r\n\r\n'));if(split<0)throw multipartError('INVALID_MULTIPART','Malformed multipart part');const headers=part.subarray(0,split).toString('utf8'),data=part.subarray(split+4);const disposition=headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);if(!disposition)throw multipartError('INVALID_MULTIPART','Missing content disposition');const [,name,filename]=disposition;if(name==='image'){if(image)throw multipartError('MULTIPLE_IMAGE_FILES','Only one image is allowed');if(data.length>maxBytes)throw multipartError('UPLOAD_TOO_LARGE','Image exceeds 10MB');const mimeType=headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase();image={buffer:data,filename:filename||'upload',mimeType};}else{if(!FIELDS.has(name))throw multipartError('UNKNOWN_MULTIPART_FIELD',`Unknown multipart field: ${name}`);fields[name]=data.toString('utf8');}}
  if(!image)throw multipartError('IMAGE_REQUIRED','Image file is required');return{image,fields};
}

export async function persistManualMainImageFiles({rootDir,draftId,revision,version,original,derivative}){
  const relative=`generated-ai-images/drafts/${draftId}/main/manual`, directory=join(rootDir,'public',...relative.split('/'));await mkdir(directory,{recursive:true});
  const ext=original.mimeType==='image/png'?'png':original.mimeType==='image/jpeg'?'jpg':'webp';const originalName=`manual-r${revision}-v${version}-original.${ext}`,coupangName=`manual-r${revision}-v${version}-coupang-1000x1000.jpg`;
  const originalPath=join(directory,originalName),coupangPath=join(directory,coupangName),token=randomUUID(),originalTemp=`${originalPath}.${token}.tmp`,coupangTemp=`${coupangPath}.${token}.tmp`;
  try{await writeFile(originalTemp,original.buffer,{flag:'wx'});await writeFile(coupangTemp,derivative.buffer,{flag:'wx'});await renameNoReplace(originalTemp,originalPath);await renameNoReplace(coupangTemp,coupangPath);}
  catch(cause){await Promise.all([rm(originalTemp,{force:true}),rm(coupangTemp,{force:true})]);if(cause.code==='EEXIST')throw multipartError('MANUAL_IMAGE_VERSION_EXISTS','Manual image version already exists');await Promise.all([rm(originalPath,{force:true}),rm(coupangPath,{force:true})]);throw cause;}
  return{originalStoredUrl:`/${relative}/${originalName}`,coupangStoredUrl:`/${relative}/${coupangName}`};
}

async function renameNoReplace(source,target){try{await writeFile(target,Buffer.alloc(0),{flag:'wx'});await rm(target);await rename(source,target);}catch(error){await rm(source,{force:true});throw error;}}
function multipartError(code,message){const error=new Error(message);error.code=code;return error;}
