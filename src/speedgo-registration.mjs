import { join } from 'node:path';

import { chromium } from 'playwright';

import { exportProductDraft } from './admin-store.mjs';
import { NaverCommerceClient } from './naver-commerce-client.mjs';
import { postProcessNaverRegistration } from './naver-registration-post-process.mjs';
import {
  completeNaverSpeedgoRegistration,
  reserveNaverSpeedgoRegistration,
} from './naver-registration-store.mjs';
import { createSpeedgoRunJournal, redactSpeedgoValue } from './speedgo-artifacts.mjs';
import { createSpeedgoBrowser } from './speedgo-browser.mjs';
import { buildSpeedgoRegistrationInput } from './speedgo-registration-input.mjs';

const KNOWN_ERROR_CODES = new Set([
  'DRAFT_NOT_FOUND',
  'DRAFT_BLOCKED',
  'DRAFT_NOT_READY',
  'NAVER_REGISTRATION_ALREADY_LINKED',
  'SPEEDGO_SESSION_EXPIRED',
  'SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND',
  'SPEEDGO_AMBIGUOUS_PRODUCT',
  'SPEEDGO_TRANSFER_UI_NOT_FOUND',
  'SPEEDGO_FORM_VALIDATION_FAILED',
  'SPEEDGO_SUBMIT_FAILED',
  'UNRESOLVED_EXTERNAL_RESULT',
  'NAVER_VERIFY_FAILED',
  'NAVER_POST_PROCESS_FAILED',
  'NAVER_POST_PROCESS_INVALID_INPUT',
  'IMAGES_NOT_APPROVED',
  'PERSISTENCE_FAILED',
]);

function registrationError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function mapError(error, code, message) {
  if (KNOWN_ERROR_CODES.has(error?.code)) return error;
  return registrationError(code, message);
}

function normalizedId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function originProductNoFromExactChannelSearch(result, channelProductNo, input) {
  const expectedChannel = String(channelProductNo || '');
  const expectedSupplier = String(input?.supplierProductNo || '');
  const matches = [];
  for (const content of result?.contents || []) {
    for (const channel of content?.channelProducts || []) {
      if (String(channel?.channelProductNo || '') !== expectedChannel) continue;
      // Not also requiring an exact channel.name match against our own
      // submitted title -- same reasoning as
      // channelProductNoFromSpeedgoSuccessEntries in speedgo-browser.mjs:
      // Speedgo's own duplicate-word removal can alter the live product name
      // (confirmed live 2026-08-17, draft 11), and channelProductNo (already
      // the exact search key above) + sellerManagementCode are already two
      // independent, reliable real identifiers -- an exact name match on top
      // only adds a false-negative risk, not real safety.
      if (String(channel?.sellerManagementCode || '') !== expectedSupplier) continue;
      const originProductNo = normalizedId(channel?.originProductNo || content?.originProductNo);
      if (originProductNo) matches.push(originProductNo);
    }
  }
  return new Set(matches).size === 1 ? matches[0] : null;
}

function channelProductNoFromLiveProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const seen = new WeakSet();
  const queue = [product];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
      if (['channelproductno', 'channelproductnumber', 'smartstorechannelproductno'].includes(normalizedKey)) {
        const id = normalizedId(value);
        if (id) return id;
      }
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function fallbackBrowserPage(browser) {
  try {
    return browser?.page || null;
  } catch {
    return null;
  }
}

function currentUrl(page, browser) {
  try {
    return (page || fallbackBrowserPage(browser))?.url?.() || null;
  } catch {
    return null;
  }
}

function compactFailure(error, stage, page, browser) {
  return redactSpeedgoValue({
    code: error?.code || 'SPEEDGO_SUBMIT_FAILED',
    message: error?.message || 'Speedgo registration failed',
    stage,
    url: currentUrl(page, browser),
    selectorName: error?.selectorName,
    operation: error?.operation,
    status: error?.status,
  });
}

