export interface GuardianDurationOption {
  minutes: number;
  label: string;
}

export interface GuardianDurationOptionInput {
  adaptiveDuration: number;
  mode?: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
  energy?: 'high' | 'medium' | 'low';
  mood?: 'high' | 'medium' | 'low' | null;
  selectedTaskMinutes?: number | null;
  plannedMinutes?: number | null;
  topTaskMinutes?: number | null;
  selectedMinutes?: number | null;
}

const STANDARD_SESSION_MINUTES = [25, 45, 60, 90, 120] as const;

function addDurationOption(
  options: GuardianDurationOption[],
  minutes: number | null | undefined,
  label: string,
) {
  if (!minutes || minutes <= 0) return;
  const rounded = Math.max(5, Math.min(240, Math.round(minutes / 5) * 5));
  if (options.some(option => option.minutes === rounded)) return;
  options.push({ minutes: rounded, label });
}

/**
 * Keep recommendations prominent without taking away ordinary session lengths.
 * Contextual values are shown first; standard manual overrides are always kept.
 */
export function buildGuardianDurationOptions(
  input: GuardianDurationOptionInput,
): GuardianDurationOption[] {
  const options: GuardianDurationOption[] = [];
  const mode = input.mode ?? 'normal';
  const base = Math.round(input.adaptiveDuration);

  addDurationOption(options, input.selectedTaskMinutes, 'This task');
  addDurationOption(options, input.plannedMinutes, 'Next planned');
  addDurationOption(
    options,
    base,
    mode === 'recovery'
      ? 'Recovery default'
      : mode === 'deadline_pressure'
        ? 'Pressure default'
        : 'Today default',
  );

  if (mode === 'recovery' || input.energy === 'low' || input.mood === 'low') {
    addDurationOption(options, Math.min(base, 20), 'Small start');
    addDurationOption(options, Math.min(Math.max(base, 25), 35), 'Manageable');
  } else if (mode === 'deadline_pressure') {
    addDurationOption(options, Math.max(base, 45), 'Serious sprint');
    addDurationOption(options, Math.max(base, 75), 'Deep push');
  } else if (mode === 'planning') {
    addDurationOption(options, Math.min(base, 30), 'Planning pass');
    addDurationOption(options, Math.max(base, 45), 'Setup block');
  } else {
    addDurationOption(options, Math.max(25, base - 15), 'Shorter');
    addDurationOption(options, Math.min(120, base + 15), 'Deeper');
  }

  addDurationOption(options, input.topTaskMinutes, 'Top recommendation');
  addDurationOption(options, input.selectedMinutes, 'Selected');
  for (const minutes of STANDARD_SESSION_MINUTES) {
    addDurationOption(options, minutes, 'Manual option');
  }
  return options;
}
