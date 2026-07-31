/**
 * One-time Gmail OAuth flow. Prints the refresh token to put in .env.
 * Prerequisite: a Google Cloud project with the Gmail API enabled and OAuth
 * "Desktop app" credentials; GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.
 */
import http from 'node:http';
import { google } from 'googleapis';
import { requireEnv } from '../src/lake.js';

const PORT = 8724;
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = requireEnv(
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  'Create OAuth Desktop credentials at https://console.cloud.google.com/apis/credentials first.',
);

const oauth2 = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `http://localhost:${PORT}/callback`,
);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') return res.end();
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No code in callback. Check the terminal.');
    return;
  }
  const { tokens } = await oauth2.getToken(code);
  res.end('Done! You can close this tab and return to the terminal.');
  server.close();
  if (tokens.refresh_token) {
    console.log('\nAdd this to your .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } else {
    console.error('No refresh token returned. Remove prior grants at https://myaccount.google.com/permissions and retry.');
  }
});

server.listen(PORT, () => {
  console.log('Open this URL in your browser and authorize the app:\n');
  console.log(authUrl + '\n');
});
