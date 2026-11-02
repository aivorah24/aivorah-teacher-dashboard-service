# aivorah-teacher-dashboard-service

Teacher dashboard data: a teacher's students, recent activity, insights, heatmap, subject summary and per-topic attempts.

**Called by:** frontend teacher Dashboard and Student Progress screens.

## Endpoints
| Route | What it does |
|---|---|
| `GET /student/by-teacher/:teacherId` | Teacher's students with status tags |
| `GET /student/recent-activity/by-teacher/:teacherId` | Recent student activity |
| `GET /student/by-teacher/:teacherId/insights, /heatmap, /subject-summary` | Class insights, topic heatmap, subject summary |
| `GET /student/:studentId/topic/:topic/attempts` | A student's attempts on one topic |
| `GET /health` | Health check |

## Run locally
```bash
npm ci
cp .env.example .env   # fill in values; see table below
npm run dev            # nodemon, port 3016
```

## Environment variables
| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `3016`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase project and service-role key (server-only, never expose) |
| `QDRANT_URL`, `QDRANT_API_KEY` | Qdrant vector DB (curriculum/topic data) |

## Tests
```bash
npm test
```

## Deploy
- **Render** web service `aivorah-teacher-dashboard-service` → https://aivorah-teacher-dashboard-service.onrender.com
- Auto-deploys from `main`. Build `npm install`, start `npm start`.
- CI: `.circleci/config.yml` and `.github/workflows/ci.yml` run the tests (GitHub Actions is billing-blocked on the account)
- After a merge, check the live commit on Render matches the branch head.

## Auth
No token check yet: trusts the teacher id in the URL. See the auth audit in `aivorah-handover`.

## Folder layout
| Path | Why it exists |
|---|---|
| `index.js` | Express app: middleware, route mounting, `/health`, listen |
| `routes/` | `student.js` |
| `services/` | Supabase and Qdrant clients |
| `utils/` | Curriculum names, student status tags (inactive / new / progress), topic status |
| `tests/` | Jest tests |
