import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from './cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text placeholder:text-text/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        className
      )}
      {...props}
    />
  )
)
Input.displayName = 'Input'
