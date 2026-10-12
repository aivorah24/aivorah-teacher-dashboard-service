const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { client: qdrant, resolveCollection } = require('../services/qdrant');
const { normalizeCurriculum } = require('../utils/curriculum');
const { computeTopicStatus } = require('../utils/topicStatus');
const { computeStudentStatus } = require('../utils/studentStatus');

// ── Helpers ────────────────────────────────────────────────
// Ported verbatim from ai-mentor/server/routes/student.js (2026-08-24) —
// only the 3 teacher-dashboard endpoints and what they depend on. See that
// file's own history for the original reasoning behind each piece; comments
// below are preserved from there.

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// teacher_student.subject is meant to scope a teacher to a real subject
// (Mathematics, English, ...), but many existing rows were populated with the
// curriculum name instead (e.g. "IB PYP", "CBSE"). Treat those as "no subject
// restriction" so we don't silently zero out every teacher's dashboard until
// links are recreated with real subjects.
const CURRICULUM_NAME_SET = new Set([
  'ib pyp', 'ib_pyp', 'ibpyp', 'ncert', 'cbse', 'cambridge', 'oxford', 'pearson',
  'singapore moe', 'singapore_moe', 'general',
]);
function isRealSubject(subject) {
  const s = String(subject || '').trim().toLowerCase();
  return s.length > 0 && !CURRICULUM_NAME_SET.has(s);
}

// Module-level cache for real syllabus topics — avoids repeated Qdrant
// pagination on every page load. Stores the NAMES; the count used by the
// roster route is derived from these, so both stay in sync by construction.
const _topicCache = new Map(); // key → { topics: [{subject, topic}], expiresAt }
const TOPIC_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// The NCERT/CBSE Qdrant collection has inconsistent ingestion: some chunks
// carry a real chapter name in `topic` ("Data Handling"), others only carry
// an internal chapter code with no readable title anywhere in the payload
// ("cemm109", "demm104" — verified by inspecting every payload field, incl.
// `source`, which is just the same code as a filename). Showing a raw code
// as a syllabus column is more confusing than not showing it at all, and an
// attempted automatic title-recovery from the OCR'd content proved
// unreliable (many "best guesses" were story character names, not chapters)
// — so these are excluded rather than mislabeled. Real student activity
// against ANY topic (readable or coded) is never affected by this filter;
// it only controls which UNTOUCHED syllabus topics get added as extra
// columns. IB PYP's collection doesn't have this problem.
function isReadableTopicName(topic) {
  return !/^[a-z]{4,6}\d{2,4}$/i.test(String(topic || '').trim());
}

async function fetchSyllabusTopicsFromQdrant(curriculum, grade, subject) {
  const cacheKey = `${curriculum}|${grade}|${subject || ''}`;
  const cached = _topicCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.topics;

  try {
    const normCurr = normalizeCurriculum(curriculum, 'IB PYP');
    const { collection, qdrantCurriculum, qdrantGrade } = resolveCollection(normCurr, grade);
    const mustFilters = [
      { key: 'curriculum', match: { value: qdrantCurriculum } },
      { key: 'grade',      match: { value: qdrantGrade } },
    ];
    if (isRealSubject(subject)) mustFilters.push({ key: 'subject', match: { value: subject } });
    const seen = new Map(); // "subject|topic" → { subject, topic }
    let offset = null;
    do {
      const result = await qdrant.scroll(collection, {
        filter:       { must: mustFilters },
        limit:        100,
        offset:       offset ?? undefined,
        with_payload: true,
        with_vector:  false,
      });
      for (const point of result.points) {
        const p = point.payload;
        if (!isReadableTopicName(p.topic)) continue;
        const key = `${p.subject}|${p.topic}`;
        if (!seen.has(key)) seen.set(key, { subject: p.subject ?? null, topic: p.topic });
      }
      offset = result.next_page_offset ?? null;
    } while (offset !== null);
    const topics = [...seen.values()];
    _topicCache.set(cacheKey, { topics, expiresAt: Date.now() + TOPIC_CACHE_TTL_MS });
    return topics;
  } catch {
    return [];
  }
}

// Kept for the roster route — same unique subject|topic pair semantics as before.
async function fetchTotalTopicsFromQdrant(curriculum, grade, subject) {
  return (await fetchSyllabusTopicsFromQdrant(curriculum, grade, subject)).length;
}

const TEACHER_ID_MAP = {
  'teacher@demo.com': '00000000-0000-0000-0000-000000000004',
};

async function resolveTeacherId(id) {
  /* istanbul ignore next -- unreachable via these 3 routes: Express guarantees
     req.params.teacherId is always a non-empty string whenever the route
     matches at all. Kept for parity with the original monolith function,
     which may have had other (not-extracted) callers that could pass
     empty/undefined. Not test-worthy through this service's actual routes. */
  if (!id) return null;
  if (TEACHER_ID_MAP[id]) return TEACHER_ID_MAP[id];
  if (/^[0-9a-f-]{36}$/.test(id)) return id;
  // Lookup by email in users table
  const { data } = await supabase.from('users').select('id').eq('email', id).single();
  return data?.id || id;
}

