import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn'

/** Linear-style compact buttons (design directive D2): 28px tall, 6px radius, 13px medium
 *  text. ONE `default` (primary) per view; everything else is `secondary` (subtle raised
 *  fill + hairline border), `outline` (hairline only) or `ghost`. No oversized slabs.
 *  `icon` is a 28px circular icon button (D5 panel-header actions). */
const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium leading-none transition-colors duration-[var(--duration-fast)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // V2: accent fill carries DARK text (#101113 on #8D93F7 = 6.9:1); white fails.
        default: 'bg-accent text-bg hover:bg-accent-hover',
        secondary: 'border border-border bg-raised text-text hover:bg-hover',
        outline: 'border border-border bg-transparent text-text hover:bg-hover',
        ghost: 'bg-transparent text-text-2 hover:bg-hover hover:text-text',
        destructive: 'bg-danger text-bg hover:bg-danger/90'
      },
      size: {
        default: 'h-7 px-2.5',
        sm: 'h-6 px-2 text-xs',
        lg: 'h-8 px-3',
        icon: 'h-7 w-7 rounded-full p-0'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  }
)
Button.displayName = 'Button'
