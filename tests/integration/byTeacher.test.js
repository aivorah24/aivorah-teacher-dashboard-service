const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

// Qdrant is only used for the "total topics for this curriculum/grade" count —
// mock its scroll() to return zero points so totalTopics resolves to 0 and
// tests can focus on the status logic.
jest.mock('../../services/qdrant', () => ({
  client: { scroll: jest.fn().mockResolvedValue({ points: [], next_page_offset: null }) },
  resolveCollection: () => ({ collection: 'fake', qdrantCurriculum: 'IB PYP', qdrantGrade: 'Grade 4' }),
}));

const { client: mockQdrantClient } = require('../../services/qdrant');
const request = require('supertest');
const app = require('../../index');

const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';
const S1 = '11111111-1111-1111-1111-111111111111';

function userRow(overrides = {}) {
  return {
    id: S1, name: 'Aarav', email: 'aarav@test.com', grade: 'Grade 4', school: 'TSRA',
    curriculum: 'IB PYP', photo_url: null, created_at: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

function linkRow(userOverrides = {}) {
  return { student_id: S1, subject: 'General', users: userRow(userOverrides) };
}

beforeEach(() => {
  mockSb.reset();
  mockSb.setTable('users', { data: null, error: null }); // teacher lookup (maybeSingle) — no email on record
  mockSb.setTable('user_preferences', { data: null, error: null });
  mockSb.setTable('topic_attempts', { data: [], error: null });
  mockSb.setTable('student_subject_time', { data: [], error: null });
  mockSb.setTable('assignment_submissions', { data: [], error: null });
  mockSb.setTable('assignments', { data: [], error: null });
  mockSb.setTable('challenge_assignments', { data: [], error: null });
});

describe('GET /student/by-teacher/:teacherId', () => {
  test('a teacher with no linked students gets an empty list', async () => {
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('a never-logged-in student whose account is 7+ days old is Needs Attention', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow({ created_at: '2020-01-01T00:00:00Z' })], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('needs_attention');
    expect(res.body[0].needsAttention).toBe(true);
  });

  test('a freshly-created student is Getting Started, not flagged', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    mockSb.setTable('teacher_student', { data: [linkRow({ created_at: twoDaysAgo })], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('getting_started');
    expect(res.body[0].needsAttention).toBe(false);
  });

  test('a student who logged in on day 1 with 0% progress is Getting Started, not flagged (manual-test bug)', async () => {
    const today = new Date().toISOString();
    mockSb.setTable('teacher_student', { data: [linkRow({ created_at: today })], error: null });
    mockSb.setTable('student_stats', {
      data: [{ student_id: S1, completed_topics: [], last_active_date: today.slice(0, 10), xp_points: 10 }],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.body[0].status).toBe('getting_started');
    expect(res.body[0].needsAttention).toBe(false);
  });

  test('an established student active recently with low progress is Keep Going, not flagged', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow({ created_at: '2020-01-01T00:00:00Z' })], error: null });
    mockSb.setTable('student_stats', {
      data: [{ student_id: S1, completed_topics: ['Fractions'], xp_points: 50, last_active_date: new Date().toISOString().slice(0, 10) }],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('keep_going');
    expect(res.body[0].needsAttention).toBe(false);
    expect(res.body[0].completedTopics).toEqual(['Fractions']);
  });

  // Student Progress work-order (2026-08-29): Activity & Performance table's
  // Quiz columns — real attempt count + best score, not fabricated.
  test('quizAttempts/quizBestScore reflect the real topic_attempts history for that student', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow()], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });
    mockSb.setTable('topic_attempts', {
      data: [
        { student_id: S1, topic: 'Fractions', subject: 'Mathematics', passed: false, score: 40 },
        { student_id: S1, topic: 'Fractions', subject: 'Mathematics', passed: true, score: 85 },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.body[0].quizAttempts).toBe(2);
    expect(res.body[0].quizBestScore).toBe(85);
  });

  test('a student with zero quiz attempts gets quizAttempts=0 and quizBestScore=null, not a crash', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow()], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.body[0].quizAttempts).toBe(0);
    expect(res.body[0].quizBestScore).toBeNull();
  });

  test('deduplicates a student linked under multiple subjects into a single row', async () => {
    mockSb.setTable('teacher_student', {
      data: [linkRow({ }), { student_id: S1, subject: 'Mathematics', users: userRow() }],
      error: null,
    });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('a fully-populated request: email-based teacherId, Staff Subject Mapping scoping, real Qdrant topic counts, subject-scoped time, and personal+broadcast assignments', async () => {
    // resolveTeacherId('teacher@aivorah.test') isn't a UUID or the demo map key,
    // so it looks the id up by email first (covers that branch) - then the route
    // separately looks up the teacher's OWN email again via .maybeSingle() for
    // the Staff Subject Mapping lookup. 'users' is hit twice, in that order.
    mockSb.setTable('users', [
      { data: { id: TEACHER_UUID }, error: null },
      { data: { email: 'teacher@aivorah.test' }, error: null },
    ]);
    mockSb.setTable('user_preferences', {
      data: { data: { teaches: [{ grade: 'Grade 7', curriculum: 'Cambridge', subjects: ['Mathematics'] }] } },
      error: null,
    });
    // Distinct curriculum/grade from every other test in this file (e.g.
    // "deduplicates" above scopes a Mathematics subject onto IB PYP/Grade 4 via
    // the teacher_student.subject fallback, which would otherwise pollute the
    // module-level topic-count cache under this exact same key).
    mockSb.setTable('teacher_student', {
      data: [linkRow({ created_at: '2020-01-01T00:00:00Z', curriculum: 'Cambridge', grade: 'Grade 7' })],
      error: null,
    });
    mockSb.setTable('student_stats', {
      data: [{ student_id: S1, completed_topics: [], xp_points: 10 }],
      error: null,
    });
    // A Mathematics topic (in scope) and an Art topic (out of scope) - only the
    // Mathematics one should survive the scoped-subjects filter.
    mockSb.setTable('topic_attempts', {
      data: [
        { student_id: S1, topic: 'Fractions', subject: 'Mathematics', passed: true },
        { student_id: S1, topic: 'Painting', subject: 'Art', passed: true },
      ],
      error: null,
    });
    // Mathematics time counts toward scopedSubjectTime; Art time is scoped OUT
    // into otherSubjectTime instead.
    const today = new Date().toISOString().split('T')[0];
    mockSb.setTable('student_subject_time', {
      data: [
        { student_id: S1, subject: 'Mathematics', minutes: 30, today_minutes: 5, today_date: today },
        { student_id: S1, subject: 'Art', minutes: 12, today_minutes: 2, today_date: today },
      ],
      error: null,
    });
    // One personal assignment (student_id set) + one broadcast (student_id null,
    // grade/curriculum match) - exercises both branches of the assignedCountMap loop.
    mockSb.setTable('assignments', {
      data: [
        { id: 'a1', student_id: S1, grade: null, curriculum: null },
        { id: 'a2', student_id: null, grade: 'Grade 7', curriculum: 'Cambridge' },
      ],
      error: null,
    });
    mockSb.setTable('assignment_submissions', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [{ student_id: S1, status: 'completed' }], error: null });

    // Real Qdrant points for this curriculum/grade/subject combo, so totalTopics
    // resolves to a real non-zero count instead of the default empty mock.
    mockQdrantClient.scroll.mockResolvedValueOnce({
      points: [{ payload: { subject: 'Mathematics', topic: 'Fractions' } }],
      next_page_offset: null,
    });

    const res = await request(app).get(`/student/by-teacher/teacher@aivorah.test`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const student = res.body[0];
    expect(student.scopedSubjects).toEqual(['Mathematics']);
    // Art topic filtered out by subject scoping - only Fractions (Mathematics) remains.
    expect(student.completedTopics).toEqual(['Fractions']);
    expect(student.totalTopics).toBeGreaterThan(0);
    expect(student.subjectTime).toEqual({ Mathematics: 30 });
    expect(student.otherSubjectTime).toEqual({ Art: 12 });
  });

  test('with no Staff Subject Mapping (unscoped), learningPathTimeToday sums today\'s time across every subject', async () => {
    mockSb.setTable('teacher_student', {
      data: [linkRow({ curriculum: 'ICSE', grade: 'Grade 8', subject: 'General' })],
      error: null,
    });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });
    const today = new Date().toISOString().split('T')[0];
    mockSb.setTable('student_subject_time', {
      data: [
        { student_id: S1, subject: 'Mathematics', minutes: 20, today_minutes: 6, today_date: today },
        { student_id: S1, subject: 'English', minutes: 15, today_minutes: 4, today_date: today },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].scopedSubjects).toEqual([]);
    expect(res.body[0].learningPathTimeToday).toBe(10); // 6 + 4, unscoped sum across all subjects
  });

  test('a Qdrant failure falls back to totalTopics=0 gracefully, not a 500', async () => {
    // A distinct curriculum/grade combo from the other tests, so this doesn't
    // hit the module-level topic-count cache from an earlier test's real lookup.
    mockSb.setTable('teacher_student', { data: [linkRow({ curriculum: 'CBSE', grade: 'Grade 5' })], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });
    mockQdrantClient.scroll.mockRejectedValueOnce(new Error('qdrant unreachable'));

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].totalTopics).toBe(0);
  });

  test('a student with no student_stats row at all still returns a full, zeroed-out row (every ?? default fires)', async () => {
    mockSb.setTable('teacher_student', {
      data: [linkRow({ curriculum: 'Oxford', grade: 'Grade 9', created_at: '2020-01-01T00:00:00Z' })],
      error: null,
    });
    // No student_stats row for this student - statsMap[id] falls back to {}.
    mockSb.setTable('student_stats', { data: [], error: null });
    // Every other per-request query legitimately returns null (not []) - the
    // real shape Supabase sends back on some empty/edge responses.
    mockSb.setTable('topic_attempts', { data: null, error: null });
    mockSb.setTable('student_subject_time', { data: null, error: null });
    mockSb.setTable('assignment_submissions', { data: null, error: null });
    mockSb.setTable('assignments', { data: null, error: null });
    mockSb.setTable('challenge_assignments', { data: null, error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    const student = res.body[0];
    expect(student.xpPoints).toBe(0);
    expect(student.level).toBe(1);
    expect(student.completedTopics).toEqual([]);
    expect(student.assignmentsDone).toBe(0);
  });

  test('resolves the demo teacher email via TEACHER_ID_MAP without a database lookup', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow()], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });

    const res = await request(app).get(`/student/by-teacher/teacher@demo.com`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('a Supabase error object (not a thrown exception) on the teacher_student query returns a clean 500', async () => {
    mockSb.setTable('teacher_student', { data: null, error: { message: 'permission denied' } });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('permission denied');
  });

  test('counts real assignment_submissions toward each student (submittedMap)', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow()], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: [] }], error: null });
    mockSb.setTable('assignment_submissions', {
      data: [{ student_id: S1, assignment_id: 'a1' }, { student_id: S1, assignment_id: 'a2' }],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // submittedMap is internal (not in the response shape) - just confirms no crash while populating it
  });

  test('a real query failure returns a clean 500, not a crash', async () => {
    // TEACHER_UUID skips resolveTeacherId's own supabase call (matches the UUID
    // regex directly), so the very first real call is teacher_student - throwing
    // there exercises the route's catch block.
    mockSb.supabase.from.mockImplementationOnce(() => { throw new Error('connection lost'); });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('connection lost');
  });
});
