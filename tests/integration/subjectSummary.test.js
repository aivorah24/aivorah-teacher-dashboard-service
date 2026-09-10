const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

jest.mock('../../services/qdrant', () => ({
  client: { scroll: jest.fn().mockResolvedValue({ points: [], next_page_offset: null }) },
  resolveCollection: () => ({ collection: 'fake', qdrantCurriculum: 'IB PYP', qdrantGrade: 'Grade 4' }),
}));

const request = require('supertest');
const app = require('../../index');

const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';
const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  mockSb.reset();
});

describe('GET /student/by-teacher/:teacherId/subject-summary', () => {
  test('a teacher with no linked students gets empty summary', async () => {
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/subject-summary`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subjects: [], combined: null });
  });

  test('computes real per-subject averages from real topic_attempts, not hardcoded numbers', async () => {
    mockSb.setTable('teacher_student', { data: [{ student_id: S1 }, { student_id: S2 }], error: null });
    mockSb.setTable('topic_attempts', {
      data: [
        { student_id: S1, subject: 'Mathematics', score: 80, time_spent_seconds: 600 },
        { student_id: S2, subject: 'Mathematics', score: 60, time_spent_seconds: 900 },
        { student_id: S1, subject: 'Science', score: 90, time_spent_seconds: 300 },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/subject-summary`);

    const math = res.body.subjects.find(s => s.subject === 'Mathematics');
    expect(math.avgScorePct).toBe(70); // (80+60)/2
    expect(math.avgAttemptSeconds).toBe(750); // (600+900)/2
    expect(math.attemptCount).toBe(2);

    const science = res.body.subjects.find(s => s.subject === 'Science');
    expect(science.avgScorePct).toBe(90);

    expect(res.body.combined.avgScorePct).toBe(Math.round((80 + 60 + 90) / 3));
    expect(res.body.combined.attemptCount).toBe(3);
  });

  test('a curriculum-name value in the subject field (not a real subject) is excluded, same convention as the roster route', async () => {
    mockSb.setTable('teacher_student', { data: [{ student_id: S1 }], error: null });
    mockSb.setTable('topic_attempts', {
      data: [{ student_id: S1, subject: 'IB PYP', score: 50, time_spent_seconds: 100 }],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/subject-summary`);

    expect(res.body.subjects).toEqual([]);
    expect(res.body.combined).toBeNull();
  });

  test('an attempt with a null score is excluded from the average, not treated as 0', async () => {
    mockSb.setTable('teacher_student', { data: [{ student_id: S1 }], error: null });
    mockSb.setTable('topic_attempts', {
      data: [
        { student_id: S1, subject: 'Mathematics', score: 100, time_spent_seconds: 200 },
        { student_id: S1, subject: 'Mathematics', score: null, time_spent_seconds: 200 },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/subject-summary`);

    expect(res.body.subjects[0].avgScorePct).toBe(100);
    expect(res.body.subjects[0].attemptCount).toBe(1);
  });

  test('a Supabase error surfaces a 500, not a crash', async () => {
    mockSb.setTable('teacher_student', { data: null, error: { message: 'db down' } });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/subject-summary`);

    expect(res.status).toBe(500);
  });
});
