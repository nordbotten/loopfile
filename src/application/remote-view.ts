import type { RemoteRecord } from "../domain/events.ts";

/** Formats a recorded remote source for operator output. */
export function formatRemoteLine(remote: RemoteRecord, fullSha = false): string {
  const path = remote.path === undefined ? "" : `/${remote.path}`;
  const ref = remote.ref === undefined ? "" : ` @ ${remote.ref}`;
  const sha = fullSha ? remote.sha : remote.sha.slice(0, 7);
  return `remote: ${remote.host}/${remote.repo}${path}${ref} (${sha})`;
}
