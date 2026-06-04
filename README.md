# PURC Letter Tracker - Render Version

This is the public-online version of the PURC Letter Tracker. It keeps the same Supabase database and the same app workflow, but runs on Node.js so it can deploy easily on Render.

## Required Render Environment Variables

Set these in Render:

```text
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-public-anon-key
SESSION_SECRET=choose-a-long-random-value
AUTH_USERS=admin:Purc@123
```

`AUTH_USERS` can contain multiple starter users separated by semicolons:

```text
AUTH_USERS=admin:Purc@123;secretary:Office@123
```

The app also supports registration from the login screen.

## Local Test

From this folder:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8080
```

## Render Deployment

1. Push this repository/folder to GitHub.
2. Open Render.
3. Choose **New +** -> **Web Service**.
4. Connect the GitHub repository.
5. Set:

   - Root Directory: `render-app`
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`

6. Add the environment variables listed above.
7. Deploy.

Render will give you a public link such as:

```text
https://purc-letter-tracker.onrender.com
```

## Supabase

Before using the deployed app, run the current `cpp-supabase/supabase_schema.sql` in Supabase SQL Editor.

