import * as ProgressPrimitive from '@radix-ui/react-progress'
import { cn } from './cn'

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <ProgressPrimitive.Root
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-card', className)}
      value={value}
    >
      <ProgressPrimitive.Indicator
        className="h-full bg-accent transition-transform duration-[var(--duration-base)]"
        style={{ transform: `translateX(-${100 - value}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}
