// Gateway pages: owner sign-in, consent, passkey enrollment, hospital login return. Every interpolated value goes through esc;
// the one script per page carries a nonce and uses only the browser's WebAuthn API.
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

export const consentPage = (app: string, uid: string): string =>
  doc('Allow access to GA', `<h1>${esc(app)} wants to use your GA record</h1>
<p>It can read your health records, import documents, and manage shares and hospital connections. You can disconnect it at any time.</p>
<form method="post" action="/interaction/${esc(uid)}/consent"><button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form>`);
