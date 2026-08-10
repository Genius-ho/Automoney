const KOREA_OFFSET_MS = 9 * 60 * 60 * 1000;

export const PRODUCT_STAGE_SLOTS = Object.freeze({
  draft: 7,
  analysis: 8,
  images: 9,
  discovery: 10,
});

export function koreaServiceDate(now = new Date()) {
  const shifted = new Date(new Date(now).getTime() + KOREA_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

export function slotForServiceDate(serviceDate, hour) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(serviceDate));
  if (!match || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new TypeError('serviceDate and hour must describe a valid Korea slot');
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour - 9));
}

export function nextDailySlot(now = new Date(), hour) {
  const instant = new Date(now);
  const today = koreaServiceDate(instant);
  const todaySlot = slotForServiceDate(today, hour);
  if (instant < todaySlot) return todaySlot;
  const tomorrowKorea = new Date(todaySlot.getTime() + 24 * 60 * 60 * 1000);
  return tomorrowKorea;
}

const STAGE_FIELDS = Object.freeze({
  draft: ['draftNextRunAt', 'draftLastServiceDate'],
  analysis: ['analysisNextRunAt', 'analysisLastServiceDate'],
  images: ['imagesNextRunAt', 'imagesLastServiceDate'],
  discovery: ['discoveryNextRunAt', 'discoveryLastServiceDate'],
});

export function selectOldestDueStage(state, now = new Date()) {
  const instant = new Date(now);
  const due = [];
  for (const stage of Object.keys(PRODUCT_STAGE_SLOTS)) {
    const [nextField, lastDateField] = STAGE_FIELDS[stage];
    if (!state?.[nextField]) continue;
    const dueAt = new Date(state[nextField]);
    if (!Number.isFinite(dueAt.getTime()) || dueAt > instant) continue;
    const serviceDate = koreaServiceDate(dueAt);
    if (state[lastDateField] === serviceDate) continue;
    due.push({ stage, serviceDate, dueAt });
  }
  due.sort((a, b) => a.dueAt - b.dueAt);
  return due[0] || null;
}
