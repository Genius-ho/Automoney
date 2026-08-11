import { loadCoupangConfig, loadTelegramConfig } from './config.mjs';
import { CoupangClient } from './coupang-client.mjs';
import { handleApprovedImages } from './image-approval-registration.mjs';

function inboxError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function approveInboxImages(db, rootDir, draftId, {
  handleApprovedImagesImpl = handleApprovedImages,
  loadCoupangConfigImpl = loadCoupangConfig,
  loadTelegramConfigImpl = loadTelegramConfig,
  createCoupangClientImpl = (config) => new CoupangClient(config),
} = {}) {
  const client = db.connect ? await db.connect() : db;
  let transactionOpen = false;
  let mainImage;
  let detailSet;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const queue = (await client.query(
      `select * from processing_queue where draft_id = $1 order by id desc limit 1 for update`,
      [draftId],
    )).rows[0];
    if (!queue || queue.status !== 'awaiting_image_approval') {
      throw inboxError('QUEUE_NOT_APPROVABLE', 'Draft is not waiting for image approval');
    }

    const currentMain = (await client.query(
      `select * from generated_ai_images
        where product_draft_id = $1 and task_type = 'main_image' and status = 'approved'
        for update`,
      [draftId],
    )).rows[0] || null;
    const targetMain = (await client.query(
      `select * from generated_ai_images
        where product_draft_id = $1 and task_type = 'main_image' and status = 'uploaded'
        order by version desc limit 1 for update`,
      [draftId],
    )).rows[0] || null;
    const currentDetail = (await client.query(
      `select * from generated_ai_detail_sets
        where product_draft_id = $1 and task_type = 'detail_page' and status = 'approved'
        for update`,
      [draftId],
    )).rows[0] || null;
    const targetDetail = (await client.query(
      `select * from generated_ai_detail_sets
        where product_draft_id = $1 and task_type = 'detail_page' and status = 'uploaded'
          and image_count = 10
        order by set_version desc limit 1 for update`,
      [draftId],
    )).rows[0] || null;

    if (!targetMain || !targetDetail) {
      throw inboxError('IMAGES_NOT_READY', 'A complete uploaded main image and detail set are required');
    }
    const detailImages = (await client.query(
      `select * from generated_ai_detail_images where detail_set_id = $1 order by image_index for update`,
      [targetDetail.id],
    )).rows;
    if (Number(targetDetail.image_count) !== 10 || detailImages.length !== 10) {
      throw inboxError('IMAGES_NOT_READY', 'The uploaded detail set must contain exactly 10 images');
    }

    if (currentMain && Number(currentMain.id) !== Number(targetMain.id)) {
      await client.query(
        `update generated_ai_images set status = 'superseded', superseded_at = now(), superseded_by_image_id = $2
          where id = $1`,
        [currentMain.id, targetMain.id],
      );
    }
    if (currentDetail && Number(currentDetail.id) !== Number(targetDetail.id)) {
      await client.query(
        `update generated_ai_detail_sets set status = 'superseded', superseded_at = now(), superseded_by_set_id = $2
          where id = $1`,
        [currentDetail.id, targetDetail.id],
      );
      await client.query(
        `update generated_ai_detail_images set status = 'superseded', superseded_at = now()
          where detail_set_id = $1`,
        [currentDetail.id],
      );
    }

    mainImage = (await client.query(
      `update generated_ai_images
          set status = 'approved', approved_at = now(), rejected_at = null,
              superseded_at = null, superseded_by_image_id = null, approval_note = $3
        where product_draft_id = $1 and id = $2 and status = 'uploaded'
        returning *`,
      [draftId, targetMain.id, '관리자 승인함 일괄 승인'],
    )).rows[0];
    detailSet = (await client.query(
      `update generated_ai_detail_sets
          set status = 'approved', approved_at = now(), rejected_at = null,
              superseded_at = null, superseded_by_set_id = null, approval_note = $3
        where product_draft_id = $1 and id = $2 and status = 'uploaded'
        returning *`,
      [draftId, targetDetail.id, '관리자 승인함 일괄 승인'],
    )).rows[0];
    const approvedDetails = (await client.query(
      `update generated_ai_detail_images
          set status = 'approved', approved_at = now(), rejected_at = null, superseded_at = null
        where detail_set_id = $1
        returning *`,
      [targetDetail.id],
    )).rows;
    if (!mainImage || !detailSet || approvedDetails.length !== 10) {
      throw inboxError('IMAGE_APPROVAL_FAILED', 'The complete image set could not be approved');
    }

    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }

  const [coupangConfig, telegramConfig] = await Promise.all([
    loadCoupangConfigImpl(rootDir),
    loadTelegramConfigImpl(rootDir),
  ]);
  const autoRegistration = await handleApprovedImagesImpl(db, rootDir, draftId, {
    coupangConfig,
    telegramConfig,
    coupangClient: createCoupangClientImpl(coupangConfig),
  });
  return { mainImage, detailSet, autoRegistration };
}

function retryStatusForStage(stage) {
  const value = String(stage || '').toLowerCase();
  if (value === 'draft_creation') return 'queued';
  if (value.includes('analysis')) return 'draft_created';
  if (value.includes('image_generation')) return 'analysis_completed';
  return null;
}

export async function retryFailedInboxItem(db, queueId) {
  const queue = (await db.query(
    `select * from processing_queue where id = $1 and status = 'failed'`,
    [queueId],
  )).rows[0];
  if (!queue) throw inboxError('QUEUE_NOT_APPROVABLE', 'Failed queue item not found');
  const nextStatus = retryStatusForStage(queue.failure_stage);
  if (!nextStatus) throw inboxError('RETRY_NOT_SAFE', 'This failure requires external status reconciliation');
  const updated = (await db.query(
    `update processing_queue
        set status = $2, failure_stage = null, failure_message = null, updated_at = now()
      where id = $1 and status = 'failed'
      returning *`,
    [queueId, nextStatus],
  )).rows[0];
  if (!updated) throw inboxError('QUEUE_NOT_APPROVABLE', 'Queue item is no longer failed');
  return { queueItem: updated };
}
