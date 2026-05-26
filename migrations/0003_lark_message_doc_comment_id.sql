ALTER TABLE lark_messages
  ADD COLUMN doc_comment_id TEXT;

CREATE INDEX idx_lark_messages_doc_comment_id
  ON lark_messages(doc_comment_id)
  WHERE doc_comment_id IS NOT NULL;
