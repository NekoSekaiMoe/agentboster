const AUTH_REQUIRED_ENV_VARS = [
  {
    displayName: 'AUTH_SECRET',
    aliases: ['AUTH_SECRET'],
  },
] as const;

const ALPHANUMERIC_CHARACTERS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function readFirstEnvValue(aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = process.env[alias]?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

function generateRandomAlphanumeric(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));

  return Array.from(bytes, (byte) => {
    const index = byte % ALPHANUMERIC_CHARACTERS.length;
    return ALPHANUMERIC_CHARACTERS[index];
  }).join('');
}

export function readConfiguredAuthSecret(): string | null {
  return readFirstEnvValue(['AUTH_SECRET']);
}

export function readConfiguredAuthUsername(): string | null {
  return readFirstEnvValue(['USERNAME']);
}

export function readConfiguredAuthPassword(): string | null {
  return readFirstEnvValue(['PASSWORD']);
}

export function generateAuthEnvExample(): string {
  return [
    `AUTH_SECRET=${generateRandomAlphanumeric(32)}`,
    `USERNAME=${generateRandomAlphanumeric(12)}`,
    `PASSWORD=${generateRandomAlphanumeric(16)}`,
  ].join('\n');
}

export function getAuthConfigStatus() {
  const missingEnvVars = AUTH_REQUIRED_ENV_VARS.filter(({ aliases }) => {
    return readFirstEnvValue(aliases) === null;
  }).map(({ displayName }) => displayName);

  return {
    isConfigured: missingEnvVars.length === 0,
    missingEnvVars,
    exampleEnvFile: generateAuthEnvExample(),
  };
}
