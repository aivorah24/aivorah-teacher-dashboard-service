// Verbatim port of ai-mentor/server/utils/curriculum.js
function normalizeCurriculum(curriculum, fallback = 'IB PYP') {
  const value = String(curriculum || fallback).trim();

  const canonicalMap = {
    'IB_PYP':        'IB PYP',
    'IB PYP':        'IB PYP',
    'IBPYP':         'IB PYP',
    'ib pyp':        'IB PYP',
    'ib_pyp':        'IB PYP',
    'NCERT':         'NCERT',
    'ncert':         'NCERT',
    'Cambridge':     'Cambridge',
    'Oxford':        'Oxford',
    'Pearson':       'Pearson',
    'Singapore MOE': 'Singapore MOE',
    'Singapore_MOE': 'Singapore MOE',
    'CBSE':          'NCERT',
    'cbse':          'NCERT',
    'Cbse':          'NCERT',
    'ICSE':          'ICSE',
    'icse':          'ICSE',
    'Icse':          'ICSE',
    'NIOS':          'NIOS',
    'nios':          'NIOS',
    'Nios':          'NIOS',
  };

  return canonicalMap[value] ?? value;
}

module.exports = { normalizeCurriculum };
