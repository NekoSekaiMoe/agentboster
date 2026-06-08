'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Bell, Check, Info, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WorkspacePageHeader } from '@/components/workspace-page-header';

interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  channel: 'web' | 'slack' | 'telegram' | 'email';
  read: boolean;
  createdAt: string;
}

interface Filters {
  channel?: string;
  read?: string;
}

async function fetchNotifications(filters: Filters): Promise<Notification[]> {
  const params = new URLSearchParams();
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.read) params.set('read', filters.read);

  const res = await fetch(`/api/notifications?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch notifications');
  return res.json();
}

async function markAsRead(ids: string[]): Promise<void> {
  const res = await fetch('/api/notifications/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error('Failed to mark as read');
}

async function markAllAsRead(): Promise<void> {
  const res = await fetch('/api/notifications/mark-all-read', {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to mark all as read');
}

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: notifications, isLoading } = useQuery({
    queryKey: ['notifications', filters],
    queryFn: () => fetchNotifications(filters),
    refetchInterval: 10000,
  });

  const markAsReadMutation = useMutation({
    mutationFn: markAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      setSelected(new Set());
      toast.success('Marked as read');
    },
    onError: () => {
      toast.error('Failed to mark as read');
    },
  });

  const markAllAsReadMutation = useMutation({
    mutationFn: markAllAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('All marked as read');
    },
    onError: () => {
      toast.error('Failed to mark all as read');
    },
  });

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selected);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelected(newSelected);
  };

  const toggleAll = () => {
    if (!notifications) return;
    const unread = notifications.filter((n) => !n.read);
    if (selected.size === unread.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(unread.map((n) => n.id)));
    }
  };

  const handleMarkAsRead = () => {
    markAsReadMutation.mutate(Array.from(selected));
  };

  const handleMarkAllAsRead = () => {
    markAllAsReadMutation.mutate();
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'success':
        return <Check className="h-5 w-5 text-green-500" />;
      case 'warning':
        return <AlertCircle className="h-5 w-5 text-yellow-500" />;
      case 'error':
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      default:
        return <Info className="h-5 w-5 text-blue-500" />;
    }
  };

  const getChannelIcon = (channel: string) => {
    switch (channel) {
      case 'slack':
        return <MessageSquare className="h-4 w-4" />;
      case 'telegram':
        return <MessageSquare className="h-4 w-4" />;
      case 'email':
        return <Bell className="h-4 w-4" />;
      default:
        return <Bell className="h-4 w-4" />;
    }
  };

  const unreadCount = notifications?.filter((n) => !n.read).length || 0;

  return (
    <div className="space-y-6">
      <WorkspacePageHeader
        title="Notifications"
        description="View and manage notifications across all channels."
        actions={
          unreadCount > 0 ? (
            <Button onClick={handleMarkAllAsRead} variant="outline" size="sm">
              Mark all as read
            </Button>
          ) : null
        }
      />

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap gap-4 pt-6">
          <div className="min-w-[200px] flex-1">
            <label
              htmlFor="notifications-filter-channel"
              className="mb-2 block font-medium text-sm"
            >
              Channel
            </label>
            <Select
              value={filters.channel || 'all'}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  channel: value === 'all' ? undefined : value,
                })
              }
            >
              <SelectTrigger id="notifications-filter-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                <SelectItem value="web">Web</SelectItem>
                <SelectItem value="slack">Slack</SelectItem>
                <SelectItem value="telegram">Telegram</SelectItem>
                <SelectItem value="email">Email</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[200px] flex-1">
            <label
              htmlFor="notifications-filter-status"
              className="mb-2 block font-medium text-sm"
            >
              Status
            </label>
            <Select
              value={filters.read || 'all'}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  read: value === 'all' ? undefined : value,
                })
              }
            >
              <SelectTrigger id="notifications-filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="unread">Unread</SelectItem>
                <SelectItem value="read">Read</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Batch Actions */}
      {selected.size > 0 && (
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <span className="font-medium text-sm">
              {selected.size} notification(s) selected
            </span>
            <Button
              onClick={handleMarkAsRead}
              variant="default"
              size="sm"
              disabled={markAsReadMutation.isPending}
            >
              {markAsReadMutation.isPending ? 'Marking...' : 'Mark as read'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Notifications List */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              Loading notifications...
            </div>
          ) : !notifications || notifications.length === 0 ? (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              No notifications
            </div>
          ) : (
            <div className="divide-y">
              {/* Select All */}
              <div className="flex items-center gap-3 border-b p-4">
                <Checkbox
                  checked={
                    notifications.filter((n) => !n.read).length > 0 &&
                    selected.size ===
                      notifications.filter((n) => !n.read).length
                  }
                  onCheckedChange={toggleAll}
                />
                <span className="font-medium text-sm">Select all unread</span>
              </div>

              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={`flex items-start gap-3 p-4 transition-colors ${
                    !notification.read ? 'bg-muted/50' : ''
                  }`}
                >
                  {!notification.read && (
                    <Checkbox
                      checked={selected.has(notification.id)}
                      onCheckedChange={() => toggleSelect(notification.id)}
                    />
                  )}
                  {notification.read && <div className="w-4" />}

                  <div className="mt-1 flex-shrink-0">
                    {getIcon(notification.type)}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="font-medium text-sm">
                          {notification.title}
                        </p>
                        <p className="mt-1 text-muted-foreground text-sm">
                          {notification.message}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="flex items-center gap-1"
                      >
                        {getChannelIcon(notification.channel)}
                        {notification.channel}
                      </Badge>
                    </div>
                    <p className="mt-2 text-muted-foreground text-xs">
                      {new Date(notification.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
