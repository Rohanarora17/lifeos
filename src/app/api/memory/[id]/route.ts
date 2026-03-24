import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { updateFact, deleteFact, supersedeFact } from '@/lib/memory';

// PATCH /api/memory/[id]
// body: { action: 'confirm' | 'activate' | 'correct' | 'supersede', content?: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const factId = parseInt(id);
  if (isNaN(factId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  try {
    const body = await req.json();
    const { action, content } = body as { action: string; content?: string };

    switch (action) {
      case 'confirm':
        // Mark as active + bump confirmed_count
        updateFact(factId, { status: 'active' });
        break;

      case 'correct':
        // Update content and activate
        if (!content) return NextResponse.json({ error: 'content required for correct' }, { status: 400 });
        updateFact(factId, { content, status: 'active' });
        break;

      case 'supersede':
        // Replace with corrected content, archive old
        if (!content) return NextResponse.json({ error: 'content required for supersede' }, { status: 400 });
        supersedeFact(factId, content);
        break;

      case 'reject':
        // Reject unverified fact — delete it outright
        deleteFact(factId);
        break;

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Return the updated fact (or null if deleted)
    const updated = action === 'reject'
      ? null
      : (getDb().prepare('SELECT * FROM mem_facts WHERE id = ?').get(factId) ?? null);

    return NextResponse.json({ ok: true, fact: updated });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/memory/[id] — hard delete (right to be forgotten)
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const factId = parseInt(id);
  if (isNaN(factId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  try {
    deleteFact(factId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
