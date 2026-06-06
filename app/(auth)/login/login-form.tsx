'use client';

import { loginAction } from '@/app/(auth)/actions';
import {
  Eye,
  EyeOff,
  Languages,
  LockKeyhole,
  Moon,
  Sun,
  User,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isDark = resolvedTheme === 'dark';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const result = await loginAction({
        username,
        password,
        redirectTo,
      });

      if (!result.ok) {
        setError(result.error ?? 'Login failed.');
        return;
      }

      router.replace(result.redirectTo ?? '/');
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-[380px] rounded-2xl border border-border/70 bg-card px-8 pt-7 pb-8 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-sky-50 text-sky-600 dark:bg-sky-950/50">
          <Logo width={38} height={38} />
        </div>

        <div className="flex items-center gap-1.5 text-sky-600">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg text-sky-600 hover:bg-sky-50 hover:text-sky-700 dark:hover:bg-sky-950/50"
            aria-label="Language"
          >
            <Languages className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg text-sky-600 hover:bg-sky-50 hover:text-sky-700 dark:hover:bg-sky-950/50"
            aria-label={isDark ? 'Use light mode' : 'Use dark mode'}
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>

      <div className="mb-5">
        <h1 className="font-semibold text-[22px] text-foreground tracking-tight">
          AgentBoster WebUI Login
        </h1>
        <p className="mt-2 text-muted-foreground text-sm">欢迎使用</p>
      </div>

      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="username" className="sr-only">
            用户名
          </Label>
          <div className="relative">
            <User className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 size-5 text-muted-foreground" />
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="用户名"
              className="h-14 rounded-lg border-border/80 bg-background pr-4 pl-12 text-base shadow-none"
              required
            />
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="password" className="sr-only">
            密码
          </Label>
          <div className="relative">
            <LockKeyhole className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 size-5 text-muted-foreground" />
            <Input
              id="password"
              type={passwordVisible ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              className="h-14 rounded-lg border-border/80 bg-background pr-12 pl-12 text-base shadow-none"
              required
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-translate-y-1/2 absolute top-1/2 right-2 size-9 rounded-lg text-muted-foreground hover:bg-transparent hover:text-foreground"
              aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
              onClick={() => setPasswordVisible((current) => !current)}
            >
              {passwordVisible ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </Button>
          </div>
        </div>

        <p className="text-muted-foreground text-xs">
          如果是第一次登录，请留意日志输出的默认密码
        </p>

        {error ? <p className="text-destructive text-sm">{error}</p> : null}

        <Button
          type="submit"
          disabled={submitting}
          className="mt-2 h-12 rounded-lg bg-[#2f91c7] font-semibold text-base hover:bg-[#2a83b4]"
        >
          {submitting ? '登录中...' : '登录'}
        </Button>
      </form>
    </div>
  );
}
