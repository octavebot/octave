// One-shot helper: sets TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as repo secrets
// on the GitHub repo for the Octave bot. Requires GH_PAT env var with
// `Secrets: read & write` permission on the repo.
import sodium from 'libsodium-wrappers';
import { readFileSync } from 'node:fs';

const PAT = process.env.GH_PAT;
const OWNER = process.env.OCTAVE_OWNER || 'octavebot';
const REPO = process.env.OCTAVE_REPO || 'octave';

async function api(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GH ${options.method || 'GET'} ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

async function setSecret(name, value, pubKey) {
  await sodium.ready;
  const keyBytes = sodium.from_base64(pubKey.key, sodium.base64_variants.ORIGINAL);
  const encrypted = sodium.crypto_box_seal(sodium.from_string(value), keyBytes);
  const encrypted_b64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ encrypted_value: encrypted_b64, key_id: pubKey.key_id }),
  });
  if (!res.ok) throw new Error(`set ${name}: ${res.status} ${await res.text()}`);
  console.log(`✓ set secret: ${name}`);
}

const env = Object.fromEntries(
  readFileSync('/Users/jqvier/.config/trading-alerts/.env', 'utf8')
    .split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2))
);
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
  console.error('Missing Telegram creds in /Users/jqvier/.config/trading-alerts/.env');
  process.exit(1);
}
const pubKey = await api(`/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
await setSecret('TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN, pubKey);
await setSecret('TELEGRAM_CHAT_ID', env.TELEGRAM_CHAT_ID, pubKey);
console.log('done.');
