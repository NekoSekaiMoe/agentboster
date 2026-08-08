import { requireAuthAccess, AuthError } from '@/lib/auth/access';
import {
  createL0Rule,
  deleteL0Rule,
  listL0Rules,
  updateL0Rule,
} from '@/lib/core/db/agentd';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const l0RuleTypeSchema = z.enum(['command', 'path', 'network']);
const l0RuleActionSchema = z.enum(['block', 'warn']);
const l0RuleScopeSchema = z.enum(['workspace', 'global']);

const createL0RuleSchema = z.object({
  agentId: z.string().trim().min(1).default('global'),
  pattern: z.string().trim().min(1),
  type: l0RuleTypeSchema.default('command'),
  action: l0RuleActionSchema.default('block'),
  scope: l0RuleScopeSchema.default('global'),
  enabled: z.boolean().default(true),
});

const updateL0RuleSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().trim().min(1).optional(),
  pattern: z.string().trim().min(1).optional(),
  type: l0RuleTypeSchema.optional(),
  action: l0RuleActionSchema.optional(),
  scope: l0RuleScopeSchema.optional(),
  enabled: z.boolean().optional(),
});

const deleteL0RuleSchema = z.object({
  id: z.string().uuid(),
});

async function requireAuthOrResponse(): Promise<NextResponse | null> {
  const cookieStore = await cookies();
  try {
    await requireAuthAccess(cookieStore);
    return null;
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    return NextResponse.json({ error: 'Unauthorized' }, { status });
  }
}

function validationError(error: z.ZodError) {
  return NextResponse.json(
    { error: 'Invalid request', issues: error.issues },
    { status: 400 },
  );
}

export async function GET() {
  try {
    const auth = await requireAuthOrResponse();
    if (auth) return auth;

    const rules = await listL0Rules();
    return NextResponse.json({ rules });
  } catch (error) {
    console.error('Failed to fetch L0 rules:', error);
    return NextResponse.json(
      { error: 'Failed to fetch L0 rules' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuthOrResponse();
    if (auth) return auth;

    const parsed = createL0RuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return validationError(parsed.error);
    }

    const rule = await createL0Rule(parsed.data);
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    console.error('Failed to create L0 rule:', error);
    return NextResponse.json(
      { error: 'Failed to create L0 rule' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireAuthOrResponse();
    if (auth) return auth;

    const parsed = updateL0RuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return validationError(parsed.error);
    }

    const { id, ...patch } = parsed.data;
    const rule = await updateL0Rule(id, patch);
    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ rule });
  } catch (error) {
    console.error('Failed to update L0 rule:', error);
    return NextResponse.json(
      { error: 'Failed to update L0 rule' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireAuthOrResponse();
    if (auth) return auth;

    const parsed = deleteL0RuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return validationError(parsed.error);
    }

    await deleteL0Rule(parsed.data.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete L0 rule:', error);
    return NextResponse.json(
      { error: 'Failed to delete L0 rule' },
      { status: 500 },
    );
  }
}
