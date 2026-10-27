/* DEMO DATA - still used by screens that are not connected to the real engine yet. */
/* ============================================================
   SAMPLE DATA - shaped like the real API responses.
   ============================================================ */
const VALID_PASSWORD = "correcthorsebattery";
const schoolName = "Test Academy";

const summary = [
  { match_status: 'auto_matched', count: 3, total: 14000 },
  { match_status: 'needs_review', count: 2, total: 8000 },
  { match_status: 'unmatched', count: 1, total: 1200 },
];
const reviewQueue = [
  { id: 101, source: 'mpesa', amount: 5000, payer_phone: '254711111111', payer_name: 'Peter Mwangi', narration: 'school fees', confidence: 0.60, match_reason: 'Phone number matches 2 students (likely siblings) - needs a person to pick which one',
    candidates: [ { student_id: 1, full_name: 'Kevin Otieno Mwangi', admission_no: 'CM/M/101/24', score: 0.60 }, { student_id: 2, full_name: 'Faith Otieno Mwangi', admission_no: 'CM/M/102/24', score: 0.58 } ] },
  { id: 102, source: 'coop', amount: 3000, payer_phone: null, payer_name: 'ADM200 fees', narration: 'ADM200 fees', confidence: 0.55, match_reason: 'Admission number "ADM200" found in payment reference',
    suggested_student_name: 'James Kariuki', suggested_admission_no: 'ADM200', candidates: null },
];
const unmatched = [
  { id: 103, source: 'mpesa', amount: 1200, payer_phone: '254700000000', payer_name: 'Peter Njoroge', narration: '', received_at: '2026-07-28' },
];
let roster = [
  { admission_no: 'CM/M/101/24', full_name: 'Kevin Otieno Mwangi', class_name: 'Grade 2', stream_name: 'North', status: 'active', balance: 3000 },
  { admission_no: 'CM/M/102/24', full_name: 'Faith Otieno Mwangi', class_name: 'Grade 2', stream_name: 'North', status: 'active', balance: -500 },
  { admission_no: 'ADM200', full_name: 'James Kariuki', class_name: 'Grade 3', stream_name: null, status: 'active', balance: 0 },
  { admission_no: 'B100', full_name: 'Brian Otieno', class_name: 'Grade 1', stream_name: 'South', status: 'repeating', balance: 4500 },
];
const feeItemsByClass = {
  'Grade 1': { version: 1, items: [ { name: 'Tuition', amount: 4000, is_mandatory: true }, { name: 'Transport', amount: 1000, is_mandatory: false } ] },
  'Grade 2': { version: 2, items: [ { name: 'Tuition', amount: 5000, is_mandatory: true }, { name: 'Lunch', amount: 800, is_mandatory: false } ], history: [ { version: 1, name: 'Tuition', amount: 4500 } ] },
};

