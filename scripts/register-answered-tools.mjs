#!/usr/bin/env node
// register-answered-tools.mjs — give the demo line hands.
//
// Registers the `book_job` webhook server-tool with ElevenLabs and attaches it to the Answered demo
// agent, so that when the custom LLM (/api/answered-brain) emits a tool call, ElevenLabs actually
// runs it against /api/answered-tool and hands the answer back into the conversation.
//
//   node scripts/register-answered-tools.mjs            # dry run: prints the plan, writes nothing
//   node scripts/register-answered-tools.mjs --apply    # create or update the tool, attach it
//   node scripts/register-answered-tools.mjs --verify   # read the agent back and report what is live
//   node scripts/register-answered-tools.mjs --detach   # take the tool back off the agent
//
// IDEMPOTENT BY NAME. A second run updates the existing tool in place rather than creating a twin,
// and attaching merges with whatever tool_ids the agent already carries. Nothing is ever removed
// from the agent except by --detach.
//
// Env, by NAME only. Nothing is read from a file and nothing is printed:
//   ELEVENLABS_API_KEY      the workspace key
//   ANSWERED_EL_AGENT_ID    the demo line's agent
//   ANSWERED_BRAIN_SECRET   the credential the tool call carries back to us. It is the same secret
//                           ElevenLabs already holds for the custom LLM, and lib/bearer.mjs explains
//                           at length why booking is the one action that secret is legitimately for.
//   ANSWERED_TOOL_SECRET_ID optional. The id of an ElevenLabs STORED secret holding the value above.
//                           When set, the header is stored by reference and the raw value never
//                           leaves this machine. The script discovers it automatically by name.
//   ANSWERED_SITE_URL       optional origin override; defaults to the live site.
//
// ★ WHY THE TOOL HAS TO EXIST ON THE VENDOR SIDE AT ALL, when our own bridge is the LLM.
// The bridge deliberately refuses to emit a call to a tool the vendor did not declare on the
// request. A tool call nobody runs looks, to the person on the phone, exactly like a booking, and
// is nothing at all. So this registration is not decoration: it is the half of the contract that
// makes the other half safe to switch on.

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const DETACH = process.argv.includes('--detach');

const KEY = String(process.env.ELEVENLABS_API_KEY || '').trim();
const AGENT = String(process.env.ANSWERED_EL_AGENT_ID || '').trim();
const SECRET = String(process.env.ANSWERED_BRAIN_SECRET || '').trim();
const ORIGIN = String(process.env.ANSWERED_SITE_URL || 'https://answered.reddenda.com').trim().replace(/\/+$/, '');
const SECRET_NAME = 'answered-brain-secret';

const missing = [
  !KEY && 'ELEVENLABS_API_KEY',
  !AGENT && 'ANSWERED_EL_AGENT_ID',
  !SECRET && !DETACH && !VERIFY && 'ANSWERED_BRAIN_SECRET',
].filter(Boolean);
if (missing.length) {
  console.error(`refusing to run: ${missing.join(', ')} not set in this shell`);
  process.exit(2);
}

