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
    const input = JSON.parse(event.body || '{}');
    const messages = Array.isArray(input.messages) ? input.messages : [
      { role: 'system', content: String(input.system || 'You are a helpful assistant.') },
      { role: 'user', content: String(input.user || '') }
    ];
    const model = String(input.model || 'gpt-4o');
    const temperature = typeof input.temperature === 'number' ? input.temperature : 0.3;
    const max_tokens = typeof input.max_tokens === 'number' ? input.max_tokens : 220;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });

    const text = await res.text();
    return { statusCode: res.status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'chat failed', detail: String(e && e.message || e) }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

