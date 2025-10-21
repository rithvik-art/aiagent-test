exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_PROJECT || process.env.OPENAI_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing OPENAI_API_KEY on server' }) };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const input = String(body.input || '');
    if (!input) return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing input' }) };
    const voice = String(body.voice || 'alloy');
    const model = String(body.model || 'gpt-4o-mini-tts');

    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input, format: 'mp3' })
    });
    if (!res.ok) {
      const t = await res.text().catch(()=>'');
      return { statusCode: res.status, headers: corsHeaders(), body: JSON.stringify({ error: 'tts failed', detail: t }) };
    }
    const arrayBuf = await res.arrayBuffer();
    const b64 = Buffer.from(arrayBuf).toString('base64');
    return { statusCode: 200, headers: { ...corsHeaders(), 'Content-Type': 'audio/mpeg' }, body: b64, isBase64Encoded: true };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'tts failed', detail: String(e && e.message || e) }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

