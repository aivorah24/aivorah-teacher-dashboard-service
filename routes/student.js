const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { client: qdrant, resolveCollection } = require('../services/qdrant');
const { normalizeCurriculum } = require('../utils/curriculum');

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

// Module-level cache for topic counts — avoids repeated Qdrant pagination on every page load
const _topicCountCache = new Map(); // key → { count, expiresAt }
const TOPIC_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function fetchTotalTopicsFromQdrant(curriculum, grade, subject) {
  const cacheKey = `${curriculum}|${grade}|${subject || ''}`;
  const cached = _topicCountCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.count;

  try {
    const normCurr = normalizeCurriculum(curriculum, 'IB PYP');
    const { collection, qdrantCurriculum, qdrantGrade } = resolveCollection(normCurr, grade);
    const mustFilters = [
      { key: 'curriculum', match: { value: qdrantCurriculum } },
      { key: 'grade',      match: { value: qdrantGrade } },
    ];
    if (isRealSubject(subject)) mustFilters.push({ key: 'subject', match: { value: subject } });
    const seen   = new Set();
    let offset   = null;
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
        seen.add(`${p.subject}|${p.topic}`);
      }
      offset = result.next_page_offset ?? null;
    } while (offset !== null);
    const count = seen.size;
    _topicCountCache.set(cacheKey, { count, expiresAt: Date.now() + TOPIC_CACHE_TTL_MS });
    return count;
  } catch {
    return 0;
  }
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
      .select('student_id, subject, users!teacher_student_student_id_fkey(id, name, email, grade, school, curriculum, photo_url, created_at)')
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
    const { data: allAttempts } = await supabase
      .from('topic_attempts')
      .select('student_id, topic, subject, passed')
      .in('student_id', studentIds);
    const passedTopicsMap = {};
    const topicSubjectMap = {}; // student_id → { topic → subject }
    (allAttempts ?? []).forEach(a => {
      if (!topicSubjectMap[a.student_id]) topicSubjectMap[a.student_id] = {};
      if (a.subject) topicSubjectMap[a.student_id][a.topic] = a.subject;
      if (a.passed) {
        if (!passedTopicsMap[a.student_id]) passedTopicsMap[a.student_id] = new Set();
        passedTopicsMap[a.student_id].add(a.topic);
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

      // Deterministic "needs attention" — flagged solely by Learning Path progress
      // < 20% (not inactivity, not streak, not Assignments/Challenges — those are
      // tracked separately in their own columns/UI).
      // When totalTopics is a known, non-zero denominator we use the real %; when
      // it's unknown (e.g. Qdrant lookup miss for that curriculum/grade), fall back
      // to "has completed zero topics" so the flag can't be silently defeated by a
      // missing topic count.
      //
      // GRACE for freshly-added students: a student who has NEVER engaged (no
      // last-active, no XP, no completed topics) and whose account is younger
      // than NEW_STUDENT_GRACE_DAYS is NOT flagged — otherwise every student a
      // teacher adds shows "Attention" the instant they're created, before they
      // ever had a chance to log in. After the grace window a still-untouched
      // account does surface (they genuinely need a nudge).
      const NEW_STUDENT_GRACE_DAYS = 7;
      const hasStarted = Boolean(s.last_active_date) || (s.xp_points ?? 0) > 0 || topicsCount > 0;
      const accountAgeDays = user.created_at
        ? (Date.now() - new Date(user.created_at).getTime()) / 86400000
        : 999;
      const inNewGrace = !hasStarted && accountAgeDays < NEW_STUDENT_GRACE_DAYS;
      const needsAttention = inNewGrace
        ? false
        : (totalTopics > 0 ? progressPct < 20 : topicsCount === 0);

      return {
        id:             link.student_id,
        name:           user.name,
        email:          user.email,
        grade:          user.grade,
        school:         user.school,
        curriculum:     user.curriculum ?? null,
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
        needsAttention,
        photoUrl:       user.photo_url ?? null,
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

module.exports = router;
