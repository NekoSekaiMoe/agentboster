'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, ShieldOff, Trash2, UserPlus } from 'lucide-react';
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

interface User {
  id: string;
  username: string;
  roles: string[];
  createdAt: string;
}

async function fetchUsers(): Promise<User[]> {
  const res = await fetch('/api/auth/users');
  if (!res.ok) throw new Error('Failed to fetch users');
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
    const err = await res
      .json()
      .catch(() => ({ error: 'Failed to create user' }));
    throw new Error(err.error);
  }
  return res.json();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function UsersPage() {
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
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-2xl tracking-tight">Users</h1>
          <p className="text-muted-foreground text-sm">Manage user accounts</p>
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
              <DialogDescription>Add a new user account</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="new-username">Username</Label>
                <Input
                  id="new-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="new-password">Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
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
                  Admin (full access to config and settings)
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
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : users.length === 0 ? (
        <p className="text-muted-foreground text-sm">No users found.</p>
      ) : (
        <div className="space-y-2">
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
  const isAdmin = user.roles.includes('admin');

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/auth/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: user.id }),
      });
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ error: 'Failed to delete user' }));
        throw new Error(err.error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('User deleted');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          {isAdmin ? (
            <Shield className="size-5 text-amber-500" />
          ) : (
            <ShieldOff className="size-5 text-muted-foreground" />
          )}
          <div>
            <p className="font-medium">{user.username}</p>
            <p className="text-muted-foreground text-xs">
              Created {formatDate(user.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-600 text-xs">
              Admin
            </span>
          ) : (
            <span className="rounded bg-muted px-2 py-0.5 text-xs">User</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              if (confirm('Delete this user?')) {
                deleteMutation.mutate();
              }
            }}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
