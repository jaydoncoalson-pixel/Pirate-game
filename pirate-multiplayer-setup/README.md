# Pirate Game: The Ocean — public + private multiplayer

This project is ready to run locally and can be deployed as a public Node.js web service.

## Run locally
1. Install Node.js 18 or newer.
2. In this folder run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

## Project structure
- `server.js` — authoritative multiplayer server and synchronized world state
- `public/` — browser game files and client scripts
- `public/js/world-sync.js` — browser-side WebSocket sync client
- `shared/world-state.js` — the shared world data schema used by the game logic
- `render.yaml` — Render deployment config

## Shared world state
The multiplayer server now owns the world state and broadcasts it to every connected client. That includes:
- time of day
- weather conditions
- player positions
- enemy positions and health
- Kraken position, phase, and health

Because the server is authoritative, each connected player sees the same state instead of random local-only values.

## Put the game online (Render)
1. Create a GitHub account (if needed) and a new repository.
2. Extract this project ZIP and upload the contents of the `pirate-multiplayer-setup` folder to that repository. The `server.js`, `package.json`, `render.yaml`, and `public` folder must be at the repo root.
3. Sign in to Render and choose **New → Blueprint**, then connect your GitHub repository. Render will read `render.yaml`; review the service and deploy it. You can also create a **Web Service** manually.
4. When deployment finishes, Render gives you an `onrender.com` URL. Open it to play and share it with friends. The server supports WebSockets, which the multiplayer game needs.

## Search engines
The site includes a descriptive title and description, social-sharing metadata, game structured data, `/robots.txt`, and `/sitemap.xml`. Once the site is online, add its exact URL as a property in Google Search Console.

## Free-hosting note
Render's free web services can spin down after 15 minutes without traffic, and the next visit can take about a minute to wake up. Free hosting is suitable for trying the game, but it may feel slow for repeated testing.

## Multiplayer notes
- Public ocean: everyone choosing the public option joins the shared `public` room.
- Private seas: players with the same invite code join the same isolated room.
- Private invite codes are shared secrets, not account authentication.
- This version uses a single authoritative state server so weather, daily cycle, enemy positions, health, and Kraken state are kept consistent for everyone.
