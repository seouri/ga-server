// Gateway pages: owner sign-in, consent, passkey enrollment, file upload, confirming a chat app's preview, hospital login return. Every interpolated value goes through esc;
// the one script per page carries a nonce and calls only WebAuthn and this origin.
import { doc, esc } from '../share/page.ts';

const msg = (title: string, text: string): string => doc(title, `<h1>${esc(text)}</h1>`);
// JSON inside <script>: no "</script>" breakout.
const data = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

export const callbackDone = (): string => msg('GA', 'GA received the authorization. You can close this window and return to your chat.');
export const callbackInvalid = (): string => msg('Link not valid', 'This login link is no longer valid');
export const callbackFailed = (): string => msg('Login failed', 'GA could not finish the hospital login. Start it again from your chat.');
export const interactionExpired = (): string => msg('Sign-in expired', 'This sign-in has expired. Start again from your chat app.');
export const enrollInvalid = (): string =>
  doc('Link not valid', '<h1>This enrollment link is no longer valid</h1><p>Run <code>ga passkey link</code> on the computer running GA for a new one.</p>');
export const noPasskey = (): string =>
  doc('No passkey yet', '<h1>No passkey yet</h1><p>Run <code>ga passkey link</code> on the computer running GA, open the link here and save a passkey, then try again.</p>');

// Runs the WebAuthn ceremony, posts the result to <this path>/<post>, then follows {redirect} or shows {done}.
const ceremony = (nonce: string, options: unknown, call: string, post: string): string => `<p id="m" class="mut"></p>
<script nonce="${esc(nonce)}">
const OPTIONS = ${data(options)};
const m = document.getElementById('m');
document.getElementById('go').addEventListener('click', async () => {
  try {
    const cred = await ${call};
    const r = await fetch(location.pathname.replace(/\\/$/, '') + '${post}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred.toJSON()) });
    const j = await r.json();
    if (j.redirect) return location.assign(j.redirect);
    m.textContent = j.done || 'That did not work. Reload the page to try again.';
  } catch {
    m.textContent = 'Cancelled or not supported. Reload the page to try again.';
  }
});
</script>`;

export const loginPage = (nonce: string, options: unknown): string =>
  doc('Sign in to GA', `<h1>Sign in to GA</h1><p>Use your passkey (Face ID or Touch ID).</p><button id="go">Sign in with passkey</button>` +
    ceremony(nonce, options, 'navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(OPTIONS) })', '/login'));

export const enrollPage = (nonce: string, options: unknown): string =>
  doc('Save a passkey for GA', `<h1>Save a passkey for GA</h1><p>This passkey signs you in when a chat app connects to GA.</p><button id="go">Save passkey</button>` +
    ceremony(nonce, options, 'navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(OPTIONS) })', ''));

// Registration is open: the redirect host and the registration age let the owner spot a connect they did not start.
const ago = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 120 ? `${m} minute${m === 1 ? '' : 's'}` : m < 2880 ? `${Math.round(m / 60)} hours` : `${Math.round(m / 1440)} days`;
};
export const consentPage = (app: string, uid: string, redirectHost: string, registeredMsAgo: number): string =>
  doc('Allow access to GA', `<h1>${esc(app)} wants to use your GA record</h1>
<p>It can read your health records, import documents, and manage shares and hospital connections. You can disconnect it at any time.</p>
<p>Access goes to <strong>${esc(redirectHost)}</strong>. This app registered with GA ${ago(registeredMsAgo)} ago.</p>
<p><strong>Only allow if you just clicked Connect in this app.</strong></p>
<form method="post" action="/interaction/${esc(uid)}/consent"><button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form>`);

export const uploadInvalid = (): string => msg('Link not valid', 'This upload link is no longer valid. Ask your chat for a new one.');

// Posts the picked file as the raw request body, its name in the query.
export const uploadPage = (nonce: string): string =>
  doc('Upload to GA', `<h1>Upload a file to GA</h1>
<p>A PDF or photo as it is; an export (Apple Health, Epic EHI, C-CDA) as a .zip. Up to 2 GB. This link works once.</p>
<p><input type="file" id="f"></p><button id="go">Upload</button><p id="m" class="mut"></p>
<script nonce="${esc(nonce)}">
const m = document.getElementById('m');
document.getElementById('go').addEventListener('click', async () => {
  const f = document.getElementById('f').files[0];
  if (!f) return;
  m.textContent = 'Uploading...';
  try {
    const r = await fetch(location.pathname + '?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    m.textContent = (await r.json()).done;
  } catch {
    m.textContent = 'The upload failed. Ask your chat for a new link.';
  }
});
</script>`);

export const confirmInvalid = (): string => msg('Link not valid', 'This confirmation link is no longer valid. Ask your chat for a new preview.');

// A plain form post: no script, and the SameSite=Lax owner cookie never rides a cross-site post.
export const confirmPage = (title: string, view: Record<string, unknown>, path: string): string =>
  doc(title, `<h1>${esc(title)}</h1><p>Your chat app asked for this. Confirm only if you asked for it.</p><dl>${Object.entries(view)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</dd>`)
    .join('')}</dl>
<form method="post" action="${esc(path)}"><button>Confirm</button></form>`);

export const confirmDone = (r: { done: string; link?: string; qr?: string }): string =>
  doc('Done', `<h1>${esc(r.done)}</h1>${r.link ? `<p><a href="${esc(r.link)}">${esc(r.link)}</a></p>` : ''}${r.qr ? `<p><img src="${esc(r.qr)}" alt="QR code of the link"></p>` : ''}<p>You can close this window and return to your chat.</p>`);

export const confirmFailed = (why: string): string => msg('Not done', `That did not work: ${why}`);
