import type { IncomingMessage } from 'node:http';
import { oauthPublicConfig, type RequestAuth } from '@ppeng/agent-core';

/**
 * Draft approve/reject requires a Lab login session (`ppeng_lab_session`).
 *
 * The cookie is HttpOnly and stays in the browser. The Next proxy does not
 * inject a release secret, and `Sec-Fetch-Site` is ignored because a local
 * client can forge it. `x-ppeng-human-release` is not a credential.
 * When OAuth is not configured, the route fails closed with 403
 * `human_login_required` (`loginRequired: false`). That is not the Lab's
 * session-expired 401, so the rest of the UI stays usable and the inbox can
 * ask the operator to turn login on. A session cookie is not accepted in that mode.
 * When login is configured but this request has no session, the status stays
 * 401 `login_required` so the login screen can take over.
 */
export function hasHumanRelease(_request: IncomingMessage, env: NodeJS.ProcessEnv, auth: RequestAuth): boolean {
  return oauthPublicConfig(env).loginRequired && Boolean(auth.user);
}

export function humanReleaseDenied(env: NodeJS.ProcessEnv): {
  status: 401 | 403;
  body:
    | { error: 'human_login_required'; loginRequired: false }
    | { error: 'login_required'; loginRequired: true; providers: readonly string[] };
} {
  const cfg = oauthPublicConfig(env);
  if (!cfg.loginRequired) {
    return { status: 403, body: { error: 'human_login_required', loginRequired: false } };
  }
  return { status: 401, body: { error: 'login_required', loginRequired: true, providers: cfg.providers } };
}
