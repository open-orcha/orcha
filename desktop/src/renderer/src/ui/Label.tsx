import { type LabelHTMLAttributes } from 'react'
import { cn } from './cn'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-xs font-medium text-text/70', className)} {...props} />
}
