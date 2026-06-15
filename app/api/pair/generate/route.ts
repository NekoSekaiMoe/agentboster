import { readAuthSessionFromCookies } from '@/lib/auth';
import { generatePairCode } from '@/lib/chat/commands/pair';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const session = await readAuthSessionFromCookies(cookieStore);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!session.userId) {
      return NextResponse.json(
        { error: 'Authenticated user has no userId.' },
        { status: 400 },
      );
    }

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
      session.userId,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
