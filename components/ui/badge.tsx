import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva('ui-badge', {
  variants: {
    tone: {
      neutral: 'ui-badge-neutral',
      success: 'ui-badge-success',
      warning: 'ui-badge-warning',
      danger: 'ui-badge-danger',
      accent: 'ui-badge-accent',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className = '', tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={`${badgeVariants({ tone })} ${className}`} {...props} />;
}
