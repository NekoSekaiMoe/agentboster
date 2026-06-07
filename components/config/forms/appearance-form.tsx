'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function AppearanceForm() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Appearance settings will be available here in the future.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
