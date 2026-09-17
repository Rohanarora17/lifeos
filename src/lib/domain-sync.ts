export function shouldReloadForDomainRevision(
  knownRevision: number,
  incomingRevision: number,
  initiatedLocally: boolean,
): boolean {
  return !initiatedLocally
    && Number.isFinite(incomingRevision)
    && incomingRevision > knownRevision;
}
