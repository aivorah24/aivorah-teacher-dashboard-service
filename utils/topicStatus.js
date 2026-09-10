/**
 * Classifies a student's attempt history for one topic into a heatmap status.
 * Zero external dependencies (no Supabase/Qdrant) so it can be unit tested
 * without a live DB connection — see tests/unit/topicStatus.test.js.
 *
 * Ported verbatim from ai-mentor/server/utils/topicStatus.js (2026-08-29) —
 * part of the deliberate, scoped extraction of GET /student/by-teacher/
 * :teacherId/heatmap (see routes/student.js) into this service, alongside
 * its two already-extracted siblings (2026-08-24).
 *
 *   mastered    — passed, or completed via the Learning Path.
 *   trying      — actively working on it: any attempt within STUCK_STALE_DAYS,
 *                 regardless of attempt count.
 *   dropped     — exactly one attempt, then nothing for STUCK_STALE_DAYS+.
 *                 Different from "stuck": no repeated struggle, just gone quiet.
 *   stuck       — 2+ failing attempts, all gone stale.
 *   not_started — no attempts and not completed via path.
 */
const STUCK_STALE_DAYS = 7;   // a failing topic untouched this long = "stuck"/"dropped", not "trying"
const STRUGGLED_ATTEMPTS = 3; // mastered in this many+ attempts earns the flag

function computeTopicStatus(attempts, { completedViaPath = false } = {}) {
  // `attempts` are chronological (oldest → newest) for a single student+topic.
  if (!attempts || attempts.length === 0) {
    return completedViaPath
      ? { status: 'mastered', attempts: 0, latestScore: null, bestScore: null, struggled: false, lastAttemptDate: null }
      : { status: 'not_started', attempts: 0, latestScore: null, bestScore: null, struggled: false, lastAttemptDate: null };
  }
  const total = attempts.length;
  const passed = attempts.some(a => a.passed);
  const bestScore = attempts.reduce((m, a) => Math.max(m, a.score || 0), 0);
  const latest = attempts[attempts.length - 1];
  const lastAttemptDate = latest.date;
  const ageDays = lastAttemptDate
    ? (Date.now() - new Date(lastAttemptDate).getTime()) / 86400000
    : 999;

  let status;
  if (passed || completedViaPath) {
    status = 'mastered';
  } else if (ageDays <= STUCK_STALE_DAYS) {
    status = 'trying';           // recent activity, regardless of attempt count
  } else if (total === 1) {
    status = 'dropped';          // a single attempt, then nothing for a week+ —
                                  // different from stuck: no repeated struggle, just gone quiet
  } else {
    status = 'stuck';            // repeated failures that have gone cold
  }

  return {
    status,
    attempts: total,
    latestScore: latest.score ?? null,
    bestScore,
    struggled: status === 'mastered' && total >= STRUGGLED_ATTEMPTS,
    lastAttemptDate,
  };
}

module.exports = { computeTopicStatus, STUCK_STALE_DAYS, STRUGGLED_ATTEMPTS };
