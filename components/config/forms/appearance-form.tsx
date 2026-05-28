'use client';

import { Monitor, Smartphone } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useNavMode } from '@/hooks/use-nav-mode';

export function AppearanceForm() {
  const { navMode, setNavMode } = useNavMode();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Navigation Style</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose how you navigate the app. This preference is stored locally
            on your device.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => setNavMode('bottom-tabs')}
              className={`flex flex-col items-center gap-3 rounded-xl border-2 p-6 transition-colors ${
                navMode === 'bottom-tabs'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              <div className="flex h-32 w-full items-end justify-center rounded-lg bg-muted/50 p-2">
                <div className="flex w-full gap-1">
                  {[
                    'Chat',
                    'Files',
                    'Memory',
                    'Schedule',
                    'Skills',
                    'Config',
                  ].map((label) => (
                    <div
                      key={label}
                      className={`flex flex-1 flex-col items-center gap-0.5 rounded px-1 py-1.5 ${
                        label === 'Chat' ? 'bg-primary/20 text-primary' : ''
                      }`}
                    >
                      <div className="h-3 w-3 rounded-sm bg-current opacity-60" />
                      <span className="text-[8px]">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Smartphone className="size-4" />
                <span className="font-medium">Bottom Tab Bar</span>
              </div>
              <span className="text-xs text-muted-foreground text-center">
                iOS-style tab bar at the bottom. Quick access to all sections.
              </span>
            </button>

            <button
              onClick={() => setNavMode('sidebar-drawer')}
              className={`flex flex-col items-center gap-3 rounded-xl border-2 p-6 transition-colors ${
                navMode === 'sidebar-drawer'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              <div className="flex h-32 w-full items-start justify-start rounded-lg bg-muted/50 p-2">
                <div className="flex flex-col gap-1 w-20">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-primary/20">
                    <div className="h-2 w-2 rounded-sm bg-primary" />
                    <span className="text-[8px]">Chat</span>
                  </div>
                  {['Files', 'Memory', 'Schedule', 'Skills', 'Config'].map(
                    (label) => (
                      <div
                        key={label}
                        className="flex items-center gap-1.5 px-2 py-1.5 rounded"
                      >
                        <div className="h-2 w-2 rounded-sm bg-current opacity-40" />
                        <span className="text-[8px]">{label}</span>
                      </div>
                    ),
                  )}
                </div>
                <div className="flex-1" />
              </div>
              <div className="flex items-center gap-2">
                <Monitor className="size-4" />
                <span className="font-medium">Slide-in Drawer</span>
              </div>
              <span className="text-xs text-muted-foreground text-center">
                Hamburger menu that slides in from the left. More screen space
                for content.
              </span>
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
