# Pirate Game server

The server now hosts the shared world. It runs the bandits and the Blackwater raider ships for everyone. Browsers send what their own player did and draw what the server sends back.

## Run it
    npm install
    npm start            # or: PORT=3000 node server.js

Open http://localhost:8080 (or your server's address) in each browser. The join box fills in the server address itself.

## Files
- `server.js` — serves `public/`, accepts WebSocket players, runs the world at 20 ticks/s, sends snapshots at 10/s
- `sim.js` — bandit AI and raider AI (moved here from the browser)
- `monsters.js` — the shared Kraken and sea serpents
- `env.js` — shared clock and weather
- `world.js` — terrain, docks, camps and ship sizes, ported from the game so the server knows where land is
- `public/index.html` — the game, updated to follow the server

## Who decides what
| Thing | Decided by |
|---|---|
| Bandit movement, attacks, HP, death and respawn | server |
| Raider sailing, targeting, firing, HP, sinking, respawn, kill credit | server |
| The Kraken: where it is, whom it hunts, its health, Sword of the Sea summons | server |
| Sea serpents: hunting, circling, strikes, health, death | server |
| Day/night clock and weather | server |
| Your own player, ship hull HP, gold, quests | your browser |
| Cannonballs hitting your own ship | your browser |
| PvP sword hits and broadsides | relayed player to player |

If you edit the islands in `index.html`, make the same change in `world.js`.

## Accounts (saved on the server)

Players log in with a captain name and password; their progress is saved on the server, so they can play from any device.
Names are unique (case-insensitive). Where accounts are stored:

- **Upstash Redis (recommended, free):** create a free database at upstash.com, then set `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` in Render's Environment tab.
- **Otherwise a file** in `DATA_DIR` (default `./data`). On Render this is wiped on every deploy, restart and free-plan
  sleep unless `DATA_DIR` points at a persistent disk.

`OWNER_PASSWORD`: only someone who knows it can create the `bob3` account (the admin / Serpent Horn owner).
If it isn't set, whoever creates `bob3` first owns it.
