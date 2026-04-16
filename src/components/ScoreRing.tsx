'use client';

import { scoreColor } from '@/lib/score-classify';

export default function ScoreRing({ score, size = 120 }: { score: number; size?: number }) {
    const radius = (size - 16) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (score / 100) * circumference;

    return (
        <div className="score-ring" style={{ width: size, height: size }}>
            <svg width={size} height={size}>
                <circle className="score-ring-bg" cx={size / 2} cy={size / 2} r={radius} />
                <circle
                    className="score-ring-fill"
                    cx={size / 2} cy={size / 2} r={radius}
                    stroke={scoreColor(score)}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                />
            </svg>
            <div className="score-value" style={{ fontSize: size * 0.22 }}>{score}</div>
        </div>
    );
}
