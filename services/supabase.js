const { createClient } = require('@supabase/supabase-js');

// Strip ALL whitespace — some hosts wrap long env vars with \n + spaces
// inside the value, causing "Headers.set: invalid header value" in Node 18+
const supabase = createClient(
  (process.env.SUPABASE_URL || '').replace(/\s+/g, ''),
  (process.env.SUPABASE_SERVICE_KEY || '').replace(/\s+/g, '')
);

module.exports = supabase;
