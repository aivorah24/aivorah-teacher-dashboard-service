// Single source of truth for the student status badge. Mirrored in the frontend
// at src/utils/studentStatus.ts — keep both in sync.
const NEW_ACCOUNT_DAYS = 7;
const INACTIVE_DAYS = 7;
const EXCELLING_PCT = 50;
const ON_TRACK_PCT = 20;

const DAY_MS = 86400000;

function daysSince(value, now) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY_MS);
}

// Order matters: Needs Attention > Getting Started > Excelling > On Track > Keep Going.
function computeStudentStatus({ lastActive, createdAt, progressPct }, now = Date.now()) {
  const sinceCreated = daysSince(createdAt, now);
  const sinceSeen = daysSince(lastActive, now) ?? sinceCreated;
  if (sinceSeen != null && sinceSeen >= INACTIVE_DAYS) return 'needs_attention';
  if (sinceCreated == null || sinceCreated < NEW_ACCOUNT_DAYS) return 'getting_started';
  const pct = progressPct ?? 0;
  if (pct >= EXCELLING_PCT) return 'excelling';
  if (pct >= ON_TRACK_PCT) return 'on_track';
  return 'keep_going';
}

module.exports = { computeStudentStatus, NEW_ACCOUNT_DAYS, INACTIVE_DAYS, EXCELLING_PCT, ON_TRACK_PCT };
