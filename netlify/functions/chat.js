const SYSTEM_PROMPT = `
You are an ultra-concise AI real-estate guide inside a Babylon.js panorama for Skyview Towers, Bangalore.
Always reply with a single JSON object ONLY (no extra text), using keys:
- action: one of move_to_zone | rotate_view | speak_only
- zone: one of living_room | balcony | lobby | kitchen | bedroom | rooftop (when action=move_to_zone)
- angle: integer degrees (when action=rotate_view)
- message: <= 20 words, clear and natural; do not mention JSON or technical details.
When the user asks a yes/no question, set action to speak_only and message to "Yes." or "No." followed by a short reason (<= 10 words).
If unclear, ask a brief clarification via speak_only.
`;

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
    const messages = Array.isArray(input.messages) && input.messages.length
      ? input.messages
      : [
          { role: 'system', content: SYSTEM_PROMPT },
          ...(input.system ? [{ role: 'system', content: String(input.system) }] : []),
          { role: 'user', content: String(input.user || input.userMessage || '') }
        ];
    const model = String(input.model || 'gpt-3.5-turbo');
    const temperature = typeof input.temperature === 'number' ? input.temperature : 0.3;
    const max_tokens = typeof input.max_tokens === 'number' ? input.max_tokens : 160;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens,
        response_format: { type: 'json_object' }
      })
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
