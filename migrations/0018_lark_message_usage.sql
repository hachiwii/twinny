ALTER TABLE lark_messages
ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lark_messages
ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lark_messages
ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lark_messages
ADD COLUMN reasoning_output_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lark_messages
ADD COLUMN token_usage_json TEXT NOT NULL DEFAULT '{}';
