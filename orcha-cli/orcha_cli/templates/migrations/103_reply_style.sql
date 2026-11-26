-- Reply style (reply_style.py): how agents write to people.
--   containers.reply_style       the project setting: normal (default), caveman or asd_ste100.
--   conversations.reply_style    per-conversation override from the composer chip; NULL follows
--                                the project.
--   tasks.reply_style            per-task-thread override; NULL follows the project.
-- ADD-only: one defaulted column and two nullable ones.

ALTER TABLE containers ADD COLUMN reply_style TEXT NOT NULL DEFAULT 'normal'
    CONSTRAINT containers_reply_style_check CHECK (reply_style IN ('normal','caveman','asd_ste100'));
ALTER TABLE conversations ADD COLUMN reply_style TEXT
    CONSTRAINT conversations_reply_style_check CHECK (reply_style IN ('normal','caveman','asd_ste100'));
ALTER TABLE tasks ADD COLUMN reply_style TEXT
    CONSTRAINT tasks_reply_style_check CHECK (reply_style IN ('normal','caveman','asd_ste100'));
