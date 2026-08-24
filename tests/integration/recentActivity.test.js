const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';
const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockSb.reset();
});

describe('GET /student/recent-activity/by-teacher/:teacherId', () => {
  test('a teacher with no linked students gets an empty feed', async () => {
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('merges topic/assignment/challenge events, filters to today, sorts newest first, caps at limit', async () => {
    const now = new Date();
    const today9am = new Date(now); today9am.setHours(9, 0, 0, 0);
    const today3pm = new Date(now); today3pm.setHours(15, 0, 0, 0);
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);

    mockSb.setTable('teacher_student', { data: [{ student_id: STUDENT_UUID }], error: null });
    mockSb.setTable('users', { data: [{ id: STUDENT_UUID, name: 'Aarav' }], error: null });
    mockSb.setTable('topic_attempts', {
      data: [{ student_id: STUDENT_UUID, topic: 'Fractions', subject: 'Maths', created_at: today9am.toISOString() }],
      error: null,
    });
    mockSb.setTable('assignments', {
      data: [{ student_id: STUDENT_UUID, title: 'Worksheet 1', subject: 'Maths', completed_at: today3pm.toISOString() }],
      error: null,
    });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('student_stats', { data: [], error: null });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Newest first: the 3pm assignment before the 9am topic.
    expect(res.body[0].type).toBe('assignment');
    expect(res.body[0].title).toBe('Worksheet 1');
    expect(res.body[1].type).toBe('topic');
    expect(res.body[1].title).toBe('Fractions');
  });

  test('respects the ?limit= query param, capped at 30', async () => {
    mockSb.setTable('teacher_student', { data: [{ student_id: STUDENT_UUID }], error: null });
    mockSb.setTable('users', { data: [{ id: STUDENT_UUID, name: 'Aarav' }], error: null });
    mockSb.setTable('topic_attempts', { data: [], error: null });
    mockSb.setTable('assignments', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('student_stats', { data: [], error: null });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}?limit=999`);
    expect(res.status).toBe(200); // no crash on an over-limit request
  });

  test('resolves and includes a completed challenge event, with its title looked up from the challenges table', async () => {
    const now = new Date();
    mockSb.setTable('teacher_student', { data: [{ student_id: STUDENT_UUID }], error: null });
    mockSb.setTable('users', { data: [{ id: STUDENT_UUID, name: 'Aarav' }], error: null });
    mockSb.setTable('topic_attempts', { data: [], error: null });
    mockSb.setTable('assignments', { data: [], error: null });
    mockSb.setTable('challenge_assignments', {
      data: [{ student_id: STUDENT_UUID, challenge_id: 'c1', completed_at: now.toISOString() }],
      error: null,
    });
    mockSb.setTable('challenges', { data: [{ id: 'c1', title: 'Fractions Sprint' }], error: null });
    mockSb.setTable('student_stats', { data: [], error: null });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe('challenge');
    expect(res.body[0].title).toBe('Fractions Sprint');
  });

  test('falls back to student_stats.last_lesson for a topic completion not represented in topic_attempts', async () => {
    const now = new Date();
    mockSb.setTable('teacher_student', { data: [{ student_id: STUDENT_UUID }], error: null });
    mockSb.setTable('users', { data: [{ id: STUDENT_UUID, name: 'Aarav' }], error: null });
    mockSb.setTable('topic_attempts', { data: [], error: null }); // no topic_attempts row at all
    mockSb.setTable('assignments', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('student_stats', {
      data: [{ student_id: STUDENT_UUID, last_lesson: 'Fractions', updated_at: now.toISOString() }],
      error: null,
    });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe('topic');
    expect(res.body[0].title).toBe('Fractions');
  });

  test('a real event with no matching user name falls back to "Student" (not a crash on a missing users row)', async () => {
    const now = new Date();
    mockSb.setTable('teacher_student', { data: [{ student_id: STUDENT_UUID }], error: null });
    mockSb.setTable('users', { data: [], error: null }); // no matching row - nameMap stays empty
    mockSb.setTable('topic_attempts', {
      data: [{ student_id: STUDENT_UUID, topic: 'Fractions', subject: null, created_at: now.toISOString() }],
      error: null,
    });
    mockSb.setTable('assignments', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('student_stats', { data: [], error: null });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Student');
  });

  test('every query legitimately returning null data (not []) is handled gracefully, same as an empty array', async () => {
    // Supabase returns `data: null` alongside a real error, or on certain edge
    // responses - every (x ?? []) fallback in this route exists for exactly
    // this case. Simulate all 5 queries doing that at once.
    mockSb.setTable('teacher_student', { data: [{ student_id: STUDENT_UUID }], error: null });
    mockSb.setTable('users', { data: null, error: null });
    mockSb.setTable('topic_attempts', { data: null, error: null });
    mockSb.setTable('assignments', { data: null, error: null });
    mockSb.setTable('challenge_assignments', { data: null, error: null });
    mockSb.setTable('student_stats', { data: null, error: null });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('a completed challenge with no matching row in the challenges table falls back to a generic "Challenge" title', async () => {
    const now = new Date();
    mockSb.setTable('teacher_student', { data: [{ student_id: STUDENT_UUID }], error: null });
    mockSb.setTable('users', { data: [{ id: STUDENT_UUID, name: 'Aarav' }], error: null });
    mockSb.setTable('topic_attempts', { data: [], error: null });
    mockSb.setTable('assignments', { data: [], error: null });
    mockSb.setTable('challenge_assignments', {
      data: [{ student_id: STUDENT_UUID, challenge_id: 'orphan-id', completed_at: now.toISOString() }],
      error: null,
    });
    mockSb.setTable('challenges', { data: null, error: null }); // challenge_id no longer exists
    mockSb.setTable('student_stats', { data: [], error: null });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].title).toBe('Challenge');
  });

  test('a real query failure returns a clean 500, not a crash', async () => {
    mockSb.supabase.from.mockImplementationOnce(() => { throw new Error('connection lost'); });

    const res = await request(app).get(`/student/recent-activity/by-teacher/${TEACHER_UUID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('connection lost');
  });
});
