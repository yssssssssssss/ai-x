import { useState, type FormEvent, type KeyboardEvent } from 'react';

// 底部 sticky 输入框。Enter 提交,Shift+Enter 换行。
export function Composer({ disabled, onSubmit }: { disabled: boolean; onSubmit: (t: string) => void }) {
  const [text, setText] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSubmit(t);
    setText('');
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
  }

  return (
    <form onSubmit={submit} style={{ borderTop: '1px solid var(--border)', padding: 16, background: 'var(--bg)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? 'AI 处理中…' : '输入一句用研需求,Enter 发送'}
          style={{
            flex: 1, resize: 'none', minHeight: 44, maxHeight: 160, padding: '11px 14px',
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            color: 'var(--text)', fontSize: 14, fontFamily: 'inherit',
          }}
        />
        <button className="btn-primary" disabled={disabled || !text.trim()}>发送</button>
      </div>
    </form>
  );
}
