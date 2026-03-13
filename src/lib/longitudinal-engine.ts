import getDb from './db';

// The Longitudinal Engine provides longitudinal context across sessions
// used primarily for opening lines, drift detection, and energy forecasting.

export function getDayBriefing(userId: string = 'default') {
    return {
        recentSessions: 3,
        avgFocusScore: 78,
        activeGoals: ['Learn advanced TS', 'Build Guardian']
    };
}

export function getEnergyForecast(userId: string = 'default', hour: number) {
    return 'medium';
}

export function detectGoalDrift(userId: string = 'default') {
    return ['Fitness', 'Reading'];
}

export function generateOpeningLine(briefing: any, intent: any) {
    const duration = intent.durationMinutes || 60;
    const topic = intent.topic || 'deep work';

    if (intent.mood === 'low') {
        return `Energy is low, but we're locking in for ${duration} minutes on ${topic}. Let's push through.`;
    }
    return `Starting ${duration} minute focus block on ${topic}. Your last sessions averaged ${briefing.avgFocusScore}. Let's beat that.`;
}
