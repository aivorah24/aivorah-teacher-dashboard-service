// Unit tests for computeTopicStatus() — pure, DB-free classifier that
// backs the Student Progress heatmap. Ported alongside the route it serves
// (see routes/student.js's /by-teacher/:teacherId/heatmap and the module's
// own header comment for provenance).
const { computeTopicStatus, STUCK_STALE_DAYS, STRUGGLED_ATTEMPTS } = require('../../utils/topicStatus');

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

describe('computeTopicStatus', () => {
  test('no attempts, not completed via path -> not_started', () => {
    const result = computeTopicStatus([]);
    expect(result).toEqual({ status: 'not_started', attempts: 0, latestScore: null, bestScore: null, struggled: false, lastAttemptDate: null });
  });

  test('no attempts, but completed via the Learning Path -> mastered', () => {
    const result = computeTopicStatus([], { completedViaPath: true });
    expect(result.status).toBe('mastered');
    expect(result.attempts).toBe(0);
  });

  test('a passed attempt -> mastered, regardless of how recent', () => {
    const result = computeTopicStatus([{ score: 90, passed: true, attemptNumber: 1, date: daysAgo(30) }]);
    expect(result.status).toBe('mastered');
    expect(result.latestScore).toBe(90);
    expect(result.bestScore).toBe(90);
  });

  test('a recent failing attempt (within the stale window) -> trying', () => {
    const result = computeTopicStatus([{ score: 40, passed: false, attemptNumber: 1, date: daysAgo(2) }]);
    expect(result.status).toBe('trying');
  });

  test('exactly one failing attempt gone stale -> dropped, not stuck', () => {
    const result = computeTopicStatus([{ score: 40, passed: false, attemptNumber: 1, date: daysAgo(STUCK_STALE_DAYS + 1) }]);
    expect(result.status).toBe('dropped');
  });

  test('2+ failing attempts, all gone stale -> stuck', () => {
    const attempts = [
      { score: 30, passed: false, attemptNumber: 1, date: daysAgo(STUCK_STALE_DAYS + 5) },
      { score: 40, passed: false, attemptNumber: 2, date: daysAgo(STUCK_STALE_DAYS + 1) },
    ];
    const result = computeTopicStatus(attempts);
    expect(result.status).toBe('stuck');
    expect(result.attempts).toBe(2);
  });

  test('multiple failing attempts, most recent still within the stale window -> trying (not stuck)', () => {
    const attempts = [
      { score: 30, passed: false, attemptNumber: 1, date: daysAgo(20) },
      { score: 40, passed: false, attemptNumber: 2, date: daysAgo(1) },
    ];
    const result = computeTopicStatus(attempts);
    expect(result.status).toBe('trying');
  });

  test('bestScore is the max across all attempts, not just the latest', () => {
    const attempts = [
      { score: 90, passed: false, attemptNumber: 1, date: daysAgo(3) },
      { score: 40, passed: false, attemptNumber: 2, date: daysAgo(1) },
    ];
    const result = computeTopicStatus(attempts);
    expect(result.bestScore).toBe(90);
    expect(result.latestScore).toBe(40); // the LAST attempt in the (chronological) array
  });

  test('struggled flag is true only for mastered after 3+ attempts', () => {
    const attempts = Array.from({ length: STRUGGLED_ATTEMPTS }, (_, i) => ({
      score: i === STRUGGLED_ATTEMPTS - 1 ? 90 : 40,
      passed: i === STRUGGLED_ATTEMPTS - 1,
      attemptNumber: i + 1,
      date: daysAgo(STRUGGLED_ATTEMPTS - i),
    }));
    const result = computeTopicStatus(attempts);
    expect(result.status).toBe('mastered');
    expect(result.struggled).toBe(true);
  });

  test('mastered on the first attempt is never flagged as struggled', () => {
    const result = computeTopicStatus([{ score: 100, passed: true, attemptNumber: 1, date: daysAgo(1) }]);
    expect(result.struggled).toBe(false);
  });

  test('a null/missing attempts array behaves the same as an empty one', () => {
    expect(computeTopicStatus(null)).toEqual(computeTopicStatus([]));
    expect(computeTopicStatus(undefined)).toEqual(computeTopicStatus([]));
  });
});
