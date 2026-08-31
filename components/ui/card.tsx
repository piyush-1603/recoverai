import * as React from 'react';

type CardProps = React.HTMLAttributes<HTMLDivElement>;

/** A deliberately minimal shadcn-style primitive; visual treatment lives with the dashboard. */
export function Card({ className = '', ...props }: CardProps) {
  return <div className={`ui-card ${className}`} {...props} />;
}

export function CardHeader({ className = '', ...props }: CardProps) {
  return <div className={`ui-card-header ${className}`} {...props} />;
}

export function CardContent({ className = '', ...props }: CardProps) {
  return <div className={`ui-card-content ${className}`} {...props} />;
}
