import type { EnvColor } from './types';

export const ENV_COLORS: { value: EnvColor; label: string }[] = [
  { value: 'slate', label: 'None' },
  { value: 'green', label: 'Dev' },
  { value: 'amber', label: 'UAT' },
  { value: 'red', label: 'Production' },
];

export const envVar = (strColor: EnvColor) => `var(--env-${strColor})`;
