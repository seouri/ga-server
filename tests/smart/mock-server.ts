// Synthetic SMART on FHIR server for tests: 127.0.0.1, random port, no real data.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, generateKeyPair, jwtVerify } from 'jose';
import type { JSONWebKeySet } from 'jose';

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

export type MockOpts = {
  clientId: string;
  jwks: { keys: object[] };
  patient?: string;
  noRefresh?: boolean; // fallback A: never issue a refresh token
  rotate?: boolean; // default true; false = refresh response omits refresh_token and the old one stays valid
  expiresIn?: number;
  // Return an RS256 id_token from the code exchange (iss = <origin>/oauth2), with `issuer` advertised in the config or not.
  idToken?: 'advertised' | 'unadvertised';
};

export type MockSmart = {
  origin: string;
  fhirBase: string;
  tokenEndpoint: string;
  opts: MockOpts;
  stats: { assertions: number; refreshes: number; reuse: number; rejected: string[] };
  currentRefresh: () => string | undefined;
  revokeAll: () => void;
  authorized: (req: IncomingMessage) => boolean; // bearer check for FHIR routes
  route: (path: string, h: Handler) => void; // add a route (exact pathname)
  onRequest?: (url: URL) => void; // test hook, runs before routing
  close: () => Promise<void>;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  let s = '';
  for await (const c of req) s += c;
  return s;
};

export async function startMock(opts: MockOpts): Promise<MockSmart> {
  const routes = new Map<string, Handler>();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const validRefresh = new Set<string>();
  const usedRefresh = new Set<string>();
  const access = new Set<string>();
  const jtis = new Set<string>();
  const patient = opts.patient ?? 'synthetic-patient-1';
  const keySet = createLocalJWKSet(opts.jwks as JSONWebKeySet);
  const kids = new Set(opts.jwks.keys.map((k) => (k as { kid?: string }).kid));
  let latest: string | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', m.origin);
    m.onRequest?.(url);
    const h = routes.get(url.pathname);
    if (!h) return json(res, 404, { error: 'not_found' });
    Promise.resolve(h(req, res, url)).catch(() => json(res, 500, { error: 'server_error' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const m: MockSmart = {
    origin,
    fhirBase: `${origin}/fhir`,
    tokenEndpoint: `${origin}/oauth2/token`,
    opts,
    stats: { assertions: 0, refreshes: 0, reuse: 0, rejected: [] },
    currentRefresh: () => latest,
    revokeAll: () => {
      validRefresh.clear();
      access.clear();
    },
    authorized: (req) => access.has((req.headers.authorization ?? '').replace(/^Bearer /, '')),
    route: (path, h) => void routes.set(path, h),
    close: () => new Promise((r) => server.close(() => r())),
  };

  const idKey = (await generateKeyPair('RS256')).privateKey;
  const issuer = `${origin}/oauth2`;
  const issue = async (res: ServerResponse, withPatient: boolean, newRefresh: boolean): Promise<void> => {
    const at = `at-${randomUUID()}`;
    access.add(at);
    const body: Record<string, unknown> = { access_token: at, token_type: 'Bearer', expires_in: opts.expiresIn ?? 3600, scope: 'patient/*.read offline_access' };
    if (withPatient) body.patient = patient;
    if (withPatient && opts.idToken) {
      body.id_token = await new SignJWT({ fhirUser: `${m.fhirBase}/Patient/${patient}` })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer)
        .setAudience(opts.clientId)
        .setSubject(patient)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(idKey);
    }
    if (newRefresh && !opts.noRefresh) {
      latest = `rt-${randomUUID()}`;
      validRefresh.add(latest);
      body.refresh_token = latest;
    }
    json(res, 200, body);
  };
  const reject = (res: ServerResponse, error: string, why: string): void => {
    m.stats.rejected.push(why);
    json(res, 400, { error });
  };

  m.route('/fhir/.well-known/smart-configuration', (_q, res) =>
    json(res, 200, {
      authorization_endpoint: `${origin}/oauth2/authorize`,
      token_endpoint: m.tokenEndpoint,
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['RS384'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: ['openid', 'fhirUser', 'launch/patient', 'offline_access', 'patient/*.read'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      ...(opts.idToken === 'advertised' ? { issuer } : {}),
      capabilities: ['launch-standalone', 'client-confidential-asymmetric', 'permission-offline', 'permission-patient', 'context-standalone-patient'],
    }),
  );

  m.route('/oauth2/authorize', (_q, res, url) => {
    const p = url.searchParams;
    const redirect = p.get('redirect_uri') ?? '';
    const ok =
      p.get('client_id') === opts.clientId &&
      p.get('response_type') === 'code' &&
      p.get('code_challenge_method') === 'S256' &&
      p.get('aud') === m.fhirBase &&
      /^http:\/\/localhost:\d+\/callback$/.test(redirect);
    if (!ok) return json(res, 400, { error: 'invalid_request' });
    const code = `code-${randomUUID()}`;
    codes.set(code, { challenge: p.get('code_challenge') ?? '', redirect });
    const to = new URL(redirect);
    to.searchParams.set('code', code);
    to.searchParams.set('state', p.get('state') ?? '');
    res.writeHead(302, { location: to.href });
    res.end();
  });

  m.route('/oauth2/token', async (req, res) => {
    const p = new URLSearchParams(await readBody(req));
    try {
      if (p.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') throw new Error('assertion type');
      const { payload, protectedHeader } = await jwtVerify(p.get('client_assertion') ?? '', keySet, {
        algorithms: ['RS384'],
        audience: m.tokenEndpoint,
        issuer: opts.clientId,
        subject: opts.clientId,
      });
      if (!protectedHeader.kid || !kids.has(protectedHeader.kid)) throw new Error('kid');
      if (payload.aud !== m.tokenEndpoint) throw new Error('aud'); // exactly the token endpoint, not an array
      if (!payload.jti || jtis.has(payload.jti)) throw new Error('jti');
      jtis.add(payload.jti);
      m.stats.assertions++;
    } catch (e) {
      return reject(res, 'invalid_client', `assertion: ${(e as Error).message}`);
    }
    if (p.get('grant_type') === 'authorization_code') {
      const c = codes.get(p.get('code') ?? '');
      codes.delete(p.get('code') ?? '');
      const verifier = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (!c || c.challenge !== verifier || c.redirect !== p.get('redirect_uri')) return reject(res, 'invalid_grant', 'code');
      return issue(res, true, true);
    }
    if (p.get('grant_type') === 'refresh_token') {
      const rt = p.get('refresh_token') ?? '';
      if (usedRefresh.has(rt)) {
        m.stats.reuse++;
        return reject(res, 'invalid_grant', 'refresh reuse');
      }
      if (!validRefresh.has(rt)) return reject(res, 'invalid_grant', 'refresh unknown');
      m.stats.refreshes++;
      const rotate = opts.rotate !== false;
      if (rotate) {
        validRefresh.delete(rt);
        usedRefresh.add(rt);
      }
      return issue(res, false, rotate); // refresh responses omit patient
    }
    reject(res, 'unsupported_grant_type', 'grant');
  });

  return m;
}
