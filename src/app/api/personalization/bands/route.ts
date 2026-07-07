import { NextResponse } from 'next/server';
import { getAdaptiveBands } from '@/lib/adaptive-bands';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';

export async function GET() {
  const bands = getAdaptiveBands();
  const snapshot = buildPersonalizationSnapshot({
    surface: 'scoring',
    maxInsights: 2,
    includeMemoryFacts: 3,
  });

  return NextResponse.json({
    bands,
    context: {
      mode: snapshot.moment.mode,
      guidance: snapshot.moment.guidance,
      energy: snapshot.userState.energy,
      mood: snapshot.userState.mood,
      focusTrend: snapshot.userState.focusTrend,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    },
    explanation: [
      `Focus score colors use your learned focus bands: excellent ${Math.round(bands.focusExcellent)}+, good ${Math.round(bands.focusGood)}+, neutral ${Math.round(bands.focusNeutral)}+.`,
      `Daily capacity is currently ${Math.round(bands.dailyCapacityMinutes)} minutes.`,
      `Current scoring context is ${snapshot.moment.mode}: ${snapshot.moment.guidance}`,
    ],
  });
}
