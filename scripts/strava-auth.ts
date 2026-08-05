/**
 * One-time Strava OAuth flow. Prints the refresh token to put in .env.
 * Prerequisite: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env, and your
 * Strava API app's "Authorization Callback Domain" set to "localhost".
 */
import http from 'node:http';
import { requireEnv } from '../src/env.js';

const PORT = 8723;
const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET } = requireEnv(
  ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET'],
  'Create an app at https://www.strava.com/settings/api first.',
);

const authUrl =
  `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}` +
  `&redirect_uri=http://localhost:${PORT}/callback&response_type=code` +
  `&scope=activity:read_all,profile:read_all`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') return res.end();
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No code in callback. Check the terminal.');
    return;
  }
  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });
  const data = (await tokenRes.json()) as { refresh_token?: string };
  res.end('Done! You can close this tab and return to the terminal.');
  server.close();
  if (data.refresh_token) {
    console.log('\nAdd this to your .env:\n');
    console.log(`STRAVA_REFRESH_TOKEN=${data.refresh_token}\n`);
  } else {
    console.error('Token exchange failed:', data);
  }
});

server.listen(PORT, () => {
  console.log('Open this URL in your browser and authorize the app:\n');
  console.log(authUrl + '\n');
});
