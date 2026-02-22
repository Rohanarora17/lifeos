'use client';

export default function DonutChart({
    productive, distraction, neutral
}: { productive: number; distraction: number; neutral: number }) {
    const total = productive + distraction + neutral;
    if (total === 0) {
        return (
            <div className="donut-chart">
                <svg viewBox="0 0 36 36" width={140} height={140}>
                    <circle cx="18" cy="18" r="14" fill="none" stroke="var(--bg-secondary)" strokeWidth="4" />
                </svg>
                <div className="donut-center">
                    <span className="text-sm" style={{ color: 'var(--text-muted)' }}>No data</span>
                </div>
            </div>
        );
    }

    const pPct = (productive / total) * 100;
    const dPct = (distraction / total) * 100;
    const nPct = (neutral / total) * 100;
    const circumference = 2 * Math.PI * 14;

    // Calculate dash arrays
    const pDash = (pPct / 100) * circumference;
    const dDash = (dPct / 100) * circumference;
    const nDash = (nPct / 100) * circumference;

    const pOffset = 0;
    const dOffset = circumference - pDash;
    const nOffset = circumference - pDash - dDash;

    return (
        <div className="donut-chart">
            <svg viewBox="0 0 36 36" width={140} height={140} style={{ transform: 'rotate(-90deg)' }}>
                {/* Neutral */}
                <circle
                    cx="18" cy="18" r="14" fill="none"
                    stroke="var(--accent-yellow)" strokeWidth="4"
                    strokeDasharray={`${nDash} ${circumference - nDash}`}
                    strokeDashoffset={-pDash - dDash}
                    strokeLinecap="round"
                />
                {/* Distraction */}
                <circle
                    cx="18" cy="18" r="14" fill="none"
                    stroke="var(--accent-red)" strokeWidth="4"
                    strokeDasharray={`${dDash} ${circumference - dDash}`}
                    strokeDashoffset={-pDash}
                    strokeLinecap="round"
                />
                {/* Productive (on top) */}
                <circle
                    cx="18" cy="18" r="14" fill="none"
                    stroke="var(--accent-green)" strokeWidth="4"
                    strokeDasharray={`${pDash} ${circumference - pDash}`}
                    strokeDashoffset={0}
                    strokeLinecap="round"
                />
            </svg>
            <div className="donut-center">
                <span className="text-lg font-bold">{Math.round(pPct)}%</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>focused</span>
            </div>
        </div>
    );
}
