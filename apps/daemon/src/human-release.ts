import type { IncomingMessage } from 'node:http';
import { oauthPublicConfig, type RequestAuth } from '@ppeng/agent-core';

/**
 * Draft approve/reject requires a Lab login session (`ppeng_lab_session`).
 *
 * The cookie is HttpOnly and stays in the browser. The Next proxy does not
 * inject a release secret, and `Sec-Fetch-Site` is ignored because a local
 * client can forge it. `x-ppeng-human-release` is not a credential.
 * When OAuth is not configured, the route fails closed (`login_required`,
 * `loginRequired: false`) so the Lab UI can tell the operator to turn login on.
 * A session cookie is not accepted in that mode.
 */
export function hasHumanRelease(_request: IncomingMessage, env: NodeJS.ProcessEnv, auth: RequestAuth): boolean {
  return oauthPublicConfig(env).loginRequired && Boolean(auth.user);
}

export function humanReleaseDeniedBody(env: NodeJS.ProcessEnv): {
  error: 'login_required';
  loginRequired: boolean;
  providers: readonly string[];
} {
  const cfg = oauthPublicConfig(env);
  return { error: 'login_required', loginRequired: cfg.loginRequired, providers: cfg.providers };
}
