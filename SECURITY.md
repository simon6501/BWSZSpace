# Security Notes

This repo is public. Treat everything committed here as public information.

## What is intentionally public

- `public/firebase-config.js` contains Firebase Web client configuration. This is not a server secret.
- The real security boundary is Firebase Authentication plus Firestore Security Rules.

## Required Firebase configuration

Use strong passwords for the two Firebase Auth users. Do not keep demo passwords for public access.

Recommended Firestore rules:

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /spaces/bwsz-state {
      allow read, write: if request.auth != null
        && request.auth.token.email in [
          "bw@bwsz.space",
          "sz@bwsz.space"
        ];
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Also add an HTTP referrer restriction to the Firebase Web API key in Google Cloud Console. Allow only the deployed GitHub Pages origin and any local development origins you actually use.

## Never commit

- `.env`
- `data/*.json`
- `data/*.sqlite*`
- `data/backups/`
- `logs/`
- downloaded tunnel binaries such as `cloudflared-linux-amd64`

## Local server exposure

If the Node/SQLite server is exposed through a tunnel or reverse proxy:

- Set `LOGIN_DISABLED=false`.
- Set strong `BW_PASSWORD` and `SZ_PASSWORD` before first startup, or rotate them with `scripts/set_password.js`.
- Set a random `SESSION_SECRET` of at least 32 bytes.
- Keep `HOST=127.0.0.1` behind the tunnel/proxy unless LAN access is explicitly required.
