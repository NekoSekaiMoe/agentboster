import { generatePairCode } from '@/lib/chat/commands/pair';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { adapter } = body;

    if (!adapter) {
      return NextResponse.json(
        { error: 'adapter is required' },
        { status: 400 },
      );
    }

    const result = await generatePairCode(
      adapter as Parameters<typeof generatePairCode>[0],
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
