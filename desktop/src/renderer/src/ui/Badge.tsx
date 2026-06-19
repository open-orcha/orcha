import { type HTMLAttributes } from 'react'
import { cn } from './cn'

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent',
        className
      )}
      {...props}
    />
  )
}
