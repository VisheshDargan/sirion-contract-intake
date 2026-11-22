// Sirion AI for the contract intake prototype.
// Vercel serverless function. Needs ANTHROPIC_API_KEY in the project's environment variables.
// Optional: ANTHROPIC_MODEL (defaults to claude-haiku-5-5).

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const hits = new Map(); // best-effort rate limit per IP, per warm instance

const PLAYBOOK = `IBM Legal's intake playbook for new contract requests. A complete request has 8 items:
1 requester (name and team), 2 supplier, 3 agreement (whose paper: IBM template, supplier's terms, order form, SOW, NDA...),
4 value (annual cost), 5 signatory for the supplier, 6 start date and term, 7 budget (budget code or owner), 8 personal data (does the supplier receive or store personal data).
Also note system access: does the supplier need access to IBM systems, accounts or sites.
Routing rules: the budget owner always approves; Finance approves above $100,000 a year; Privacy reviews when personal data is shared; Security reviews when the supplier gets access to IBM systems or accounts.`;

const EXTRACT = `You are Sirion AI, reading an email sent to IBM Legal. ${PLAYBOOK}

Return ONLY a JSON object, no prose, no code fences, in this shape:
{"is_request": true|false, "reason": "only if not a request: one short sentence",
 "fields": {"title": "short request title, max 60 characters", "summary": "one or two plain sentences",
  "requester": string|null, "team": string|null, "email": string|null, "supplier": string|null, "agreement": string|null,
  "value_text": string|null, "value_usd": number|null (annual, in US dollars, if stated), "signatory": string|null, "start_term": string|null,
  "budget": string|null, "personal": true|false, "personal_text": string|null, "access": true|false, "access_text": string|null,
  "flags": [up to 3 short risks or conflicts a lawyer should see], "questions": [up to 2 short questions to ask the requester for missing items],
  "quotes": {"supplier"|"agreement"|"value_text"|"signatory"|"start_term"|"budget"|"personal_text"|"access_text": "exact short quote from the email that supports the field"}}}
Rules: use null when the email does not say. Never invent values. Quotes must be copied exactly from the email and be under 20 words. Write in plain English.`;

const ASK = `You are Sirion AI, helping IBM Legal with an email. ${PLAYBOOK}
Answer the question in at most 80 words, in plain English. Base the answer only on the email and the playbook. If the email doesn't say, say so. Quote the short part of the email you relied on.`;

function send(res, code, obj) { res.status(code).setHeader('Cache-Control', 'no-store'); res.json(obj); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, {error:'method'});
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, {error:'no_key'});
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || 'x', t = Date.now();
  const recent = (hits.get(ip) || []).filter(x => t - x < 60000); recent.push(t); hits.set(ip, recent);
  if (recent.length > 15) return send(res, 429, {error:'rate'});
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const task = body && body.task, email = String((body && body.email) || '').slice(0, 9000);
  if (!['extract', 'ask'].includes(task) || email.trim().length < 20) return send(res, 400, {error:'bad_request'});
  if (email.length > 8000) return send(res, 413, {error:'too_long'});
  const question = String(body.question || '').slice(0, 500);
  if (task === 'ask' && question.trim().length < 3) return send(res, 400, {error:'bad_request'});
  const messages = [{role:'user', content: task === 'extract' ? `Email:\n"""\n${email}\n"""` : `Email:\n"""\n${email}\n"""\n\nQuestion: ${question}`}];
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 28000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {method:'POST', signal:ctl.signal,
      headers:{'content-type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:MODEL, max_tokens:task === 'extract' ? 1400 : 400, system:task === 'extract' ? EXTRACT : ASK, messages})});
    clearTimeout(to);
    if (!r.ok) { const detail = await r.text(); return send(res, 502, {error:'upstream', detail:detail.slice(0, 300)}); }
    const j = await r.json(), text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (task === 'ask') return send(res, 200, {answer:text});
    const m = text.match(/\{[\s\S]*\}/);
    let out; try { out = JSON.parse(m ? m[0] : text); } catch (e) { return send(res, 502, {error:'bad_json'}); }
    return send(res, 200, out);
  } catch (e) {
    return send(res, 504, {error:e.name === 'AbortError' ? 'timeout' : 'upstream'});
  }
};
