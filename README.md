# AI Agent VR Tour

Interactive Babylon.js VR/360 tour with an AI guide. Includes Netlify Functions to proxy OpenAI chat, TTS, and transcription so your API key is server‑side.

## Local Dev

1. Install deps: `npm i`
2. Optional: create `.env.local` and set:
   - `VITE_OPENAI_TTS_VOICE=alloy`
   - For local (non‑proxy) testing: `VITE_OPENAI_API_KEY=sk-proj-...`
3. Run: `npm run dev` (HTTPS is recommended for mic)

## Build

```
npm run build
```
Outputs to `dist/`.

## Netlify Deploy (with Functions)

Netlify builds the site and deploys serverless functions under `/api/*`.

- `netlify.toml` already wires:
  - build command: `npm run build`
  - publish dir: `dist`
  - redirects `/api/*` → `/.netlify/functions/:splat`
  - `VITE_API_PROXY=/api` in production

Environment variables to set in Netlify UI (Site settings → Environment → Variables):

- `OPENAI_API_KEY` = your `sk-proj-...` key (server only)
- Optional: `VITE_OPENAI_TTS_VOICE` = `alloy`

No need to set `VITE_OPENAI_API_KEY` on Netlify when using the proxy.

## GitHub + Netlify

1. Initialize Git (`git init`) and push to a new GitHub repo.
2. In Netlify, “Add new site from Git”, select repo.
3. Set the env vars above and deploy.

## Security Notes

- Never commit `.env` or `.env.local`. They are ignored via `.gitignore`.
- In production, the browser calls `/api/*` functions; your key stays server‑side.

