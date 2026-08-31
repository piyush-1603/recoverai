import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva('ui-button', {
  variants: { variant: { default: 'ui-button-default', outline: 'ui-button-outline', warning: 'ui-button-warning' } },
  defaultVariants: { variant: 'default' },
});

export function Button({ className = '', variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={`${buttonVariants({ variant })} ${className}`} {...props} />;
}
