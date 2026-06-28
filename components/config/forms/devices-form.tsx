'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  Copy,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type PairCodeListing = {
  code: string;
  label?: string;
  createdAt: number;
  expiresInSeconds: number;
};

type DeviceListing = {
  id: string;
  label: string | null;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  active: boolean;
};

type DevicesData = {
  devices: DeviceListing[];
  pairCodes: PairCodeListing[];
};

async function fetchDevices(): Promise<DevicesData> {
  const res = await fetch('/api/auth/cli-devices');
  if (!res.ok) throw new Error('Failed to load devices');
  return res.json();
}

async function generatePairCode(label?: string): Promise<{ code: string }> {
  const res = await fetch('/api/auth/pair-generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: label?.trim() || undefined }),
  });
  if (!res.ok) throw new Error('Failed to generate pair code');
  return res.json();
}

async function revokePairCodeRequest(code: string): Promise<void> {
  const res = await fetch('/api/auth/pair-revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error('Failed to revoke pair code');
}

async function revokeDevice(deviceId: string): Promise<void> {
  const res = await fetch(`/api/auth/cli-devices/${deviceId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to revoke device');
}

function formatRelative(iso: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function DevicesForm() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['cli-devices'],
    queryFn: fetchDevices,
  });

  const generateMutation = useMutation({
    mutationFn: () => generatePairCode(label),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cli-devices'] });
      setLabel('');
      toast.success(t('config.devices.codeGenerated'));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeCodeMutation = useMutation({
    mutationFn: revokePairCodeRequest,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cli-devices'] });
      toast.success(t('config.devices.codeRevoked'));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeDeviceMutation = useMutation({
    mutationFn: revokeDevice,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cli-devices'] });
      toast.success(t('config.devices.deviceRevoked'));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            {t('config.devices.generateTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {t('config.devices.generateDescription')}
          </p>
          <div className="flex gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('config.devices.labelPlaceholder')}
              className="max-w-xs"
              maxLength={64}
            />
            <Button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
            >
              {generateMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {t('config.devices.generate')}
            </Button>
          </div>

          {data?.pairCodes && data.pairCodes.length > 0 ? (
            <div className="space-y-2">
              {data.pairCodes.map((pc) => (
                <div
                  key={pc.code}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-muted px-2 py-0.5 font-mono text-sm tracking-wider">
                        {pc.code}
                      </code>
                      {pc.label ? (
                        <span className="text-muted-foreground text-xs">
                          {pc.label}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground flex items-center gap-1 text-xs">
                      <Clock className="size-3" />
                      {t('config.devices.expiresIn', {
                        seconds: pc.expiresInSeconds,
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyCode(pc.code)}
                    >
                      {copiedCode === pc.code ? (
                        <CheckCircle2 className="size-4" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revokeCodeMutation.mutate(pc.code)}
                      disabled={revokeCodeMutation.isPending}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <MonitorSmartphone className="size-5" />
              {t('config.devices.devicesTitle')}
            </span>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="size-4" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-muted-foreground py-8 text-center text-sm">
              <Loader2 className="mx-auto size-6 animate-spin" />
            </div>
          ) : data?.devices && data.devices.length > 0 ? (
            <div className="space-y-2">
              {data.devices.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {d.label || t('config.devices.unlabeled')}
                      </span>
                      {d.active ? (
                        <Badge variant="default">
                          {t('config.devices.active')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          {t('config.devices.revoked')}
                        </Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {t('config.devices.pairedAt')}{' '}
                      {formatRelative(d.pairedAt)}
                      {d.lastSeenAt
                        ? ` · ${t('config.devices.lastSeen')} ${formatRelative(d.lastSeenAt)}`
                        : null}
                    </div>
                  </div>
                  {d.active ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revokeDeviceMutation.mutate(d.id)}
                      disabled={revokeDeviceMutation.isPending}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t('config.devices.noDevices')}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
