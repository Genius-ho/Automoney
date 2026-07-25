// Shared cancellation check -- was duplicated identically in
// purchase-order-builder.mjs and channel-dispatch.mjs; Phase 10's
// cancellation-exception sweep needs the same check a third time, so it's
// factored out here rather than copied again.
const CANCELLED_PATTERN = /CANCEL|취소/i;

export function isChannelOrderCancelled(channelOrder) {
  return Boolean(channelOrder?.cancelledAt) || CANCELLED_PATTERN.test(channelOrder?.orderStatus || '');
}
