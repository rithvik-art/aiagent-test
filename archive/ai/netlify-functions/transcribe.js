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
    const ct = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!ct.includes('multipart/form-data')) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Expected multipart/form-data' }) };
    }
    const buf = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': ct },
      body: buf
    });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'transcribe failed', detail: String(e && e.message || e) }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

