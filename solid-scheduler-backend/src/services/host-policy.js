/**
 * The server's policy for where a signed-in user's requests may go.
 *
 * Identity providers, WebIDs and Pod URLs all come from users, or from
 * profiles they control. Without a check, anyone could sign in with a
 * profile that lists an internal address as their Pod and have the server
 * send requests there. Only public addresses are allowed, plus the host of
 * the identity provider the operator configured (it may run on the local
 * network). ALLOW_PRIVATE_POD_HOSTS turns the check off.
 */

import config from '../config/index.js';
import { createHostPolicy } from '../utils/public-host.js';

export const hostPolicy = createHostPolicy({
  allowPrivate: config.allowPrivatePodHosts,
  trustedUrls: [config.solid.defaultIdp],
});

export default hostPolicy;
