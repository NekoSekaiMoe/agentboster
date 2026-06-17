'use client';

import { Volume2 } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigContextStrict } from '@/components/config/config-provider';
import { useConfigSection } from '@/hooks/use-config-section';
import type { TtsConfig } from '@/types/config/tts';
import { SectionIssues } from './shared';

const DEFAULT_TTS_CONFIG: TtsConfig = {
  format: 'mp3',
};

const VOICE_OPTIONS = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
  'coral',
  'sage',
  'ash',
  'ballad',
] as const;

const FORMAT_OPTIONS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const;

export function TtsForm() {
  const { issues, value, updateValue } = useConfigSection('tts');
  const { isAdmin } = useConfigContextStrict();

  const current: TtsConfig = {
    ...DEFAULT_TTS_CONFIG,
    ...(value ?? {}),
  };

  function update(patch: Partial<TtsConfig>) {
    updateValue((prev) => ({
      ...DEFAULT_TTS_CONFIG,
      ...(prev ?? {}),
      ...patch,
    }));
  }

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <SectionIssues issues={issues} />
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Volume2 className="size-4" />
              Text-to-Speech
            </CardTitle>
            <CardDescription>
              Administrator access required to configure TTS.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Volume2 className="size-4" />
            Text-to-Speech
          </CardTitle>
          <CardDescription>
            Configure the bot&apos;s speaking voice, speech model, and audio
            format. These settings are bot-wide personality attributes — like
            the bot&apos;s locale, the voice applies wherever TTS is invoked
            (Web chat auto-play, IM voice replies). Whether TTS is actually
            produced for a given request is decided per channel (IM) or per user
            (Web localStorage toggle).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tts-model">Speech model</Label>
            <Input
              id="tts-model"
              value={current.model ?? ''}
              onChange={(e) => update({ model: e.target.value || undefined })}
              placeholder="e.g. openai/tts-1, openai/gpt-4o-mini-tts"
            />
            <p className="text-muted-foreground text-xs">
              Must route to an OpenAI provider configured under Models (e.g.
              &quot;openai/tts-1&quot;). Other provider formats are not
              supported because their speech APIs are unstable or
              format-incompatible.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tts-voice">Voice</Label>
            <Select
              value={current.voice ?? 'alloy'}
              onValueChange={(v) => update({ voice: v })}
            >
              <SelectTrigger id="tts-voice">
                <SelectValue placeholder="alloy" />
              </SelectTrigger>
              <SelectContent>
                {VOICE_OPTIONS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              The bot&apos;s speaking voice. Treated as a personality attribute
              — pick one that matches the bot&apos;s persona. Available voices
              depend on the model (gpt-4o-mini-tts exposes more than tts-1).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tts-format">Audio format</Label>
            <Select
              value={current.format ?? 'mp3'}
              onValueChange={(v) =>
                update({ format: v as TtsConfig['format'] })
              }
            >
              <SelectTrigger id="tts-format">
                <SelectValue placeholder="mp3" />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Output container. MP3 is the safest default (plays everywhere).
              Use OPUS for smaller Telegram voice sizes; WAV/PCM for lossless
              post-processing.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
