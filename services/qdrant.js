// Minimal port of ai-mentor/server/services/qdrant.js — only what the
// Teacher Dashboard's total-topics-per-subject lookup needs (client +
// resolveCollection). The full RAG search/upsert surface stays in the
// monolith/learning-paths-service; this service only ever reads topic counts.
const { QdrantClient } = require('@qdrant/js-client-rest');

const COLLECTION    = 'aivorah_curriculum_chunks_v1'; // NCERT + new content
const IB_COLLECTION = 'ai_mentor_content';            // IB PYP, CBSE, Cambridge, etc.

// Pick the right collection and normalise grade/curriculum for Qdrant
function resolveCollection(normCurriculum, grade) {
  if (normCurriculum === 'NCERT') {
    const m = String(grade || '').match(/(\d+)/);
    const qdrantGrade = m ? parseInt(m[1], 10) : grade;
    return { collection: COLLECTION, qdrantCurriculum: normCurriculum, qdrantGrade };
  }
  const qdrantCurriculum = normCurriculum === 'IB PYP' ? 'IB_PYP' : normCurriculum;
  const m = String(grade || '').match(/(\d+)/);
  const qdrantGrade = m ? `Grade ${m[1]}` : grade;
  return { collection: IB_COLLECTION, qdrantCurriculum, qdrantGrade };
}

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

module.exports = { client, resolveCollection, COLLECTION, IB_COLLECTION };
