import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva('ui-button', {
  variants: {
    variant: {
      default: 'ui-button-default',
      outline: 'ui-button-outline',
      secondary: 'ui-button-secondary',
      warning: 'ui-button-warning',
      danger: 'ui-button-danger',
      ghost: 'ui-button-ghost',
    },
    size: {
      default: '',
      sm: 'ui-button-sm',
      lg: 'ui-button-lg',
      icon: 'ui-button-icon',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export function Button({
  className = '',
  variant,
  size,
  type = 'button',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={`${buttonVariants({ variant, size })} ${className}`} {...props} />;
}
