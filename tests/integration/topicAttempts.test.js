const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

jest.mock('../../services/qdrant', () => ({
  client: { scroll: jest.fn().mockResolvedValue({ points: [], next_page_offset: null }) },
  resolveCollection: () => ({ collection: 'fake', qdrantCurriculum: 'IB PYP', qdrantGrade: 'Grade 4' }),
}));

const request = require('supertest');
const app = require('../../index');

const S1 = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockSb.reset();
});

describe('GET /student/:studentId/topic/:topic/attempts', () => {
  test('a topic never attempted returns an empty list, not an error', async () => {
    mockSb.setTable('topic_attempts', { data: [], error: null });

    const res = await request(app).get(`/student/${S1}/topic/Fractions/attempts`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attempts: [] });
  });

  test('returns the real per-attempt history, ordered, with mistakes derived from total-correct', async () => {
    mockSb.setTable('topic_attempts', {
      data: [
        { attempt_number: 1, score: 40, passed: false, total_questions: 10, correct_answers: 4, time_spent_seconds: 300, created_at: '2026-08-10T00:00:00Z' },
        { attempt_number: 2, score: 90, passed: true, total_questions: 10, correct_answers: 9, time_spent_seconds: 240, created_at: '2026-08-20T00:00:00Z' },
      ],
      error: null,
    });

    const res = await request(app).get(`/student/${S1}/topic/Fractions/attempts`);

    expect(res.body.attempts).toHaveLength(2);
    expect(res.body.attempts[0]).toEqual({
      attemptNumber: 1, score: 40, passed: false, totalQuestions: 10, correctAnswers: 4,
      mistakes: 6, timeSpentSeconds: 300, date: '2026-08-10T00:00:00Z',
    });
    expect(res.body.attempts[1].mistakes).toBe(1);
  });

  test('a real topic name containing special characters (e.g. an apostrophe) round-trips correctly through the URL', async () => {
    mockSb.setTable('topic_attempts', {
      data: [{ attempt_number: 1, score: 70, passed: true, total_questions: 5, correct_answers: 4, time_spent_seconds: 100, created_at: '2026-08-10T00:00:00Z' }],
      error: null,
    });

    const res = await request(app).get(`/student/${S1}/topic/${encodeURIComponent("Newton's Laws")}/attempts`);

    expect(res.status).toBe(200);
    expect(res.body.attempts).toHaveLength(1);
  });

  test('missing total_questions/correct_answers -> mistakes is null, not NaN or a crash', async () => {
    mockSb.setTable('topic_attempts', {
      data: [{ attempt_number: 1, score: 70, passed: true, total_questions: null, correct_answers: null, time_spent_seconds: 100, created_at: '2026-08-10T00:00:00Z' }],
      error: null,
    });

    const res = await request(app).get(`/student/${S1}/topic/Fractions/attempts`);

    expect(res.body.attempts[0].mistakes).toBeNull();
  });

  test('a Supabase error surfaces a 500, not a crash', async () => {
    mockSb.setTable('topic_attempts', { data: null, error: { message: 'db down' } });

    const res = await request(app).get(`/student/${S1}/topic/Fractions/attempts`);

    expect(res.status).toBe(500);
  });
});
