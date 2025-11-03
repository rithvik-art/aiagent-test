Babylon AI Walkthrough (Client)

Quick start
- Ensure the server is running on http://localhost:3000 (see ../server).
- Install a simple static server, e.g. `npx live-server`.
- From repo root: `npx live-server client` (or `cd client && npx live-server`).
- Open the served URL and click "Enable Voice".

Assets
- Put 360 images into `client/assets/` named:
  living_room.jpg, balcony.jpg, lobby.jpg, kitchen.jpg, bedroom.jpg, rooftop.jpg.

Notes
- Uses browser SpeechRecognition and SpeechSynthesis (no paid speech APIs).
- Local intent routing reduces OpenAI calls for moves/rotations and common Q&A.

