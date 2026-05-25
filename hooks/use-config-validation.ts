'use client';

import { useEffect, useMemo, useState } from 'react';

import { appConfigSchema } from '@/types/config';

export interface ConfigValidationIssue {
  message: string;
  path: string;
}

export interface ConfigValidationResult {
  isValid: boolean;
  issues: ConfigValidationIssue[];
}

export function useConfigValidation(
  value: unknown,
  delay = 250,
): ConfigValidationResult {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return useMemo(() => {
    const result = appConfigSchema.safeParse(debouncedValue);

    if (result.success) {
      return {
        isValid: true,
        issues: [],
      };
    }

    return {
      isValid: false,
      issues: result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.join('.'),
      })),
    };
  }, [debouncedValue]);
}
