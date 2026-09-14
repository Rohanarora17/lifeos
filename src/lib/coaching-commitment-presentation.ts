import type { CommitmentState } from './coaching-commitments';

export function getCommitmentPresentation(
  commitment: { state: CommitmentState; plannedStartAt: string },
  now = new Date(),
): {
  isUpcoming: boolean;
  primaryActionLabel: 'Start early' | 'Start now';
  showBlockerPrompt: boolean;
  statusMessage: string | null;
} {
  const startMs = new Date(commitment.plannedStartAt).getTime();
  const isUpcoming = (
    commitment.state === 'scheduled' || commitment.state === 'rescheduled'
  ) && Number.isFinite(startMs) && startMs > now.getTime();

  return {
    isUpcoming,
    primaryActionLabel: isUpcoming ? 'Start early' : 'Start now',
    showBlockerPrompt: !isUpcoming && commitment.state !== 'started',
    statusMessage: isUpcoming
      ? 'LifeOS will check this commitment at its scheduled time and follow up if the start is missed.'
      : null,
  };
}
