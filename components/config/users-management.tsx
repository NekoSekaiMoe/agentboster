'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Download,
  KeyRound,
  Loader2,
  Shield,
  ShieldOff,
  Trash2,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

type UserStats = {
  sessions: number;
  files: number;
  memories: number;
};

type User = {
  id: string;
  username: string;
  roles: string[];
  isSeedAdmin: boolean;
  createdAt: string;
  stats?: UserStats;
};

type UserData = {
  sessions: Array<{
    id: string;
    title: string | null;
    channel: string;
    status: string;
    totalTokens: number;
    createdAt: string;
    updatedAt: string;
  }>;
  files: Array<{
    id: string;
    sessionId: string;
    fileName: string;
    mimeType: string;
    size: number;
    createdAt: string;
  }>;
  memories: Array<{
    id: string;
    content: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

async function readError(res: Response, fallback: string) {
  const payload = await res.json().catch(() => ({ error: fallback }));
  return payload?.error ?? fallback;
}

async function fetchUsers(): Promise<User[]> {
  const res = await fetch('/api/auth/users?includeStats=1');
  if (!res.ok) throw new Error(await readError(res, 'Failed to fetch users'));
  return res.json();
}

async function fetchUserData(userId: string): Promise<UserData> {
  const res = await fetch(
    `/api/auth/users?id=${encodeURIComponent(userId)}&includeData=1`,
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to fetch user data'));
  }
  return res.json();
}

async function createUser(data: {
  username: string;
  password: string;
  roles?: string[];
}): Promise<User> {
  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to create user'));
  }
  return res.json();
}

async function updateUserRoles(input: { id: string; roles: string[] }) {
  const res = await fetch('/api/auth/users', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to update roles'));
  }
  return res.json();
}

async function resetUserPassword(input: { id: string; password: string }) {
  const res = await fetch('/api/auth/users', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to reset password'));
  }
  return res.json();
}

async function deleteUserResource(input: {
  id: string;
  resource?: 'user' | 'session' | 'memory';
  resourceId?: string;
}) {
  const res = await fetch('/api/auth/users', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Delete failed'));
  }
}

function formatDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function shortId(value: string) {
  return value.length <= 12
    ? value
    : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export function UsersManagement() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
  });

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      setOpen(false);
      toast.success('User created');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-xl tracking-tight">Users</h2>
          <p className="text-muted-foreground text-sm">
            Manage accounts, roles, conversations, files, and user memories.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus className="mr-2 size-4" />
              Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create User</DialogTitle>
              <DialogDescription>
                Add a user to this instance.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="new-username">Username</Label>
                <Input
                  id="new-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="new-password">Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="new-is-admin"
                  checked={isAdmin}
                  onCheckedChange={(checked) => setIsAdmin(checked === true)}
                />
                <Label
                  htmlFor="new-is-admin"
                  className="cursor-pointer text-sm"
                >
                  Admin
                </Label>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() =>
                  createMutation.mutate({
                    username,
                    password,
                    roles: isAdmin ? ['admin', 'user'] : ['user'],
                  })
                }
                disabled={!username || !password || createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : users.length === 0 ? (
        <p className="text-muted-foreground text-sm">No users found.</p>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <UserCard key={user.id} user={user} />
          ))}
        </div>
      )}
    </div>
  );
}