// ── GET /student/recent-activity/by-teacher/:teacherId ──────
// Live event feed (topic completed / assignment submitted / challenge completed)
// across a teacher's students — replaces the old static "Xh total study time"
// row with real, timestamped events, industry-dashboard style.
router.get('/recent-activity/by-teacher/:teacherId', async (req, res) => {
  try {
    const rawId = req.params.teacherId;
    const teacherId = await resolveTeacherId(rawId);
    // "Recent Activity" means today's activity, not a running history — a short,
    // high-signal list of what happened today, capped at 3 so it never crowds
    // out the rest of the dashboard.
    const limit = Math.min(parseInt(req.query.limit) || 3, 30);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const { data: links } = await supabase
      .from('teacher_student')
      .select('student_id')
      .eq('teacher_id', teacherId ?? rawId);
    const studentIds = [...new Set((links ?? []).map(l => l.student_id))];
    if (studentIds.length === 0) return res.json([]);

    const { data: usersRows } = await supabase
      .from('users')
      .select('id, name')
      .in('id', studentIds);
    const nameMap = {};
    (usersRows ?? []).forEach(u => { nameMap[u.id] = u.name; });

    const [{ data: attempts }, { data: assignments }, { data: challAssigns }, { data: statsRows }] = await Promise.all([
      supabase.from('topic_attempts')
        .select('student_id, topic, subject, created_at')
        .in('student_id', studentIds).eq('passed', true)
        .order('created_at', { ascending: false }).limit(limit),
      supabase.from('assignments')
        .select('student_id, title, subject, completed_at')
        .in('student_id', studentIds).eq('status', 'completed').not('completed_at', 'is', null)
        .order('completed_at', { ascending: false }).limit(limit),
      supabase.from('challenge_assignments')
        .select('student_id, challenge_id, completed_at')
        .in('student_id', studentIds).eq('status', 'completed').not('completed_at', 'is', null)
        .order('completed_at', { ascending: false }).limit(limit),
      // Fallback for topics completed via a path that didn't log topic_attempts
      // (e.g. before subject tracking was wired up) — last_lesson + updated_at
      // is the best signal available so a real completion never silently
      // vanishes from the feed.
      supabase.from('student_stats')
        .select('student_id, last_lesson, updated_at')
        .in('student_id', studentIds).not('last_lesson', 'is', null).neq('last_lesson', ''),
    ]);

    const challengeIds = [...new Set((challAssigns ?? []).map(c => c.challenge_id))];
    let challengeTitleMap = {};
    if (challengeIds.length > 0) {
      const { data: challenges } = await supabase.from('challenges').select('id, title').in('id', challengeIds);
      (challenges ?? []).forEach(c => { challengeTitleMap[c.id] = c.title; });
    }

    // Topics already represented by a topic_attempts row (per student) — skip
    // these in the fallback so a topic isn't shown twice.
    const attemptedTopicsByStudent = {};
    (attempts ?? []).forEach(a => {
      if (!attemptedTopicsByStudent[a.student_id]) attemptedTopicsByStudent[a.student_id] = new Set();
      attemptedTopicsByStudent[a.student_id].add(a.topic);
    });
    const fallbackTopicEvents = (statsRows ?? [])
      .filter(s => !(attemptedTopicsByStudent[s.student_id]?.has(s.last_lesson)))
      .map(s => ({
        studentId: s.student_id,
        name: nameMap[s.student_id] || 'Student',
        type: 'topic',
        prefix: 'Completed ', title: s.last_lesson, suffix: '',
        text: `Completed "${s.last_lesson}"`,
        timestamp: s.updated_at,
      }));

    const events = [
      ...(attempts ?? []).map(a => ({
        studentId: a.student_id,
        name: nameMap[a.student_id] || 'Student',
        type: 'topic',
        prefix: 'Completed ', title: a.topic, suffix: a.subject ? ` in ${a.subject}` : '',
        text: `Completed "${a.topic}"${a.subject ? ` in ${a.subject}` : ''}`,
        timestamp: a.created_at,
      })),
      ...fallbackTopicEvents,
      ...(assignments ?? []).map(a => ({
        studentId: a.student_id,
        name: nameMap[a.student_id] || 'Student',
        type: 'assignment',
        prefix: 'Completed assignment ', title: a.title, suffix: '',
        text: `Completed assignment "${a.title}"`,
        timestamp: a.completed_at,
      })),
      ...(challAssigns ?? []).map(c => ({
        studentId: c.student_id,
        name: nameMap[c.student_id] || 'Student',
        type: 'challenge',
        prefix: 'Completed challenge ', title: challengeTitleMap[c.challenge_id] || 'Challenge', suffix: '',
        text: `Completed challenge "${challengeTitleMap[c.challenge_id] || 'Challenge'}"`,
        timestamp: c.completed_at,
      })),
    ]
      .filter(e => e.timestamp && new Date(e.timestamp) >= todayStart)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /student/by-teacher/:teacherId ─────────────────────
// Returns all students linked to a teacher with their stats
router.get('/by-teacher/:teacherId', async (req, res) => {
  try {
    const rawId = req.params.teacherId;
    const teacherId = await resolveTeacherId(rawId);

    const { data: links, error } = await supabase
      .from('teacher_student')
      .select('student_id, subject, users!teacher_student_student_id_fkey(id, name, email, grade, section, class, school, curriculum, photo_url, created_at)')
      .eq('teacher_id', teacherId ?? rawId);

    if (error) return res.status(500).json({ error: error.message });

    // The real source of "which subjects does this teacher teach" is the
    // admin-curated Staff Subject Mapping (StaffSubjectMappingScreen), stored as
    // teacher.user_preferences.data.teaches = [{ grade, curriculum, subjects[] }].
    // teacher_student.subject is a separate, mostly-unused field that in practice
    // holds the curriculum name, not a real subject — so it's only a fallback.
    const { data: teacherUser } = await supabase.from('users').select('email').eq('id', teacherId ?? rawId).maybeSingle();
    let teacherTeaches = [];
    if (teacherUser?.email) {
      const { data: teacherPrefs } = await supabase
        .from('user_preferences')
        .select('data')
        .eq('user_email', teacherUser.email)
        .maybeSingle();
      teacherTeaches = teacherPrefs?.data?.teaches || [];
    }
    // Resolve real subjects for a given grade+curriculum from the teaches mapping.
    function subjectsForGradeCurriculum(grade, curriculum) {
      const subjects = new Set();
      teacherTeaches.forEach(entry => {
        if (entry.grade === grade && entry.curriculum === curriculum) {
          (entry.subjects || []).forEach(s => subjects.add(s));
        }
      });
      return subjects;
    }

    // A student can have multiple subject-scoped links to the same teacher (e.g.
    // "Mathematics" + "English") — collect all real subjects per student before
    // deduplicating to a single row, so we know exactly which subjects this
    // teacher is scoped to for that student. Prefer the Staff Subject Mapping;
    // fall back to teacher_student.subject only when it holds a real subject.
    const teacherSubjectsByStudent = {};
    links.forEach(l => {
      const info = l.users ?? {};
      const fromMapping = subjectsForGradeCurriculum(info.grade, info.curriculum);
      if (fromMapping.size > 0) {
        teacherSubjectsByStudent[l.student_id] = fromMapping;
      } else if (isRealSubject(l.subject) && !teacherSubjectsByStudent[l.student_id]) {
        teacherSubjectsByStudent[l.student_id] = new Set([l.subject]);
      }
    });

    // Deduplicate links by student_id — a student can have multiple subjects assigned
    // (e.g., "General" + "Mathematics") but should only appear once in the list
    const seenStudentIds = new Set();
    const uniqueLinks = links.filter(l => {
      if (seenStudentIds.has(l.student_id)) return false;
      seenStudentIds.add(l.student_id);
      return true;
    });

    const studentIds = uniqueLinks.map(l => l.student_id);
    if (studentIds.length === 0) return res.json([]);

    const { data: stats } = await supabase
      .from('student_stats')
      .select('*')
      .in('student_id', studentIds);

    const statsMap = {};
    (stats ?? []).forEach(s => { statsMap[s.student_id] = s; });

    // Fetch topic_attempts (all, not just passed) — supplements student_stats.completed_topics
    // and gives us topic → subject so completed topics can be scoped to the teacher's subjects.
    // Also the source for quizAttempts/quizBestScore below (Activity & Performance
    // table's Quiz columns — Student Progress work-order).
    const { data: allAttempts } = await supabase
      .from('topic_attempts')
      .select('student_id, topic, subject, passed, score')
      .in('student_id', studentIds);
    const passedTopicsMap = {};
    const topicSubjectMap = {}; // student_id → { topic → subject }
    const quizStatsMap = {}; // student_id → { attempts, bestScore }
    (allAttempts ?? []).forEach(a => {
      if (!topicSubjectMap[a.student_id]) topicSubjectMap[a.student_id] = {};
      if (a.subject) topicSubjectMap[a.student_id][a.topic] = a.subject;
      if (a.passed) {
        if (!passedTopicsMap[a.student_id]) passedTopicsMap[a.student_id] = new Set();
        passedTopicsMap[a.student_id].add(a.topic);
      }
      if (!quizStatsMap[a.student_id]) quizStatsMap[a.student_id] = { attempts: 0, bestScore: null };
      quizStatsMap[a.student_id].attempts += 1;
      if (typeof a.score === 'number') {
        quizStatsMap[a.student_id].bestScore = Math.max(quizStatsMap[a.student_id].bestScore ?? 0, a.score);
      }
    });

    // Per-subject Learning Path time (Maths: Xm, English: Ym, ...) tracked going
    // forward via student_subject_time — used both for the scoped-subject display
    // and to surface "other subjects" time separately, never blended in.
    // today_minutes/today_date give today's per-subject time (reset when the date
    // rolls over) for the leaderboard's "Today" column.
    const today = todayISO();
    const { data: subjectTimeRows } = await supabase
      .from('student_subject_time')
      .select('student_id, subject, minutes, today_minutes, today_date')
      .in('student_id', studentIds);
    const subjectTimeMap = {}; // student_id → { subject → minutes }
    const subjectTimeTodayMap = {}; // student_id → { subject → minutes today }
    (subjectTimeRows ?? []).forEach(r => {
      if (!subjectTimeMap[r.student_id]) subjectTimeMap[r.student_id] = {};
      subjectTimeMap[r.student_id][r.subject] = r.minutes;
      if (!subjectTimeTodayMap[r.student_id]) subjectTimeTodayMap[r.student_id] = {};
      subjectTimeTodayMap[r.student_id][r.subject] = r.today_date === today ? (r.today_minutes || 0) : 0;
    });

    // Pre-fetch totalTopics once per unique curriculum+grade(+subject) combo — avoids
    // N Qdrant queries. Includes one combo per teacher-scoped subject per student.
    const combos = new Set();
    uniqueLinks.forEach(l => {
      const curriculum = l.users?.curriculum ?? '';
      const grade = l.users?.grade ?? '';
      const subjects = teacherSubjectsByStudent[l.student_id];
      if (subjects && subjects.size > 0) {
        subjects.forEach(subj => combos.add(`${curriculum}|${grade}|${subj}`));
      } else {
        combos.add(`${curriculum}|${grade}|`);
      }
    });
    const topicsCache = {};
    await Promise.all([...combos].map(async key => {
      const [curriculum, grade, subject] = key.split('|');
      topicsCache[key] = await fetchTotalTopicsFromQdrant(curriculum, grade, subject || undefined);
    }));

    // ── Per-student Assignments + Challenges completion (for the composite score used
    // by "needs attention" — a student should only be flagged when they're behind
    // across ALL activity streams, not just one, e.g. skipping Learning Path while
    // being highly active on assignments/challenges shouldn't trigger a flag alone).
    const { data: subs } = await supabase
      .from('assignment_submissions')
      .select('student_id, assignment_id')
      .in('student_id', studentIds);
    const submittedMap = {};
    (subs ?? []).forEach(sub => { submittedMap[sub.student_id] = (submittedMap[sub.student_id] || 0) + 1; });

    const { data: teacherAssignments } = await supabase
      .from('assignments')
      .select('id, student_id, grade, curriculum')
      .eq('created_by_id', teacherId ?? rawId);
    const assignedCountMap = {};
    studentIds.forEach(id => { assignedCountMap[id] = 0; });
    (teacherAssignments ?? []).forEach(a => {
      if (a.student_id) {
        if (assignedCountMap[a.student_id] !== undefined) assignedCountMap[a.student_id] += 1;
      } else {
        uniqueLinks.forEach(l => {
          const info = l.users ?? {};
          const gradeMatch = !a.grade || info.grade === a.grade;
          const curriculumMatch = !a.curriculum || info.curriculum === a.curriculum;
          if (gradeMatch && curriculumMatch) assignedCountMap[l.student_id] += 1;
        });
      }
    });

    const { data: challengeAssigns } = await supabase
      .from('challenge_assignments')
      .select('student_id, status')
      .in('student_id', studentIds);
    const challengeMap = {};
    (challengeAssigns ?? []).forEach(c => {
      if (!challengeMap[c.student_id]) challengeMap[c.student_id] = { assigned: 0, completed: 0 };
      challengeMap[c.student_id].assigned += 1;
      if (c.status === 'completed') challengeMap[c.student_id].completed += 1;
    });

    const students = await Promise.all(uniqueLinks.map(async link => {
      const s = statsMap[link.student_id] ?? {};
      const user = link.users ?? {};

      // Merge completed_topics from student_stats + passed topics from topic_attempts
      const statsTopics = s.completed_topics ?? [];
      const attemptsPassed = passedTopicsMap[link.student_id] ?? new Set();
      const allMergedTopics = [...new Set([...statsTopics, ...attemptsPassed])];

      const curriculum = user.curriculum ?? '';
      const grade      = user.grade ?? '';
      const scopedSubjects = teacherSubjectsByStudent[link.student_id]
        ? [...teacherSubjectsByStudent[link.student_id]]
        : [];

      // When this teacher is scoped to real subjects, count ONLY topics known to
      // belong to those subjects — other subjects (PE, Art, Science, ...) are
      // handled by other staff and must never inflate this teacher's Maths/English
      // progress, even when a topic's subject isn't on record yet.
      const topicSubjects = topicSubjectMap[link.student_id] ?? {};
      const mergedTopics = scopedSubjects.length > 0
        ? allMergedTopics.filter(t => scopedSubjects.includes(topicSubjects[t]))
        : allMergedTopics;
      const topicsCount = mergedTopics.length;
      // Per-topic subject label — lets the teacher see exactly which subject each
      // completed topic belongs to (falls back to "—" when not yet on record).
      const completedTopicsDetailed = mergedTopics.map(t => ({ topic: t, subject: topicSubjects[t] || null }));

      const totalTopics = scopedSubjects.length > 0
        ? scopedSubjects.reduce((sum, subj) => sum + (topicsCache[`${curriculum}|${grade}|${subj}`] ?? 0), 0)
        : (topicsCache[`${curriculum}|${grade}|`] ?? 0);
      const progressPct = totalTopics > 0
        ? Math.min(100, Math.round((topicsCount / totalTopics) * 100))
        : 0;

      // Per-subject time: scoped subjects only when the teacher has real subjects,
      // otherwise every subject the student has logged time in.
      const subjectTimes = subjectTimeMap[link.student_id] ?? {};
      const scopedSubjectTime = scopedSubjects.length > 0
        ? Object.fromEntries(scopedSubjects.map(subj => [subj, subjectTimes[subj] || 0]))
        : subjectTimes;
      const otherSubjectTime = scopedSubjects.length > 0
        ? Object.fromEntries(Object.entries(subjectTimes).filter(([subj]) => !scopedSubjects.includes(subj)))
        : {};

      // Today's Learning Path time, scoped to the teacher's subject(s) the same
      // way as the cumulative total above. scopedSubjectTimeToday exposes the
      // per-subject breakdown (Mathematics: Xm, English: Ym) for today specifically.
      const subjectTimesToday = subjectTimeTodayMap[link.student_id] ?? {};
      const scopedSubjectTimeToday = scopedSubjects.length > 0
        ? Object.fromEntries(scopedSubjects.map(subj => [subj, subjectTimesToday[subj] || 0]))
        : subjectTimesToday;
      const learningPathTimeToday = scopedSubjects.length > 0
        ? scopedSubjects.reduce((sum, subj) => sum + (subjectTimesToday[subj] || 0), 0)
        : Object.values(subjectTimesToday).reduce((sum, m) => sum + m, 0);

      // Per-student Assignments % and Challenges % — same volumetric completion-rate
      // logic as the class-wide insights endpoint (completed ÷ assigned), so a student
      // who's actively submitting isn't penalized just for a 0-populated denominator.
      const assignedCount  = assignedCountMap[link.student_id] || 0;
      const submittedCount = submittedMap[link.student_id] || 0;
      const assignPct = assignedCount > 0 ? Math.round((submittedCount / assignedCount) * 100) : 0;

      const chall = challengeMap[link.student_id] || { assigned: 0, completed: 0 };
      const challPct = chall.assigned > 0 ? Math.round((chall.completed / chall.assigned) * 100) : 0;

      const hasStarted = Boolean(s.last_active_date) || (s.xp_points ?? 0) > 0 || topicsCount > 0;
      const status = computeStudentStatus({ lastActive: s.last_active_date, createdAt: user.created_at, progressPct });
      const needsAttention = status === 'needs_attention';

      return {
        id:             link.student_id,
        name:           user.name,
        email:          user.email,
        grade:          user.grade,
        school:         user.school,
        curriculum:     user.curriculum ?? null,
        section:        user.section ?? null,
        class:          user.class ?? null,
        subject:        link.subject,
        scopedSubjects,
        totalTopics,
        createdAt:      user.created_at ?? null,
        hasStarted,
        xpPoints:       s.xp_points        ?? 0,
        level:          s.level            ?? 1,
        currentStreak:  s.current_streak   ?? 0,
        studyTime:      s.study_time_minutes ?? 0,
        // learningPathTime is subject-scoped once real subjects are tracked (via
        // student_subject_time); falls back to the pre-existing combined total
        // for teachers/students without subject-tagged history yet.
        learningPathTime: scopedSubjects.length > 0
          ? Object.values(scopedSubjectTime).reduce((a, b) => a + b, 0)
          : (s.learning_path_minutes ?? 0),
        // Today's Learning Path time, scoped the same way as learningPathTime —
        // falls back to 0 for students with no per-subject time logged today yet.
        learningPathTimeToday: learningPathTimeToday,
        subjectTimeToday: scopedSubjectTimeToday, // e.g. { Mathematics: 4, English: 0 } — today only
        subjectTime:      scopedSubjectTime, // e.g. { Mathematics: 12, English: 8 } — cumulative total
        otherSubjectTime: otherSubjectTime,  // subjects outside this teacher's scope, shown separately
        assignmentTime: s.assignment_time_minutes ?? 0,
        challengeTime:  s.challenge_time_minutes ?? 0,
        completedTopics: mergedTopics,
        completedTopicsDetailed, // [{ topic, subject }] — which subject each completed topic belongs to
        progressPct,
        assignmentsDone: s.assignments_done ?? 0,
        lastActive:     s.last_active_date,
        status,
        needsAttention,
        photoUrl:       user.photo_url ?? null,
        // Real quiz stats (Activity & Performance table's Quiz columns) —
        // Student Progress work-order. No fabricated Learn/Listen/AI-Tutor
        // time split or "used Aivorah AI" flag — neither is tracked
        // anywhere in the schema, so those columns are simply not returned
        // rather than invented.
        quizAttempts:   quizStatsMap[link.student_id]?.attempts ?? 0,
        quizBestScore:  quizStatsMap[link.student_id]?.bestScore ?? null,
      };
    }));

    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /student/by-teacher/:teacherId/insights ─────────────
router.get('/by-teacher/:teacherId/insights', async (req, res) => {
  try {
    const rawId = req.params.teacherId;
    const teacherId = await resolveTeacherId(rawId);

    const { data: links } = await supabase
      .from('teacher_student')
      .select('student_id')
      .eq('teacher_id', teacherId ?? rawId);

    const studentIds = (links || []).map(l => l.student_id);
    if (studentIds.length === 0) return res.json({ assignments: [], challenges: [] });

    // Fetch all assignment submissions for these students
    const { data: subs } = await supabase
      .from('assignment_submissions')
      .select('student_id, assignment_id, score, status, completed_at')
      .in('student_id', studentIds);

    // Fetch all challenge assignments for these students
    const { data: challengeAssigns } = await supabase
      .from('challenge_assignments')
      .select('student_id, challenge_id, status, score, xp_awarded, created_at')
      .in('student_id', studentIds);

    // Get student names + grade/curriculum (grade/curriculum needed to resolve how many
    // students each class-wide "All students" assignment broadcast actually reaches)
    const { data: users } = await supabase
      .from('users')
      .select('id, name, grade, curriculum')
      .in('id', studentIds);
    const nameMap = {};
    const studentInfoMap = {};
    (users || []).forEach(u => {
      nameMap[u.id] = u.name;
      studentInfoMap[u.id] = { grade: u.grade || null, curriculum: u.curriculum || null };
    });

    // Fetch this teacher's own assignments (personal + class-wide broadcasts) to compute
    // a true "total assigned" count — mirrors the visibility logic in GET /assignments:
    // personal assignments reach exactly 1 student; broadcasts reach every linked student
    // whose grade+curriculum matches the assignment.
    const { data: teacherAssignments } = await supabase
      .from('assignments')
      .select('id, student_id, grade, curriculum, subject')
      .eq('created_by_id', teacherId ?? rawId);

    // Real subject mapping (same Staff Subject Mapping source used for Learning Path
    // scoping) — lets Assignments be scoped/broken-down by subject too (Mathematics
    // assigned/submitted vs English assigned/submitted), not just a combined count.
    const { data: teacherUserForAssign } = await supabase.from('users').select('email').eq('id', teacherId ?? rawId).maybeSingle();
    let teacherTeachesForAssign = [];
    if (teacherUserForAssign?.email) {
      const { data: prefs } = await supabase.from('user_preferences').select('data').eq('user_email', teacherUserForAssign.email).maybeSingle();
      teacherTeachesForAssign = prefs?.data?.teaches || [];
    }
    function assignSubjectsFor(grade, curriculum) {
      const set = new Set();
      teacherTeachesForAssign.forEach(entry => {
        if (entry.grade === grade && entry.curriculum === curriculum) (entry.subjects || []).forEach(s => set.add(s));
      });
      return set;
    }

    let totalAssignmentsAssigned = 0;
    const assignedCountMap = {};
    const assignedBySubjectMap = {}; // student_id → { subject → count }
    const assignmentIdSubjectMap = {}; // assignment_id → subject (for scoping submissions)
    studentIds.forEach(id => { assignedCountMap[id] = 0; assignedBySubjectMap[id] = {}; });
    (teacherAssignments || []).forEach(a => {
      if (a.subject) assignmentIdSubjectMap[a.id] = a.subject;
      const bump = (id) => {
        totalAssignmentsAssigned += 1;
        assignedCountMap[id] += 1;
        if (a.subject) assignedBySubjectMap[id][a.subject] = (assignedBySubjectMap[id][a.subject] || 0) + 1;
      };
      if (a.student_id) {
        if (studentIds.includes(a.student_id)) bump(a.student_id);
      } else {
        studentIds.forEach(id => {
          const info = studentInfoMap[id];
          if (!info) return;
          const gradeMatch = !a.grade || info.grade === a.grade;
          const curriculumMatch = !a.curriculum || info.curriculum === a.curriculum;
          if (gradeMatch && curriculumMatch) bump(id);
        });
      }
    });

    // Aggregate assignment stats per student
    const assignMap = {};
    const submittedBySubjectMap = {}; // student_id → { subject → count }
    studentIds.forEach(id => { submittedBySubjectMap[id] = {}; });
    (subs || []).forEach(s => {
      if (!assignMap[s.student_id]) assignMap[s.student_id] = { submitted: 0, totalScore: 0, scored: 0 };
      assignMap[s.student_id].submitted++;
      if (typeof s.score === 'number') {
        assignMap[s.student_id].totalScore += s.score;
        assignMap[s.student_id].scored++;
      }
      const subj = assignmentIdSubjectMap[s.assignment_id];
      if (subj && submittedBySubjectMap[s.student_id]) {
        submittedBySubjectMap[s.student_id][subj] = (submittedBySubjectMap[s.student_id][subj] || 0) + 1;
      }
    });

    const assignmentStats = studentIds.map(id => {
      const info = studentInfoMap[id] || {};
      const scopedSubjects = [...assignSubjectsFor(info.grade, info.curriculum)];
      return {
        id,
        name: nameMap[id] || 'Unknown',
        assigned: assignedCountMap[id] || 0,
        submitted: assignMap[id]?.submitted || 0,
        avgScore: assignMap[id]?.scored > 0 ? Math.round(assignMap[id].totalScore / assignMap[id].scored) : null,
        scopedSubjects,
        // e.g. { Mathematics: { assigned: 3, submitted: 1 }, English: { assigned: 2, submitted: 2 } }
        bySubject: Object.fromEntries(scopedSubjects.map(subj => [subj, {
          assigned: assignedBySubjectMap[id]?.[subj] || 0,
          submitted: submittedBySubjectMap[id]?.[subj] || 0,
        }])),
      };
    });

    // Aggregate challenge stats per student
    const challMap = {};
    (challengeAssigns || []).forEach(c => {
      if (!challMap[c.student_id]) challMap[c.student_id] = { assigned: 0, completed: 0, totalScore: 0, scored: 0 };
      challMap[c.student_id].assigned++;
      if (c.status === 'completed') challMap[c.student_id].completed++;
      if (typeof c.score === 'number') {
        challMap[c.student_id].totalScore += c.score;
        challMap[c.student_id].scored++;
      }
    });

    const challengeStats = studentIds.map(id => ({
      id,
      name: nameMap[id] || 'Unknown',
      assigned: challMap[id]?.assigned || 0,
      completed: challMap[id]?.completed || 0,
      avgScore: challMap[id]?.scored > 0 ? Math.round(challMap[id].totalScore / challMap[id].scored) : null,
    }));

    // Totals
    const totalSubmissions = (subs || []).length;
    const allScores = (subs || []).filter(s => typeof s.score === 'number').map(s => s.score);
    const classAvgScore = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : null;

    const totalChallengesAssigned = (challengeAssigns || []).length;
    const totalChallengesCompleted = (challengeAssigns || []).filter(c => c.status === 'completed').length;

    res.json({
      assignments: assignmentStats,
      challenges: challengeStats,
      totals: {
        totalSubmissions,
        totalAssignmentsAssigned,
        classAvgScore,
        totalChallengesAssigned,
        totalChallengesCompleted,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /student/by-teacher/:teacherId/heatmap ──────────────
// Real per-student x per-topic mastery heatmap — ported verbatim (2026-08-29)
// from ai-mentor/server/routes/student.js, the same deliberate, scoped
// extraction already done for the two routes above (2026-08-24). This route
// was left in the monolith at the time as "nothing depends on it yet" — it
// now backs the real Teacher "Student Progress" page (previously a dummy/
// mock screen with hardcoded fake students, see BUGS_AND_FIXES.md / Teacher
// Student Progress work-order).
router.get('/by-teacher/:teacherId/heatmap', async (req, res) => {
  try {
    const rawId = req.params.teacherId;
    const teacherId = await resolveTeacherId(rawId);
    const subjectFilter = req.query.subject && isRealSubject(req.query.subject) ? req.query.subject : null;
    const gradeFilter   = req.query.grade || null;

    const { data: links, error } = await supabase
      .from('teacher_student')
      .select('student_id, subject, users!teacher_student_student_id_fkey(id, name, grade, section, class, curriculum, photo_url)')
      .eq('teacher_id', teacherId ?? rawId);
    if (error) return res.status(500).json({ error: error.message });

    // Which real subjects does this teacher teach? (Staff Subject Mapping first,
    // teacher_student.subject as fallback) — same source of truth as the main
    // by-teacher route so scoping stays consistent across screens.
    const { data: teacherUser } = await supabase.from('users').select('email').eq('id', teacherId ?? rawId).maybeSingle();
    let teacherTeaches = [];
    if (teacherUser?.email) {
      const { data: teacherPrefs } = await supabase
        .from('user_preferences').select('data').eq('user_email', teacherUser.email).maybeSingle();
      teacherTeaches = teacherPrefs?.data?.teaches || [];
    }
    function subjectsForGradeCurriculum(grade, curriculum) {
      const subjects = new Set();
      teacherTeaches.forEach(entry => {
        if (entry.grade === grade && entry.curriculum === curriculum) {
          (entry.subjects || []).forEach(s => subjects.add(s));
        }
      });
      return subjects;
    }
    const teacherSubjectsByStudent = {};
    links.forEach(l => {
      const info = l.users ?? {};
      const fromMapping = subjectsForGradeCurriculum(info.grade, info.curriculum);
      if (fromMapping.size > 0) teacherSubjectsByStudent[l.student_id] = fromMapping;
      else if (isRealSubject(l.subject) && !teacherSubjectsByStudent[l.student_id]) {
        teacherSubjectsByStudent[l.student_id] = new Set([l.subject]);
      }
    });

    // Deduplicate to one row per student, honoring the optional grade filter.
    const seen = new Set();
    const uniqueLinks = links.filter(l => {
      if (seen.has(l.student_id)) return false;
      if (gradeFilter && (l.users?.grade ?? '') !== gradeFilter) return false;
      seen.add(l.student_id);
      return true;
    });
    const studentIds = uniqueLinks.map(l => l.student_id);
    if (studentIds.length === 0) return res.json({ students: [], topics: [] });

    // Full attempt history (need score / attempt_number / created_at for the composite).
    const { data: allAttempts } = await supabase
      .from('topic_attempts')
      .select('student_id, topic, subject, grade, score, passed, attempt_number, created_at')
      .in('student_id', studentIds);

    // completed_topics from student_stats — topics finished via the Learning Path
    // that may never have generated a quiz attempt row.
    const { data: stats } = await supabase
      .from('student_stats').select('student_id, completed_topics').in('student_id', studentIds);
    const completedMap = {};
    (stats ?? []).forEach(s => { completedMap[s.student_id] = new Set(s.completed_topics ?? []); });

    // student_id → topic → { subject, attempts[] }
    const byStudentTopic = {};
    const topicSubject = {}; // topic → subject (for the column list)
    (allAttempts ?? []).forEach(a => {
      if (!byStudentTopic[a.student_id]) byStudentTopic[a.student_id] = {};
      if (!byStudentTopic[a.student_id][a.topic]) byStudentTopic[a.student_id][a.topic] = { subject: a.subject || null, attempts: [] };
      byStudentTopic[a.student_id][a.topic].attempts.push({
        score: a.score != null ? parseFloat(a.score) : null,
        passed: a.passed,
        attemptNumber: a.attempt_number,
        date: a.created_at,
      });
      if (a.subject && !topicSubject[a.topic]) topicSubject[a.topic] = a.subject;
    });

    // Real syllabus topics per student's (curriculum, grade, subject) — so the
    // heatmap's columns are the teacher's ACTUAL curriculum, not just whatever
    // topics happen to have activity. Without this, "Not started" is unreachable:
    // a topic nobody has touched never becomes a column at all.
    const syllabusByStudent = {};
    const syllabusCombos = new Map(); // "curr|grade|subj" → Promise
    for (const link of uniqueLinks) {
      const u = link.users ?? {};
      const scoped = teacherSubjectsByStudent[link.student_id]
        ? [...teacherSubjectsByStudent[link.student_id]] : [];
      const subjects = subjectFilter ? [subjectFilter] : (scoped.length > 0 ? scoped : [null]);
      const perStudent = [];
      for (const subj of subjects) {
        const key = `${u.curriculum}|${u.grade}|${subj || ''}`;
        if (!syllabusCombos.has(key)) {
          syllabusCombos.set(key, fetchSyllabusTopicsFromQdrant(u.curriculum, u.grade, subj || undefined));
        }
        perStudent.push(syllabusCombos.get(key));
      }
      syllabusByStudent[link.student_id] = (await Promise.all(perStudent)).flat();
    }

    // Union of topic columns across the whole class (so a topic only one student
    // has touched still appears as a column, gray for everyone else).
    const topicSet = new Set();

    const students = uniqueLinks.map(link => {
      const user = link.users ?? {};
      const scoped = teacherSubjectsByStudent[link.student_id]
        ? [...teacherSubjectsByStudent[link.student_id]] : [];
      const topicMap = byStudentTopic[link.student_id] ?? {};
      const completed = completedMap[link.student_id] ?? new Set();

      // Every topic this student has any signal for, unioned with the real
      // syllabus so untouched topics still appear (as "not_started") — no
      // real attempt data is ever dropped just because a topic isn't in Qdrant.
      const syllabus = syllabusByStudent[link.student_id] ?? [];
      syllabus.forEach(s => { if (s.subject && !topicSubject[s.topic]) topicSubject[s.topic] = s.subject; });
      const topicNames = new Set([
        ...Object.keys(topicMap),
        ...completed,
        ...syllabus.map(s => s.topic),
      ]);
      const topicStatus = {};
      topicNames.forEach(topic => {
        const entry = topicMap[topic];
        const subj = entry?.subject || topicSubject[topic] || null;
        // Subject scoping: an explicit ?subject= wins; otherwise a subject-teacher
        // only sees their scoped subjects; a class teacher (no scope) sees all.
        if (subjectFilter && subj !== subjectFilter) return;
        if (!subjectFilter && scoped.length > 0 && subj && !scoped.includes(subj)) return;
        const attempts = (entry?.attempts ?? []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
        const st = computeTopicStatus(attempts, { completedViaPath: completed.has(topic) });
        topicStatus[topic] = { ...st, subject: subj };
        topicSet.add(topic);
      });

      return {
        id: link.student_id,
        name: user.name,
        grade: user.grade ?? null,
        curriculum: user.curriculum ?? null,
        section: user.section ?? null,
        class: user.class ?? null,
        photoUrl: user.photo_url ?? null,
        scopedSubjects: scoped,
        topicStatus,
      };
    });

    const topics = [...topicSet].map(t => ({ topic: t, subject: topicSubject[t] || null }));
    res.json({ students, topics });
  } catch (err) {
    console.error('GET /student/by-teacher/:teacherId/heatmap error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /student/by-teacher/:teacherId/subject-summary ─────
// Real per-subject class averages — backs the Student Progress page's
// "Where the class stands, by subject" summary cards (previously hardcoded
// literal strings in the frontend mockup, e.g. "47%" / "Avg attempt: 15m" —
// see the Teacher Student Progress work-order). Grounded in the SAME
// teacher_student scoping as the other routes in this file, aggregating
// real topic_attempts rows — no fabricated numbers.
router.get('/by-teacher/:teacherId/subject-summary', async (req, res) => {
  try {
    const rawId = req.params.teacherId;
    const teacherId = await resolveTeacherId(rawId);

    const { data: links, error } = await supabase
      .from('teacher_student')
      .select('student_id')
      .eq('teacher_id', teacherId ?? rawId);
    if (error) return res.status(500).json({ error: error.message });

    const studentIds = [...new Set((links ?? []).map(l => l.student_id))];
    if (studentIds.length === 0) return res.json({ subjects: [], combined: null });

    const { data: attempts } = await supabase
      .from('topic_attempts')
      .select('student_id, subject, score, time_spent_seconds')
      .in('student_id', studentIds);

    const bySubject = {};
    const allScores = [];
    const allTimes = [];
    (attempts ?? []).forEach(a => {
      if (typeof a.score !== 'number' || !isRealSubject(a.subject)) return;
      if (!bySubject[a.subject]) bySubject[a.subject] = { scores: [], times: [] };
      bySubject[a.subject].scores.push(a.score);
      allScores.push(a.score);
      if (typeof a.time_spent_seconds === 'number') {
        bySubject[a.subject].times.push(a.time_spent_seconds);
        allTimes.push(a.time_spent_seconds);
      }
    });

    const avg = (arr) => arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

    const subjects = Object.entries(bySubject).map(([subject, v]) => ({
      subject,
      avgScorePct: avg(v.scores),
      avgAttemptSeconds: avg(v.times),
      attemptCount: v.scores.length,
    }));

    const combined = allScores.length > 0
      ? { avgScorePct: avg(allScores), avgAttemptSeconds: avg(allTimes), attemptCount: allScores.length }
      : null;

    res.json({ subjects, combined });
  } catch (err) {
    console.error('GET /student/by-teacher/:teacherId/subject-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /student/:studentId/topic/:topic/attempts ───────────
// Real per-attempt history for one student+topic — backs the Student
// Progress page's drill-down drawer (previously one hardcoded fake row in
// the frontend mockup). Not teacher-scoped by design: a specific student+
// topic pair is only ever reachable by tapping a cell the teacher already
// has legitimate access to render (via the heatmap/roster routes above),
// same trust boundary as the rest of this read-only aggregation service.
router.get('/:studentId/topic/:topic/attempts', async (req, res) => {
  try {
    const { studentId, topic } = req.params;
    const { data: attempts, error } = await supabase
      .from('topic_attempts')
      .select('attempt_number, score, passed, total_questions, correct_answers, time_spent_seconds, created_at')
      .eq('student_id', studentId)
      .eq('topic', topic)
      .order('attempt_number', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const rows = (attempts ?? []).map(a => ({
      attemptNumber: a.attempt_number,
      score: a.score != null ? parseFloat(a.score) : null,
      passed: a.passed,
      totalQuestions: a.total_questions ?? null,
      correctAnswers: a.correct_answers ?? null,
      mistakes: (a.total_questions != null && a.correct_answers != null) ? Math.max(0, a.total_questions - a.correct_answers) : null,
      timeSpentSeconds: a.time_spent_seconds ?? null,
      date: a.created_at,
    }));

    res.json({ attempts: rows });
  } catch (err) {
    console.error('GET /student/:studentId/topic/:topic/attempts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
