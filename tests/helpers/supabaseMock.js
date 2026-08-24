// Chainable Supabase mock, same pattern as aivorah-assignments-service's.
// Configure per-table responses via `setTable(name, {data, error})` (or a
// queue via `setTable(name, [res1, res2, ...])` for a table hit more than
// once per request, consumed in call order). Every chain method returns
// `this`; the chain itself is thenable so code that awaits it directly
// (no terminal .single()/.maybeSingle() call) still resolves.
function makeSupabaseMock() {
  const tableResponses = {};
  const tableCallCounts = {};

  function nextResponseFor(table) {
    const configured = tableResponses[table];
    if (configured === undefined) return { data: null, error: null };
    if (Array.isArray(configured)) {
      const i = tableCallCounts[table] || 0;
      tableCallCounts[table] = i + 1;
      return configured[Math.min(i, configured.length - 1)];
    }
    return configured;
  }

  function makeChain(table) {
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      or: jest.fn(() => chain),
      in: jest.fn(() => chain),
      not: jest.fn(() => chain),
      neq: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      single: jest.fn(() => Promise.resolve(nextResponseFor(table))),
      maybeSingle: jest.fn(() => Promise.resolve(nextResponseFor(table))),
      then: (resolve, reject) => Promise.resolve(nextResponseFor(table)).then(resolve, reject),
    };
    return chain;
  }

  const supabase = {
    from: jest.fn((table) => makeChain(table)),
  };

  return {
    supabase,
    setTable(table, response) { tableResponses[table] = response; },
    reset() {
      Object.keys(tableResponses).forEach(k => delete tableResponses[k]);
      Object.keys(tableCallCounts).forEach(k => delete tableCallCounts[k]);
    },
  };
}

module.exports = { makeSupabaseMock };
