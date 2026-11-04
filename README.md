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
- `APP_URL`, the public address used for links in emails, such as `https://jigsaw.example.com`. Without it, links use the address the inviting browser was on.

Without SMTP settings, emails are printed to the server log instead of being sent.
