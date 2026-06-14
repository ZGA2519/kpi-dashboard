# KPI Dashboard

## Static + Sheets Edition

This branch contains a rewrite that replaces the Next.js/Prisma stack with a
fully static frontend (HTML + vanilla JS + Tailwind CDN) backed by a Google
Apps Script Web App that uses a Google Sheet as its database.

No Node.js, no server, no build step required.

### Architecture

```
Browser (index.html / login.html)
  assets/js/api.js    — fetch() transport, points at WEB_APP_URL
  assets/js/auth.js   — localStorage token management, login/logout
  assets/js/app.js    — dashboard rendering, CRUD operations
        |
        | HTTPS (POST / GET)
        v
Google Apps Script Web App  (single /exec URL)
  Code-Main.gs     — doGet / doPost / route_ / shared helpers
  Code-Projects.gs — getDashboard / createProject / updateProject / deleteProject
  Code-Tasks.gs    — createTask / updateTask / deleteTask
  Code-Auth.gs     — login / logout / session management (SHA-256 + salt)
  Code-Setup.gs    — one-time sheet initialisation + admin user bootstrap
        |
        v
Google Sheet  (Projects / Tasks / Users / Sessions tabs)
```

### Quick Start

See [DEPLOY.md](DEPLOY.md) for complete copy-paste deployment instructions:

1. Create a Google Sheet and open Apps Script (Extensions > Apps Script)
2. Paste each `Code-*.gs` file as a separate script file
3. Set the `SS_ID` script property or use a bound script
4. Run `setup("admin", "<your-password>")` once from the editor
5. Deploy as Web App (Execute as: Me, Access: Anyone)
6. Copy the deployment URL into `assets/js/api.js` `CONFIG.WEB_APP_URL`
7. Host the static files on GitHub Pages, Netlify, or open `index.html` locally
