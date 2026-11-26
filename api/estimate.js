// Sends meal photos/descriptions to Google Gemini
// and returns a nutrition estimate. The prompts live here (not in the page) so
// this endpoint can't be used as a general-purpose proxy for your API key.
//
// Env vars / secrets (Cloudflare → Workers → macro-lens → Settings → Variables):
//   GEMINI_API_KEY  required — free key from https://aistudio.google.com/apikey
//   GEMINI_MODEL    optional — override the model used for meal photos

const API = 'https://generativelanguage.googleapis.com/v1beta';
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const MEAL_INSTRUCTIONS = `You estimate nutrition for a food-tracking app.
Identify each distinct food or drink and estimate its portion, then estimate calories and macronutrients for that portion. Judge size from cues such as plate size (a dinner plate is about 27 cm across), bowls, cutlery, hands and packaging. Include likely hidden calories: cooking oil, butter, dressing, sauces, sugar in drinks. Use typical values from standard nutrition databases. Round kcal to the nearest 5 and grams to whole numbers.
Reply with only JSON in this shape:
{"meal_name":"short name, 2-5 words","items":[{"name":"grilled chicken breast","portion":"1 fillet (150 g)","kcal":250,"protein_g":46,"carbs_g":0,"fat_g":6}],"confidence":"low|medium|high","notes":"one short sentence on the biggest assumption you made"}
If there is no food or drink, reply {"error":"no food found"}.`;

const COACH_INSTRUCTIONS = `You are a friendly, practical nutrition coach. Here is a person's goal, daily targets and the last 7 days of food they logged:

{SUMMARY}

Give exactly 3 short, specific tips for the rest of today and this week, based on the numbers above (for example which macro is short and which foods would close the gap). One sentence each, plain text, each line starting with "• ". No intro or sign-off. Don't give medical advice.`;

// Photo estimates prefer the stronger Flash model; when its small free quota
// runs out we fall back to Flash-Lite. Coach tips go to Flash-Lite first.
const modelsFor = (kind, override) => kind === 'meal'
  ? [override, 'gemini-flash-latest', 'gemini-flash-lite-latest'].filter(Boolean)
  : ['gemini-flash-lite-latest', 'gemini-flash-latest'];

let discovered = null; // cached result of listing models, used if the aliases above ever go away
async function discoverModels(key) {
  if (discovered) return discovered;
  try {
    const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    const j = await r.json();
    const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const names = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(n))
      .sort((a, b) => ver(b) - ver(a) || (a.includes('lite') ? 1 : -1));
    discovered = names.slice(0, 3);
  } catch { discovered = []; }
  return discovered;
}

async function generate(model, parts, key, json) {
  const r = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.2 } : { temperature: 0.6 },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || `Gemini returned ${r.status}`);
    e.status = r.status;
    throw e;
  }
  if (j.promptFeedback?.blockReason) { const e = new Error('blocked'); e.status = 451; throw e; }
  const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) { const e = new Error('empty'); e.status = 502; throw e; }
  return text;
}

async function run(kind, parts, key, json, override) {
  const tried = new Set();
  let last;
  const attempt = async list => {
    for (const m of list) {
      if (tried.has(m)) continue;
      tried.add(m);
      try { return await generate(m, parts, key, json); }
      catch (e) {
        last = e;
        // try the next model on: unknown model, quota exhausted, overloaded
        if (![404, 429, 500, 503].includes(e.status)) throw e;
      }
    }
    return null;
  };
  const out = (await attempt(modelsFor(kind, override))) ??(await attempt(await discoverModels(key)));
  if (out != null) return out;
  throw last || new Error('no model available');
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

// Platform-neutral core: takes the parsed request body and an env object
// ({GEMINI_API_KEY, GEMINI_MODEL}) and returns {status, data}.
export async function estimate(body, env = {}) {
  const key = env.GEMINI_API_KEY;
  if (!key) return { status: 503, data: { error: 'not_configured' } };
  body = body && typeof body === 'object' ? body : {};
  try {
    if (body.kind === 'meal') {
      const note = String(body.note || '').slice(0, 800);
      const parts = [];
      if (body.source === 'photo') {
        const mime = String(body.mime || 'image/jpeg').toLowerCase();
        const data = String(body.image || '');
        if (!MIME.has(mime) || !data) return { status: 400, data: { error: 'image_rejected' } };
        if (data.length > 4.4e6) return { status: 413, data: { error: 'too_large' } };
        parts.push({ inline_data: { mime_type: mime, data } });
        parts.push({ text: `${MEAL_INSTRUCTIONS}\n\nThe attached photo shows food or drink someone is about to eat.${note ? ` They add: "${note}". Trust their note over the photo where they disagree.` : ''}` });
      } else {
        if (!note.trim()) return { status: 400, data: { error: 'no_food' } };
        parts.push({ text: `${MEAL_INSTRUCTIONS}\n\nSomeone describes what they ate: "${note}".` });
      }
      const text = await run('meal', parts, key, true, env.GEMINI_MODEL);
      const r = parseJson(text);
      if (!r) return { status: 502, data: { error: 'invalid_json' } };
      if (r.error || !Array.isArray(r.items) || !r.items.length) return { status: 422, data: { error: 'no_food' } };
      return { status: 200, data: r };
    }
    if (body.kind === 'coach') {
      const summary = String(body.summary || '').slice(0, 4000);
      if (!summary.trim()) return { status: 400, data: { error: 'bad_request' } };
      const text = await run('coach', [{ text: COACH_INSTRUCTIONS.replace('{SUMMARY}', summary) }], key, false);
      return { status: 200, data: { text } };
    }
    return { status: 400, data: { error: 'bad_request' } };
  } catch (e) {
    console.error('estimate failed:', e.status, e.message);
    const code = e.status === 429 ? 'rate_limited'
      : e.status === 451 ? 'refused'
      : e.status === 400 && /image|mime|inline/i.test(e.message) ? 'image_rejected'
      : (e.status === 400 || e.status === 403) && /api key|API_KEY|permission/i.test(e.message) ? 'not_configured'
      : 'upstream_error';
    return { status: e.status === 429 ? 429 : 502, data: { error: code } };
  }
}

// Node-style handler (used by server.js for local runs).
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : req.body;
  const { status, data } = await estimate(body, process.env);
  return res.status(status).json(data);
}
