// context.js — C: the Context manager.
//
// Owns the message history and DECIDES what stays in the model's context. When the running size
// exceeds a char budget (≈ tokens × 4), it evicts the OLDEST (assistant tool_use → user
// tool_result) PAIR — always evicted as a pair so every remaining tool_use still has its result
// (Anthropic requires that), and always from the front so the conversation stays valid
// (user prompt → assistant → user → …). This is a real, bounded sliding-window context manager
// (the gap the agent previously lacked: messages just accumulated unbounded).
//
// Roughly 4 chars ≈ 1 token. Default budget keeps things well under the model window while
// bounding cost; set it small in tests to force compaction.

class Context {
  constructor(opts) {
    opts = opts || {};
    this.system = '';
    this.messages = [];
    this.maxChars = opts.maxChars != null ? opts.maxChars : 80000; // ~20k tokens
    this.keepLast = opts.keepLast != null ? opts.keepLast : 6;     // never evict below this many messages
    this.compactions = 0;                                           // how many pairs evicted (observability)
    this._notedCompact = false;
  }
  setSystem(s) { this.system = s || ''; }
  pushUser(content) { this.messages.push({ role: 'user', content }); this.compact(); }
  pushAssistant(content) { this.messages.push({ role: 'assistant', content }); this.compact(); }
  pushToolResult(toolUseId, content, isError) {
    const tr = { type: 'tool_result', tool_use_id: toolUseId, content };
    if (isError) tr.is_error = true;
    this.messages.push({ role: 'user', content: [tr] });
    this.compact();
  }
  size() { return this.system.length + JSON.stringify(this.messages).length; }

  // Find the earliest assistant message that contains a tool_use, paired with the following
  // user(tool_result) message. Valid to evict from the front while we keep >= keepLast messages.
  _earliestToolPair() {
    if (this.messages.length <= this.keepLast) return null;
    for (let i = 0; i < this.messages.length - 1; i++) {
      const a = this.messages[i], b = this.messages[i + 1];
      const aHasTU = a.role === 'assistant' && Array.isArray(a.content) && a.content.some((c) => c && c.type === 'tool_use');
      const bIsTR = b.role === 'user' && Array.isArray(b.content) && b.content.some((c) => c && c.type === 'tool_result');
      if (aHasTU && bIsTR) return [i, i + 1];
    }
    return null;
  }
  compact() {
    while (this.size() > this.maxChars) {
      const pair = this._earliestToolPair();
      if (!pair) break; // nothing safely evictable
      // drop the assistant(tool_use) + user(tool_result) pair
      this.messages.splice(pair[0], 2);
      this.compactions++;
    }
    // one-time note so the model knows older tool calls were trimmed
    if (this.compactions > 0 && !this._notedCompact) {
      this.messages.push({ role: 'user', content: '[system] 为节省上下文，较早的工具调用与结果已被省略；请基于剩余信息继续。' });
      this._notedCompact = true;
    }
  }
}
module.exports = { Context };
