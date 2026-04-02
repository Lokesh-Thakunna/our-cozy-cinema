# Our Cozy Cinema

Our Cozy Cinema is a private two-person app for long-distance chat and synchronized YouTube watching. It now supports a private couple PIN so you can safely put it on a public internet server and open the same HTTPS link on both phones.

## Features

- Fixed paired users: `Me` and `My Love`
- Real-time chat with Socket.io
- Shared YouTube playback with play, pause, and seek sync
- Saved chat history and saved video progress
- Private PIN gate for public deployment
- Romantic mobile-friendly UI
- Installable PWA support

## Tech Stack

- Node.js + Express
- Socket.io
- Vanilla HTML, CSS, and JavaScript
- Local JSON persistence on the server

## Files

- `server.js` - Express server, Socket.io events, persistence, PIN protection, error handling
- `public/index.html` - main app layout
- `public/style.css` - responsive styling
- `public/script.js` - PIN gate, chat, playback sync, PWA logic
- `public/manifest.webmanifest` - PWA manifest
- `public/sw.js` - service worker
- `.env.example` - deployment environment example

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Set a private PIN for public-style testing:

```bash
set COUPLE_PIN=our-secret-pin
```

3. Start the app:

```bash
npm start
```

4. Open it in your browser:

```text
http://localhost:3000
```

## Development Mode

Run with auto-restart:

```bash
npm run dev
```

## How Access Works

- If `COUPLE_PIN` is set, both phones must enter the same private PIN.
- After a phone enters the correct PIN once, the browser remembers it on that device.
- The first paired browser/device is assigned `Me`.
- The second paired browser/device is assigned `My Love`.
- That pairing is remembered using a browser ID and saved server state.
- If a third browser opens the app, it becomes read-only spectator mode.

## Long-Distance Deployment

1. Deploy this Node.js app to a public server or platform such as Render, Railway, Fly.io, a VPS, or Docker behind Nginx.
2. Set the environment variable `COUPLE_PIN` to a secret that only you two know.
3. Keep `PORT` managed by the platform, or set it yourself if needed.
4. Put the app behind HTTPS so the PWA install prompt works on phones.
5. Share the single HTTPS URL with her.
6. Open that same URL on both phones, enter the PIN, and use the app.

## Render Deployment

This repo now includes `render.yaml`, so you can create the service from the repo without typing all settings manually.

1. Put this project in a GitHub repo.
2. In Render, choose **New +** -> **Blueprint**.
3. Select your GitHub repo.
4. When Render reads `render.yaml`, create the service.
5. Enter a value for `COUPLE_PIN` when prompted.
6. After deploy finishes, open the Render HTTPS URL on both phones.

Notes:

- The app saves chat and playback state in `storage/state.json`.
- The included `render.yaml` is configured for the free Render setup and does not use a persistent disk.
- Because free Render does not keep a persistent disk attached, saved chat/video state can reset on redeploy, restart, or when the service is rebuilt.

## Environment Variables

- `PORT` - server port, default `3000`
- `COUPLE_PIN` - required for safe public deployment
- `TRUST_PROXY` - set to `true` when running behind a reverse proxy or managed platform

## Persistence

Saved data is stored in:

```text
storage/state.json
```

This includes:

- Chat history
- Last loaded YouTube video
- Last saved playback time
- Remembered device-to-role mapping

## Health Check

The server exposes:

```text
/healthz
```

## Important Note

Do not deploy this publicly without `COUPLE_PIN`. The app is meant for two people, and the PIN is what keeps the public link private enough for your use case.
