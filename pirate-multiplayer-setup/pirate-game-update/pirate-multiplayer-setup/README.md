# Pirate Game server

The server now hosts the shared world. It runs the bandits and the Blackwater raider ships for everyone. Browsers send what their own player did and draw what the server sends back.

## Run it
    npm install
    npm start            # or: PORT=3000 node server.js

Open http://localhost:8080 (or your server's address) in each browser. The join box fills in the server address itself.

## Files
- `server.js` — serves `public/`, accepts WebSocket players, runs the world at 20 ticks/s, sends snapshots at 10/s
- `sim.js` — bandit AI and raider AI (moved here from the browser)
- `world.js` — terrain, docks, camps and ship sizes, ported from the game so the server knows where land is
- `public/index.html` — the game, updated to follow the server

## Who decides what
| Thing | Decided by |
|---|---|
| Bandit movement, attacks, HP, death and respawn | server |
| Raider sailing, targeting, firing, HP, sinking, respawn, kill credit | server |
| Your own player, ship hull HP, gold, quests | your browser |
| Cannonballs hitting your own ship | your browser |
| PvP sword hits, kraken strikes on rival ships | relayed player to player, as before |

If you edit the islands in `index.html`, make the same change in `world.js`.
