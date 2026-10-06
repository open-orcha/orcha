import { type HTMLAttributes } from 'react'
import { cn } from './cn'

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md bg-hover px-1.5 py-0.5 text-xs font-medium text-text-2',
        className
      )}
      {...props}
    />
  )
}
