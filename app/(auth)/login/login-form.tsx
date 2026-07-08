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

import { useI18n } from '@/components/i18n-provider';
import { LanguageMenuGroup } from '@/components/language-menu-group';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordHelpVisible, setPasswordHelpVisible] = useState(false);
  const isDark = resolvedTheme === 'dark';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      const result = await loginAction({
        username,
        password,
        redirectTo,
      });

      if (!result.ok) {
        setError(result.error ?? t('login.failed'));
        return;
      }

      setSuccess(true);
      router.replace(result.redirectTo ?? '/');
      router.refresh();
    } catch {
      setError(t('login.networkError'));
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg text-sky-600 hover:bg-sky-50 hover:text-sky-700 dark:hover:bg-sky-950/50"
                aria-label={t('login.language')}
              >
                <Languages className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <LanguageMenuGroup />
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg text-sky-600 hover:bg-sky-50 hover:text-sky-700 dark:hover:bg-sky-950/50"
            aria-label={
              isDark ? t('login.useLightMode') : t('login.useDarkMode')
            }
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>

      <div className="mb-5">
        <h1 className="font-semibold text-[22px] text-foreground tracking-tight">
          {t('login.title')}
        </h1>
        <p className="mt-2 text-muted-foreground text-sm">
          {t('login.welcome')}
        </p>
      </div>

      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="username" className="sr-only">
            {t('login.username')}
          </Label>
          <div className="relative">
            <User className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t('login.username')}
              className="h-14 rounded-lg border-border/80 bg-background pr-4 pl-12 text-base shadow-none"
              required
            />
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="password" className="sr-only">
            {t('login.password')}
          </Label>
          <div className="relative">
            <LockKeyhole className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="password"
              type={passwordVisible ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('login.password')}
              className="h-14 rounded-lg border-border/80 bg-background pr-12 pl-12 text-base shadow-none"
              required
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-1/2 right-2 size-9 -translate-y-1/2 rounded-lg text-muted-foreground hover:bg-transparent hover:text-foreground"
              aria-label={
                passwordVisible
                  ? t('login.hidePassword')
                  : t('login.showPassword')
              }
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

        <div className="flex flex-col gap-2 text-xs sm:flex-row sm:items-start sm:justify-between">
          <p className="text-muted-foreground">{t('login.firstLoginHint')}</p>
          <button
            type="button"
            className="shrink-0 self-start font-medium text-sky-600 underline-offset-4 hover:text-sky-700 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
            aria-expanded={passwordHelpVisible}
            onClick={() => setPasswordHelpVisible((visible) => !visible)}
          >
            {t('login.forgotPassword')}
          </button>
        </div>

        {passwordHelpVisible ? (
          <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
            {t('login.forgotPasswordHint')}
          </p>
        ) : null}

        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        {success ? (
          <p className="text-green-600 text-sm dark:text-green-500">
            {t('login.success')}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={submitting}
          className="mt-2 h-12 rounded-lg bg-[#2f91c7] font-semibold text-base hover:bg-[#2a83b4]"
        >
          {submitting ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>
    </div>
  );
}
