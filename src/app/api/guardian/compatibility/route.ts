import { NextResponse } from 'next/server';
import {
  GUARDIAN_EVIDENCE_SCHEMA_VERSION,
  MIN_CHROME_COLLECTOR_VERSION,
  MIN_NATIVE_COLLECTOR_VERSION,
} from '@/lib/guardian-evidence-contract';
import { configuredGuardianEvidenceMode } from '@/lib/guardian-evidence-store';
import { getGuardianShadowRolloutStatus } from '@/lib/guardian-evidence-shadow';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    evidenceSchemaVersion: GUARDIAN_EVIDENCE_SCHEMA_VERSION,
    minimumVersions: {
      native: MIN_NATIVE_COLLECTOR_VERSION,
      chrome: MIN_CHROME_COLLECTOR_VERSION,
    },
    evidenceMode: configuredGuardianEvidenceMode(),
    extensionDistribution: process.env.LIFEOS_EXTENSION_DISTRIBUTION || 'unpacked_manual_reload',
    serverDeploymentUpdatesCollectors: false,
    shadowRollout: getGuardianShadowRolloutStatus(10),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
