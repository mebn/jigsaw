# Jigsaw

A multiplayer jigsaw puzzle app, written in TypeScript. The frontend is React, built with Vite. The backend is a small JSON and WebSocket API backed by SQLite, which runs as a Vite plugin (`server/api.ts`), so there is no separate backend process to start.

https://github.com/user-attachments/assets/e7aee30f-cdcd-469a-b9dd-854b7db83120


## Requirements

- Node.js 22.13 or newer (the server uses the built-in `node:sqlite` module)
- npm

## Running the server

Install dependencies first:

```sh
npm install
```

### Development

```sh
npm run dev
```

Starts the Vite dev server with hot reload at http://localhost:5173. The `--host` flag is set, so it is also reachable from other devices on your network.

### Production

```sh
npm run start
```

Builds the app into `dist/` and serves it with `vite preview` at http://localhost:4173, also listening on all network interfaces.

To use a different port, pass it after `--`, for example `npm run dev -- --port 3000`.

### Type checking

```sh
npm run typecheck
```

Vite only strips the types when it builds or serves the app, so type errors don't stop it. Run this to check them.

## Data

- The SQLite database lives at `data/puzzle.db` and is created automatically on first start. The `data/` directory is git ignored.
- The API is served under `/api`, with the WebSocket endpoint at `/api/ws`.
- Schema migrations in `server/migrations/` run automatically, in order, each time the server starts. See `AGENTS.md` for the rules on adding migrations.

## Email

Players can switch their login to an email and password, and invite players who have an email to private jigsaws. Invites are sent over SMTP, set up with environment variables:

- `SMTP_URL`, such as `smtps://user:pass@smtp.example.com`, or `SMTP_HOST`, `SMTP_PORT` (default 587, 465 uses TLS), `SMTP_USER` and `SMTP_PASS`
- `MAIL_FROM`, the sender, such as `Jigsaw <jigsaw@example.com>`
- `APP_URL`, the public address used for links in emails, such as `https://jigsaw.example.com`. Without it, emails that are really sent carry no link (the address a browser says it is on can't be trusted); mail printed to the log uses the address the inviting browser was on.

Without SMTP settings, emails are printed to the server log instead of being sent.

## Behind a proxy

The server limits wrong passphrases, new players and new jigsaws per address. Behind a reverse proxy or CDN every request comes from the proxy's address, so set `CLIENT_IP_HEADER` to the header the proxy puts the player's own address in, such as `CF-Connecting-IP` behind Cloudflare. Only set it when the server can't be reached around the proxy, since anyone who can reach it directly could write the header themselves.

## Playing in a terminal

`cli/` is a terminal client: it joins a jigsaw's room like any page does, so people in the terminal and in the browser play the same jigsaw together. Pieces are drawn with half-block characters in 24-bit colour; drag them with the mouse, or use the arrow keys, Enter to pick up and put down, and Space to turn. Press H for all the keys.

```sh
npm run cli                                   # builds cli/dist/jigsaw.js, one file with no dependencies
node cli/dist/jigsaw.js                       # the jigsaws on jigsaw.marnil.dev, as picture cards
node cli/dist/jigsaw.js https://host/r/<id>   # or open a jigsaw by its link, or another site by its address
```

Press L to log in as on the website: pick a name as a new player, or log in with a passphrase or an email and password. A guest who tries to move a piece is asked the same. The login is kept per site in `~/.config/jigsaw/logins.json`. `--login <passphrase>` logs in from the command line, `--256` is for terminals without 24-bit colour, and `JIGSAW_URL` sets the site used when no link is given. It needs Node.js 22.4 or newer.

To publish it so anyone can run `npx @mebn/jigsaw`, run `npm publish --access public` in `cli/` (its `prepack` builds it first).
