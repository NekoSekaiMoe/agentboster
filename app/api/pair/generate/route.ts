import { requireAuthAccess, AuthError } from '@/lib/auth/access';
import { generatePairCode } from '@/lib/chat/commands/pair';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const cookieStore = await cookies();
  let userId: string;
  try {
    const access = await requireAuthAccess(cookieStore);
    userId = access.session.userId;
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    return NextResponse.json({ error: 'Unauthorized' }, { status });
  }

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
      userId,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
