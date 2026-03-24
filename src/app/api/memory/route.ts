import { NextResponse } from 'next/server';
import {
  getAllFacts,
  getMemoryStats,
  queryRecentEpisodes,
  searchFactsByText,
  insertFact,
  FactCategory,
} from '@/lib/memory';

// GET /api/memory?category=&status=&search=&limit=100
export async function GET(req: Request) {
  const url = new URL(req.url);
  const category = url.searchParams.get('category') as FactCategory | null;
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search')?.trim();
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '100'));

  try {
    let facts = getAllFacts({ includeSuperseded: false });

    // Filter by search (FTS5) — overrides other filters when provided
    if (search) {
      facts = searchFactsByText(search, limit);
    } else {
      if (category) facts = facts.filter(f => f.category === category);
      if (status) facts = facts.filter(f => f.status === status);
      facts = facts.slice(0, limit);
    }

    const stats = getMemoryStats();
    const episodes = queryRecentEpisodes({ hours: 72, limit: 20 });

    return NextResponse.json({ facts, stats, episodes });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// POST /api/memory — manually add a fact
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { category, topic, content, confidence, importance } = body;

    if (!category || !topic || !content) {
      return NextResponse.json({ error: 'category, topic, content required' }, { status: 400 });
    }

    const id = insertFact({
      category: category as FactCategory,
      topic,
      content,
      confidence: confidence ?? 0.9,
      importance: importance ?? 0.6,
      source: 'manual',
      status: 'active', // manually added facts are immediately active
    });

    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
