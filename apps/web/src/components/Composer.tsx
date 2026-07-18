import { useState, useEffect, useRef, useMemo, type FormEvent, type KeyboardEvent } from 'react';
import { api, type SkillItem } from '../api/client.ts';
import { LABS, type Lab } from '../pages/Labs.tsx';

// 底部 sticky 输入框。Enter 提交,Shift+Enter 换行。
// 输入以 $ 开头(尚未输入空格)时,弹出 skill 命令菜单,随输入实时筛选;选中插入 $<id> 。
export function Composer({ disabled, onSubmit }: { disabled: boolean; onSubmit: (t: string) => void }) {
  const [text, setText] = useState('');
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false); // Esc 关闭,直到下次改动
  const [activeLab, setActiveLab] = useState<Lab | null>(null); // 工具弹窗
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 首次挂载拉一次可直呼 skill 列表(登录态)
  useEffect(() => {
    api.skills().then((r) => setSkills(r.skills)).catch(() => {});
  }, []);

  // 仅当整段输入是 $token(还没敲空格)时进入菜单态;query 为 $ 后的字符
  const query = useMemo(() => {
    const m = text.match(/^\$(\S*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

  const filtered = useMemo(() => {
    if (query === null) return [];
    // 只按 id + 展示名筛选(描述太长会过度命中);中文名支持中文搜索。
    return skills.filter(
      (s) => s.id.toLowerCase().includes(query) || s.name.toLowerCase().includes(query),
    );
  }, [query, skills]);

  const menuOpen = query !== null && filtered.length > 0 && !dismissed && !disabled;

  useEffect(() => setSel(0), [query]);

  function choose(s: SkillItem) {
    setText(`$${s.id} `);
    setDismissed(true);
    taRef.current?.focus();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSubmit(t);
    setText('');
    setDismissed(false);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => (i + 1) % filtered.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => (i - 1 + filtered.length) % filtered.length); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); choose(filtered[sel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
  }

  return (
    <form onSubmit={submit} style={{ borderTop: '1px solid var(--border-soft)', padding: '18px 20px 22px', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', position: 'relative' }}>
        {menuOpen && (
          <div
            role="listbox"
            style={{
              position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0,
              maxHeight: 320, overflowY: 'auto',
              background: 'var(--bg-elev)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
              padding: 6, zIndex: 20,
            }}
          >
            <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text-faint)' }}>
              技能 · {filtered.length} 个{query ? ` · 匹配 "${query}"` : ''}
            </div>
            {filtered.map((s, i) => (
              <div
                key={s.id}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(s); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
                  borderRadius: 8, cursor: 'pointer',
                  background: i === sel ? 'var(--bg-card)' : 'transparent',
                }}
              >
                <span style={{ color: 'var(--skill-fg)', fontSize: 15, flexShrink: 0 }}>◈</span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)', flexShrink: 0,
                }}>
                  {s.id}
                </span>
                <span style={{
                  fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
                }}>
                  {s.name !== s.id ? `${s.name} · ` : ''}{s.description}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>
                  {s.domain[0] ?? '技能'}
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {LABS.map((lab) => (
            <button
              key={lab.id}
              type="button"
              onClick={() => setActiveLab(lab)}
              title={lab.desc}
              style={{
                fontSize: 12, padding: '5px 12px', borderRadius: 999,
                background: 'var(--bg-card)', border: '1px solid var(--border-soft)',
                color: 'var(--text-dim)', cursor: 'pointer',
              }}
            >
              🧪 {lab.name}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => { setText(e.target.value); setDismissed(false); }}
            onKeyDown={onKey}
            disabled={disabled}
            rows={1}
            placeholder={disabled ? 'AI 处理中…' : '输入一句用研需求,或输入 $ 唤起技能,Enter 发送'}
            style={{
              flex: 1, resize: 'none', minHeight: 52, maxHeight: 180, padding: '14px 16px',
              background: 'var(--bg-card)', border: '1px solid var(--border-soft)', borderRadius: 16,
              color: 'var(--text)', fontSize: 15, fontFamily: 'inherit', lineHeight: 1.55,
              boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            }}
          />
          <button className="btn-primary" disabled={disabled || !text.trim()}>发送</button>
        </div>
      </div>

      {activeLab && (
        <div
          onClick={() => setActiveLab(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'grid', placeItems: 'center' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '90vw', height: '85vh', display: 'flex', flexDirection: 'column',
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
              <strong style={{ fontSize: 14 }}>{activeLab.name}</strong>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{activeLab.url}</span>
              <a className="btn-ghost" href={activeLab.url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 12 }}>新标签打开 ↗</a>
              <button type="button" className="btn-ghost" onClick={() => setActiveLab(null)} style={{ fontSize: 16, lineHeight: 1, padding: '2px 10px' }}>×</button>
            </div>
            <iframe title={activeLab.name} src={activeLab.url} style={{ flex: 1, border: 'none', width: '100%' }} />
          </div>
        </div>
      )}
    </form>
  );
}
