// Minimal placeholder; restore full chat proxy later if needed.
exports.handler = async () => {
  return { statusCode: 501, body: JSON.stringify({ error: 'chat function not implemented' }) };
};

