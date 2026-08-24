require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-teacher-dashboard-service' }));

app.use('/student', require('./routes/student'));

const PORT = process.env.PORT || 3016;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Teacher Dashboard service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
