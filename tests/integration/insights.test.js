const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';
const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  mockSb.reset();
});

describe('GET /student/by-teacher/:teacherId/insights', () => {
  test('a teacher with no linked students gets empty totals', async () => {
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/insights`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignments: [], challenges: [] });
  });

  test('computes assignment submission counts, class average score, and challenge completion totals', async () => {
    mockSb.setTable('teacher_student', { data: [{ student_id: S1 }, { student_id: S2 }], error: null });
    mockSb.setTable('assignment_submissions', {
      data: [
        { student_id: S1, assignment_id: 'a1', score: 80, status: 'completed', completed_at: '2026-08-20' },
        { student_id: S2, assignment_id: 'a1', score: 60, status: 'completed', completed_at: '2026-08-21' },
      ],
      error: null,
    });
    mockSb.setTable('challenge_assignments', {
      data: [
        { student_id: S1, challenge_id: 'c1', status: 'completed', score: 90 },
        { student_id: S2, challenge_id: 'c1', status: 'assigned', score: null },
      ],
      error: null,
    });
    mockSb.setTable('users', {
      data: [
        { id: S1, name: 'Aarav', grade: 'Grade 4', curriculum: 'IB PYP' },
        { id: S2, name: 'Bela', grade: 'Grade 4', curriculum: 'IB PYP' },
      ],
      error: null,
    });
    mockSb.setTable('assignments', {
      data: [{ id: 'a1', student_id: null, grade: 'Grade 4', curriculum: 'IB PYP', subject: 'Maths' }],
      error: null,
    });
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/insights`);

    expect(res.status).toBe(200);
    expect(res.body.totals.totalSubmissions).toBe(2);
    expect(res.body.totals.classAvgScore).toBe(70); // (80+60)/2
    expect(res.body.totals.totalChallengesAssigned).toBe(2);
    expect(res.body.totals.totalChallengesCompleted).toBe(1);
    // Broadcast assignment (student_id: null) reaches both grade-4/IB-PYP students.
    expect(res.body.totals.totalAssignmentsAssigned).toBe(2);
    expect(res.body.assignments).toHaveLength(2);
    expect(res.body.challenges).toHaveLength(2);
  });

  test('a personal (student_id-targeted) assignment counts only for that one student, and Staff Subject Mapping scopes bySubject', async () => {
    mockSb.setTable('teacher_student', { data: [{ student_id: S1 }, { student_id: S2 }], error: null });
    mockSb.setTable('assignment_submissions', {
      data: [{ student_id: S1, assignment_id: 'a1', score: 100, status: 'completed', completed_at: '2026-08-20' }],
      error: null,
    });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    // 'users' is queried twice in this route: once for the student list (array),
    // once via .maybeSingle() for the teacher's own email — queue both in call order.
    mockSb.setTable('users', [
      {
        data: [
          { id: S1, name: 'Aarav', grade: 'Grade 4', curriculum: 'IB PYP' },
          { id: S2, name: 'Bela', grade: 'Grade 4', curriculum: 'IB PYP' },
        ],
        error: null,
      },
      { data: { email: 'teacher@aivorah.test' }, error: null },
    ]);
    // Personal assignment (student_id set) - reaches ONLY S1, not S2.
    mockSb.setTable('assignments', {
      data: [{ id: 'a1', student_id: S1, grade: null, curriculum: null, subject: 'Mathematics' }],
      error: null,
    });
    mockSb.setTable('user_preferences', {
      data: { data: { teaches: [{ grade: 'Grade 4', curriculum: 'IB PYP', subjects: ['Mathematics'] }] } },
      error: null,
    });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/insights`);

    expect(res.status).toBe(200);
    expect(res.body.totals.totalAssignmentsAssigned).toBe(1); // personal, not a broadcast to both
    const s1Stats = res.body.assignments.find(a => a.id === S1);
    const s2Stats = res.body.assignments.find(a => a.id === S2);
    expect(s1Stats.assigned).toBe(1);
    expect(s2Stats.assigned).toBe(0);
    // Staff Subject Mapping scopes bySubject for both (grade 4 + IB PYP -> Mathematics).
    expect(s1Stats.scopedSubjects).toEqual(['Mathematics']);
    expect(s1Stats.bySubject.Mathematics.assigned).toBe(1);
    expect(s1Stats.bySubject.Mathematics.submitted).toBe(1);
  });

  test('every query legitimately returning null data (not []/{}) still produces a clean, zeroed response', async () => {
    mockSb.setTable('teacher_student', { data: [{ student_id: S1 }], error: null });
    mockSb.setTable('assignment_submissions', { data: null, error: null });
    mockSb.setTable('challenge_assignments', { data: null, error: null });
    mockSb.setTable('users', [
      { data: null, error: null }, // student info list comes back null, not []
      { data: null, error: null }, // teacher's own email lookup also null
    ]);
    mockSb.setTable('assignments', { data: null, error: null });
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/insights`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      totalSubmissions: 0, totalAssignmentsAssigned: 0, classAvgScore: null,
      totalChallengesAssigned: 0, totalChallengesCompleted: 0,
    });
  });

  test('a broadcast assignment skips a linked student with no matching users row, instead of crashing', async () => {
    const MISSING_STUDENT = '44444444-4444-4444-4444-444444444444';
    mockSb.setTable('teacher_student', { data: [{ student_id: S1 }, { student_id: MISSING_STUDENT }], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    // Only S1 has a users row - MISSING_STUDENT has none, so studentInfoMap[MISSING_STUDENT] is undefined.
    mockSb.setTable('users', [
      { data: [{ id: S1, name: 'Aarav', grade: 'Grade 4', curriculum: 'IB PYP' }], error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('assignments', {
      data: [{ id: 'a1', student_id: null, grade: 'Grade 4', curriculum: 'IB PYP' }], // broadcast
      error: null,
    });
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/insights`);

    expect(res.status).toBe(200);
    // Broadcast reaches only S1 (has info) - MISSING_STUDENT is silently skipped, not crashed on.
    expect(res.body.totals.totalAssignmentsAssigned).toBe(1);
  });

  test('a real query failure returns a clean 500, not a crash', async () => {
    mockSb.supabase.from.mockImplementationOnce(() => { throw new Error('connection lost'); });

    const res = await request(app).get(`/student/by-teacher/${TEACHER_UUID}/insights`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('connection lost');
  });
});
