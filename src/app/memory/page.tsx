'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

type FactStatus = 'active' | 'unverified' | 'superseded';
type FactCategory = 'preference' | 'pattern' | 'habit' | 'identity' | 'goal' | 'mood' | 'constraint';

interface MemFact {
  id: number;
  category: FactCategory;
  topic: string;
  content: string;
  confidence: number;
  importance: number;
  status: FactStatus;
  half_life_days: number;
  source: string;
  source_episode_ids: string;
  confirmed_count: number;
  last_confirmed: string;
  access_count: number;
  created_at: string;
  effectiveScore: number;
  embedding: string | null;
}

interface MemEpisode {
  id: number;
  source: string;
  summary: string;
  importance: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface MemStats {
  episodes: number;
  activeFacts: number;
  unverifiedFacts: number;
  activeProcedures: number;
  workingSnapshots: number;
}

interface MemoryPersonalization {
  mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
  guidance: string;
  energy: 'high' | 'medium' | 'low';
  mood: 'high' | 'medium' | 'low' | null;
  standupGoal: string | null;
  alertFatigueLevel: 'low' | 'medium' | 'high';
  plannedFocus: {
    nextTitle: string | null;
    nextMinutes: number | null;
    recentFollowThroughRate: number | null;
  };
}

// ── Constants ──────────────────────────────────────────────────────────────────

const CATEGORIES: FactCategory[] = ['preference', 'pattern', 'habit', 'identity', 'goal', 'mood', 'constraint'];

const CATEGORY_COLORS: Record<FactCategory, string> = {
  preference: '#6366f1',
  pattern:    '#f59e0b',
  habit:      '#22c55e',
  identity:   '#a855f7',
  goal:       '#3b82f6',
  mood:       '#ec4899',
  constraint: '#ef4444',
};

const CATEGORY_ICONS: Record<FactCategory, string> = {
  preference: '⚙️',
  pattern:    '📊',
  habit:      '🔄',
  identity:   '👤',
  goal:       '🎯',
  mood:       '💭',
  constraint: '⚠️',
};

const SOURCE_ICONS: Record<string, string> = {
  guardian: '🛡️',
  voice:    '🎙️',
  chat:     '💬',
  browse:   '🌐',
  manual:   '✏️',
  extracted:'🤖',
  inferred: '🔮',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function confidenceLabel(c: number): string {
  if (c >= 0.85) return 'high';
  if (c >= 0.65) return 'medium';
  return 'low';
}

function compactMemoryText(text: string, maxLength = 54): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function suggestedMemoryCategory(personalization: MemoryPersonalization | null): FactCategory {
  if (!personalization) return 'preference';
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') return 'mood';
  if (personalization.mode === 'deadline_pressure') return 'constraint';
  if (personalization.mode === 'planning') return 'goal';
  if (personalization.plannedFocus.nextTitle) return 'pattern';
  return 'preference';
}

function memoryTopicPlaceholder(personalization: MemoryPersonalization | null, category: FactCategory): string {
  if (!personalization) return 'e.g. preferred_study_time';
  if (category === 'mood') return 'e.g. low_energy_triggers';
  if (category === 'constraint') return 'e.g. deadline_pressure_blockers';
  if (category === 'goal' && personalization.standupGoal) return `e.g. ${compactMemoryText(personalization.standupGoal, 28).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  if (category === 'pattern' && personalization.plannedFocus.nextTitle) return 'e.g. planned_focus_follow_through';
  if (category === 'habit') return 'e.g. habit_that_survives_bad_days';
  return 'e.g. preferred_study_time';
}

function memoryContentPlaceholder(personalization: MemoryPersonalization | null, category: FactCategory): string {
  if (!personalization) return 'Specific factual statement about you...';
  if (category === 'mood' || personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'When my energy is low, what still helps me make progress is...';
  }
  if (category === 'constraint' || personalization.mode === 'deadline_pressure') {
    return 'Under deadline pressure, the blocker or rule LifeOS should remember is...';
  }
  if (category === 'goal' || personalization.mode === 'planning') {
    return 'For tomorrow planning, LifeOS should remember that...';
  }
  if (personalization.plannedFocus.nextTitle) {
    return `For "${compactMemoryText(personalization.plannedFocus.nextTitle, 42)}", what LifeOS should remember is...`;
  }
  return 'Specific factual statement about you...';
}

function memoryEmptyMessage(activeTab: 'all' | 'unverified' | FactCategory, search: string, personalization: MemoryPersonalization | null): string {
  if (search) {
    if (personalization?.plannedFocus.nextTitle) {
      return `No facts matching "${search}". Add what LifeOS should remember for ${compactMemoryText(personalization.plannedFocus.nextTitle, 42)}.`;
    }
    if (personalization?.mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low') {
      return `No facts matching "${search}". Add an energy, sleep, or capacity rule if this keeps affecting your day.`;
    }
    if (personalization?.mode === 'deadline_pressure') {
      return `No facts matching "${search}". Add the blocker, constraint, or deadline rule LifeOS should use next time.`;
    }
    if (personalization?.mode === 'planning') {
      return `No facts matching "${search}". Add what tomorrow planning should inherit or avoid.`;
    }
    return `No facts matching "${search}". Add the personal rule if this should guide future choices.`;
  }
  if (activeTab === 'unverified') return 'No unverified facts. The next useful signal is fresh feedback after a session.';
  if (!personalization) return 'No facts in this category yet.';
  if (activeTab === 'mood' || personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'No mood facts here yet. Add what changes your energy, sleep, or capacity.';
  }
  if (activeTab === 'constraint' || personalization.mode === 'deadline_pressure') {
    return 'No constraint facts here yet. Add deadline blockers, calendar limits, or rules that affect planning.';
  }
  if (activeTab === 'goal' || personalization.mode === 'planning') {
    return 'No goal facts here yet. Add what tomorrow should optimize for or avoid.';
  }
  return 'No facts in this category yet. Add a personal rule the agent should use later.';
}

function memorySearchPlaceholder(personalization: MemoryPersonalization | null): string {
  if (!personalization) return 'Search memory...';
  if (personalization.plannedFocus.nextTitle) {
    return `Search facts for ${compactMemoryText(personalization.plannedFocus.nextTitle, 34)}...`;
  }
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'Search energy, sleep, mood, or recovery facts...';
  }
  if (personalization.mode === 'deadline_pressure') {
    return 'Search deadline blockers, constraints, or pressure patterns...';
  }
  if (personalization.mode === 'planning') {
    return 'Search tomorrow goals, calendar rules, or planning facts...';
  }
  if (personalization.standupGoal) {
    return `Search facts for ${compactMemoryText(personalization.standupGoal, 34)}...`;
  }
  return 'Search memory by goal, habit, mood, or constraint...';
}

// ── Fact Card ──────────────────────────────────────────────────────────────────

function FactCard({
  fact,
  onConfirm,
  onReject,
  onDelete,
  onCorrect,
}: {
  fact: MemFact;
  onConfirm: (id: number) => void;
  onReject: (id: number) => void;
  onDelete: (id: number) => void;
  onCorrect: (id: number, content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(fact.content);
  const color = CATEGORY_COLORS[fact.category];
  const isUnverified = fact.status === 'unverified';

  const handleSave = () => {
    if (editText.trim() && editText !== fact.content) {
      onCorrect(fact.id, editText.trim());
    }
    setEditing(false);
  };

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: `1px solid ${isUnverified ? 'rgba(251,191,36,0.4)' : 'var(--border)'}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        position: 'relative',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{
          background: color + '22',
          color,
          border: `1px solid ${color}44`,
          borderRadius: '6px',
          padding: '2px 8px',
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          {CATEGORY_ICONS[fact.category]} {fact.category}
        </span>

        <span style={{
          color: 'var(--text-muted)',
          fontSize: '12px',
          fontWeight: 500,
          background: 'var(--bg-tertiary)',
          borderRadius: '4px',
          padding: '2px 6px',
        }}>
          {fact.topic.replace(/_/g, ' ')}
        </span>

        {isUnverified && (
          <span style={{
            background: 'rgba(251,191,36,0.15)',
            color: '#fbbf24',
            border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: '6px',
            padding: '2px 8px',
            fontSize: '11px',
            fontWeight: 600,
          }}>
            unverified
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {SOURCE_ICONS[fact.source] || '•'} {fact.source}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {timeAgo(fact.created_at)}
          </span>
        </div>
      </div>

      {/* Content */}
      {editing ? (
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            autoFocus
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
            style={{
              flex: 1,
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '6px 10px',
              color: 'var(--text-primary)',
              fontSize: '13px',
            }}
          />
          <button onClick={handleSave} style={{ padding: '6px 12px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>Save</button>
          <button onClick={() => setEditing(false)} style={{ padding: '6px 10px', borderRadius: '6px', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', fontSize: '12px', border: '1px solid var(--border)', cursor: 'pointer' }}>Cancel</button>
        </div>
      ) : (
        <p style={{ fontSize: '13.5px', color: 'var(--text-primary)', lineHeight: 1.5, margin: 0 }}>
          {fact.content}
        </p>
      )}

      {/* Metrics row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '2px' }}>
        {/* Confidence bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>conf</span>
          <div style={{ width: 60, height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${fact.confidence * 100}%`, height: '100%', background: color, borderRadius: 2 }} />
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{confidenceLabel(fact.confidence)}</span>
        </div>

        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          score {fact.effectiveScore.toFixed(2)}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          seen {fact.confirmed_count}x
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          accessed {fact.access_count}x
        </span>
        {fact.embedding && (
          <span style={{ fontSize: '11px', color: '#6366f1' }} title="Embedding vector stored">
            ⬡ embedded
          </span>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
        {isUnverified && (
          <>
            <button
              onClick={() => onConfirm(fact.id)}
              style={{ padding: '4px 12px', borderRadius: '6px', background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
            >
              Confirm
            </button>
            <button
              onClick={() => onReject(fact.id)}
              style={{ padding: '4px 12px', borderRadius: '6px', background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
            >
              Reject
            </button>
          </>
        )}
        <button
          onClick={() => { setEditText(fact.content); setEditing(true); }}
          style={{ padding: '4px 10px', borderRadius: '6px', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border)', fontSize: '12px', cursor: 'pointer' }}
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(fact.id)}
          style={{ padding: '4px 10px', borderRadius: '6px', background: 'transparent', color: '#ef444488', border: '1px solid transparent', fontSize: '12px', cursor: 'pointer' }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Add Fact Modal ─────────────────────────────────────────────────────────────

function AddFactModal({
  onClose,
  onAdded,
  personalization,
}: {
  onClose: () => void;
  onAdded: () => void;
  personalization: MemoryPersonalization | null;
}) {
  const [category, setCategory] = useState<FactCategory>(() => suggestedMemoryCategory(personalization));
  const [topic, setTopic] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!topic.trim() || !content.trim()) return;
    setSaving(true);
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, topic: topic.trim().toLowerCase().replace(/\s+/g, '_'), content: content.trim() }),
    });
    setSaving(false);
    onAdded();
    onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '14px', padding: '24px', width: '480px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h2 style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '16px', margin: 0 }}>Add memory fact</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Category</label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value as FactCategory)}
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '7px', padding: '8px 10px', color: 'var(--text-primary)', fontSize: '13px' }}
          >
            {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_ICONS[c]} {c}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Topic (snake_case key)</label>
          <input
            value={topic}
            onChange={e => setTopic(e.target.value)}
            placeholder={memoryTopicPlaceholder(personalization, category)}
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '7px', padding: '8px 10px', color: 'var(--text-primary)', fontSize: '13px' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Content</label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={memoryContentPlaceholder(personalization, category)}
            rows={3}
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '7px', padding: '8px 10px', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: '8px', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border)', fontSize: '13px', cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !topic.trim() || !content.trim()}
            style={{ padding: '8px 20px', borderRadius: '8px', background: 'var(--gradient-primary)', color: '#fff', border: 'none', fontSize: '13px', fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Saving...' : 'Add Fact'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function MemoryPage() {
  const [facts, setFacts] = useState<MemFact[]>([]);
  const [stats, setStats] = useState<MemStats | null>(null);
  const [episodes, setEpisodes] = useState<MemEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'unverified' | FactCategory>('all');
  const [search, setSearch] = useState('');
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [personalization, setPersonalization] = useState<MemoryPersonalization | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (searchQuery = '') => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (searchQuery) params.set('search', searchQuery);
      else if (activeTab !== 'all' && activeTab !== 'unverified') params.set('category', activeTab);
      if (activeTab === 'unverified') params.set('status', 'unverified');

      const res = await fetch(`/api/memory?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setFacts(data.facts ?? []);
      setStats(data.stats ?? null);
      setEpisodes(data.episodes ?? []);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(res => res.ok ? res.json() : null)
      .then(data => setPersonalization(data?.personalization ?? null))
      .catch(() => setPersonalization(null));
  }, []);

  // Debounced search
  const handleSearch = (val: string) => {
    setSearch(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(val), 350);
  };

  const handleAction = async (id: number, action: string, content?: string) => {
    await fetch(`/api/memory/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, content }),
    });
    load(search);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Permanently delete this memory fact?')) return;
    await fetch(`/api/memory/${id}`, { method: 'DELETE' });
    load(search);
  };

  const displayFacts = search ? facts : facts.filter(f => {
    if (activeTab === 'unverified') return f.status === 'unverified';
    if (activeTab === 'all') return true;
    return f.category === activeTab;
  });

  const unverifiedCount = facts.filter(f => f.status === 'unverified').length;

  return (
    <div style={{ padding: '32px', maxWidth: '960px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '28px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Memory Inspector</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Everything the guardian has learned about you. Confirm, correct, or delete.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          style={{ padding: '9px 18px', borderRadius: '9px', background: 'var(--gradient-primary)', color: '#fff', border: 'none', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
        >
          + Add fact
        </button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '24px' }}>
          {[
            { label: 'Active facts', value: stats.activeFacts, color: '#22c55e' },
            { label: 'Unverified', value: stats.unverifiedFacts, color: '#fbbf24' },
            { label: 'Episodes', value: stats.episodes, color: '#6366f1' },
            { label: 'Procedures', value: stats.activeProcedures, color: '#a855f7' },
            { label: 'Snapshots', value: stats.workingSnapshots, color: '#3b82f6' },
          ].map(s => (
            <div key={s.label} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px 16px' }}>
              <div style={{ fontSize: '22px', fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Search */}
      <div style={{ marginBottom: '16px' }}>
        <input
          value={search}
          onChange={e => handleSearch(e.target.value)}
          placeholder={memorySearchPlaceholder(personalization)}
          style={{
            width: '100%',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '9px',
            padding: '10px 14px',
            color: 'var(--text-primary)',
            fontSize: '13px',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Tabs */}
      {!search && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '20px' }}>
          {(['all', 'unverified', ...CATEGORIES] as const).map(tab => {
            const isActive = activeTab === tab;
            const color = tab === 'unverified' ? '#fbbf24' : CATEGORIES.includes(tab as FactCategory) ? CATEGORY_COLORS[tab as FactCategory] : 'var(--text-primary)';
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '8px',
                  border: `1px solid ${isActive ? color + '66' : 'var(--border)'}`,
                  background: isActive ? color + '1a' : 'var(--bg-secondary)',
                  color: isActive ? color : 'var(--text-muted)',
                  fontSize: '12px',
                  fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {tab === 'all' && 'All'}
                {tab === 'unverified' && <>Unverified {unverifiedCount > 0 && <span style={{ background: '#fbbf2433', borderRadius: '10px', padding: '0 6px', fontSize: '11px' }}>{unverifiedCount}</span>}</>}
                {CATEGORIES.includes(tab as FactCategory) && <>{CATEGORY_ICONS[tab as FactCategory]} {tab}</>}
              </button>
            );
          })}
        </div>
      )}

      {/* Unverified alert banner */}
      {!search && unverifiedCount > 0 && activeTab !== 'unverified' && (
        <div
          onClick={() => setActiveTab('unverified')}
          style={{
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: '10px',
            padding: '12px 16px',
            marginBottom: '16px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            color: '#fbbf24',
            fontSize: '13px',
          }}
        >
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <span><strong>{unverifiedCount} unverified {unverifiedCount === 1 ? 'fact' : 'facts'}</strong> waiting for your review — click to review</span>
          <span style={{ marginLeft: 'auto', fontSize: '12px', opacity: 0.7 }}>→</span>
        </div>
      )}

      {/* Facts list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>Loading memory...</div>
      ) : displayFacts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
          {memoryEmptyMessage(activeTab, search, personalization)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {displayFacts.map(fact => (
            <FactCard
              key={fact.id}
              fact={fact}
              onConfirm={id => handleAction(id, 'confirm')}
              onReject={id => handleAction(id, 'reject')}
              onDelete={handleDelete}
              onCorrect={(id, content) => handleAction(id, 'correct', content)}
            />
          ))}
        </div>
      )}

      {/* Episodes section */}
      <div style={{ marginTop: '36px' }}>
        <button
          onClick={() => setShowEpisodes(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600, padding: 0, marginBottom: '12px' }}
        >
          <span style={{ fontSize: '10px' }}>{showEpisodes ? '▼' : '▶'}</span>
          Recent Episodes ({episodes.length})
        </button>

        {showEpisodes && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {episodes.map(ep => (
              <div key={ep.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <span style={{ fontSize: '18px', flexShrink: 0 }}>{SOURCE_ICONS[ep.source] || '•'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.4 }}>{ep.summary}</p>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{ep.source}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{timeAgo(ep.created_at)}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>importance {ep.importance.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAddModal && (
        <AddFactModal onClose={() => setShowAddModal(false)} onAdded={() => load()} personalization={personalization} />
      )}
    </div>
  );
}
