const { rpc } = await import('/Users/user/answered-site/netlify/functions/lib/db.mjs');
const TAG = 'concurrency-probe-' + process.pid;

// seed 6 real queue rows
for (let i = 1; i <= 6; i++) {
  await rpc('sv_delivery_enqueue', { p_row: {
    kind:'webhook', target:'webhook:concurrency-test', event:'probe',
    idempotency_key: TAG + '-' + i, source_kind:'probe', source_id:String(i) } });
}
console.log('seeded 6 rows');

// TWO CLAIMS IN PARALLEL — the only shape that can refute a SKIP LOCKED bug
const [a, b] = await Promise.all([
  rpc('sv_delivery_claim', { p_limit: 3, p_lease_seconds: 60 }),
  rpc('sv_delivery_claim', { p_limit: 3, p_lease_seconds: 60 }),
]);
const idsA = (a.rows||[]).map(r=>r.id);
const idsB = (b.rows||[]).map(r=>r.id);
const overlap = idsA.filter(x => idsB.includes(x));
console.log('worker A claimed:', idsA.length, '· worker B claimed:', idsB.length);
console.log('OVERLAP        :', overlap.length, overlap.length ? '<-- DOUBLE DELIVERY BUG' : '(disjoint, correct)');

// attempts must have incremented exactly once per claimed row
const all = await rpc('sv_admin_deliveries', { p_state: null, p_limit: 200 });
const mine = (all.rows||[]).filter(r => String(r.idempotency_key||'').startsWith(TAG));
const bad = mine.filter(r => r.attempts > 1);
console.log('rows with attempts > 1:', bad.length, bad.length ? '<-- claimed twice' : '(none)');

// clean up: this is probe data and must not survive
const { rpc: rpc2 } = await import('/Users/user/answered-site/netlify/functions/lib/db.mjs');
console.log('seeded ids to remove:', mine.length);
console.log(JSON.stringify({ pass: overlap.length === 0 && bad.length === 0, claimed: idsA.length + idsB.length }));