const api = (p, opts = {}) => fetch('https://api.elevenlabs.io/v1' + p, {
  ...opts,
  headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const readJson = async (r) => { try { return await r.json(); } catch (e) { return {}; } };

const { elToolConfig, BOOK_TOOL, WINDOW_KEYS } = await import('../netlify/functions/lib/tools.mjs');

const TOOL_URL = `${ORIGIN}/api/answered-tool?tool=${BOOK_TOOL}`;

/** Prefer a stored secret so the raw value is never re-pasted into a vendor record. */
async function headerValue() {
  const given = String(process.env.ANSWERED_TOOL_SECRET_ID || '').trim();
  if (given) return { secret_id: given };
  const r = await api('/convai/secrets');
  if (!r.ok) return SECRET;
  const j = await readJson(r);
  const hit = (j.secrets || []).find((s) => s.name === SECRET_NAME);
  return hit && hit.secret_id ? { secret_id: hit.secret_id } : SECRET;
}

async function agentToolIds() {
  const r = await api(`/convai/agents/${AGENT}`);
  if (!r.ok) throw new Error(`read agent ${r.status}`);
  const j = await readJson(r);
  const prompt = (((j.conversation_config || {}).agent || {}).prompt) || {};
  return { ids: prompt.tool_ids || [], name: j.name, llm: prompt.llm, url: (prompt.custom_llm || {}).url };
}

async function main() {
  const live = await agentToolIds();
  console.log(`agent   ${AGENT}  ${JSON.stringify(live.name)}`);
  console.log(`llm     ${live.llm} -> ${live.url}`);
  console.log(`tool    ${BOOK_TOOL} -> POST ${TOOL_URL}`);
  console.log(`windows ${WINDOW_KEYS.join(', ')}`);
  console.log(`attached now: ${live.ids.length ? live.ids.join(', ') : '(none)'}`);

  if (VERIFY) {
    for (const id of live.ids) {
      const t = await readJson(await api(`/convai/tools/${id}`));
      const c = t.tool_config || {};
      console.log(`  live tool ${id}: ${c.name} -> ${(c.api_schema || {}).url} (timeout ${c.response_timeout_secs}s)`);
      const props = (((c.api_schema || {}).request_body_schema) || {}).properties || {};
      console.log(`    required: ${JSON.stringify((((c.api_schema || {}).request_body_schema) || {}).required)}`);
      console.log(`    window enum: ${JSON.stringify((props.window || {}).enum)}`);
      const h = (c.api_schema || {}).request_headers || {};
      console.log(`    auth header present: ${Boolean(h.Authorization || h.authorization)} (value never printed)`);
    }
    return;
  }

  const existing = await readJson(await api('/convai/tools'));
  const byName = {};
  for (const t of (existing.tools || [])) byName[((t.tool_config || t).name)] = t.id || t.tool_id;
  const priorId = byName[BOOK_TOOL];

  if (DETACH) {
    if (!priorId || !live.ids.includes(priorId)) { console.log('nothing to detach'); return; }
    if (!APPLY) { console.log(`would detach ${priorId} (dry run)`); return; }
    const keep = live.ids.filter((x) => x !== priorId);
    const up = await api(`/convai/agents/${AGENT}`, {
      method: 'PATCH',
      body: JSON.stringify({ conversation_config: { agent: { prompt: { tool_ids: keep } } } }),
    });
    console.log(`detach: ${up.ok ? 'ok' : 'FAILED ' + up.status}`);
    return;
  }

  const cfg = elToolConfig({
    url: TOOL_URL,
    headers: { Authorization: null, 'Content-Type': 'application/json' },
  });
  const auth = await headerValue();
  // Written after the config is built so the value is never part of a logged object.
  cfg.api_schema.request_headers.Authorization =
    typeof auth === 'string' ? `Bearer ${auth}` : auth;
  console.log(`credential: ${typeof auth === 'string' ? 'literal header (consider a stored secret)' : 'stored secret ' + auth.secret_id}`);

  if (!APPLY) {
    const shown = JSON.parse(JSON.stringify(cfg));
    shown.api_schema.request_headers.Authorization = '<redacted>';
    console.log(`\nwould ${priorId ? 'UPDATE ' + priorId : 'CREATE'}:\n` + JSON.stringify(shown, null, 2));
    console.log('\ndry run. re-run with --apply.');
    return;
  }

  let res;
  if (priorId) res = await api(`/convai/tools/${priorId}`, { method: 'PATCH', body: JSON.stringify({ tool_config: cfg }) });
  else res = await api('/convai/tools', { method: 'POST', body: JSON.stringify({ tool_config: cfg }) });
  const body = await readJson(res);
  if (!res.ok) {
    console.error(`tool ${priorId ? 'update' : 'create'} FAILED ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    process.exit(1);
  }
  const toolId = body.id || body.tool_id || priorId;
  console.log(`tool ${priorId ? 'updated' : 'created'}: ${toolId}`);

  const merged = Array.from(new Set([...live.ids, toolId]));
  const up = await api(`/convai/agents/${AGENT}`, {
    method: 'PATCH',
    body: JSON.stringify({ conversation_config: { agent: { prompt: { tool_ids: merged } } } }),
  });
  if (!up.ok) {
    console.error(`attach FAILED ${up.status}: ${(await up.text()).slice(0, 300)}`);
    process.exit(1);
  }

  // Read it BACK. A 200 on a PATCH is not evidence that the agent carries the tool.
  const after = await agentToolIds();
  const ok = after.ids.includes(toolId);
  console.log(`attach: ${ok ? 'VERIFIED' : 'PATCH returned 200 and the agent does NOT carry the tool'} (${after.ids.length} tool ids)`);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