function UserCard({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const isAdmin = user.roles.includes('admin');
  const canChangeRoles = !user.isSeedAdmin;

  const userData = useQuery({
    queryKey: ['user-data', user.id],
    queryFn: () => fetchUserData(user.id),
    enabled: expanded,
  });

  const roleMutation = useMutation({
    mutationFn: updateUserRoles,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Roles updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteUserResource,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['user-data', user.id] });
      toast.success(
        variables.resource === 'session'
          ? 'Session deleted'
          : variables.resource === 'memory'
            ? 'Memory deleted'
            : 'User deleted',
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const nextRoles = isAdmin ? ['user'] : ['admin', 'user'];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <button
            type="button"
            className="flex min-w-0 items-center gap-3 text-left"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )}
            {isAdmin ? (
              <Shield className="size-5 shrink-0 text-amber-500" />
            ) : (
              <ShieldOff className="size-5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="truncate font-medium">{user.username}</span>
                {user.isSeedAdmin ? (
                  <span className="rounded bg-primary/10 px-2 py-0.5 text-primary text-xs">
                    Seed
                  </span>
                ) : null}
              </span>
              <span className="block text-muted-foreground text-xs">
                Created {formatDate(user.createdAt)}
              </span>
            </span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-muted px-2 py-1 text-xs">
              {isAdmin ? 'Admin' : 'User'}
            </span>
            <span className="rounded bg-muted px-2 py-1 text-xs">
              {user.stats?.sessions ?? 0} sessions
            </span>
            <span className="rounded bg-muted px-2 py-1 text-xs">
              {user.stats?.files ?? 0} files
            </span>
            <span className="rounded bg-muted px-2 py-1 text-xs">
              {user.stats?.memories ?? 0} memories
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!canChangeRoles || roleMutation.isPending}
              onClick={() =>
                roleMutation.mutate({ id: user.id, roles: nextRoles })
              }
            >
              {isAdmin ? 'Demote' : 'Promote'}
            </Button>
            <PasswordResetDialog user={user} />
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive"
              disabled={deleteMutation.isPending || user.isSeedAdmin}
              onClick={() => {
                if (confirm(`Delete user "${user.username}"?`)) {
                  deleteMutation.mutate({ id: user.id, resource: 'user' });
                }
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        {expanded ? (
          <div className="space-y-5">
            <Separator />
            {userData.isLoading ? (
              <div className="flex h-24 items-center justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : userData.error ? (
              <p className="text-destructive text-sm">
                {userData.error instanceof Error
                  ? userData.error.message
                  : 'Failed to load user data'}
              </p>
            ) : (
              <UserDataPanels
                user={user}
                data={
                  userData.data ?? { sessions: [], files: [], memories: [] }
                }
                deleting={deleteMutation.isPending}
                onDelete={(payload) => deleteMutation.mutate(payload)}
              />
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PasswordResetDialog({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const queryClient = useQueryClient();
  const passwordsMatch = password === confirmPassword;

  const resetMutation = useMutation({
    mutationFn: resetUserPassword,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setPassword('');
      setConfirmPassword('');
      setOpen(false);
      toast.success('Password reset');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setPassword('');
          setConfirmPassword('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyRound className="mr-2 size-4" />
          Reset password
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.username}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor={`reset-password-${user.id}`}>New password</Label>
            <Input
              id={`reset-password-${user.id}`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`confirm-password-${user.id}`}>
              Confirm password
            </Label>
            <Input
              id={`confirm-password-${user.id}`}
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </div>
          {confirmPassword && !passwordsMatch ? (
            <p className="text-destructive text-sm">Passwords do not match.</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={
              !password ||
              !confirmPassword ||
              !passwordsMatch ||
              resetMutation.isPending
            }
            onClick={() => resetMutation.mutate({ id: user.id, password })}
          >
            {resetMutation.isPending ? 'Resetting...' : 'Reset password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserDataPanels({
  user,
  data,
  deleting,
  onDelete,
}: {
  user: User;
  data: UserData;
  deleting: boolean;
  onDelete: (payload: {
    id: string;
    resource: 'session' | 'memory';
    resourceId: string;
  }) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <section className="space-y-2">
        <h3 className="font-medium text-sm">Sessions</h3>
        {data.sessions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No sessions.</p>
        ) : (
          <div className="space-y-2">
            {data.sessions.map((session) => (
              <div key={session.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      className="block truncate font-medium text-sm hover:underline"
                      href={`/chat/${session.id}`}
                    >
                      {session.title || 'Untitled'}
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      {session.channel} · {session.status} ·{' '}
                      {shortId(session.id)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Updated {formatDate(session.updatedAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-destructive hover:text-destructive"
                    disabled={deleting}
                    onClick={() => {
                      if (confirm('Delete this session?')) {
                        onDelete({
                          id: user.id,
                          resource: 'session',
                          resourceId: session.id,
                        });
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-medium text-sm">Files</h3>
        {data.files.length === 0 ? (
          <p className="text-muted-foreground text-sm">No files.</p>
        ) : (
          <div className="space-y-2">
            {data.files.map((file) => (
              <div key={file.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-sm">
                      {file.fileName}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {formatBytes(file.size)} · {shortId(file.sessionId)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {formatDate(file.createdAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    asChild
                  >
                    <a href={`/api/files/${file.id}/download`}>
                      <Download className="size-4" />
                    </a>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-medium text-sm">Long-term Memory</h3>
        {data.memories.length === 0 ? (
          <p className="text-muted-foreground text-sm">No memories.</p>
        ) : (
          <div className="space-y-2">
            {data.memories.map((memory) => (
              <div key={memory.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="line-clamp-3 text-sm">{memory.content}</p>
                    <p className="mt-1 text-muted-foreground text-xs">
                      Updated {formatDate(memory.updatedAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-destructive hover:text-destructive"
                    disabled={deleting}
                    onClick={() => {
                      if (confirm('Delete this memory?')) {
                        onDelete({
                          id: user.id,
                          resource: 'memory',
                          resourceId: memory.id,
                        });
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
