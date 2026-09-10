const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

jest.mock('../../services/qdrant', () => ({
  client: { scroll: jest.fn().mockResolvedValue({ points: [], next_page_offset: null }) },
  resolveCollection: () => ({ collection: 'fake', qdrantCurriculum: 'IB PYP', qdrantGrade: 'Grade 4' }),
}));

const { client: mockQdrantClient } = require('../../services/qdrant');
const request = require('supertest');
const app = require('../../index');

const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';
const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '33333333-3333-3333-3333-333333333333';

function userRow(overrides = {}) {
  return { id: S1, name: 'Aarav', grade: 'Grade 4', curriculum: 'IB PYP', photo_url: null, ...overrides };
}
function linkRow(studentId, userOverrides = {}, subject = 'General') {
  return { student_id: studentId, subject, users: userRow({ id: studentId, ...userOverrides }) };
}

beforeEach(() => {
  mockSb.reset();
  mockSb.setTable('users', { data: null, error: null }); // teacher lookup (maybeSingle)
  mockSb.setTable('user_preferences', { data: null, error: null });
  mockSb.setTable('topic_attempts', { data: [], error: null });
  mockSb.setTable('student_stats', { data: [], error: null });
});

describe('GET /student/by-teacher/:teacherId/heatmap', () => {
  test('a teacher with no linked students gets an empty heatmap', async () => {
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ students: [], topics: [] });
  });

  test('a topic with a real passing attempt shows as mastered for that student and appears in the topic column list', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow(S1)], error: null });
    mockSb.setTable('topic_attempts', {
      data: [{ student_id: S1, topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4', score: 85, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' }],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.status).toBe(200);
    expect(res.body.students).toHaveLength(1);
    expect(res.body.students[0].topicStatus['Fractions'].status).toBe('mastered');
    expect(res.body.students[0].topicStatus['Fractions'].subject).toBe('Mathematics');
    expect(res.body.topics).toEqual(expect.arrayContaining([{ topic: 'Fractions', subject: 'Mathematics' }]));
  });

  test('a topic completed via the Learning Path (no quiz attempt row) still shows as mastered', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow(S1)], error: null });
    mockSb.setTable('student_stats', { data: [{ student_id: S1, completed_topics: ['Photosynthesis'] }], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.body.students[0].topicStatus['Photosynthesis'].status).toBe('mastered');
  });

  test('a class-wide union of topics: a topic only one student touched still appears as a column for the whole class', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow(S1), linkRow(S2, { name: 'Bhavna' })], error: null });
    mockSb.setTable('topic_attempts', {
      data: [{ student_id: S1, topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4', score: 85, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' }],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.body.students).toHaveLength(2);
    expect(res.body.topics.map(t => t.topic)).toContain('Fractions');
    // S2 never touched it — no entry in their topicStatus map (frontend renders that as gray/unattempted).
    expect(res.body.students.find(s => s.id === S2).topicStatus['Fractions']).toBeUndefined();
  });

  test('an explicit ?subject= filter only returns topics matching that subject', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow(S1)], error: null });
    mockSb.setTable('topic_attempts', {
      data: [
        { student_id: S1, topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4', score: 85, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' },
        { student_id: S1, topic: 'Photosynthesis', subject: 'Science', grade: 'Grade 4', score: 70, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`).query({ subject: 'Mathematics' });

    expect(Object.keys(res.body.students[0].topicStatus)).toEqual(['Fractions']);
  });

  test('an explicit ?grade= filter excludes students in other grades', async () => {
    mockSb.setTable('teacher_student', {
      data: [linkRow(S1, { grade: 'Grade 4' }), linkRow(S2, { grade: 'Grade 6', name: 'Chirag' })],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`).query({ grade: 'Grade 4' });

    expect(res.body.students).toHaveLength(1);
    expect(res.body.students[0].id).toBe(S1);
  });

  test('a subject-scoped teacher (Staff Subject Mapping) only sees topics in their scoped subjects', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow(S1)], error: null });
    mockSb.setTable('users', { data: { email: 'teacher@test.com' }, error: null });
    mockSb.setTable('user_preferences', {
      data: { data: { teaches: [{ grade: 'Grade 4', curriculum: 'IB PYP', subjects: ['Mathematics'] }] } },
      error: null,
    });
    mockSb.setTable('topic_attempts', {
      data: [
        { student_id: S1, topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4', score: 85, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' },
        { student_id: S1, topic: 'Photosynthesis', subject: 'Science', grade: 'Grade 4', score: 70, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(Object.keys(res.body.students[0].topicStatus)).toEqual(['Fractions']);
    expect(res.body.students[0].scopedSubjects).toEqual(['Mathematics']);
  });

  test('a Supabase error on the teacher_student lookup surfaces a 500, not a crash', async () => {
    mockSb.setTable('teacher_student', { data: null, error: { message: 'db down' } });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.status).toBe(500);
  });

  test('multiple attempts on the same topic are classified using the FULL attempt history, not just the latest row', async () => {
    mockSb.setTable('teacher_student', { data: [linkRow(S1)], error: null });
    mockSb.setTable('topic_attempts', {
      data: [
        { student_id: S1, topic: 'Long Division', subject: 'Mathematics', grade: 'Grade 4', score: 30, passed: false, attempt_number: 1, created_at: new Date(Date.now() - 20 * 86400000).toISOString() },
        { student_id: S1, topic: 'Long Division', subject: 'Mathematics', grade: 'Grade 4', score: 40, passed: false, attempt_number: 2, created_at: new Date(Date.now() - 15 * 86400000).toISOString() },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    const status = res.body.students[0].topicStatus['Long Division'];
    expect(status.status).toBe('stuck'); // 2 failed attempts, both stale
    expect(status.attempts).toBe(2);
    expect(status.bestScore).toBe(40);
  });

  // Real syllabus topics (from Qdrant) must appear as columns even when a
  // student has never attempted them — this is what makes "Not started"
  // reachable at all. A distinct curriculum/grade from the other tests
  // avoids the module-level topic cache serving a stale result.
  test('a real syllabus topic with zero attempts appears as a "not_started" column, not just attempted topics', async () => {
    mockSb.setTable('teacher_student', {
      data: [linkRow(S1, { curriculum: 'CBSE', grade: 'Grade 3' })],
      error: null,
    });
    mockQdrantClient.scroll.mockResolvedValueOnce({
      points: [
        { payload: { subject: 'Mathematics', topic: 'Double Century' } },
        { payload: { subject: 'Mathematics', topic: 'Time Goes On' } },
      ],
      next_page_offset: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.body.topics.map(t => t.topic)).toEqual(expect.arrayContaining(['Double Century', 'Time Goes On']));
    expect(res.body.students[0].topicStatus['Double Century'].status).toBe('not_started');
    expect(res.body.students[0].topicStatus['Time Goes On'].status).toBe('not_started');
  });

  // A topic with a real attempt AND present in the syllabus must still use
  // the real attempt data (not get silently overwritten to "not_started").
  test('a syllabus topic the student HAS attempted keeps its real mastery status, not "not_started"', async () => {
    mockSb.setTable('teacher_student', {
      data: [linkRow(S1, { curriculum: 'CBSE', grade: 'Grade 3', name: 'Aarav Attempted' })],
      error: null,
    });
    mockSb.setTable('topic_attempts', {
      data: [{ student_id: S1, topic: 'Give and Take', subject: 'Mathematics', grade: 'Grade 3', score: 90, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' }],
      error: null,
    });
    mockQdrantClient.scroll.mockResolvedValueOnce({
      points: [{ payload: { subject: 'Mathematics', topic: 'Give and Take' } }],
      next_page_offset: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.body.students[0].topicStatus['Give and Take'].status).toBe('mastered');
    expect(res.body.topics.filter(t => t.topic === 'Give and Take')).toHaveLength(1); // no duplicate column
  });

  // A Qdrant failure while fetching the syllabus must degrade gracefully —
  // the heatmap still returns real attempt data, just without the extra
  // untouched syllabus columns (fetchSyllabusTopicsFromQdrant catches and
  // returns []).
  test('a Qdrant failure while fetching syllabus topics does not break the heatmap — falls back to attempted topics only', async () => {
    mockSb.setTable('teacher_student', {
      data: [linkRow(S1, { curriculum: 'Cambridge', grade: 'Grade 7' })],
      error: null,
    });
    mockSb.setTable('topic_attempts', {
      data: [{ student_id: S1, topic: 'Algebra Basics', subject: 'Mathematics', grade: 'Grade 7', score: 80, passed: true, attempt_number: 1, created_at: '2026-08-20T00:00:00Z' }],
      error: null,
    });
    mockQdrantClient.scroll.mockRejectedValueOnce(new Error('qdrant unreachable'));

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/heatmap`);

    expect(res.status).toBe(200);
    expect(res.body.students[0].topicStatus['Algebra Basics'].status).toBe('mastered');
  });
});