/* ---------- NEW fee-structure sample data, matching the real API shapes exactly ---------- */
const enabledClassesForFeeView = ['PP1', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4'];
const termTabs = [ { id: 1, label: 'Term 1' }, { id: 2, label: 'Term 2' }, { id: 3, label: 'Term 3' } ];

const feeStructureData = {
  'PP1': {
    1: { version: 1, items: [ { name: 'Tuition', amount: 3000, is_mandatory: true } ], history: [] },
    2: { version: 1, items: [ { name: 'Tuition', amount: 3000, is_mandatory: true } ], history: [] },
    3: { version: 1, items: [], history: [] },
  },
  'Grade 1': {
    1: { version: 1, items: [ { name: 'Tuition', amount: 4000, is_mandatory: true }, { name: 'Transport', amount: 1000, is_mandatory: false } ], history: [] },
    2: { version: 1, items: [ { name: 'Tuition', amount: 4200, is_mandatory: true } ], history: [] },
    3: { version: 1, items: [], history: [] },
  },
  'Grade 2': {
    1: { version: 2, items: [ { name: 'Tuition', amount: 4800, is_mandatory: true }, { name: 'Transport', amount: 1000, is_mandatory: false } ],
      history: [ { version: 1, name: 'Tuition', amount: 5000 } ] },
    2: { version: 1, items: [ { name: 'Tuition', amount: 5000, is_mandatory: true } ], history: [] },
    3: { version: 1, items: [], history: [] },
  },
  'Grade 3': {
    1: { version: 5, items: [ { name: 'Tuition', amount: 5500, is_mandatory: true }, { name: 'Lunch', amount: 900, is_mandatory: false } ],
      history: [
        { version: 1, name: 'Tuition', amount: 6000 }, { version: 2, name: 'Tuition', amount: 5800 },
        { version: 3, name: 'Tuition', amount: 5800 }, { version: 4, name: 'Tuition', amount: 5600 },
      ] },
    2: { version: 1, items: [ { name: 'Tuition', amount: 5800, is_mandatory: true } ], history: [] },
    3: { version: 1, items: [], history: [] },
  },
  'Grade 4': {
    1: { version: 1, items: [], history: [] },
    2: { version: 1, items: [], history: [] },
    3: { version: 1, items: [], history: [] },
  },
};
window.__feeUiState = window.__feeUiState || {};
let feeViewSelectedClass = window.__feeUiState.lastFeeClass || enabledClassesForFeeView[0];
let feeViewSelectedTerm = 1;
let feeAddFormOpen = false;
let feeAddMultiClasses = {};

const banks = [
  { code: 'mpesa', name: 'M-Pesa Paybill', fields: ['shortcode'], connected: true, push: true },
  { code: 'equity', name: 'Equity Bank (Jenga API)', fields: ['ipn_username', 'ipn_password'], connected: true, push: true },
  { code: 'kcb', name: 'KCB Bank (Buni API)', fields: ['consumer_key', 'consumer_secret', 'account_number'], connected: false, push: true },
  { code: 'coop', name: 'Co-operative Bank', fields: ['api_key', 'account_number'], connected: true, push: false },
];
const staffList = [
  { full_name: 'Jane Wambui', email: 'jane@testacademy.ac.ke', status: 'active', has_password: true },
  { full_name: 'Samuel Otieno', email: 'samuel@testacademy.ac.ke', status: 'active', has_password: false },
];
const promotionDecisions = [
  { name: 'Kevin Otieno Mwangi', from: 'Grade 1 - North', to: 'Grade 2', decision: 'promote' },
  { name: 'Faith Otieno Mwangi', from: 'Grade 1 - North', to: 'Grade 2', decision: 'promote' },
  { name: 'Brian Otieno', from: 'Grade 1 - South', to: 'Grade 1 - South', decision: 'repeat' },
  { name: 'James Kariuki', from: 'Grade 2', to: 'Left school', decision: 'leave' },
];
let classesData = [
  { name: 'Playgroup', enabled: false, streams: [] },
  { name: 'PP1', enabled: true, streams: [] },
  { name: 'PP2', enabled: true, streams: [] },
  { name: 'Grade 1', enabled: true, streams: [ { name: 'North', count: 18 }, { name: 'South', count: 16 } ] },
  { name: 'Grade 2', enabled: true, streams: [] },
  { name: 'Grade 3', enabled: true, streams: [] },
  { name: 'Grade 4', enabled: false, streams: [] },
  { name: 'Grade 5', enabled: false, streams: [] },
  { name: 'Grade 6', enabled: false, streams: [] },
];
const academicYears = {
  2026: {
    current: true,
    terms: [
      { number: 1, start: '2026-01-05', end: '2026-04-03', status: 'ended' },
      { number: 2, start: '2026-04-27', end: '2026-07-31', status: 'live' },
      { number: 3, start: '2026-08-24', end: '2026-10-23', status: 'upcoming' },
    ],
  },
  2025: {
    current: false,
    terms: [
      { number: 1, start: '2025-01-06', end: '2025-04-04', status: 'ended' },
      { number: 2, start: '2025-04-28', end: '2025-08-01', status: 'ended' },
      { number: 3, start: '2025-08-25', end: '2025-10-24', status: 'ended' },
    ],
  },
};
let bulkAdmitPreview = [];

/* ---------- NEW: student detail, reports, audit log, optional fees, settings ---------- */
const studentDetailData = {
  full_name: 'Kevin Otieno Mwangi', admission_no: 'CM/M/101/24', class_name: 'Grade 2', stream_name: 'North',
  guardian_name: 'Peter Mwangi', guardian_phone: '254711111111', status: 'active',
  ledgerByTerm: [
    { term: 'Term 1, 2026', opening: 0, charged: 5000, paid: 5000, closing: 0 },
    { term: 'Term 2, 2026', opening: 0, charged: 5000, paid: 2000, closing: 3000 },
  ],
  payments: [
    { date: '2026-05-12', source: 'mpesa', amount: 2000, ref: 'ADM101 fees', status: 'confirmed' },
    { date: '2026-01-20', source: 'equity', amount: 5000, ref: 'CM/M/101/24', status: 'confirmed' },
  ],
  feeEditHistory: [
    { date: '2026-05-15 09:12', by: 'Jane Wambui', from: 5000, to: 4500, reason: 'Sibling discount applied - 2nd child in family' },
  ],
};

const reportsData = {
  termCollection: [
    { term: 'Term 1, 2026', charged: 420000, collected: 398000 },
    { term: 'Term 2, 2026', charged: 435000, collected: 301000 },
    { term: 'Term 3, 2025', charged: 400000, collected: 400000 },
  ],
  arrearsByClass: [
    { class_name: 'PP1', owed: 12000, students_owing: 3 },
    { class_name: 'Grade 1', owed: 34000, students_owing: 7 },
    { class_name: 'Grade 2', owed: 51000, students_owing: 9 },
    { class_name: 'Grade 3', owed: 8000, students_owing: 2 },
  ],
};

const auditLog = [
  { date: '2026-08-04 14:22', staff: 'Jane Wambui', action: 'Confirmed payment', detail: 'TXN #101 - KES 5,000 -> Kevin Otieno Mwangi' },
  { date: '2026-08-04 11:05', staff: 'Samuel Otieno', action: 'Rejected payment', detail: 'TXN #98 - unclear reference, escalated' },
  { date: '2026-05-15 09:12', staff: 'Jane Wambui', action: 'Manually edited fee', detail: 'Kevin Otieno Mwangi - Tuition KES 5,000 -> KES 4,500 (sibling discount)' },
  { date: '2026-04-02 08:40', staff: 'Jane Wambui', action: 'Ran promotion', detail: '2025 -> 2026 - 42 promoted, 3 repeating, 2 left' },
];

const optionalFeesData = [
  { fee_name: 'Transport', amount: 1000, students: [
    { name: 'Kevin Otieno Mwangi', opted_in: true }, { name: 'Faith Otieno Mwangi', opted_in: true },
    { name: 'James Kariuki', opted_in: false }, { name: 'Brian Otieno', opted_in: false },
  ]},
  { fee_name: 'Lunch', amount: 800, students: [
    { name: 'Kevin Otieno Mwangi', opted_in: false }, { name: 'Faith Otieno Mwangi', opted_in: true },
    { name: 'James Kariuki', opted_in: true }, { name: 'Brian Otieno', opted_in: true },
  ]},
];

let schoolSettings = { name: 'Test Academy', phone: '254700123456', email: 'admin@testacademy.ac.ke', address: 'Nairobi, Kenya' };

// School-wide fee edits, across EVERY student - not buried per-student.
// This is what lets someone catch a suspicious edit without already
// knowing which of 1000 kids to go check. Newest first, always.
const allFeeEdits = [
  { date: '2026-08-04 16:40', student: 'Brian Otieno', admission_no: 'B100', by: 'Samuel Otieno', from: 4000, to: 500, reason: 'Waiver - family hardship, approved by head teacher' },
  { date: '2026-06-02 10:15', student: 'James Kariuki', admission_no: 'ADM200', by: 'Jane Wambui', from: 2000, to: 2000, reason: 'Corrected typo in amount, no actual change' },
  { date: '2026-05-15 09:12', student: 'Kevin Otieno Mwangi', admission_no: 'CM/M/101/24', by: 'Jane Wambui', from: 5000, to: 4500, reason: 'Sibling discount applied - 2nd child in family' },
  { date: '2026-03-20 13:50', student: 'Faith Otieno Mwangi', admission_no: 'CM/M/102/24', by: 'Jane Wambui', from: 4500, to: 4500, reason: 'Sibling discount applied - matches Kevin' },
];
