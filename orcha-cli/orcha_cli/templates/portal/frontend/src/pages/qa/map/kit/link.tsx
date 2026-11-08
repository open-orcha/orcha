/** A link by `href` on the portal's router (an outside URL stays a plain link). */
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link as RouterLink } from "react-router-dom";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, prefetch: _prefetch, scroll: _scroll, replace, ...rest }, ref) {
  if (/^[a-z]+:/i.test(href)) return <a ref={ref} href={href} {...rest} />;
  return <RouterLink ref={ref} to={href} replace={replace} {...rest} />;
});
export default Link;
export { Link };
