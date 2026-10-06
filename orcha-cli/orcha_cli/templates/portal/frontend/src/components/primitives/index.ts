/**
 * Orcha V2 shared UI primitives (owner: B). Styled by
 * static/styles/v2-primitives.css using the --v2-* tokens
 * (docs/orcha-v2-design-system.md §2+ documents usage).
 */
export { Button, ButtonLink, IconButton, buttonClass, type ButtonProps, type ButtonLinkProps, type ButtonVariant, type ButtonSize, type IconButtonProps } from "./Button";
export { Badge, Count, StatusDot, statusGlyph, statusTone, type Tone, type Glyph } from "./Badge";
export { Dialog, ConfirmDialog, type DialogProps } from "./Dialog";
export { Menu, MenuButton, Popover, type MenuItemSpec, type PopoverProps } from "./Menu";
export { List, Row, moveRowFocus, rowNavKeyDown, ROW_SELECTOR, type ListProps, type RowProps, type RowNavOptions } from "./List";
export {
  SplitPane, Inspector, Tabs, TabPanel, NavTabs, Segmented, Section, Toolbar, Breadcrumbs, EmptyState, Skeleton,
  useTabStripOverflow,
  type SplitPaneProps, type TabSpec, type NavTabSpec, type SegmentSpec, type Crumb,
} from "./Layout";
export { focusables, trapTab, useFocusReturn, isEditingTarget, isEditorOrTerminal } from "./focus";
export {
  Payload, KeyValue, ShortId, RawPayload, payloadTitle, payloadText, normalizePayload, humanizeKey,
  type PayloadProps, type KVItem,
} from "./Payload";
export { Tooltip, placeTooltip, type TooltipProps, type TooltipPlacement } from "./Tooltip";
export { HelpTip, type HelpTipProps } from "./HelpTip";
/* ---- D7/D8 identity + Linear iconography (owner: primitives-a) ---- */
export {
  Avatar, AvatarStack, avatarPx, avatarColor, avatarColors, avatarInitial, presenceTone,
  AVATAR_HUES, paletteColor, paletteIndex, assignPalette, actorKey, projectAvatarKey, projectInitials,
  rosterPaletteSlots, useActorPalette,
  type AvatarColors, type AvatarProps, type AvatarStackProps, type AvatarActor, type AvatarKind, type AvatarSize, type AvatarSizeName, type PresenceTone,
} from "./Avatar";
export { StatusIcon, StatusGlyph, statusShape, statusColor, statusLabel, type StatusIconProps, type StatusShape, type StatusColor } from "./StatusIcon";
export { PriorityIcon, PriorityGlyph, priorityLevel, type PriorityIconProps, type PriorityLevel } from "./PriorityIcon";
export { Chip, PrChip, labelDotColor, type ChipProps, type ChipTone, type PrChipProps, type PrState } from "./Chip";
export { LivePill, liveStateFor, LIVE_LABEL, type LivePillProps, type LiveState } from "./LivePill";
export { HealthChip, HEALTH_LABEL, HEALTH_RULE, HEALTH_THRESHOLDS, healthFromFailures, type Health } from "./HealthChip";
/* ---- primitives-b: Linear layout building blocks ---- */
export { iconButtonClass, type IconButtonVariant } from "./IconButton";
export { FilterPills, FilterBar, type FilterPillSpec, type FilterPillsProps } from "./FilterPills";
export { GroupHeader, ListGroup, type GroupHeaderProps, type ListGroupProps } from "./GroupHeader";
export {
  Timeline, TimelineEvent, TimelineCard, TimelineMessage, TimelineCardEvent, TimelineComment, TimelineDivider, RelTime,
  type TimelineEventProps, type TimelineMessageProps,
} from "./Timeline";
export { PropertyRail, PropertySection, Property, type PropertyProps } from "./PropertyRail";
export { Composer, ContextChip, AttachGlyph, type ComposerProps } from "./Composer";
export { Board, BoardColumn, BoardCard, type BoardColumnProps, type BoardCardProps } from "./Board";
export { ChatThread, ChatBubble, ChatNote, WorkedFor, formatDuration, type ChatBubbleProps, type WorkedForProps } from "./ChatBubble";
export { ChangesCard, type ChangesCardProps } from "./ChangesCard";
/* ---- D14: project icons (per-project store: cloud/projects/projectIcons.ts) ---- */
export { ProjectIcon, GlyphSvg, glyphColor, useProjectIcon, useProjectIcons, type ProjectIconValue, type GlyphName } from "./ProjectIcon";
export { EmojiPicker, ProjectIconPicker } from "./EmojiPicker";
