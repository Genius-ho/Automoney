import { ZipArchive } from 'archiver';
import { PassThrough } from 'node:stream';
import { detectImageType } from './image-processing.mjs';

const INSTRUCTIONS = `- 원본 제품의 형태, 색상, 구조를 변경하지 않는다.
- 이미지 안에 문구를 넣지 않는다.
- 정사각형 대표이미지 1장을 만든다.
- 경쟁사 이미지는 복제하지 않는다.
- 생성 결과를 Automoney에 다시 업로드한다.
`;

export async function buildPackageEntries(context,{fetchImpl=fetch}={}) {
  const {draft,request,sourceMainImage,referenceImages=[]}=context||{};
  if(!draft)throw packageError('DRAFT_NOT_FOUND','Product draft not found');
  if(!request)throw packageError('MAIN_IMAGE_PROMPT_MISSING','Main-image prompt does not exist');
  if(request.state!=='current')throw packageError('MAIN_IMAGE_PROMPT_STALE','Main-image prompt is not current');
  if(!request.promptRendered)throw packageError('MAIN_IMAGE_PROMPT_INVALID','Rendered prompt is required');
  if(!sourceMainImage?.url)throw packageError('SOURCE_MAIN_IMAGE_MISSING','Source main image is required');
  const source=await download(sourceMainImage.url,fetchImpl);
  const info={draftId:Number(draft.id),productName:draft.sellingTitle||draft.rawName||'',requestId:Number(request.id),promptRevision:Number(request.revision||1),templateVersion:request.templateVersion??null,promptHash:request.templateHash||'',sourceImageUrl:sourceMainImage.url,workflowMode:'manual_external_ai'};
  const entries=[
    {name:`01-source-main-image.${extension(source.mimeType)}`,data:source.buffer},
    {name:'02-prompt-rendered.txt',data:Buffer.from(request.promptRendered,'utf8')},
    {name:'03-prompt-original.txt',data:Buffer.from(request.promptOriginal||'','utf8')},
    {name:'04-product-info.json',data:Buffer.from(JSON.stringify(info,null,2),'utf8')},
    {name:'05-instructions.txt',data:Buffer.from(INSTRUCTIONS,'utf8')},
  ];
  for(let index=0;index<referenceImages.length;index++){
    const reference=await download(referenceImages[index].url,fetchImpl);
    entries.push({name:`references/optional-reference-${String(index+1).padStart(2,'0')}.${extension(reference.mimeType)}`,data:reference.buffer});
  }
  return entries;
}

export async function buildMainImagePackage(context,options={}){
  const entries=await buildPackageEntries(context,options);
  const archive=new ZipArchive({zlib:{level:9}}), output=new PassThrough(),chunks=[];
  const completed=new Promise((resolve,reject)=>{output.on('data',(chunk)=>chunks.push(chunk));output.on('end',resolve);output.on('error',reject);archive.on('error',reject);});
  archive.pipe(output);for(const entry of entries)archive.append(entry.data,{name:entry.name});await archive.finalize();await completed;
  return{filename:`draft-${context.draft.id}-main-image-r${context.request.revision||1}.zip`,buffer:Buffer.concat(chunks)};
}

async function download(url,fetchImpl){const response=await fetchImpl(url);if(!response?.ok)throw packageError('SOURCE_IMAGE_DOWNLOAD_FAILED',`Could not download source image (${response?.status||'network'})`);const buffer=Buffer.from(await response.arrayBuffer());const mimeType=detectImageType(buffer);if(!mimeType)throw packageError('SOURCE_IMAGE_FORMAT_INVALID','Source image format is not PNG, JPEG, or WebP');return{buffer,mimeType};}
function extension(mime){return mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';}
function packageError(code,message){const error=new Error(message);error.code=code;return error;}