export async function runSpeedgoNaverRegistration(db, rootDir, draftId, options = {}) {
  const {
    confirm = false,
    headless = false,
    artifactDir,
    browserImpl,
    naverConfig,
    clientImpl,
    chromiumImpl = chromium,
    exportDraftImpl = exportProductDraft,
    buildInputImpl = buildSpeedgoRegistrationInput,
    createJournalImpl = createSpeedgoRunJournal,
    createBrowserImpl = createSpeedgoBrowser,
    createClientImpl = (config) => new NaverCommerceClient(config),
    reserveImpl = reserveNaverSpeedgoRegistration,
    completeImpl = completeNaverSpeedgoRegistration,
    postProcessImpl = postProcessNaverRegistration,
    ...postProcessDeps
  } = options;

  let browser = null;
  let page = null;
  let journal = null;
  let screenshotSequence = 0;
  let stage = 'draft_loaded';
  let primaryError = null;
  let result = null;

  const recordStep = async (step, details = {}) => {
    try {
      await journal.recordStep(step, details);
    } catch (error) {
      throw mapError(error, 'PERSISTENCE_FAILED', 'Speedgo run journal could not be persisted');
    }
  };

  const recordBrowserStage = async (step, operation) => {
    stage = step;
    try {
      await operation();
    } catch (error) {
      throw mapError(error, 'SPEEDGO_SUBMIT_FAILED', `Speedgo browser stage failed: ${step}`);
    }

    screenshotSequence += 1;
    const screenshot = join(journal.artifactDir, `${String(screenshotSequence).padStart(2, '0')}-${step}.png`);
    try {
      await browser.screenshot(screenshot);
    } catch (error) {
      throw mapError(error, 'SPEEDGO_SUBMIT_FAILED', `Speedgo screenshot failed: ${step}`);
    }
    await recordStep(step, { url: currentUrl(page, browser) });
    try {
      await journal.setScreenshot(step, screenshot, { url: currentUrl(page, browser) });
    } catch (error) {
      throw mapError(error, 'PERSISTENCE_FAILED', 'Speedgo screenshot metadata could not be persisted');
    }
  };

  try {
    let draft;
    try {
      draft = await exportDraftImpl(db, draftId, 'naver');
    } catch (error) {
      throw mapError(error, 'PERSISTENCE_FAILED', 'Naver product draft could not be loaded');
    }

    let input;
    try {
      input = buildInputImpl(draft, { draftId });
    } catch (error) {
      throw mapError(error, 'DRAFT_NOT_READY', 'Naver product draft is not ready');
    }

    try {
      journal = await createJournalImpl({ rootDir, draftId, artifactDir });
    } catch (error) {
      throw mapError(error, 'PERSISTENCE_FAILED', 'Speedgo run journal could not be created');
    }
    await recordStep('draft_loaded', {
      draftId,
      supplierProductNo: input.supplierProductNo,
      requestHash: input.requestHash,
    });

    try {
      browser = browserImpl || createBrowserImpl({ chromiumImpl, rootDir, headless });
    } catch (error) {
      throw mapError(error, 'SPEEDGO_SUBMIT_FAILED', 'Speedgo browser could not be created');
    }

    await recordBrowserStage('open', async () => {
      const openedPage = await browser.open();
      page = openedPage || fallbackBrowserPage(browser);
    });
    await recordBrowserStage('session_verified', () => browser.assertAuthenticated());
    await recordBrowserStage('supplier_product_found', () => browser.findSupplierProduct(input));
    await recordBrowserStage('speedgo_transfer_opened', () => browser.openSpeedgoTransfer());
    await recordBrowserStage('naver_form_selected', () => browser.selectNaverMarket());
    await recordBrowserStage('fields_filled', () => browser.fillNaverForm(input));

    if (confirm !== true) {
      await recordBrowserStage('preview', () => browser.preview());
      result = {
        status: 'dry_run',
        dryRun: true,
        draftId,
        supplierProductNo: input.supplierProductNo,
      };
    } else {
      stage = 'reservation';
      let reservation;
      try {
        reservation = await reserveImpl(db, draftId, { requestHash: input.requestHash });
      } catch (error) {
        throw mapError(error, 'PERSISTENCE_FAILED', 'Naver registration could not be reserved');
      }

      let ids;
      if (reservation?.action === 'reserved') {
        try {
          await recordBrowserStage('submitted', async () => {
            ids = await browser.submitAndResolveIds();
          });
        } catch (error) {
          // submitAndResolveIds' live capture (network response / URL
          // pattern / popup success text) reliably misses Speedgo's
          // confirmation signal even when the transfer itself already
          // succeeded -- confirmed live 2026-08-14 across 4/4 real
          // registrations, every one recovered cleanly on a second CLI
          // invocation via this exact recoverRegistration() list lookup.
          // Fall back to it in the same run instead of making the caller
          // invoke this twice.
          if (error?.code !== 'UNRESOLVED_EXTERNAL_RESULT') throw error;
          await recordBrowserStage('recovered', async () => {
            ids = await browser.recoverRegistration(input);
          });
        }
      } else if (reservation?.action === 'recover') {
        await recordBrowserStage('recovered', async () => {
          ids = await browser.recoverRegistration(input);
        });
      } else if (reservation?.action === 'already_linked') {
        ids = {
          originProductNo: reservation.registration?.originProductNo,
          channelProductNo: reservation.registration?.channelProductNo,
        };
      } else {
        throw registrationError(
          'NAVER_REGISTRATION_ALREADY_LINKED',
          'Draft has an incompatible Naver registration reservation',
        );
      }

      let originProductNo = normalizedId(ids?.originProductNo);
      let channelProductNo = normalizedId(ids?.channelProductNo);
      let client;
      try {
        client = clientImpl || createClientImpl(naverConfig);
      } catch (error) {
        throw mapError(error, 'NAVER_VERIFY_FAILED', 'Naver client could not be created');
      }

      if (!originProductNo && channelProductNo) {
        let searchResult;
        try {
          searchResult = await client.searchProducts({
            searchKeywordType: 'CHANNEL_PRODUCT_NO',
            channelProductNos: [Number(channelProductNo)],
            page: 1,
            size: 10,
          });
        } catch (error) {
          throw mapError(error, 'NAVER_VERIFY_FAILED', 'Naver registration recovery search failed');
        }
        originProductNo = originProductNoFromExactChannelSearch(
          searchResult,
          channelProductNo,
          input,
        );
      }

      if (!originProductNo) {
        throw registrationError(
          'UNRESOLVED_EXTERNAL_RESULT',
          'No verified Naver origin product number was resolved',
        );
      }
      await recordStep('registration_ids_resolved', {
        originProductNo,
        channelProductNo,
      });

      stage = 'naver_verified';
      let verifiedProduct;
      try {
        verifiedProduct = await client.getProduct(originProductNo);
        if (!verifiedProduct || typeof verifiedProduct !== 'object') {
          throw new Error('Naver returned no live product');
        }
      } catch (error) {
        throw mapError(error, 'NAVER_VERIFY_FAILED', 'Naver registration could not be verified');
      }

      channelProductNo ||= channelProductNoFromLiveProduct(verifiedProduct);
      if (!channelProductNo) {
        throw registrationError(
          'PERSISTENCE_FAILED',
          'A verified channel product number is required to persist the registration',
        );
      }
      await recordStep('naver_verified', { originProductNo, channelProductNo });

      let registration = reservation.registration;
      if (reservation.action === 'reserved' || reservation.action === 'recover') {
        stage = 'db_reserved_and_completed';
        try {
          registration = await completeImpl(db, draftId, {
            requestHash: input.requestHash,
            originProductNo,
            channelProductNo,
          });
        } catch (error) {
          throw mapError(error, 'PERSISTENCE_FAILED', 'Naver registration identifiers could not be persisted');
        }
        if (!registration) {
          throw registrationError(
            'PERSISTENCE_FAILED',
            'The matching Naver registration reservation was not completed',
          );
        }
        await recordStep('db_reserved_and_completed', { originProductNo, channelProductNo });
      }

      stage = 'post_processed';
      let postProcessResult;
      try {
        postProcessResult = await postProcessImpl(db, rootDir, draftId, {
          ...postProcessDeps,
          originProductNo,
          channelProductNo,
          salePrice: input.salePrice,
          naverConfig,
          clientImpl: client,
          verifiedProduct,
        });
      } catch (error) {
        throw mapError(error, 'NAVER_POST_PROCESS_FAILED', 'Naver registration post-processing failed');
      }
      await recordStep('post_processed', {
        originProductNo,
        channelProductNo,
        verified: postProcessResult?.verified === true,
      });
      await recordStep('completed', { originProductNo, channelProductNo });

      result = {
        status: 'completed',
        dryRun: false,
        draftId,
        supplierProductNo: input.supplierProductNo,
        originProductNo,
        channelProductNo,
        linkedVia: registration?.linkedVia || 'speedgo_automation',
        verified: true,
        postProcess: postProcessResult,
      };
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (browser) {
      const pageAvailable = Boolean(page || fallbackBrowserPage(browser));

      if (pageAvailable && journal) {
        screenshotSequence += 1;
        const terminalPath = join(
          journal.artifactDir,
          `${String(screenshotSequence).padStart(2, '0')}-terminal.png`,
        );
        let terminalScreenshotCaptured = false;
        try {
          await browser.screenshot(terminalPath);
          terminalScreenshotCaptured = true;
        } catch (error) {
          if (!primaryError) {
            primaryError = mapError(error, 'SPEEDGO_SUBMIT_FAILED', 'Terminal screenshot could not be captured');
            stage = 'terminal';
          }
        }

        if (terminalScreenshotCaptured) {
          let terminalStepRecorded = false;
          try {
            await journal.recordStep('terminal', { url: currentUrl(page, browser) });
            terminalStepRecorded = true;
          } catch (error) {
            if (!primaryError) {
              primaryError = mapError(error, 'PERSISTENCE_FAILED', 'Terminal journal step could not be persisted');
              stage = 'terminal';
            }
          }

          if (terminalStepRecorded) {
            try {
              await journal.setScreenshot('terminal', terminalPath, { url: currentUrl(page, browser) });
            } catch (error) {
              if (!primaryError) {
                primaryError = mapError(error, 'PERSISTENCE_FAILED', 'Terminal screenshot metadata could not be persisted');
                stage = 'terminal';
              }
            }
          }
        }
      }

      try {
        await browser.close();
      } catch (error) {
        if (!primaryError) {
          primaryError = mapError(error, 'SPEEDGO_SUBMIT_FAILED', 'Speedgo browser could not be closed');
          stage = 'close';
        }
      }
    }
  }

  if (primaryError) {
    if (journal) {
      try {
        await journal.recordFailure(compactFailure(primaryError, stage, page, browser));
      } catch {
        // Artifact cleanup must never replace the operation's primary error.
      }
    }
    throw primaryError;
  }

  try {
    await journal.finish(result);
  } catch (error) {
    const finishError = mapError(error, 'PERSISTENCE_FAILED', 'Speedgo run journal could not be finalized');
    try {
      await journal.recordFailure(compactFailure(finishError, 'finish', page, browser));
    } catch {
      // Retain the journal finalization error.
    }
    throw finishError;
  }
  return result;
}
