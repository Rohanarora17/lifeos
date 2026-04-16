import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execAsync = promisify(exec);

export interface CaptureResult {
  base64Jpeg: string;
  appInFocus: string;
  windowTitle: string;
}

const SENSITIVE_FULL_APPS = [
  '1password 8', '1password 7', '1password',
  'bitwarden', 'lastpass', 'keychain access',
];
const SENSITIVE_TITLE_PATTERNS = [/password/i, /private key/i, /secret/i, /\.pem\b/i, /\.key\b/i];

function isSensitive(appName: string, windowTitle: string, extraApps: string[]): boolean {
  const appLower = appName.toLowerCase();
  const allSensitive = [...SENSITIVE_FULL_APPS, ...extraApps.map((a) => a.toLowerCase())];
  if (allSensitive.some((s) => appLower.includes(s))) return true;
  if (appLower.includes('terminal') || appLower.includes('iterm')) {
    return SENSITIVE_TITLE_PATTERNS.some((p) => p.test(windowTitle));
  }
  return false;
}

export async function getFrontmostApp(): Promise<{ appName: string; windowTitle: string }> {
  try {
    const script = `
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        set frontWindow to ""
        try
          set frontWindow to name of front window of application process frontApp
        end try
        return frontApp & "|||" & frontWindow
      end tell
    `;
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    const parts = stdout.trim().split('|||');
    return { appName: parts[0]?.trim() ?? '', windowTitle: parts[1]?.trim() ?? '' };
  } catch {
    return { appName: '', windowTitle: '' };
  }
}

export async function captureScreen(quality = 60, sensitiveApps: string[] = []): Promise<CaptureResult | null> {
  const { appName, windowTitle } = await getFrontmostApp();

  if (isSensitive(appName, windowTitle, sensitiveApps)) {
    console.log(`[capture] Skipping sensitive app: ${appName}`);
    return null;
  }

  const tmpFile = path.join(os.tmpdir(), `lifeos-capture-${Date.now()}.jpg`);
  try {
    // -x = no sound, -t jpg = JPEG format, quality via sips if needed
    execSync(`screencapture -x -t jpg "${tmpFile}"`, { timeout: 5000 });

    if (!fs.existsSync(tmpFile)) return null;

    const rawBuffer = fs.readFileSync(tmpFile);
    const base64Jpeg = rawBuffer.toString('base64');
    return { base64Jpeg, appInFocus: appName, windowTitle };
  } catch (err) {
    console.error('[capture] screencapture failed:', err);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
  }
}

/** Read the current clipboard text (for cross-app text selection via copy+trigger) */
export function getClipboardText(): string {
  try {
    return execSync('pbpaste', { encoding: 'utf8', timeout: 1000 }).trim();
  } catch {
    return '';
  }
}
