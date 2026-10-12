const { computeStudentStatus } = require('../../utils/studentStatus');

const NOW = new Date('2026-10-12T12:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

describe('computeStudentStatus', () => {
  test('a student who logged in today on a brand-new account is Getting Started, not Needs Attention', () => {
    expect(computeStudentStatus({ lastActive: daysAgo(0), createdAt: daysAgo(0), progressPct: 0 }, NOW)).toBe('getting_started');
  });

  test('a new account that has never logged in is Getting Started', () => {
    expect(computeStudentStatus({ lastActive: null, createdAt: daysAgo(3), progressPct: 0 }, NOW)).toBe('getting_started');
  });

  test('a never-logged-in account becomes Needs Attention exactly at 7 days', () => {
    expect(computeStudentStatus({ lastActive: null, createdAt: daysAgo(6), progressPct: 0 }, NOW)).toBe('getting_started');
    expect(computeStudentStatus({ lastActive: null, createdAt: daysAgo(7), progressPct: 0 }, NOW)).toBe('needs_attention');
  });

  test('inactivity of 7+ days is Needs Attention even with high progress', () => {
    expect(computeStudentStatus({ lastActive: daysAgo(7), createdAt: daysAgo(90), progressPct: 80 }, NOW)).toBe('needs_attention');
    expect(computeStudentStatus({ lastActive: daysAgo(6), createdAt: daysAgo(90), progressPct: 80 }, NOW)).toBe('excelling');
  });

  test('an established active student is tagged by progress: Excelling / On Track / Keep Going', () => {
    const base = { lastActive: daysAgo(1), createdAt: daysAgo(30) };
    expect(computeStudentStatus({ ...base, progressPct: 50 }, NOW)).toBe('excelling');
    expect(computeStudentStatus({ ...base, progressPct: 49 }, NOW)).toBe('on_track');
    expect(computeStudentStatus({ ...base, progressPct: 20 }, NOW)).toBe('on_track');
    expect(computeStudentStatus({ ...base, progressPct: 19 }, NOW)).toBe('keep_going');
    expect(computeStudentStatus({ ...base, progressPct: 0 }, NOW)).toBe('keep_going');
  });

  test('a new account stays Getting Started regardless of progress', () => {
    expect(computeStudentStatus({ lastActive: daysAgo(0), createdAt: daysAgo(2), progressPct: 90 }, NOW)).toBe('getting_started');
  });

  test('missing dates do not crash and default to Getting Started', () => {
    expect(computeStudentStatus({ lastActive: null, createdAt: null, progressPct: null }, NOW)).toBe('getting_started');
    expect(computeStudentStatus({ lastActive: 'not-a-date', createdAt: undefined }, NOW)).toBe('getting_started');
  });
});
