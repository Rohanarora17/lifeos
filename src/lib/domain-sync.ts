import { createClientRequestId } from './polyfill-crypto-uuid';

export function createDomainSyncOrigin(): string {
  return createClientRequestId();
}

export function shouldReloadForDomainRevision(
  knownRevision: number,
  incomingRevision: number,
  initiatedLocally: boolean,
): boolean {
  return !initiatedLocally
    && Number.isFinite(incomingRevision)
    && incomingRevision > knownRevision;
}
